import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  ApplicationNotification,
  AuthorityAction,
  Clock,
  CreatePrimitiveDraftRequest,
  DeprecatePrimitiveVersionRequest,
  IdGenerator,
  PrimitiveCommandResponse,
  PrimitiveDependencyInput,
  PrimitiveDraftCommandResponse,
  PrimitiveDraftInput,
  PrimitiveIndexProvenance,
  PrimitiveIndexState,
  PrimitiveKind,
  PrimitiveListQuery,
  PrimitiveListResponse,
  PrimitiveReindexResponse,
  PrimitiveRetrievalRequest,
  PrimitiveRetrievalResponse,
  PrimitiveVersionView,
  PublishPrimitiveVersionRequest,
  ReindexPrimitiveVersionRequest,
  UpdatePrimitiveDraftRequest,
} from '@worldgraph/contracts';
import { canonicalJson } from '@worldgraph/contracts';
import {
  buildPrimitiveIndexDocument,
  assertEmbedding,
  normalizedQueryHash,
  normalizeRetrievalQuery,
  parseSemver,
  rankCandidates,
  resolveDependencies,
  retrievalTerms,
  validateSafeJsonStructure,
  validatePrimitive,
} from '@worldgraph/catalog';
import { telemetry, withSpan, withSpanSync } from '@worldgraph/observability';

import { evaluateAuthority } from '../authority/evaluator.js';
import { buildCommand } from '../application/command.js';
import { ApplicationError } from '../application/errors.js';
import type { NotificationSink } from '../application/notifications.js';
import type { AuthenticatedActor } from '../identity/service.js';
import {
  retrievalListItem,
  type PrimitiveCursorTuple,
  type PrimitiveRepository,
  type PublishedCatalogEntry,
  type ResolvedDependencyWrite,
} from './repository.js';

interface RequestCommandContext {
  idempotencyKey: string;
  requestId: string;
}

interface CursorPayload extends PrimitiveCursorTuple {
  filterHash: string;
}

const CURSOR_MAC_DOMAIN = 'worldgraph:primitive-cursor:v1\0';

function hasForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface LocalQueryVectorSource {
  readonly configurationId: string;
  readonly enabled: boolean;
  readonly execution: 'local';
  readonly model: string | null;
  readonly provider: string | null;
  vectorize(normalizedText: string, signal: AbortSignal): Promise<readonly number[]>;
}

export const disabledLocalQueryVectorSource: LocalQueryVectorSource = {
  configurationId: 'disabled-v1',
  enabled: false,
  execution: 'local',
  model: null,
  provider: null,
  vectorize: async () => {
    throw new Error('QUERY_VECTOR_DISABLED');
  },
};

export interface PrimitiveIndexProfile {
  readonly configurationId: string;
  readonly model: string | null;
  readonly provider: string | null;
}

export const disabledPrimitiveIndexProfile: PrimitiveIndexProfile = {
  configurationId: 'disabled-v1',
  model: null,
  provider: null,
};

export class PrimitiveService {
  public constructor(
    private readonly repository: PrimitiveRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly notifications: NotificationSink,
    private readonly cursorSecret: string,
    private readonly queryVectors: LocalQueryVectorSource = disabledLocalQueryVectorSource,
    private readonly indexProfile: PrimitiveIndexProfile = disabledPrimitiveIndexProfile,
    private readonly queryVectorTimeoutMs = 3_000,
  ) {
    if (this.queryVectors.execution !== 'local')
      throw new Error('Primitive query vectors must execute locally.');
    if (
      this.queryVectors.enabled &&
      (!this.queryVectors.provider ||
        !this.queryVectors.model ||
        this.queryVectors.configurationId !== this.indexProfile.configurationId ||
        this.queryVectors.provider !== this.indexProfile.provider ||
        this.queryVectors.model !== this.indexProfile.model)
    ) {
      throw new Error('Enabled primitive query-vector and index profiles must match exactly.');
    }
  }

  public async refreshCatalogMetrics(): Promise<void> {
    try {
      telemetry.setPrimitiveCatalogVersions(await this.repository.catalogVersionCounts());
    } catch {
      // Metrics refresh is derived and must never change command/query outcomes.
    }
  }

  public async list(
    actor: AuthenticatedActor,
    query: PrimitiveListQuery,
  ): Promise<PrimitiveListResponse> {
    this.assertRead(actor, 'primitive.catalog.read');
    const isAdmin = actor.user.platformRole === 'platform_admin';
    const lifecycle = isAdmin ? (query.lifecycle ?? 'published') : 'published';
    const kinds = [...new Set(query.kinds ?? [])].sort();
    const tags = [...new Set(query.tags ?? [])].sort();
    const normalizedQuery = query.query ? normalizeRetrievalQuery(query.query) : '';
    const terms = retrievalTerms(normalizedQuery).slice(0, 24);
    const limit = query.limit ?? 50;
    const filterHash = createHash('sha256')
      .update(canonicalJson({ isAdmin, kinds, lifecycle, limit, query: normalizedQuery, tags }))
      .digest('hex');
    const cursor = query.cursor ? this.decodeCursor(query.cursor, filterHash) : null;
    const page = await this.repository.list({
      cursor,
      kinds,
      lifecycle,
      limit,
      tags,
      tsquery: terms.length > 0 ? terms.join(' | ') : null,
    });
    telemetry.primitiveCatalogQueries.add(1, {
      lifecycle,
      outcome: page.items.length === 0 ? 'empty' : 'succeeded',
    });
    return {
      items: page.items,
      nextCursor: page.tail ? this.encodeCursor({ ...page.tail, filterHash }) : null,
    };
  }

  public async get(
    actor: AuthenticatedActor,
    key: string,
    version: string,
  ): Promise<PrimitiveVersionView> {
    this.assertRead(actor, 'primitive.catalog.read');
    const primitive = await this.repository.getVersion(
      key,
      version,
      actor.user.platformRole === 'platform_admin',
    );
    if (!primitive) this.notFound();
    return primitive;
  }

  public async dependencies(actor: AuthenticatedActor, key: string, version: string) {
    return (await this.get(actor, key, version)).dependencies;
  }

  public async retrieve(
    actor: AuthenticatedActor,
    input: PrimitiveRetrievalRequest,
    correlationId?: string,
  ): Promise<PrimitiveRetrievalResponse> {
    this.assertRead(actor, 'primitive.retrieval.run');
    return withSpan('primitive.retrieval', async (span) => {
      span.setAttributes({
        'primitive.index.provider_configuration': this.queryVectors.configurationId,
        'primitive.index.schema_version': 1,
        'primitive.retrieval.outcome': 'failed',
      });
      if (correlationId) span.setAttribute('worldgraph.correlation_id', correlationId);
      const result = await this.retrieveAuthorized(input);
      span.setAttributes({
        'primitive.retrieval.outcome': 'succeeded',
        'primitive.retrieval.semantic_mode': result.provider.semanticAvailable
          ? 'hybrid'
          : 'lexical_fallback',
      });
      return result;
    });
  }

  private async retrieveAuthorized(
    input: PrimitiveRetrievalRequest,
  ): Promise<PrimitiveRetrievalResponse> {
    if (input.query.length > 500) {
      throw new ApplicationError(
        'QUERY_TOO_LARGE',
        'The retrieval query exceeds 500 characters.',
        400,
      );
    }
    const normalized = normalizeRetrievalQuery(input.query);
    const terms = retrievalTerms(normalized).slice(0, 24);
    if (terms.length === 0)
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'The retrieval query has no searchable terms.',
        400,
      );
    const compatibility = input.compatibility ?? {};
    const compatibilityIssues = validateSafeJsonStructure(compatibility, '/compatibility');
    if (compatibilityIssues.length > 0) {
      throw new ApplicationError('VALIDATION_FAILED', 'The compatibility filter is invalid.', 400, {
        issues: compatibilityIssues,
      });
    }
    const kinds = [...new Set(input.kinds ?? [])];
    const tags = [...new Set(input.tags ?? [])];
    const started = performance.now();
    let fallback = false;
    let outcome = 'failed';
    let resultCount = 0;
    try {
      const semantic = await this.queryEmbedding(normalized);
      fallback = semantic.result === null;
      const snapshot = await withSpan(
        'primitive.retrieval.filter_lexical_tag_vector',
        async (span) => {
          span.setAttributes({
            'primitive.index.provider_configuration': this.queryVectors.configurationId,
            'primitive.index.schema_version': 1,
            'primitive.retrieval.outcome': 'failed',
            'primitive.retrieval.vector_input':
              semantic.result === null ? 'unavailable' : 'available',
          });
          const result = await this.repository.retrievalSnapshot({
            compatibility,
            kinds,
            model: this.queryVectors.model,
            provider: this.queryVectors.provider,
            providerConfigurationId: this.queryVectors.configurationId,
            queryVector: semantic.result?.vector ?? null,
            tags,
            terms,
            tsquery: terms.join(' | '),
          });
          span.setAttribute('primitive.retrieval.outcome', 'completed');
          return result;
        },
      );
      if (snapshot.scopeSize > 500)
        throw new ApplicationError(
          'RETRIEVAL_UNAVAILABLE',
          'The compatible catalog scope exceeds the exact ranking limit.',
          503,
          { limit: 500, reasonCode: 'CATALOG_SCOPE_LIMIT' },
        );
      const rows = snapshot.rows;
      if (rows.length === 0) {
        outcome = 'empty';
        throw new ApplicationError(
          'NO_COMPATIBLE_PRIMITIVES',
          'No compatible published primitives matched.',
          404,
        );
      }
      const semanticAvailable =
        semantic.result !== null && rows.some((row) => row.vector_similarity !== null);
      fallback = !semanticAvailable;
      const semanticState =
        semantic.result !== null && !semanticAvailable
          ? {
              degradedReason: 'INDEX_UNAVAILABLE',
              warning: {
                code: 'SEMANTIC_INDEX_UNAVAILABLE',
                message:
                  'No current compatible semantic index was available; deterministic lexical and tag ranking remains available.',
              },
            }
          : semantic;
      const ranked = await withSpan('primitive.retrieval.fusion', async (span) => {
        span.setAttributes({
          'primitive.index.schema_version': 1,
          'primitive.retrieval.fusion_strategy': 'weighted_rrf_v1',
          'primitive.retrieval.outcome': 'failed',
          'primitive.retrieval.vector_input': semanticAvailable ? 'available' : 'unavailable',
        });
        const result = rankCandidates(
          normalized,
          rows.map((row) => ({
            id: row.id,
            key: row.stable_key,
            kind: row.kind,
            lexicalScore: row.lexical_score,
            normalizedText: row.normalized_text,
            tags: row.tags,
            tagScore: row.tag_score,
            ...(row.vector_similarity === null ? {} : { vectorSimilarity: row.vector_similarity }),
            version: row.semver,
          })),
        );
        span.setAttribute('primitive.retrieval.outcome', 'completed');
        return result;
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const limited = ranked.slice(0, input.limit ?? 12);
      const results = await Promise.all(
        limited.map(async (rankedEntry, index) => {
          const row = byId.get(rankedEntry.id)!;
          return {
            dependencyClosure: await this.repository.dependencyClosure(row.id),
            index: {
              contentHash: row.content_hash.toString('hex'),
              indexSchemaVersion: 1 as const,
              lastErrorCode: row.last_error_code,
              model: row.model,
              provider: row.provider,
              providerConfigurationId: this.queryVectors.configurationId,
              status: row.retrieval_index_state,
            },
            primitive: retrievalListItem(row),
            rank: index + 1,
            reason: {
              lexicalRank: rankedEntry.lexicalRank,
              lexicalScore: rankedEntry.lexicalScore ?? null,
              matchedTags: rankedEntry.matchedTags,
              matchedTerms: rankedEntry.matchedTerms,
              score: rankedEntry.score,
              tagRank: rankedEntry.tagRank,
              tagScore: rankedEntry.tagScore ?? null,
              vectorRank: rankedEntry.vectorRank,
              vectorSimilarity: rankedEntry.vectorSimilarity ?? null,
            },
          };
        }),
      );
      resultCount = results.length;
      outcome = 'succeeded';
      return {
        normalizedQueryHash: normalizedQueryHash(normalized),
        provider: {
          configurationId: this.queryVectors.configurationId,
          degradedReason: semanticState.degradedReason,
          model: semantic.result?.model ?? null,
          name: semantic.result?.provider ?? null,
          semanticAvailable,
        },
        ranking: {
          k: 60,
          strategy: 'weighted_rrf_v1',
          weights: { lexical: 1, tag: 0.6, vector: 0.35 },
        },
        results,
        retrievalRunId: this.ids.next(),
        warnings: this.retrievalWarnings(rows, semanticState.warning, semanticAvailable),
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        'RETRIEVAL_UNAVAILABLE',
        'Primitive retrieval is temporarily unavailable.',
        503,
      );
    } finally {
      telemetry.primitiveRetrievalDuration.record(performance.now() - started, { outcome });
      telemetry.primitiveRetrievalResults.record(resultCount, { outcome });
      telemetry.primitiveRetrievals.add(1, { fallback: String(fallback), outcome });
    }
  }

  public async createDraft(
    actor: AuthenticatedActor,
    primitive: CreatePrimitiveDraftRequest,
    context: RequestCommandContext,
  ): Promise<PrimitiveDraftCommandResponse> {
    await this.assertAdmin(actor, 'primitive.draft.create', context.requestId);
    const command = buildCommand(
      {
        action: 'primitive.draft.create',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: { body: primitive, route: { key: primitive.key, version: primitive.version } },
        requestId: context.requestId,
      },
      this.ids,
    );
    const response = await this.idempotent(command, 201, async (repository) => {
      const validation = this.validated(primitive);
      let family = await repository.family(primitive.key, true);
      if (!family) {
        family = {
          displayName: primitive.displayName,
          id: this.ids.next(),
          kind: primitive.kind,
          published: false,
          versionCount: 0,
        };
        await repository.insertFamily({
          actorUserId: actor.user.id,
          displayName: primitive.displayName,
          id: family.id,
          key: primitive.key,
          kind: primitive.kind,
        });
      } else {
        this.assertFamilyCompatible(family, primitive, false);
        if (!family.published && family.displayName !== primitive.displayName)
          await repository.updateFamilyDisplay(family.id, primitive.displayName);
      }
      if (await repository.getVersion(primitive.key, primitive.version, true, true)) {
        throw new ApplicationError(
          'PRIMITIVE_VERSION_EXISTS',
          'That primitive version already exists.',
          409,
        );
      }
      const versionId = this.ids.next();
      const catalog = await repository.loadPublishedCatalog();
      const dependencyResolution = await this.resolveDraftWrites(repository, primitive, catalog);
      await repository.insertDraft({
        actorUserId: actor.user.id,
        contentHash: validation.contentHash!,
        familyId: family.id,
        id: versionId,
        parsed: parseSemver(primitive.version)!,
        primitive,
      });
      await repository.replaceDerived({
        contentHash: validation.contentHash!,
        dependencies: dependencyResolution.dependencies,
        document: buildPrimitiveIndexDocument(primitive),
        tags: primitive.tags,
        versionId,
      });
      await repository.insertAudit(
        this.audit(command, 'primitive.draft.created', versionId, 'COMMAND_APPLIED', 'succeeded', {
          contentHash: validation.contentHash,
          key: primitive.key,
          version: primitive.version,
        }),
      );
      const view = (await repository.getVersion(primitive.key, primitive.version, true))!;
      return {
        primitive: repository.toListItem(view),
        validation: this.withDependencyIssues(validation, dependencyResolution.issues),
      };
    });
    await this.refreshCatalogMetrics();
    return response;
  }

  public async updateDraft(
    actor: AuthenticatedActor,
    key: string,
    version: string,
    input: UpdatePrimitiveDraftRequest,
    context: RequestCommandContext,
  ): Promise<PrimitiveDraftCommandResponse> {
    await this.assertAdmin(actor, 'primitive.draft.update', context.requestId);
    const command = buildCommand(
      {
        action: 'primitive.draft.update',
        actorUserId: actor.user.id,
        expectedRowVersion: input.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { body: input, route: { key, version } },
        requestId: context.requestId,
      },
      this.ids,
    );
    const response = await this.idempotent(command, 200, async (repository) => {
      if (input.draft.key !== key || input.draft.version !== version) {
        throw new ApplicationError(
          'VALIDATION_FAILED',
          'Route identity and draft identity must match.',
          400,
          {
            issues: [
              {
                code: 'IDENTITY_MISMATCH',
                message: 'Stable key and version cannot change.',
                pointer: '/key',
              },
            ],
          },
        );
      }
      const validation = this.validated(input.draft);
      const current = await repository.getVersion(key, version, true, true);
      if (!current) this.notFound();
      if (current.lifecycle !== 'draft')
        throw new ApplicationError(
          'PRIMITIVE_IMMUTABLE',
          'Published primitive versions cannot be edited.',
          409,
        );
      const family = await repository.family(key, true);
      if (!family) this.notFound();
      this.assertFamilyCompatible(family, input.draft, true);
      if (!family.published && family.displayName !== input.draft.displayName)
        await repository.updateFamilyDisplay(family.id, input.draft.displayName);
      const catalog = await repository.loadPublishedCatalog();
      const dependencyResolution = await this.resolveDraftWrites(repository, input.draft, catalog);
      await repository.updateDraft({
        contentHash: validation.contentHash!,
        expectedRowVersion: input.expectedRowVersion,
        parsed: parseSemver(version)!,
        primitive: input.draft,
        versionId: current.id,
      });
      await repository.replaceDerived({
        contentHash: validation.contentHash!,
        dependencies: dependencyResolution.dependencies,
        document: buildPrimitiveIndexDocument(input.draft),
        tags: input.draft.tags,
        versionId: current.id,
      });
      await repository.insertAudit(
        this.audit(command, 'primitive.draft.updated', current.id, 'COMMAND_APPLIED', 'succeeded', {
          contentHash: validation.contentHash,
        }),
      );
      const view = (await repository.getVersion(key, version, true))!;
      return {
        primitive: repository.toListItem(view),
        validation: this.withDependencyIssues(validation, dependencyResolution.issues),
      };
    });
    await this.refreshCatalogMetrics();
    return response;
  }

  public async publishVersion(
    actor: AuthenticatedActor,
    key: string,
    version: string,
    input: PublishPrimitiveVersionRequest,
    context: RequestCommandContext,
  ): Promise<PrimitiveCommandResponse> {
    await this.assertAdmin(actor, 'primitive.version.publish', context.requestId);
    const command = buildCommand(
      {
        action: 'primitive.version.publish',
        actorUserId: actor.user.id,
        expectedRowVersion: input.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { body: input, route: { key, version } },
        requestId: context.requestId,
      },
      this.ids,
    );
    let applied = false;
    const response = await this.idempotent(command, 200, async (repository) =>
      withSpan('primitive.publication', async (span) => {
        span.setAttributes({
          'primitive.index.provider_configuration': this.indexProfile.configurationId,
          'primitive.index.schema_version': 1,
          'primitive.publication.outcome': 'failed',
          'primitive.schema.version': 1,
          'primitive.version': version,
          'worldgraph.correlation_id': command.correlationId,
        });
        const current = await repository.getVersion(key, version, true, true);
        if (!current) this.notFound();
        span.setAttribute('primitive.version.id', current.id);
        if (current.lifecycle !== 'draft')
          throw new ApplicationError('PRIMITIVE_IMMUTABLE', 'Only a draft can be published.', 409);
        const primitive = this.toDraftInput(current);
        const validation = this.validated(primitive, true);
        const dependencies = await this.resolvePublishWrites(
          repository,
          primitive,
          await repository.loadPublishedCatalog(),
        );
        await repository.replaceDerived({
          contentHash: validation.contentHash!,
          dependencies,
          document: buildPrimitiveIndexDocument(primitive),
          tags: primitive.tags,
          versionId: current.id,
        });
        await repository.publish(current.id, actor.user.id, input.expectedRowVersion);
        await repository.requestIndex(
          current.id,
          validation.contentHash!,
          this.indexProfile.configurationId,
        );
        await repository.insertAudit(
          this.audit(
            command,
            'primitive.version.published',
            current.id,
            'COMMAND_APPLIED',
            'succeeded',
            { contentHash: validation.contentHash },
          ),
        );
        applied = true;
        span.setAttribute('primitive.publication.outcome', 'published');
        return {
          primitive: repository.toListItem((await repository.getVersion(key, version, true))!),
        };
      }),
    );
    if (applied) {
      await this.publishBestEffort('PrimitiveVersionPublished', {
        actorUserId: actor.user.id,
        primitiveVersionId: response.primitive.id,
      });
      await this.publishBestEffort('PrimitiveIndexRequested', {
        actorUserId: actor.user.id,
        contentHash: response.primitive.contentHash,
        indexSchemaVersion: 1,
        primitiveVersionId: response.primitive.id,
        providerConfigurationId: this.indexProfile.configurationId,
      });
    }
    if (applied) await this.refreshCatalogMetrics();
    return response;
  }

  public async deprecateVersion(
    actor: AuthenticatedActor,
    key: string,
    version: string,
    input: DeprecatePrimitiveVersionRequest,
    context: RequestCommandContext,
  ): Promise<PrimitiveCommandResponse> {
    await this.assertAdmin(actor, 'primitive.version.deprecate', context.requestId);
    const reason = input.reason.trim().normalize('NFC');
    const command = buildCommand(
      {
        action: 'primitive.version.deprecate',
        actorUserId: actor.user.id,
        expectedRowVersion: input.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { body: { ...input, reason }, route: { key, version } },
        requestId: context.requestId,
      },
      this.ids,
    );
    let applied = false;
    const response = await this.idempotent(command, 200, async (repository) => {
      if (reason.length < 10 || reason.length > 500 || hasForbiddenControl(reason)) {
        throw new ApplicationError('VALIDATION_FAILED', 'The deprecation reason is invalid.', 400, {
          issues: [
            {
              code: 'DEPRECATION_REASON_INVALID',
              message: 'Use 10–500 printable characters.',
              pointer: '/reason',
            },
          ],
        });
      }
      const current = await repository.getVersion(key, version, true, true);
      if (!current) this.notFound();
      if (current.lifecycle !== 'published')
        throw new ApplicationError(
          'PRIMITIVE_IMMUTABLE',
          'Only a published version can be deprecated.',
          409,
        );
      await repository.deprecate(current.id, actor.user.id, input.expectedRowVersion, reason);
      await repository.insertAudit(
        this.audit(
          command,
          'primitive.version.deprecated',
          current.id,
          'COMMAND_APPLIED',
          'succeeded',
        ),
      );
      applied = true;
      return {
        primitive: repository.toListItem((await repository.getVersion(key, version, true))!),
      };
    });
    if (applied)
      await this.publishBestEffort('PrimitiveVersionDeprecated', {
        actorUserId: actor.user.id,
        primitiveVersionId: response.primitive.id,
      });
    if (applied) await this.refreshCatalogMetrics();
    return response;
  }

  public async reindexVersion(
    actor: AuthenticatedActor,
    key: string,
    version: string,
    input: ReindexPrimitiveVersionRequest,
    context: RequestCommandContext,
  ): Promise<PrimitiveReindexResponse> {
    await this.assertAdmin(actor, 'primitive.version.reindex', context.requestId);
    const command = buildCommand(
      {
        action: 'primitive.version.reindex',
        actorUserId: actor.user.id,
        expectedRowVersion: input.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { body: input, route: { key, version } },
        requestId: context.requestId,
      },
      this.ids,
    );
    let applied = false;
    const response = await this.idempotent(command, 202, async (repository) => {
      const current = await repository.getVersion(key, version, true, true);
      if (!current) this.notFound();
      if (current.lifecycle === 'draft')
        throw new ApplicationError(
          'PRIMITIVE_NOT_PUBLISHED',
          'Draft versions cannot be reindexed.',
          409,
        );
      if (current.rowVersion !== input.expectedRowVersion)
        throw new ApplicationError('STALE_VERSION', 'The primitive version has changed.', 409);
      await repository.requestIndex(
        current.id,
        current.contentHash,
        this.indexProfile.configurationId,
      );
      await repository.insertAudit(
        this.audit(
          command,
          'primitive.version.reindex_requested',
          current.id,
          'COMMAND_APPLIED',
          'succeeded',
          { contentHash: current.contentHash },
        ),
      );
      applied = true;
      const index: PrimitiveIndexProvenance = {
        contentHash: current.contentHash,
        indexSchemaVersion: 1,
        lastErrorCode: null,
        model: this.indexProfile.model,
        provider: this.indexProfile.provider,
        providerConfigurationId: this.indexProfile.configurationId,
        status: 'pending',
      };
      return { index, primitiveVersionId: current.id };
    });
    if (applied)
      await this.publishBestEffort('PrimitiveIndexRequested', {
        actorUserId: actor.user.id,
        contentHash: response.index.contentHash,
        indexSchemaVersion: 1,
        primitiveVersionId: response.primitiveVersionId,
        providerConfigurationId: response.index.providerConfigurationId ?? 'disabled-v1',
      });
    return response;
  }

  private validated(primitive: PrimitiveDraftInput, publishing = false) {
    return withSpanSync('primitive.validation', (span) => {
      span.setAttributes({
        'primitive.schema.version': primitive.primitiveSchemaVersion,
        'primitive.version': primitive.version,
        'primitive.validation.mode': publishing ? 'publication' : 'draft',
        'primitive.validation.outcome': 'invalid',
      });
      const validation = validatePrimitive(primitive);
      if (!validation.valid) {
        if (publishing) {
          for (const issue of validation.issues)
            telemetry.primitivePublishValidationFailures.add(1, { code: issue.code });
        }
        throw new ApplicationError(
          'VALIDATION_FAILED',
          'The primitive definition is invalid.',
          400,
          { issues: validation.issues },
        );
      }
      span.setAttribute('primitive.validation.outcome', 'valid');
      return validation;
    });
  }

  private dependencyIssues(
    primitive: PrimitiveDraftInput,
    resolution: ReturnType<typeof resolveDependencies>,
  ) {
    return resolution.issues.slice(0, 128).map((entry) => {
      const directKey = entry.path[1] ?? entry.key;
      const index = primitive.dependencies.findIndex((dependency) => dependency.key === directKey);
      return {
        code: entry.code,
        message: `Dependency ${entry.key} does not resolve safely.`,
        pointer: index >= 0 ? `/dependencies/${index}/versionRange` : '/dependencies',
      };
    });
  }

  private async resolveDraftWrites(
    repository: PrimitiveRepository,
    primitive: PrimitiveDraftInput,
    catalog: readonly PublishedCatalogEntry[],
    mode: 'draft' | 'publication' = 'draft',
  ): Promise<{
    dependencies: ResolvedDependencyWrite[];
    issues: ReturnType<PrimitiveService['dependencyIssues']>;
  }> {
    return withSpan('primitive.dependency.resolve', async (span) => {
      span.setAttributes({
        'primitive.dependency.mode': mode,
        'primitive.dependency.outcome': 'failed',
        'primitive.schema.version': primitive.primitiveSchemaVersion,
        'primitive.version': primitive.version,
      });
      const resolution = resolveDependencies(primitive.key, primitive.dependencies, catalog);
      const direct = new Map(resolution.resolved.map((entry) => [entry.key, entry]));
      const dependencies: ResolvedDependencyWrite[] = [];
      for (const [index, dependency] of primitive.dependencies.entries()) {
        const family = await repository.family(dependency.key);
        if (!family)
          throw new ApplicationError(
            'VALIDATION_FAILED',
            'A dependency family does not exist.',
            400,
            {
              issues: [
                {
                  code: 'DEPENDENCY_NOT_FOUND',
                  message: `Dependency ${dependency.key} does not exist.`,
                  pointer: `/dependencies/${index}/key`,
                },
              ],
            },
          );
        const resolved = direct.get(dependency.key);
        const target = catalog.find((entry) => entry.versionId === resolved?.resolvedVersionId);
        dependencies.push({
          dependencyFamilyId: family.id,
          parameterMapping: dependency.parameterMapping ?? {},
          required: dependency.required ?? true,
          resolvedContentHash: target ? (resolved?.contentHash ?? null) : null,
          resolvedVersionId: target ? (resolved?.resolvedVersionId ?? null) : null,
          versionRange: dependency.versionRange,
        });
      }
      const issues = this.dependencyIssues(primitive, resolution);
      span.setAttribute(
        'primitive.dependency.outcome',
        issues.length === 0 ? 'resolved' : 'resolved_with_issues',
      );
      return { dependencies, issues };
    });
  }

  private async resolvePublishWrites(
    repository: PrimitiveRepository,
    primitive: PrimitiveDraftInput,
    catalog: readonly PublishedCatalogEntry[],
  ): Promise<ResolvedDependencyWrite[]> {
    const draft = await this.resolveDraftWrites(repository, primitive, catalog, 'publication');
    if (draft.issues.length > 0) {
      for (const issue of draft.issues)
        telemetry.primitivePublishValidationFailures.add(1, { code: issue.code });
      throw new ApplicationError('VALIDATION_FAILED', 'Primitive dependencies are invalid.', 400, {
        issues: draft.issues,
      });
    }
    return draft.dependencies;
  }

  private withDependencyIssues(
    validation: ReturnType<typeof validatePrimitive>,
    issues: ReturnType<PrimitiveService['dependencyIssues']>,
  ) {
    return issues.length === 0
      ? validation
      : {
          ...validation,
          issues: [...validation.issues, ...issues].slice(0, 128),
          valid: false,
        };
  }

  private retrievalWarnings(
    rows: readonly {
      retrieval_index_state: PrimitiveIndexState;
      vector_similarity: number | null;
    }[],
    base: { code: string; message: string } | null,
    semanticAvailable: boolean,
  ): { code: string; message: string }[] {
    const warnings = new Map<string, string>();
    if (base) warnings.set(base.code, base.message);
    const states = new Set(rows.map((row) => row.retrieval_index_state));
    if (states.has('dead'))
      warnings.set(
        'SEMANTIC_INDEX_DEAD',
        'One or more semantic indexes exhausted bounded retries.',
      );
    if (states.has('stale'))
      warnings.set(
        'SEMANTIC_INDEX_STALE',
        'One or more semantic indexes do not match current primitive content.',
      );
    if (states.has('failed'))
      warnings.set(
        'SEMANTIC_INDEX_FAILED',
        'One or more semantic indexes are awaiting a bounded retry.',
      );
    if (semanticAvailable && rows.some((row) => row.vector_similarity === null)) {
      warnings.set(
        'SEMANTIC_INDEX_PARTIAL',
        'Semantic ranking was available for only part of the compatible catalog.',
      );
    }
    return [...warnings].slice(0, 16).map(([code, message]) => ({ code, message }));
  }

  private assertFamilyCompatible(
    family: { displayName: string; kind: PrimitiveKind; published: boolean; versionCount: number },
    primitive: PrimitiveDraftInput,
    allowOnlyDraftRename: boolean,
  ): void {
    const displayConflict =
      family.displayName !== primitive.displayName &&
      (family.published || !allowOnlyDraftRename || family.versionCount > 1);
    if (family.kind !== primitive.kind || displayConflict) {
      throw new ApplicationError(
        'PRIMITIVE_FAMILY_CONFLICT',
        'The stable primitive family identity conflicts with this draft.',
        409,
      );
    }
  }

  private assertRead(
    actor: AuthenticatedActor,
    action: 'primitive.catalog.read' | 'primitive.retrieval.run',
  ): void {
    const decision = evaluateAuthority(
      { platformRole: actor.user.platformRole, userId: actor.user.id },
      action,
      {},
    );
    if (!decision.allowed)
      throw new ApplicationError('FORBIDDEN', 'This action is not permitted.', 403);
  }

  private async assertAdmin(
    actor: AuthenticatedActor,
    action: Exclude<AuthorityAction, 'primitive.catalog.read' | 'primitive.retrieval.run'>,
    requestId: string,
  ): Promise<void> {
    const decision = evaluateAuthority(
      { platformRole: actor.user.platformRole, userId: actor.user.id },
      action,
      {},
    );
    telemetry.authorizationDecisions.add(1, {
      action,
      outcome: decision.allowed ? 'allowed' : 'denied',
    });
    if (decision.allowed) return;
    await this.repository.insertAudit({
      action,
      actorUserId: actor.user.id,
      correlationId: requestId,
      id: this.ids.next(),
      metadata: { authorityReasonCode: decision.reasonCode, authorityRuleId: decision.ruleId },
      outcome: 'denied',
      reasonCode: decision.reasonCode,
      requestId,
    });
    throw new ApplicationError('FORBIDDEN', 'Platform administrator authority is required.', 403, {
      reasonCode: decision.reasonCode,
      ruleId: decision.ruleId,
    });
  }

  private async idempotent<T extends Record<string, unknown>>(
    command: ReturnType<typeof buildCommand>,
    status: number,
    operation: (repository: PrimitiveRepository) => Promise<T>,
  ): Promise<T> {
    try {
      return await withSpan('primitive.command.transaction', async (span) => {
        span.setAttributes({
          'primitive.command.action': command.action,
          'primitive.command.outcome': 'failed',
          'primitive.command.schema_version': command.schemaVersion,
          'worldgraph.correlation_id': command.correlationId,
        });
        return this.repository.transaction(async (repository) => {
          const identity = {
            actorId: command.actorUserId,
            expiresAt: new Date(this.clock.now().getTime() + 86_400_000),
            key: command.idempotencyKey,
            requestHash: command.requestHashBytes,
            scope: command.action,
          };
          const started = await repository.beginIdempotency(identity);
          if (started.kind === 'replay') {
            span.setAttribute('primitive.command.outcome', 'replayed');
            return started.body as T;
          }
          const body = await operation(repository);
          if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 60 * 1024)
            throw new Error('Primitive command response exceeds the idempotency storage budget.');
          await repository.completeIdempotency({ ...identity, body, status });
          span.setAttribute('primitive.command.outcome', 'applied');
          return body;
        });
      });
    } catch (error) {
      await this.auditCommandFailure(command, error);
      throw error;
    }
  }

  private async auditCommandFailure(
    command: ReturnType<typeof buildCommand>,
    error: unknown,
  ): Promise<void> {
    const candidate = error instanceof ApplicationError ? error.code : 'UNEXPECTED_FAILURE';
    const reasonCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(candidate) ? candidate : 'UNEXPECTED_FAILURE';
    try {
      await this.repository.insertAudit({
        action: command.action,
        actorUserId: command.actorUserId,
        correlationId: command.correlationId,
        id: this.ids.next(),
        metadata: {
          action: command.action,
          ...(command.expectedRowVersion === undefined
            ? {}
            : { expectedRowVersion: command.expectedRowVersion }),
          requestHash: command.requestHash,
        },
        outcome: 'failed',
        reasonCode,
        requestId: command.requestId,
      });
      telemetry.primitiveMutationFailures.add(1, {
        action: command.action,
        reason_code: reasonCode,
      });
    } catch {
      telemetry.primitiveCommandAuditWriteFailures.add(1, { action: command.action });
    }
  }

  private audit(
    command: ReturnType<typeof buildCommand>,
    action: string,
    targetId: string,
    reasonCode: string,
    outcome: 'allowed' | 'denied' | 'succeeded' | 'failed',
    metadata: Record<string, unknown> = {},
  ) {
    return {
      action,
      actorUserId: command.actorUserId,
      correlationId: command.correlationId,
      id: this.ids.next(),
      metadata,
      outcome,
      reasonCode,
      requestId: command.requestId,
      targetId,
    };
  }

  private toDraftInput(view: PrimitiveVersionView): PrimitiveDraftInput {
    return {
      behaviorRef: view.behaviorRef,
      compatibility: view.compatibility,
      defaults: view.defaults,
      dependencies: view.dependencies.map((dependency): PrimitiveDependencyInput => ({
        key: dependency.key,
        parameterMapping: dependency.parameterMapping,
        required: dependency.required,
        versionRange: dependency.versionRange,
      })),
      displayName: view.displayName,
      documentation: view.documentation,
      key: view.key,
      kind: view.kind,
      parameterSchema: view.parameterSchema,
      primitiveSchemaVersion: 1,
      provenance: view.provenance,
      tags: view.tags,
      version: view.version,
      visualHints: view.visualHints,
    };
  }

  private encodeCursor(payload: CursorPayload): string {
    const serialized = canonicalJson(payload);
    const signature = createHmac('sha256', this.cursorSecret)
      .update(CURSOR_MAC_DOMAIN)
      .update(serialized)
      .digest('hex');
    return Buffer.from(canonicalJson({ payload, signature }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string, filterHash: string): PrimitiveCursorTuple {
    try {
      const encodedCursor = Buffer.from(cursor, 'base64url');
      if (encodedCursor.toString('base64url') !== cursor) throw new Error('invalid');
      const decoded = JSON.parse(encodedCursor.toString('utf8')) as {
        payload?: CursorPayload;
        signature?: string;
      };
      const payload = decoded.payload;
      if (
        !payload ||
        typeof decoded.signature !== 'string' ||
        decoded.signature.length !== 64 ||
        payload.filterHash !== filterHash ||
        ![payload.id, payload.key, payload.sortKey, payload.version].every(
          (value) => typeof value === 'string',
        )
      )
        throw new Error('invalid');
      const expected = createHmac('sha256', this.cursorSecret)
        .update(CURSOR_MAC_DOMAIN)
        .update(canonicalJson(payload))
        .digest();
      const actual = Buffer.from(decoded.signature, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error('invalid');
      return {
        id: payload.id,
        key: payload.key,
        sortKey: payload.sortKey,
        version: payload.version,
      };
    } catch {
      throw new ApplicationError(
        'INVALID_CURSOR',
        'The pagination cursor is invalid for these filters.',
        400,
      );
    }
  }

  private async publishBestEffort<
    T extends Extract<
      ApplicationNotification,
      {
        type:
          'PrimitiveVersionPublished' | 'PrimitiveVersionDeprecated' | 'PrimitiveIndexRequested';
      }
    >['type'],
  >(type: T, payload: Extract<ApplicationNotification, { type: T }>['payload']): Promise<void> {
    try {
      await this.notifications.publish({
        id: this.ids.next(),
        occurredAt: this.clock.now().toISOString(),
        payload,
        schemaVersion: 1,
        type,
      } as Extract<ApplicationNotification, { type: T }>);
      telemetry.primitiveNotifications.add(1, { outcome: 'published', type });
    } catch {
      telemetry.primitiveNotifications.add(1, { outcome: 'failed', type });
    }
  }

  private async queryEmbedding(normalizedText: string): Promise<{
    degradedReason: string | null;
    result: { model: string; provider: string; vector: number[] } | null;
    warning: { code: string; message: string } | null;
  }> {
    return withSpan('primitive.retrieval.local_vectorization', async (span) => {
      span.setAttributes({
        'primitive.index.provider_configuration': this.queryVectors.configurationId,
        'primitive.index.schema_version': 1,
        'primitive.vectorization.execution': 'local',
        'primitive.vectorization.outcome': 'failed',
      });
      if (!this.queryVectors.enabled) {
        span.setAttribute('primitive.vectorization.outcome', 'disabled');
        return {
          degradedReason: 'PROVIDER_DISABLED',
          result: null,
          warning: {
            code: 'SEMANTIC_PROVIDER_DISABLED',
            message:
              'Semantic ranking is disabled; deterministic lexical and tag ranking remains available.',
          },
        };
      }
      const controller = new AbortController();
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('QUERY_VECTOR_TIMEOUT'));
        }, this.queryVectorTimeoutMs);
        timeout.unref();
      });
      try {
        const vector = [
          ...(await Promise.race([
            this.queryVectors.vectorize(normalizedText, controller.signal),
            deadline,
          ])),
        ];
        const result = assertEmbedding({
          dimensions: 1536,
          latencyMs: 0,
          model: this.queryVectors.model ?? 'local-query-vector',
          provider: this.queryVectors.provider ?? 'local',
          tokenEstimate: null,
          vector,
        });
        span.setAttribute('primitive.vectorization.outcome', 'completed');
        return {
          degradedReason: null,
          result: { model: result.model, provider: result.provider, vector: result.vector },
          warning: null,
        };
      } catch {
        const code = timedOut ? 'QUERY_VECTOR_TIMEOUT' : 'QUERY_VECTOR_FAILED';
        span.setAttribute('primitive.vectorization.outcome', timedOut ? 'timed_out' : 'failed');
        return {
          degradedReason: code,
          result: null,
          warning: {
            code: `SEMANTIC_${code}`,
            message:
              'Semantic ranking is unavailable; deterministic lexical and tag ranking remains available.',
          },
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
  }

  private notFound(): never {
    throw new ApplicationError('NOT_FOUND', 'The primitive version was not found.', 404);
  }
}
