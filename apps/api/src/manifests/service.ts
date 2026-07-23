import { createHmac, timingSafeEqual } from 'node:crypto';

import type { RuntimeConfig } from '@worldgraph/config';
import {
  MANIFEST_SCHEMA_VERSION,
  canonicalizeJson,
  type ApplicationNotification,
  type ApproveManifestRevisionRequest,
  type ApproveManifestRevisionResponse,
  type AuthorityAction,
  type Clock,
  type CreateManifestRevisionRequest,
  type GetManifestRevisionResponse,
  type IdGenerator,
  type ManifestGenerationRunView,
  type ManifestGenerationWarning,
  type ManifestFieldProvenance,
  type ManifestRevisionDiffQuery,
  type ManifestRevisionDiffView,
  type ManifestRevisionListQuery,
  type ManifestRevisionListResponse,
  type ManifestValidationReportView,
  type StartManifestGenerationRequest,
  type StartManifestGenerationResponse,
  type WorldManifestV1,
} from '@worldgraph/contracts';
import {
  attachManifestGenerationWarnings,
  manifestContentHash,
  manifestGenerationRequestHash,
  normalizeManifestPrompt,
  parseSafeYaml,
  projectSafeYaml,
  resolveManifestGenerationSeed,
  sha256,
  structuralManifestDiff,
  validateWorldManifest,
  type SafeYamlLocation,
} from '@worldgraph/manifests';
import { telemetry } from '@worldgraph/observability';

import { evaluateAuthority } from '../authority/evaluator.js';
import { buildCommand } from '../application/command.js';
import { ApplicationError } from '../application/errors.js';
import type { NotificationSink } from '../application/notifications.js';
import {
  decodeDurableLegacyRejection,
  encodeDurableLegacyRejection,
  legacyLedgerRejectionCode,
  type LegacyMutationCommandContext,
} from '../commands/legacy-mutation-ledger.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type {
  ManifestCommandIdentity,
  ManifestRepository,
  ManifestWorldAccess,
} from './repository.js';

export interface ManifestCommandContext {
  idempotencyKey: string;
  requestId: string;
}

interface ParsedManifestInput {
  locations?: ReadonlyMap<string, SafeYamlLocation>;
  value: unknown;
}

const keyedManifestCollections = [
  ['actors', 'key'],
  ['connections', 'key'],
  ['districts', 'key'],
  ['institutions', 'key'],
  ['organizations', 'key'],
  ['primitiveRefs', 'ref'],
  ['relationships', 'key'],
] as const;

function parentPointer(pointer: string): string {
  const boundary = pointer.lastIndexOf('/');
  return boundary <= 0 ? '' : pointer.slice(0, boundary);
}

function reorderedCollectionPointers(before: WorldManifestV1, after: WorldManifestV1): string[] {
  const reordered: string[] = [];
  for (const [collection, identity] of keyedManifestCollections) {
    const left = (before[collection] as readonly Record<string, unknown>[]).map(
      (entry) => entry[identity],
    );
    const right = (after[collection] as readonly Record<string, unknown>[]).map(
      (entry) => entry[identity],
    );
    if (JSON.stringify(left) !== JSON.stringify(right)) reordered.push(`/${collection}`);
  }
  return reordered;
}

export class ManifestService {
  private readonly providerConfigurationId: string;

  public constructor(
    private readonly repository: ManifestRepository,
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly notifications: NotificationSink,
    private readonly cursorSecret: string,
  ) {
    this.providerConfigurationId = `${config.manifestGenerationProvider}-v1`;
  }

  public async startGeneration(
    actor: AuthenticatedActor,
    worldId: string,
    payload: StartManifestGenerationRequest,
    context: ManifestCommandContext,
  ): Promise<StartManifestGenerationResponse> {
    if (!this.config.manifestGenerationEnabled) {
      throw new ApplicationError(
        'MANIFEST_GENERATION_DISABLED',
        'Manifest generation is not enabled.',
        503,
      );
    }
    await this.authorize(this.repository, actor, worldId, 'manifest.generation.start', false);
    const parentRevisionId = 'parentRevisionId' in payload ? payload.parentRevisionId : undefined;
    const expectedParentContentHash =
      'expectedParentContentHash' in payload ? payload.expectedParentContentHash : undefined;
    this.assertParentPair(parentRevisionId, expectedParentContentHash);
    const prompt = normalizeManifestPrompt(payload.prompt);
    if (prompt.length < 10 || prompt.length > 2_000) {
      throw new ApplicationError('VALIDATION_FAILED', 'The manifest prompt is invalid.', 400);
    }
    const seed = resolveManifestGenerationSeed({
      prompt,
      providerConfigurationId: this.providerConfigurationId,
      seed: payload.seed ?? null,
    });
    const inputHash = manifestGenerationRequestHash({
      expectedParentContentHash: expectedParentContentHash ?? null,
      parentRevisionId: parentRevisionId ?? null,
      prompt,
      providerConfigurationId: this.providerConfigurationId,
      seed,
    });
    const normalizedHash = sha256(prompt);
    const command = buildCommand(
      {
        action: 'manifest.generation.start',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: {
          expectedParentContentHash: expectedParentContentHash ?? null,
          parentRevisionId: parentRevisionId ?? null,
          promptHash: normalizedHash,
          seed,
        },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    const runId = this.ids.next();
    const promptId = this.ids.next();
    let applied = false;
    const body = await this.idempotent(actor, command, 202, async (repository) => {
      const world = await this.authorize(
        repository,
        actor,
        worldId,
        'manifest.generation.start',
        true,
      );
      await repository.lockGenerationUser(actor.user.id);
      const latestRevisionNumber = await repository.latestRevisionNumber(worldId);
      if (latestRevisionNumber > 0 && !parentRevisionId) {
        throw new ApplicationError(
          'MANIFEST_PARENT_REQUIRED',
          'A new generation must identify its parent manifest revision.',
          409,
        );
      }
      if (parentRevisionId && expectedParentContentHash) {
        const parent = await repository.getRevision(worldId, parentRevisionId, true);
        if (!parent || parent.contentHash !== expectedParentContentHash) {
          throw new ApplicationError(
            'STALE_MANIFEST_REVISION',
            'The parent manifest revision has changed or is unavailable.',
            409,
          );
        }
      }
      const cached = await repository.findGenerationByInput(worldId, inputHash);
      if (cached) {
        await this.audit(
          repository,
          command,
          world,
          'manifest.generation.reused',
          cached.id,
          'manifest_generation_run',
        );
        return { rowVersion: cached.rowVersion, runId: cached.id, status: cached.status };
      }
      const counts = await repository.activeGenerationCounts(worldId, actor.user.id);
      if (
        (!parentRevisionId && counts.world > 0) ||
        counts.world >= this.config.manifestGenerationMaxConcurrentPerWorld ||
        counts.user >= this.config.manifestGenerationMaxConcurrentPerUser
      ) {
        throw new ApplicationError(
          'GENERATION_LIMIT',
          'A manifest generation is already active.',
          429,
        );
      }
      applied = true;
      const run = await repository.createGeneration({
        actorUserId: actor.user.id,
        expectedParentContentHash: expectedParentContentHash ?? null,
        inputHash,
        normalizedHash,
        parentRevisionId: parentRevisionId ?? null,
        prompt,
        promptId,
        providerConfigurationId: this.providerConfigurationId,
        retentionUntil: new Date(
          this.clock.now().getTime() + this.config.manifestPromptRetentionDays * 86_400_000,
        ),
        runId,
        seed,
        worldId,
      });
      await this.audit(
        repository,
        command,
        world,
        'manifest.generation.requested',
        run.id,
        'manifest_generation_run',
      );
      return { rowVersion: run.rowVersion, runId: run.id, status: 'queued' as const };
    });
    const response = body as StartManifestGenerationResponse;
    if (applied) {
      await this.publishSafely('ManifestGenerationRequested', {
        actorUserId: actor.user.id,
        inputHash,
        runId: response.runId,
        worldId,
      });
      telemetry.manifestGenerationRuns.add(1, { mode: 'pending', outcome: 'queued' });
    }
    return response;
  }

  public async generation(
    actor: AuthenticatedActor,
    runId: string,
  ): Promise<ManifestGenerationRunView> {
    const run = await this.repository.getGenerationRun(actor.user.id, runId);
    if (!run) this.notFound();
    await this.authorize(this.repository, actor, run.worldId, 'manifest.generation.read', false);
    return run;
  }

  public async cancelGeneration(
    actor: AuthenticatedActor,
    runId: string,
    expectedRowVersion: number,
    context: ManifestCommandContext,
  ): Promise<ManifestGenerationRunView> {
    const visible = await this.repository.getGenerationRun(actor.user.id, runId);
    if (!visible) this.notFound();
    const command = buildCommand(
      {
        action: 'manifest.generation.cancel',
        actorUserId: actor.user.id,
        expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { runId },
        requestId: context.requestId,
        resourceId: visible.worldId,
      },
      this.ids,
    );
    const body = await this.idempotent(actor, command, 200, async (repository) => {
      const world = await this.authorize(
        repository,
        actor,
        visible.worldId,
        'manifest.generation.cancel',
        true,
      );
      const current = await repository.getGenerationRun(actor.user.id, runId, true);
      if (!current) this.notFound();
      if (current.status === 'cancelled') return current;
      if (current.status === 'succeeded' || current.status === 'failed') {
        throw new ApplicationError(
          'GENERATION_TERMINAL',
          'A completed manifest generation cannot be cancelled.',
          409,
        );
      }
      const cancelled = await repository.cancelGeneration(actor.user.id, runId, expectedRowVersion);
      if (!cancelled) {
        throw new ApplicationError('STALE_VERSION', 'The generation run has changed.', 409);
      }
      await this.audit(
        repository,
        command,
        world,
        'manifest.generation.cancelled',
        runId,
        'manifest_generation_run',
      );
      return cancelled;
    });
    telemetry.manifestGenerationRuns.add(1, { mode: 'pending', outcome: 'cancelled' });
    return body as ManifestGenerationRunView;
  }

  public async createRevision(
    actor: AuthenticatedActor,
    worldId: string,
    payload: CreateManifestRevisionRequest,
    context: ManifestCommandContext,
  ): Promise<{ revision: object; validationReportId: string | null }> {
    const command = buildCommand(
      {
        action: 'manifest.revision.create',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: {
          baseRevisionId: payload.baseRevisionId,
          documentHash: sha256(
            payload.format === 'yaml'
              ? payload.jsonOrYaml
              : JSON.stringify(canonicalizeJson(payload.jsonOrYaml)),
          ),
          expectedHash: payload.expectedHash,
          format: payload.format,
        },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    const revisionId = this.ids.next();
    let created = false;
    let createdContentHash = '';
    let createdReport: ManifestValidationReportView | null = null;
    const body = await this.idempotent(actor, command, 201, async (repository) => {
      const world = await this.authorize(
        repository,
        actor,
        worldId,
        'manifest.revision.create',
        true,
      );
      this.assertBasePair(payload.baseRevisionId, payload.expectedHash);
      const parsed = this.parseManifest(payload);
      const latestRevisionNumber = await repository.latestRevisionNumber(worldId);
      if (latestRevisionNumber > 0 && !payload.baseRevisionId) {
        throw new ApplicationError(
          'MANIFEST_PARENT_REQUIRED',
          'A new revision must identify its parent manifest revision.',
          409,
        );
      }
      if (latestRevisionNumber === 0 && !payload.baseRevisionId) {
        const active = await repository.activeGenerationCounts(worldId, actor.user.id);
        if (active.world > 0) {
          throw new ApplicationError(
            'GENERATION_LIMIT',
            'The first manifest revision is already being generated.',
            409,
          );
        }
      }
      let baseManifest: WorldManifestV1 | null = null;
      let parentProvenance: ManifestFieldProvenance[] = [];
      let generationWarnings: ManifestGenerationWarning[] = [];
      if (payload.baseRevisionId && payload.expectedHash) {
        const base = await repository.getRevision(worldId, payload.baseRevisionId, true);
        if (!base || base.contentHash !== payload.expectedHash) {
          throw new ApplicationError(
            'STALE_MANIFEST_REVISION',
            'The base manifest revision has changed or is unavailable.',
            409,
          );
        }
        baseManifest = base.manifest;
        [parentProvenance, generationWarnings] = await Promise.all([
          repository.provenance(base.id),
          repository.generationWarnings(worldId, base.id),
        ]);
      }
      // The edit payload is bounded JSON, not necessarily a WorldManifest. Run
      // schema validation before dereferencing primitiveRefs for catalog lookup
      // so malformed documents produce stable client diagnostics instead of an
      // internal TypeError or PostgreSQL UUID error.
      const shapeValidation = validateWorldManifest(
        parsed.value,
        { primitives: [] },
        parsed.locations,
      );
      if (shapeValidation.contentHash === null) {
        throw new ApplicationError(
          'MANIFEST_INVALID',
          'The manifest document does not satisfy the versioned schema.',
          400,
          { diagnostics: shapeValidation.diagnostics },
        );
      }
      const manifest = parsed.value as WorldManifestV1;
      const catalog = await repository.catalogForManifest(manifest);
      const validation = this.attachGenerationWarnings(
        validateWorldManifest(manifest, catalog, parsed.locations),
        generationWarnings,
      );
      if (validation.contentHash === null) {
        throw new ApplicationError(
          'MANIFEST_INVALID',
          'The manifest document does not satisfy the versioned schema.',
          400,
          { diagnostics: validation.diagnostics },
        );
      }
      const contentHash = manifestContentHash(manifest);
      const revision = await repository.insertManualRevision({
        contentHash,
        createdBy: actor.user.id,
        id: revisionId,
        manifest,
        generationWarnings,
        parentRevisionId: payload.baseRevisionId,
        revisionNumber: latestRevisionNumber + 1,
        worldId,
      });
      await repository.insertProvenance(
        revision.id,
        this.manualRevisionProvenance(
          actor.user.id,
          contentHash,
          baseManifest,
          manifest,
          parentProvenance,
        ),
      );
      createdReport = await repository.putValidationReport({
        catalogSnapshotHash: validation.catalogSnapshotHash,
        diagnostics: validation.diagnostics,
        id: this.ids.next(),
        reportHash: validation.reportHash,
        revisionId: revision.id,
        valid: validation.valid,
      });
      created = true;
      createdContentHash = contentHash;
      await this.audit(
        repository,
        command,
        world,
        'manifest.revision.created',
        revision.id,
        'manifest_revision',
      );
      const authority = this.authorityDecision(actor, world, 'manifest.revision.create');
      await repository.appendLegacyMutation({
        ...this.legacyLedgerContext(actor, command, authority.ruleId),
        event: {
          aggregateId: revision.id,
          aggregateType: 'manifest_revision',
          eventType: 'ManifestRevisionCreatedV1',
          payload: {
            contentHash,
            manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
            revisionId: revision.id,
            revisionNumber: String(revision.revisionNumber),
            source: 'manual',
          },
        },
        worldId,
      });
      return { revision, validationReportId: createdReport.id };
    });
    const publishedReport = createdReport as ManifestValidationReportView | null;
    if (created && publishedReport) {
      await this.publishSafely('ManifestRevisionCreated', {
        actorUserId: actor.user.id,
        contentHash: createdContentHash,
        revisionId,
        worldId,
      });
      await this.publishSafely('ManifestRevisionValidated', {
        reportHash: publishedReport.reportHash,
        reportId: publishedReport.id,
        revisionId,
        valid: publishedReport.valid,
        worldId,
      });
      this.recordDiagnostics(publishedReport);
    }
    return body as { revision: object; validationReportId: string | null };
  }

  public async validateRevision(
    actor: AuthenticatedActor,
    worldId: string,
    revisionId: string,
    expectedContentHash: string,
    context: ManifestCommandContext,
  ): Promise<ManifestValidationReportView> {
    await this.authorize(this.repository, actor, worldId, 'manifest.revision.validate', false);
    const command = buildCommand(
      {
        action: 'manifest.revision.validate',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: { expectedContentHash, revisionId },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    let applied = false;
    const body = await this.idempotent(actor, command, 200, async (repository) => {
      const world = await this.authorize(
        repository,
        actor,
        worldId,
        'manifest.revision.validate',
        true,
      );
      const revision = await repository.getRevision(worldId, revisionId, true);
      if (!revision) this.notFound();
      if (revision.contentHash !== expectedContentHash) {
        throw new ApplicationError(
          'STALE_MANIFEST_REVISION',
          'The revision hash has changed.',
          409,
        );
      }
      const catalog = await repository.catalogForManifest(revision.manifest);
      const generationWarnings = await repository.generationWarnings(worldId, revisionId);
      const validation = this.attachGenerationWarnings(
        validateWorldManifest(revision.manifest, catalog),
        generationWarnings,
      );
      const report = await repository.putValidationReport({
        catalogSnapshotHash: validation.catalogSnapshotHash,
        diagnostics: validation.diagnostics,
        id: this.ids.next(),
        reportHash: validation.reportHash,
        revisionId,
        valid: validation.valid,
      });
      applied = true;
      await this.audit(
        repository,
        command,
        world,
        'manifest.revision.validated',
        revisionId,
        'manifest_revision',
      );
      return { report };
    });
    const report = (body as { report: ManifestValidationReportView }).report;
    if (applied) {
      await this.publishSafely('ManifestRevisionValidated', {
        reportHash: report.reportHash,
        reportId: report.id,
        revisionId,
        valid: report.valid,
        worldId,
      });
      this.recordDiagnostics(report);
    }
    return report;
  }

  public async listRevisions(
    actor: AuthenticatedActor,
    worldId: string,
    query: ManifestRevisionListQuery,
  ): Promise<ManifestRevisionListResponse> {
    await this.authorize(this.repository, actor, worldId, 'manifest.revision.read', false);
    const limit = query.limit ? Number(query.limit) : 25;
    const cursor = query.cursor ? this.decodeCursor(query.cursor, worldId) : null;
    const page = await this.repository.listRevisions({ cursor, limit, worldId });
    return {
      items: page.items,
      nextCursor: page.tail
        ? this.encodeCursor({ id: page.tail.id, revisionNumber: page.tail.revisionNumber }, worldId)
        : null,
    };
  }

  public async revision(
    actor: AuthenticatedActor,
    worldId: string,
    revisionId: string,
  ): Promise<GetManifestRevisionResponse> {
    await this.authorize(this.repository, actor, worldId, 'manifest.revision.read', false);
    const revision = await this.repository.getRevision(worldId, revisionId);
    if (!revision) this.notFound();
    const [report, entries] = await Promise.all([
      this.repository.latestValidationReport(revisionId),
      this.repository.provenance(revisionId),
    ]);
    return {
      provenance: { entries, manifestRevisionId: revisionId },
      report,
      revision,
      yaml: projectSafeYaml(canonicalizeJson(revision.manifest)),
    };
  }

  public async diff(
    actor: AuthenticatedActor,
    worldId: string,
    query: ManifestRevisionDiffQuery,
  ): Promise<ManifestRevisionDiffView> {
    await this.authorize(this.repository, actor, worldId, 'manifest.revision.diff', false);
    const [from, to] = await Promise.all([
      this.repository.getRevision(worldId, query.fromRevisionId),
      this.repository.getRevision(worldId, query.toRevisionId),
    ]);
    if (!from || !to) this.notFound();
    const result = structuralManifestDiff(from.manifest, to.manifest);
    const limit = query.limit ? Number(query.limit) : 100;
    const offset = query.cursor ? this.decodeDiffCursor(query.cursor, worldId, from.id, to.id) : 0;
    if (offset < 0 || offset >= Math.max(1, result.entries.length)) this.invalidCursor();
    const entries = result.entries.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    return {
      counts: result.counts,
      entries: [...entries],
      fromContentHash: from.contentHash,
      fromRevisionId: from.id,
      nextCursor:
        nextOffset < result.entries.length
          ? this.encodeDiffCursor(nextOffset, worldId, from.id, to.id)
          : null,
      toContentHash: to.contentHash,
      toRevisionId: to.id,
    };
  }

  public async approve(
    actor: AuthenticatedActor,
    worldId: string,
    revisionId: string,
    payload: ApproveManifestRevisionRequest,
    context: ManifestCommandContext,
  ): Promise<ApproveManifestRevisionResponse> {
    const command = buildCommand(
      {
        action: 'manifest.revision.approve',
        actorUserId: actor.user.id,
        expectedRowVersion: payload.expectedWorldVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { ...payload, revisionId },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    let applied = false;
    let approvedHash = '';
    const body = await this.idempotent(actor, command, 200, async (repository) => {
      const world = await this.authorize(
        repository,
        actor,
        worldId,
        'manifest.revision.approve',
        true,
      );
      if (world.rowVersion !== payload.expectedWorldVersion) {
        telemetry.manifestStaleConflicts.add(1, { operation: 'approval' });
        throw new ApplicationError('STALE_VERSION', 'The world has changed.', 409);
      }
      if (payload.confirmationName.trim().normalize('NFC') !== world.name) {
        throw new ApplicationError(
          'APPROVAL_CONFIRMATION_MISMATCH',
          'The world-name confirmation does not match.',
          400,
        );
      }
      const revision = await repository.getRevision(worldId, revisionId, true);
      if (!revision) this.notFound();
      if (revision.contentHash !== payload.expectedContentHash) {
        telemetry.manifestStaleConflicts.add(1, { operation: 'approval' });
        throw new ApplicationError(
          'STALE_MANIFEST_REVISION',
          'The revision hash has changed.',
          409,
        );
      }
      const latestNumber = await repository.latestRevisionNumber(worldId);
      if (revision.revisionNumber !== latestNumber) {
        throw new ApplicationError(
          'MANIFEST_NOT_LATEST',
          'Only the latest manifest revision can be approved.',
          409,
        );
      }
      if (revision.approvalStatus === 'approved') {
        if (world.currentApprovedManifestRevisionId !== revision.id) {
          throw new ApplicationError(
            'MANIFEST_APPROVAL_CONFLICT',
            'The approved manifest pointer is inconsistent.',
            409,
          );
        }
        return {
          contentHash: revision.contentHash,
          manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
          revisionId,
          worldId,
          worldRowVersion: world.rowVersion,
        };
      }
      if (revision.approvalStatus !== 'draft') {
        throw new ApplicationError(
          'MANIFEST_APPROVAL_CONFLICT',
          'Only a draft manifest revision can be approved.',
          409,
        );
      }
      const catalog = await repository.catalogForManifest(revision.manifest);
      const generationWarnings = await repository.generationWarnings(worldId, revisionId);
      const validation = this.attachGenerationWarnings(
        validateWorldManifest(revision.manifest, catalog),
        generationWarnings,
      );
      const report = await repository.putValidationReport({
        catalogSnapshotHash: validation.catalogSnapshotHash,
        diagnostics: validation.diagnostics,
        id: this.ids.next(),
        reportHash: validation.reportHash,
        revisionId,
        valid: validation.valid,
      });
      if (!report.valid) {
        throw new ApplicationError(
          'MANIFEST_VALIDATION_FAILED',
          'The manifest has blocking validation errors.',
          409,
          { diagnostics: report.diagnostics },
        );
      }
      const warningCodes = [
        ...new Set([
          ...report.diagnostics
            .filter((diagnostic) => diagnostic.severity === 'warning')
            .map((diagnostic) => diagnostic.code),
          ...generationWarnings.map((warning) => warning.code),
        ]),
      ].sort();
      const acknowledgements = [...new Set(payload.acknowledgedWarningCodes)].sort();
      if (
        warningCodes.length !== acknowledgements.length ||
        warningCodes.some((code, index) => code !== acknowledgements[index])
      ) {
        throw new ApplicationError(
          'MANIFEST_WARNING_ACKNOWLEDGEMENT_REQUIRED',
          'Every current validation warning must be acknowledged exactly.',
          409,
          { requiredWarningCodes: warningCodes },
        );
      }
      const worldRowVersion = await repository.approveRevision({
        acknowledgedWarningCodes: acknowledgements,
        actorUserId: actor.user.id,
        expectedWorldVersion: payload.expectedWorldVersion,
        revisionId,
        worldId,
      });
      await this.audit(
        repository,
        command,
        world,
        'manifest.revision.approved',
        revisionId,
        'manifest_revision',
      );
      const authority = this.authorityDecision(actor, world, 'manifest.revision.approve');
      await repository.appendLegacyMutation({
        ...this.legacyLedgerContext(actor, command, authority.ruleId),
        event: {
          aggregateId: revisionId,
          aggregateType: 'manifest_revision',
          eventType: 'ManifestApprovedV1',
          payload: {
            contentHash: revision.contentHash,
            manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
            revisionId,
          },
        },
        worldId,
      });
      applied = true;
      approvedHash = revision.contentHash;
      return {
        contentHash: revision.contentHash,
        manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
        revisionId,
        worldId,
        worldRowVersion,
      };
    });
    const response = body as ApproveManifestRevisionResponse;
    if (applied) {
      await this.publishSafely('ManifestApproved', {
        actorUserId: actor.user.id,
        contentHash: approvedHash,
        revisionId,
        worldId,
      });
      telemetry.manifestApprovals.add(1, { outcome: 'approved' });
    }
    return response;
  }

  private parseManifest(payload: CreateManifestRevisionRequest): ParsedManifestInput {
    if (payload.format === 'json') return { value: payload.jsonOrYaml };
    const result = parseSafeYaml(payload.jsonOrYaml);
    if (!result.ok) {
      throw new ApplicationError(
        'MANIFEST_YAML_INVALID',
        'The YAML document is invalid or uses an unsafe feature.',
        400,
        { issues: result.issues },
      );
    }
    return { locations: result.locations, value: result.value };
  }

  private attachGenerationWarnings(
    validation: ReturnType<typeof validateWorldManifest>,
    warnings: readonly ManifestGenerationWarning[],
  ): ReturnType<typeof validateWorldManifest> {
    try {
      return attachManifestGenerationWarnings(validation, warnings);
    } catch (error) {
      if (error instanceof Error && error.message === 'MANIFEST_GENERATION_WARNING_LIMIT') {
        throw new ApplicationError(
          'MANIFEST_GENERATION_WARNING_LIMIT',
          'The immutable generation warning set exceeds the safe validation-report limit.',
          422,
        );
      }
      throw error;
    }
  }

  private manualRevisionProvenance(
    actorUserId: string,
    contentHash: string,
    base: WorldManifestV1 | null,
    manifest: WorldManifestV1,
    parentEntries: readonly ManifestFieldProvenance[],
  ): ManifestFieldProvenance[] {
    if (!base) {
      return [
        { pointer: '', sourceHash: contentHash, sourceRef: actorUserId, sourceType: 'manual' },
      ];
    }
    const diff = structuralManifestDiff(base, manifest);
    if (diff.truncated) {
      throw new ApplicationError(
        'MANIFEST_PROVENANCE_LIMIT',
        'The edit is too large to retain exact field provenance.',
        422,
      );
    }
    const changedPointers = new Set(diff.entries.map((entry) => entry.pointer));
    for (const pointer of reorderedCollectionPointers(base, manifest)) changedPointers.add(pointer);
    const overlaps = (left: string, right: string): boolean =>
      left === '' ||
      right === '' ||
      left === right ||
      left.startsWith(`${right}/`) ||
      right.startsWith(`${left}/`);
    const inherited = parentEntries.filter(
      (entry) => ![...changedPointers].some((pointer) => overlaps(entry.pointer, pointer)),
    );
    const manualPointers = new Set<string>();
    for (const entry of diff.entries) {
      if (entry.kind !== 'removed') manualPointers.add(entry.pointer);
      else manualPointers.add(parentPointer(entry.pointer));
    }
    for (const pointer of reorderedCollectionPointers(base, manifest)) manualPointers.add(pointer);
    const manual = [...manualPointers].sort().map<ManifestFieldProvenance>((pointer) => ({
      pointer,
      sourceHash: contentHash,
      sourceRef: actorUserId,
      sourceType: 'manual',
    }));
    const combined = [...inherited, ...manual];
    if (combined.length > 512) {
      throw new ApplicationError(
        'MANIFEST_PROVENANCE_LIMIT',
        'The edit would exceed the bounded field-provenance limit.',
        422,
      );
    }
    return combined.length > 0
      ? combined
      : [{ pointer: '', sourceHash: contentHash, sourceRef: actorUserId, sourceType: 'manual' }];
  }

  private async authorize(
    repository: ManifestRepository,
    actor: AuthenticatedActor,
    worldId: string,
    action: AuthorityAction,
    lock: boolean,
  ): Promise<ManifestWorldAccess> {
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
      throw new ApplicationError('FORBIDDEN', 'This manifest action is not permitted.', 403, {
        reasonCode: decision.reasonCode,
        ruleId: decision.ruleId,
      });
    }
    return world;
  }

  private async audit(
    repository: ManifestRepository,
    command: ReturnType<typeof buildCommand>,
    world: ManifestWorldAccess,
    action: string,
    targetId: string,
    targetType: string,
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
      targetType,
      worldId: world.worldId,
    });
  }

  private async idempotent(
    actor: AuthenticatedActor,
    command: ReturnType<typeof buildCommand>,
    status: number,
    operation: (repository: ManifestRepository) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const result = await this.repository.transaction(async (repository) => {
      const identity: ManifestCommandIdentity = {
        actorId: command.actorUserId,
        expiresAt: new Date(this.clock.now().getTime() + 86_400_000),
        key: command.idempotencyKey,
        requestHash: command.requestHashBytes,
        scope: command.action,
      };
      const started = await repository.beginIdempotency(identity);
      if (started.kind === 'replay') {
        telemetry.idempotency.add(1, { outcome: 'replay' });
        return { body: started.body, rejection: decodeDurableLegacyRejection(started.body) };
      }
      telemetry.idempotency.add(1, { outcome: 'new' });
      let body: Record<string, unknown>;
      try {
        body = await operation(repository);
      } catch (error) {
        if (!(error instanceof ApplicationError) || !command.resourceId) throw error;
        if (typeof repository.rejectLegacyMutation !== 'function') throw error;
        const appended = await repository.rejectLegacyMutation({
          actorType: this.ledgerActorType(actor),
          command,
          decidedAt: this.clock.now(),
          rejectionCode: legacyLedgerRejectionCode(error),
          worldId: command.resourceId,
        });
        if (appended.kind === 'unanchored') throw error;
        const body = encodeDurableLegacyRejection(error);
        await repository.completeIdempotency(identity, error.statusCode, body);
        return { body, rejection: error };
      }
      await repository.completeIdempotency(identity, status, body);
      return { body, rejection: null };
    });
    if (result.rejection) throw result.rejection;
    return result.body;
  }

  private authorityDecision(
    actor: AuthenticatedActor,
    world: ManifestWorldAccess,
    action: AuthorityAction,
  ) {
    return evaluateAuthority(
      {
        membershipRole: world.role,
        membershipStatus: 'active',
        platformRole: actor.user.platformRole,
        userId: actor.user.id,
      },
      action,
      { worldId: world.worldId },
    );
  }

  private legacyLedgerContext(
    actor: AuthenticatedActor,
    command: ReturnType<typeof buildCommand>,
    authorizationRuleId: string,
  ): LegacyMutationCommandContext {
    return {
      actorType: this.ledgerActorType(actor),
      authorizationRuleId,
      command,
      decidedAt: this.clock.now(),
      overrideId: null,
    };
  }

  private ledgerActorType(actor: AuthenticatedActor): LegacyMutationCommandContext['actorType'] {
    return actor.user.platformRole === 'platform_admin' ? 'platform_admin' : 'user';
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
      telemetry.manifestGenerationRuns.add(1, { mode: 'pending', outcome: 'queue_deferred' });
    }
  }

  private recordDiagnostics(report: ManifestValidationReportView): void {
    for (const diagnostic of report.diagnostics) {
      telemetry.manifestValidationDiagnostics.add(1, {
        code: diagnostic.code,
        severity: diagnostic.severity,
      });
    }
  }

  private encodeCursor(value: { id: string; revisionNumber: number }, worldId: string): string {
    const payload = Buffer.from(JSON.stringify({ ...value, worldId })).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private decodeCursor(cursor: string, worldId: string): { id: string; revisionNumber: number } {
    const parts = cursor.split('.');
    const payload = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || !payload || !signature) this.invalidCursor();
    const expected = createHmac('sha256', this.cursorSecret).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      this.invalidCursor();
    }
    if (
      actual!.toString('base64url') !== signature ||
      expected.length !== actual!.length ||
      !timingSafeEqual(expected, actual!)
    ) {
      this.invalidCursor();
    }
    try {
      const encodedPayload = Buffer.from(payload, 'base64url');
      if (encodedPayload.toString('base64url') !== payload) this.invalidCursor();
      const parsed = JSON.parse(encodedPayload.toString('utf8')) as {
        id?: unknown;
        revisionNumber?: unknown;
        worldId?: unknown;
      };
      if (
        parsed.worldId !== worldId ||
        typeof parsed.id !== 'string' ||
        typeof parsed.revisionNumber !== 'number' ||
        !Number.isSafeInteger(parsed.revisionNumber) ||
        parsed.revisionNumber < 1
      ) {
        this.invalidCursor();
      }
      return { id: parsed.id, revisionNumber: parsed.revisionNumber };
    } catch {
      this.invalidCursor();
    }
  }

  private encodeDiffCursor(
    offset: number,
    worldId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): string {
    const payload = Buffer.from(
      JSON.stringify({ fromRevisionId, kind: 'manifest-diff', offset, toRevisionId, worldId }),
    ).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private decodeDiffCursor(
    cursor: string,
    worldId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): number {
    const parts = cursor.split('.');
    const payload = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || !payload || !signature) this.invalidCursor();
    const expected = createHmac('sha256', this.cursorSecret).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      this.invalidCursor();
    }
    if (
      actual!.toString('base64url') !== signature ||
      expected.length !== actual!.length ||
      !timingSafeEqual(expected, actual!)
    ) {
      this.invalidCursor();
    }
    try {
      const encodedPayload = Buffer.from(payload, 'base64url');
      if (encodedPayload.toString('base64url') !== payload) this.invalidCursor();
      const parsed = JSON.parse(encodedPayload.toString('utf8')) as {
        fromRevisionId?: unknown;
        kind?: unknown;
        offset?: unknown;
        toRevisionId?: unknown;
        worldId?: unknown;
      };
      if (
        parsed.kind !== 'manifest-diff' ||
        parsed.worldId !== worldId ||
        parsed.fromRevisionId !== fromRevisionId ||
        parsed.toRevisionId !== toRevisionId ||
        typeof parsed.offset !== 'number' ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 1
      ) {
        this.invalidCursor();
      }
      return parsed.offset;
    } catch {
      this.invalidCursor();
    }
  }

  private assertParentPair(parent?: string, expected?: string): void {
    if ((parent === undefined) !== (expected === undefined)) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'Parent revision and expected hash must be supplied together.',
        400,
      );
    }
  }

  private assertBasePair(base: string | null, expected: string | null): void {
    if ((base === null) !== (expected === null)) {
      throw new ApplicationError(
        'VALIDATION_FAILED',
        'Base revision and expected hash must be supplied together.',
        400,
      );
    }
  }

  private invalidCursor(): never {
    throw new ApplicationError('INVALID_CURSOR', 'The manifest cursor is invalid.', 400);
  }

  private notFound(): never {
    throw new ApplicationError('NOT_FOUND', 'The manifest resource was not found.', 404);
  }
}
