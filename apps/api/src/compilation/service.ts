import { createHmac, timingSafeEqual } from 'node:crypto';

import type { RuntimeConfig } from '@worldgraph/config';
import {
  createCompilerInputBundle,
  createGovernanceCompilerInputBundle,
  createPreviousCompilerInputBundle,
  createRetainedCompilerInputBundle,
  memberPrincipalKey,
  verifyCompiledArtifact,
} from '@worldgraph/compiler';
import {
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  GOVERNANCE_COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILER_VERSION,
  canonicalJson,
  type ApplicationNotification,
  type AuthorityAction,
  type Clock,
  type CompiledArtifact,
  type CompilerDiagnosticV1,
  type IdGenerator,
  type PrimitiveDraftInput,
  type PreviousCompilerInputBundleV1,
  type RetainedCompilerInputBundleV1,
  type CompilerInputBundleV1,
  type GovernanceCompilerInputBundleV1,
  type RuntimeRevisionMetadata,
  type RuntimeSummaryView,
  type StartWorldCompilationRequest,
  type StartWorldCompilationResponse,
  type WorldManifestV1,
  type WorldCompilationRunView,
  type WorldEntityListQuery,
  type WorldEntityListResponse,
  type WorldEntityDetailResponse,
  type WorldEntityType,
  type WorldEntityView,
  type WorldNeighborQuery,
  type WorldNeighborResponse,
  type WorldRelationshipListQuery,
  type WorldRelationshipListResponse,
  type WorldRelationshipType,
  type WorldRelationshipView,
} from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';

import { buildCommand } from '../application/command.js';
import { ApplicationError } from '../application/errors.js';
import type { NotificationSink } from '../application/notifications.js';
import { evaluateAuthority } from '../authority/evaluator.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type { ManifestCommandContext } from '../manifests/service.js';
import type {
  CompilationCommandIdentity,
  CompilationPrimitiveRecord,
  CompilationRepository,
  CompilationRunRecord,
  CompilationWorldAccess,
} from './repository.js';

interface CursorPayload {
  filterHash: string;
  key: string;
  kind: 'entity' | 'neighbor' | 'relationship';
  worldId: string;
}

type RunnableCompilerVersion =
  | typeof RETAINED_COMPILER_VERSION
  | typeof PREVIOUS_COMPILER_VERSION
  | typeof GOVERNANCE_COMPILER_VERSION
  | typeof COMPILER_VERSION;

/**
 * Manifest V1 is shared across sealed compiler lanes. Governance V1 natively
 * requires compiler 1.4/artifact 5 (exact 1.3/artifact 4 remains executable);
 * economy V2 without governance stays on 1.2/artifact 3; absent/economy-V1
 * manifests remain reproducible on the retained 1.1/artifact 2 lane.
 */
export function compilerVersionForManifest(manifest: WorldManifestV1): RunnableCompilerVersion {
  const governance = manifest.extensions['worldgraph.governance'];
  if (
    governance !== null &&
    typeof governance === 'object' &&
    !Array.isArray(governance) &&
    governance.schemaVersion === 1
  ) {
    return COMPILER_VERSION;
  }
  const economy = manifest.extensions['worldgraph.economy'];
  return economy !== null &&
    typeof economy === 'object' &&
    !Array.isArray(economy) &&
    economy.schemaVersion === 2
    ? PREVIOUS_COMPILER_VERSION
    : RETAINED_COMPILER_VERSION;
}

function primitiveDefinition(primitive: CompilationPrimitiveRecord): PrimitiveDraftInput {
  return {
    behaviorRef: primitive.behaviorRef,
    compatibility: primitive.compatibility,
    defaults: primitive.defaults,
    dependencies: primitive.dependencies.map((dependency) => ({
      key: dependency.familyKey,
      parameterMapping: dependency.parameterMapping,
      required: dependency.required,
      versionRange: dependency.versionRange,
    })),
    displayName: primitive.displayName,
    documentation: primitive.documentation,
    key: primitive.key,
    kind: primitive.kind as PrimitiveDraftInput['kind'],
    parameterSchema: primitive.parameterSchema,
    primitiveSchemaVersion: primitive.primitiveSchemaVersion as 1,
    provenance: primitive.provenance,
    tags: primitive.tags,
    version: primitive.version,
    visualHints: primitive.visualHints,
  };
}

function runView(run: CompilationRunRecord): WorldCompilationRunView {
  return {
    artifactHash: run.artifactHash,
    completedAt: run.completedAt?.toISOString() ?? null,
    compilerConfigVersion: run.compilerConfigVersion as 1,
    compilerVersion: run.compilerVersion as WorldCompilationRunView['compilerVersion'],
    diagnostics: run.diagnostics as CompilerDiagnosticV1[],
    id: run.id,
    inputHash: run.inputHash,
    manifestRevisionId: run.manifestRevisionId,
    progressPercent: run.progressPercent,
    queuedAt: run.queuedAt.toISOString(),
    requestedByUserId: run.requestedByUserId,
    rowVersion: run.rowVersion,
    seed: run.seed,
    stage: run.stage,
    startedAt: run.startedAt?.toISOString() ?? null,
    status: run.status,
    worldId: run.worldId,
  };
}

function entityView(row: Record<string, unknown>): WorldEntityView {
  return {
    createdWorldVersionId: row.created_world_version_id as string,
    entitySchemaVersion: row.entity_schema_version as 1,
    entityType: row.entity_type as WorldEntityType,
    logicalKey: row.logical_key as string,
    retiredWorldVersionId: (row.retired_world_version_id as string | null) ?? null,
    rowVersion: Number(row.row_version),
    state: row.state as WorldEntityView['state'],
    worldId: row.world_id as string,
  };
}

function relationshipView(row: Record<string, unknown>): WorldRelationshipView {
  return {
    attributes: row.attributes as WorldRelationshipView['attributes'],
    createdWorldVersionId: row.created_world_version_id as string,
    logicalKey: row.logical_key as string,
    relationshipSchemaVersion: row.relationship_schema_version as 1,
    relationshipType: row.relationship_type as WorldRelationshipType,
    retiredWorldVersionId: (row.retired_world_version_id as string | null) ?? null,
    rowVersion: Number(row.row_version),
    sourceLogicalKey: row.source_logical_key as string,
    targetLogicalKey: row.target_logical_key as string,
    worldId: row.world_id as string,
  };
}

function runtimeMetadata(row: Record<string, unknown>): RuntimeRevisionMetadata {
  return {
    activeWorldVersionId: row.active_world_version_id as string,
    stateRevision: Number(row.state_revision),
    worldVersionNumber: Number(row.version_number),
  };
}

export class CompilationService {
  public constructor(
    private readonly repository: CompilationRepository,
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly notifications: NotificationSink,
    private readonly cursorSecret: string,
  ) {}

  public async start(
    actor: AuthenticatedActor,
    worldId: string,
    payload: StartWorldCompilationRequest,
    context: ManifestCommandContext,
  ): Promise<StartWorldCompilationResponse> {
    if (!(this.config.compilerEnabled ?? true)) {
      throw new ApplicationError('COMPILER_DISABLED', 'World compilation is not enabled.', 503);
    }
    await this.authorize(this.repository, actor, worldId, 'world.compilation.start', false);
    const command = buildCommand(
      {
        action: 'world.compilation.start',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload,
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    const runId = this.ids.next();
    const enqueued: { value: CompilationRunRecord | null } = { value: null };
    const body = await this.idempotent(command, 202, async (repository) => {
      await repository.lockWorldCompilation(worldId);
      const world = await this.authorize(
        repository,
        actor,
        worldId,
        'world.compilation.start',
        true,
      );
      this.assertWorldCanCompile(world);
      if (world.currentApprovedManifestRevisionId !== payload.manifestRevisionId) {
        throw new ApplicationError(
          'MANIFEST_NOT_CURRENT',
          'The requested manifest is not the current approved revision.',
          409,
        );
      }
      const manifest = await repository.approvedManifest(worldId, payload.manifestRevisionId, true);
      if (
        !manifest ||
        manifest.approvalStatus !== 'approved' ||
        manifest.contentHash !== payload.expectedManifestHash
      ) {
        throw new ApplicationError(
          'MANIFEST_NOT_CURRENT',
          'The approved manifest hash or revision has changed.',
          409,
        );
      }
      const compilerVersion = compilerVersionForManifest(manifest.manifest);
      const bundle = await this.inputBundle(
        repository,
        worldId,
        manifest.manifest,
        payload.seed,
        compilerVersion,
      );
      if (bundle.manifestContentHash !== manifest.contentHash) {
        throw new ApplicationError(
          'MANIFEST_HASH_MISMATCH',
          'The stored manifest bytes do not match the approved content hash.',
          409,
        );
      }
      const existing = await repository.findRunByInput({
        compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
        compilerVersion,
        inputHash: bundle.inputHash,
        seed: payload.seed,
        worldId,
      });
      if (existing) {
        if (existing.status === 'queued' || existing.status === 'running') {
          return this.startResponse(existing);
        }
        throw new ApplicationError(
          existing.status === 'failed' ? 'COMPILATION_RETRY_REQUIRED' : 'COMPILATION_CONFLICT',
          existing.status === 'failed'
            ? 'Retry the existing failed compilation run.'
            : 'This exact compilation input already has a terminal run.',
          409,
          { runId: existing.id },
        );
      }
      enqueued.value = await repository.createRun({
        actorUserId: actor.user.id,
        compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
        compilerVersion,
        idempotencyKey: context.idempotencyKey,
        inputHash: bundle.inputHash,
        manifestContentHash: manifest.contentHash,
        manifestRevisionId: manifest.revisionId,
        runId,
        seed: payload.seed,
        worldId,
      });
      await repository.markWorldCompiling(worldId, world.rowVersion);
      await this.audit(repository, command, world, 'world.compilation.requested', runId);
      return this.startResponse(enqueued.value);
    });
    const requested = enqueued.value;
    if (requested) {
      await this.publishSafely('WorldCompilationRequested', {
        actorUserId: actor.user.id,
        compilerVersion: this.runnableCompilerVersion(requested.compilerVersion),
        inputHash: requested.inputHash,
        manifestRevisionId: requested.manifestRevisionId,
        runId: requested.id,
        worldId,
      });
      telemetry.worldCompilationRuns.add(1, { outcome: 'queued' });
    }
    return body as StartWorldCompilationResponse;
  }

  public async get(
    actor: AuthenticatedActor,
    worldId: string,
    runId: string,
  ): Promise<WorldCompilationRunView> {
    await this.authorize(this.repository, actor, worldId, 'world.compilation.read', false);
    const run = await this.repository.getRun(worldId, runId);
    if (!run) this.notFound();
    return runView(run);
  }

  public async current(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<WorldCompilationRunView> {
    await this.authorize(this.repository, actor, worldId, 'world.compilation.read', false);
    const run = await this.repository.currentRun(worldId);
    if (!run) this.notFound();
    return runView(run);
  }

  public async artifact(
    actor: AuthenticatedActor,
    worldId: string,
    runId: string,
  ): Promise<CompiledArtifact> {
    await this.authorize(this.repository, actor, worldId, 'world.compilation.read', false);
    const row = await this.repository.compiledArtifact(worldId, runId);
    if (!row) this.notFound();
    const artifact = {
      artifactKind: 'compiled_world',
      artifactSchemaVersion: row.artifact_schema_version,
      canonicalBytes: canonicalJson(row.canonical_content),
      contentHash: row.content_hash,
      inputHash: row.input_hash,
      world: row.canonical_content,
    };
    if (!verifyCompiledArtifact(artifact).valid) {
      telemetry.worldCompilationRuns.add(1, { outcome: 'artifact_hash_mismatch' });
      throw new ApplicationError(
        'ARTIFACT_CORRUPT',
        'The compiled artifact failed integrity verification.',
        500,
      );
    }
    return artifact as CompiledArtifact;
  }

  public async cancel(
    actor: AuthenticatedActor,
    worldId: string,
    runId: string,
    expectedRowVersion: number,
    context: ManifestCommandContext,
  ): Promise<WorldCompilationRunView> {
    const command = buildCommand(
      {
        action: 'world.compilation.cancel',
        actorUserId: actor.user.id,
        expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { runId },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    const body = await this.idempotent(command, 200, async (repository) => {
      await repository.lockWorldCompilation(worldId);
      const world = await this.authorize(
        repository,
        actor,
        worldId,
        'world.compilation.cancel',
        true,
      );
      const current = await repository.getRun(worldId, runId, true);
      if (!current) this.notFound();
      if (current.status === 'cancelled') return runView(current);
      if (current.stage === 'seeding' || current.status === 'succeeded') {
        throw new ApplicationError(
          'COMPILATION_CANCELLATION_TOO_LATE',
          'Compilation cannot be cancelled after seeding begins.',
          409,
        );
      }
      const cancelled = await repository.cancelRun(worldId, runId, expectedRowVersion);
      if (!cancelled) {
        throw new ApplicationError('STALE_VERSION', 'The compilation run has changed.', 409);
      }
      await repository.restoreWorldAfterCancellation(worldId);
      await this.audit(repository, command, world, 'world.compilation.cancelled', runId);
      return runView(cancelled);
    });
    telemetry.worldCompilationRuns.add(1, { outcome: 'cancelled' });
    return body as WorldCompilationRunView;
  }

  public async retry(
    actor: AuthenticatedActor,
    worldId: string,
    runId: string,
    expectedRowVersion: number,
    context: ManifestCommandContext,
  ): Promise<StartWorldCompilationResponse> {
    if (!(this.config.compilerEnabled ?? true)) {
      throw new ApplicationError('COMPILER_DISABLED', 'World compilation is not enabled.', 503);
    }
    const command = buildCommand(
      {
        action: 'world.compilation.retry',
        actorUserId: actor.user.id,
        expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { runId },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    const queued: { value: CompilationRunRecord | null } = { value: null };
    const body = await this.idempotent(command, 202, async (repository) => {
      await repository.lockWorldCompilation(worldId);
      const world = await this.authorize(
        repository,
        actor,
        worldId,
        'world.compilation.retry',
        true,
      );
      this.assertWorldCanCompile(world);
      const current = await repository.getRun(worldId, runId, true);
      if (!current) this.notFound();
      if (current.status !== 'failed' || !this.isRetryable(current)) {
        throw new ApplicationError(
          'COMPILATION_NOT_RETRYABLE',
          'The compilation failure is not safely retryable.',
          409,
        );
      }
      if (world.currentApprovedManifestRevisionId !== current.manifestRevisionId) {
        throw new ApplicationError(
          'MANIFEST_NOT_CURRENT',
          'The approved manifest changed after this run failed.',
          409,
        );
      }
      const manifest = await repository.approvedManifest(worldId, current.manifestRevisionId, true);
      if (!manifest || manifest.contentHash !== current.manifestContentHash) {
        throw new ApplicationError(
          'MANIFEST_NOT_CURRENT',
          'The approved manifest changed after this run failed.',
          409,
        );
      }
      const compilerVersion = this.runnableCompilerVersion(current.compilerVersion);
      if (compilerVersionForManifest(manifest.manifest) !== compilerVersion) {
        throw new ApplicationError(
          'COMPILER_VERSION_MISMATCH',
          'The manifest compiler lane does not match the failed compilation run.',
          409,
        );
      }
      const bundle = await this.inputBundle(
        repository,
        worldId,
        manifest.manifest,
        current.seed,
        compilerVersion,
      );
      if (bundle.inputHash !== current.inputHash) {
        throw new ApplicationError(
          'COMPILATION_INPUT_CHANGED',
          'The exact primitive or membership input changed; start a new compilation.',
          409,
        );
      }
      queued.value = await repository.retryRun(worldId, runId, expectedRowVersion);
      if (!queued.value) {
        throw new ApplicationError('STALE_VERSION', 'The compilation run has changed.', 409);
      }
      await repository.markWorldCompiling(worldId, world.rowVersion);
      await this.audit(repository, command, world, 'world.compilation.retried', runId);
      return this.startResponse(queued.value);
    });
    const requested = queued.value;
    if (requested) {
      await this.publishSafely('WorldCompilationRequested', {
        actorUserId: actor.user.id,
        compilerVersion: this.runnableCompilerVersion(requested.compilerVersion),
        inputHash: requested.inputHash,
        manifestRevisionId: requested.manifestRevisionId,
        runId: requested.id,
        worldId,
      });
      telemetry.worldCompilationRuns.add(1, { outcome: 'retried' });
    }
    return body as StartWorldCompilationResponse;
  }

  public async runtimeSummary(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<RuntimeSummaryView> {
    await this.authorize(this.repository, actor, worldId, 'world.runtime.read', false);
    const row = await this.repository.runtimeSummary(worldId);
    if (!row) {
      throw new ApplicationError('WORLD_NOT_ACTIVE', 'The world is not active.', 409);
    }
    return {
      ...runtimeMetadata(row),
      activatedAt: (row.activated_at as Date).toISOString(),
      artifactHash: row.artifact_hash as string,
      compilerConfigVersion: row.compiler_config_version as 1,
      compilerVersion: row.compiler_version as WorldCompilationRunView['compilerVersion'],
      controllerCount: Number(row.controller_count),
      entityCount: Number(row.entity_count),
      lastLedgerSequence: Number(row.last_ledger_sequence),
      lifecycle: 'active',
      manifestContentHash: row.manifest_hash as string,
      manifestRevisionId: row.manifest_revision_id as string,
      manifestSchemaVersion: row.manifest_schema_version as 1,
      relationshipCount: Number(row.relationship_count),
      seed: row.seed as string,
      worldGraphSchemaVersion: row.world_schema_version as 1,
      worldId,
    };
  }

  public async listEntities(
    actor: AuthenticatedActor,
    worldId: string,
    query: WorldEntityListQuery,
  ): Promise<WorldEntityListResponse> {
    await this.authorize(this.repository, actor, worldId, 'world.runtime.read', false);
    const limit = Number(query.limit ?? 50);
    const filterHash = this.filterHash({
      entityType: query.entityType ?? null,
      query: query.query ?? null,
    });
    const after = query.cursor
      ? this.decodeCursor(query.cursor, worldId, 'entity', filterHash).key
      : undefined;
    const [rows, metadata] = await Promise.all([
      this.repository.entities({
        ...(after ? { after } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        limit: limit + 1,
        ...(query.query ? { query: query.query } : {}),
        worldId,
      }),
      this.repository.runtimeMetadata(worldId),
    ]);
    if (!metadata) throw new ApplicationError('WORLD_NOT_ACTIVE', 'The world is not active.', 409);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => entityView(row)),
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              filterHash,
              key: last.logical_key as string,
              kind: 'entity',
              worldId,
            })
          : null,
      runtime: runtimeMetadata(metadata),
    };
  }

  public async getEntity(
    actor: AuthenticatedActor,
    worldId: string,
    logicalKey: string,
  ): Promise<WorldEntityDetailResponse> {
    await this.authorize(this.repository, actor, worldId, 'world.runtime.read', false);
    const row = await this.repository.entity(worldId, logicalKey);
    if (!row) this.notFound();
    return { entity: entityView(row), runtime: runtimeMetadata(row) };
  }

  public async listRelationships(
    actor: AuthenticatedActor,
    worldId: string,
    query: WorldRelationshipListQuery,
  ): Promise<WorldRelationshipListResponse> {
    await this.authorize(this.repository, actor, worldId, 'world.runtime.read', false);
    const limit = Number(query.limit ?? 50);
    const filterHash = this.filterHash({
      relationshipType: query.relationshipType ?? null,
      sourceLogicalKey: query.sourceLogicalKey ?? null,
      targetLogicalKey: query.targetLogicalKey ?? null,
    });
    const after = query.cursor
      ? this.decodeCursor(query.cursor, worldId, 'relationship', filterHash).key
      : undefined;
    const [rows, metadata] = await Promise.all([
      this.repository.relationships({
        ...(after ? { after } : {}),
        limit: limit + 1,
        ...(query.relationshipType ? { relationshipType: query.relationshipType } : {}),
        ...(query.sourceLogicalKey ? { sourceLogicalKey: query.sourceLogicalKey } : {}),
        ...(query.targetLogicalKey ? { targetLogicalKey: query.targetLogicalKey } : {}),
        worldId,
      }),
      this.repository.runtimeMetadata(worldId),
    ]);
    if (!metadata) throw new ApplicationError('WORLD_NOT_ACTIVE', 'The world is not active.', 409);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => relationshipView(row)),
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              filterHash,
              key: last.logical_key as string,
              kind: 'relationship',
              worldId,
            })
          : null,
      runtime: runtimeMetadata(metadata),
    };
  }

  public async neighbors(
    actor: AuthenticatedActor,
    worldId: string,
    logicalKey: string,
    query: WorldNeighborQuery,
  ): Promise<WorldNeighborResponse> {
    await this.authorize(this.repository, actor, worldId, 'world.runtime.read', false);
    const limit = Number(query.limit ?? 50);
    const filterHash = this.filterHash({
      direction: query.direction ?? 'both',
      logicalKey,
      relationshipType: query.relationshipType ?? null,
    });
    const after = query.cursor
      ? this.decodeCursor(query.cursor, worldId, 'neighbor', filterHash).key
      : undefined;
    const result = await this.repository.neighbors(worldId, logicalKey, limit, {
      ...(after ? { after } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.relationshipType ? { relationshipType: query.relationshipType } : {}),
    });
    if (!result.entity) this.notFound();
    const rows = [...result.inbound, ...result.outbound].sort((left, right) =>
      String(left.logical_key) < String(right.logical_key)
        ? -1
        : String(left.logical_key) > String(right.logical_key)
          ? 1
          : 0,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entity: entityView(result.entity),
      items: page.map((row) => {
        const inbound = row.direction === 'inbound';
        return {
          direction: inbound ? 'inbound' : 'outbound',
          neighbor: entityView({
            created_world_version_id:
              row[inbound ? 'source_created_world_version_id' : 'target_created_world_version_id'],
            entity_schema_version:
              row[inbound ? 'source_entity_schema_version' : 'target_entity_schema_version'],
            entity_type: row[inbound ? 'source_entity_type' : 'target_entity_type'],
            logical_key: row[inbound ? 'source_logical_key' : 'target_logical_key'],
            retired_world_version_id:
              row[inbound ? 'source_retired_world_version_id' : 'target_retired_world_version_id'],
            row_version: row[inbound ? 'source_row_version' : 'target_row_version'],
            state: row[inbound ? 'source_state' : 'target_state'],
            world_id: row.world_id,
          }),
          relationship: relationshipView(row),
        };
      }),
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              filterHash,
              key: last.logical_key as string,
              kind: 'neighbor',
              worldId,
            })
          : null,
      runtime: runtimeMetadata(result.entity),
    };
  }

  private async inputBundle(
    repository: CompilationRepository,
    worldId: string,
    manifest: WorldManifestV1,
    seed: string,
    compilerVersion: RunnableCompilerVersion,
  ): Promise<
    | CompilerInputBundleV1
    | GovernanceCompilerInputBundleV1
    | PreviousCompilerInputBundleV1
    | RetainedCompilerInputBundleV1
  > {
    const primitives = await repository.compilationPrimitives(manifest);
    const members = await repository.activeMembers(worldId);
    const options = {
      activeMembers: members.map((member) => ({
        principalKey: memberPrincipalKey(worldId, member.userId),
        role: member.role,
      })),
      compilerConfig: {
        adapterRegistryVersion: 1 as const,
        deprecatedPrimitivePolicy: 'reject' as const,
        maxEntities: this.config.compilerMaxEntities ?? 2_000,
        maxRelationships: this.config.compilerMaxRelationships ?? 8_000,
      },
      manifest,
      primitives: primitives.map((primitive) => ({
        contentHash: primitive.contentHash,
        definition: primitiveDefinition(primitive),
        lifecycle: primitive.lifecycle,
        primitiveVersionId: primitive.versionId,
      })),
      seed,
    };
    if (compilerVersion === COMPILER_VERSION) return createCompilerInputBundle(options);
    if (compilerVersion === GOVERNANCE_COMPILER_VERSION) {
      return createGovernanceCompilerInputBundle(options);
    }
    return compilerVersion === PREVIOUS_COMPILER_VERSION
      ? createPreviousCompilerInputBundle(options)
      : createRetainedCompilerInputBundle(options);
  }

  private runnableCompilerVersion(version: string): RunnableCompilerVersion {
    if (
      version === COMPILER_VERSION ||
      version === GOVERNANCE_COMPILER_VERSION ||
      version === PREVIOUS_COMPILER_VERSION ||
      version === RETAINED_COMPILER_VERSION
    ) {
      return version;
    }
    throw new ApplicationError(
      'COMPILER_VERSION_MISMATCH',
      'The compilation run uses a compiler version that this release cannot execute.',
      409,
    );
  }

  private startResponse(run: CompilationRunRecord): StartWorldCompilationResponse {
    return { rowVersion: run.rowVersion, runId: run.id, stage: run.stage, status: run.status };
  }

  private assertWorldCanCompile(world: CompilationWorldAccess): void {
    if (world.activeWorldVersionId || world.lifecycle === 'active') {
      throw new ApplicationError(
        'WORLD_ALREADY_ACTIVE',
        'An active world cannot be recompiled.',
        409,
      );
    }
    if (world.lifecycle === 'compiling') {
      throw new ApplicationError(
        'COMPILATION_IN_PROGRESS',
        'A world compilation is already active.',
        409,
      );
    }
    if (!world.currentApprovedManifestRevisionId || world.lifecycle === 'draft') {
      throw new ApplicationError(
        'MANIFEST_APPROVAL_REQUIRED',
        'A current approved manifest is required.',
        409,
      );
    }
  }

  private isRetryable(run: CompilationRunRecord): boolean {
    const errors = (run.diagnostics as CompilerDiagnosticV1[]).filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    return (
      run.attempts < 3 &&
      (errors.length === 0 || errors.every((diagnostic) => diagnostic.retryable))
    );
  }

  private async authorize(
    repository: CompilationRepository,
    actor: AuthenticatedActor,
    worldId: string,
    action: AuthorityAction,
    lock: boolean,
  ): Promise<CompilationWorldAccess> {
    const world = await repository.getWorldAccess(actor.user.id, worldId, lock);
    if (!world) this.notFound();
    const decision = evaluateAuthority(
      {
        membershipRole: world.role,
        membershipStatus: 'active',
        platformRole: actor.user.platformRole,
        userId: actor.user.id,
      },
      action,
      { worldId },
    );
    telemetry.authorizationDecisions.add(1, {
      action,
      outcome: decision.allowed ? 'allowed' : 'denied',
    });
    if (!decision.allowed) {
      await repository.insertAudit({
        action,
        actorUserId: actor.user.id,
        correlationId: this.ids.next(),
        id: this.ids.next(),
        metadata: { authorityReasonCode: decision.reasonCode, authorityRuleId: decision.ruleId },
        outcome: 'denied',
        reasonCode: decision.reasonCode,
        requestId: this.ids.next(),
        targetId: worldId,
        targetType: 'world',
        worldId,
      });
      throw new ApplicationError('FORBIDDEN', 'This compiler action is not permitted.', 403, {
        reasonCode: decision.reasonCode,
        ruleId: decision.ruleId,
      });
    }
    return world;
  }

  private async audit(
    repository: CompilationRepository,
    command: ReturnType<typeof buildCommand>,
    world: CompilationWorldAccess,
    action: string,
    targetId: string,
  ): Promise<void> {
    const decision = evaluateAuthority(
      {
        membershipRole: world.role,
        membershipStatus: 'active',
        platformRole: 'user',
        userId: command.actorUserId,
      },
      command.action as AuthorityAction,
      { worldId: world.worldId },
    );
    await repository.insertAudit({
      action,
      actorUserId: command.actorUserId,
      correlationId: command.correlationId,
      id: this.ids.next(),
      metadata: { authorityReasonCode: decision.reasonCode, authorityRuleId: decision.ruleId },
      reasonCode: 'COMMAND_APPLIED',
      requestId: command.requestId,
      targetId,
      targetType: 'world_compilation_run',
      worldId: world.worldId,
    });
  }

  private async idempotent(
    command: ReturnType<typeof buildCommand>,
    status: number,
    operation: (repository: CompilationRepository) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.repository.transaction(async (repository) => {
      const identity: CompilationCommandIdentity = {
        actorId: command.actorUserId,
        expiresAt: new Date(this.clock.now().getTime() + 86_400_000),
        key: command.idempotencyKey,
        requestHash: command.requestHashBytes,
        scope: command.action,
      };
      const started = await repository.beginIdempotency(identity);
      if (started.kind === 'replay') {
        telemetry.idempotency.add(1, { outcome: 'replay' });
        return started.body;
      }
      telemetry.idempotency.add(1, { outcome: 'new' });
      const body = await operation(repository);
      await repository.completeIdempotency(identity, status, body);
      return body;
    });
  }

  private async publishSafely<T extends ApplicationNotification['type']>(
    type: T,
    payload: Extract<ApplicationNotification, { type: T }>['payload'],
  ): Promise<void> {
    try {
      await this.notifications.publish({
        id: this.ids.next(),
        occurredAt: this.clock.now().toISOString(),
        payload,
        schemaVersion: 1,
        type,
      } as Extract<ApplicationNotification, { type: T }>);
    } catch {
      telemetry.worldCompilationRuns.add(1, { outcome: 'queue_deferred' });
    }
  }

  private filterHash(value: Record<string, unknown>): string {
    return createHmac('sha256', this.cursorSecret).update(canonicalJson(value)).digest('hex');
  }

  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    worldId: string,
    kind: CursorPayload['kind'],
    filterHash: string,
  ): CursorPayload {
    const parts = cursor.split('.');
    const encoded = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || !encoded || !signature) this.invalidCursor();
    const expected = createHmac('sha256', this.cursorSecret).update(encoded).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (
      actual.toString('base64url') !== signature ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      this.invalidCursor();
    try {
      const encodedPayload = Buffer.from(encoded, 'base64url');
      if (encodedPayload.toString('base64url') !== encoded) this.invalidCursor();
      const payload = JSON.parse(encodedPayload.toString('utf8')) as CursorPayload;
      if (
        payload.worldId !== worldId ||
        payload.kind !== kind ||
        payload.filterHash !== filterHash ||
        typeof payload.key !== 'string' ||
        payload.key.length < 3 ||
        payload.key.length > 240
      ) {
        this.invalidCursor();
      }
      return payload;
    } catch {
      this.invalidCursor();
    }
  }

  private invalidCursor(): never {
    throw new ApplicationError('INVALID_CURSOR', 'The pagination cursor is invalid.', 400);
  }

  private notFound(): never {
    throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
  }
}
