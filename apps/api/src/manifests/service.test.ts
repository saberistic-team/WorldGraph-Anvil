import { describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '@worldgraph/config';
import type { ApplicationNotification } from '@worldgraph/contracts';
import {
  attachManifestGenerationWarnings,
  createDeterministicFallback,
  manifestGenerationRequestHash,
  starterManifestCatalog,
  validateWorldManifest,
} from '@worldgraph/manifests';

import type { AuthenticatedActor } from '../identity/service.js';
import type { ManifestRepository } from './repository.js';
import { ManifestService } from './service.js';

const actor = {
  csrfHash: Buffer.alloc(32),
  session: {
    absoluteExpiresAt: '2026-07-22T12:00:00.000Z',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e20',
    idleExpiresAt: '2026-07-21T13:00:00.000Z',
  },
  user: {
    displayName: 'Creator',
    email: 'creator@example.test',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e21',
    platformRole: 'user',
    rowVersion: 1,
    status: 'active',
  },
} as AuthenticatedActor;

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const config = loadRuntimeConfig({
  ALLOWED_ORIGINS: 'http://localhost:3000',
  AUTH_PEPPER: 'test-only-auth-pepper-at-least-32-characters',
  DATABASE_URL: 'postgres://worldgraph:worldgraph@localhost:5432/worldgraph',
  NODE_ENV: 'test',
  REDIS_URL: 'redis://localhost:6379',
});

function ids() {
  let value = 30;
  return {
    next: () => `018f8652-3cb6-7d52-904b-${String(value++).padStart(12, '0')}`,
  };
}

describe('ManifestService', () => {
  it('persists a deterministic explicit seed and publishes only a wake-safe hash', async () => {
    let inserted:
      | {
          inputHash: string;
          prompt: string;
          providerConfigurationId: string;
          seed: string;
        }
      | undefined;
    const notifications: ApplicationNotification[] = [];
    const repository = {
      activeGenerationCounts: async () => ({ user: 0, world: 0 }),
      beginIdempotency: async () => ({ kind: 'new' as const }),
      completeIdempotency: async () => undefined,
      createGeneration: async (input: typeof inserted & { runId: string; worldId: string }) => {
        inserted = input;
        return { id: input.runId, rowVersion: 1, status: 'queued', worldId: input.worldId };
      },
      findGenerationByInput: async () => null,
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'creator' as const,
        rowVersion: 1,
        worldId,
      }),
      insertAudit: async () => undefined,
      latestRevisionNumber: async () => 0,
      lockGenerationUser: async () => undefined,
      transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(repository),
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      config,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async (notification) => void notifications.push(notification) },
      'cursor-secret-at-least-32-characters',
    );

    const response = await service.startGeneration(
      actor,
      worldId,
      { prompt: 'An energy-scarce floating city-state governed by competing guilds.' },
      { idempotencyKey: 'manifest-start-001', requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29' },
    );

    expect(response).toMatchObject({ rowVersion: 1, status: 'queued' });
    expect(inserted?.seed).toMatch(/^request-[a-f0-9]{32}$/u);
    expect(inserted?.inputHash).toBe(
      manifestGenerationRequestHash({
        expectedParentContentHash: null,
        parentRevisionId: null,
        prompt: inserted!.prompt,
        providerConfigurationId: 'disabled-v1',
        seed: inserted!.seed,
      }),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      payload: { inputHash: inserted?.inputHash, runId: response.runId, worldId },
      type: 'ManifestGenerationRequested',
    });
    expect(JSON.stringify(notifications)).not.toContain(inserted?.prompt);
  });

  it('admits only one active root generation even when configured world concurrency is higher', async () => {
    let createCalls = 0;
    const repository = {
      activeGenerationCounts: async () => ({ user: 1, world: 1 }),
      beginIdempotency: async () => ({ kind: 'new' as const }),
      completeIdempotency: async () => undefined,
      createGeneration: async () => {
        createCalls += 1;
        throw new Error('unexpected create');
      },
      findGenerationByInput: async () => null,
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'creator' as const,
        rowVersion: 1,
        worldId,
      }),
      latestRevisionNumber: async () => 0,
      lockGenerationUser: async () => undefined,
      transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(repository),
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      loadRuntimeConfig({
        ALLOWED_ORIGINS: 'http://localhost:3000',
        AUTH_PEPPER: 'test-only-auth-pepper-at-least-32-characters',
        DATABASE_URL: 'postgres://worldgraph:worldgraph@localhost:5432/worldgraph',
        MANIFEST_GENERATION_MAX_CONCURRENT_PER_USER: '5',
        MANIFEST_GENERATION_MAX_CONCURRENT_PER_WORLD: '3',
        NODE_ENV: 'test',
        REDIS_URL: 'redis://localhost:6379',
      }),
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async () => undefined },
      'cursor-secret-at-least-32-characters',
    );

    await expect(
      service.startGeneration(
        actor,
        worldId,
        { prompt: 'An energy-scarce floating city-state governed by competing guilds.' },
        {
          idempotencyKey: 'manifest-root-exclusion-001',
          requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        },
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_LIMIT', statusCode: 429 });
    expect(createCalls).toBe(0);
  });

  it('requires a parent before consulting the generation cache once revisions exist', async () => {
    let cacheLookups = 0;
    const repository = {
      beginIdempotency: async () => ({ kind: 'new' as const }),
      findGenerationByInput: async () => {
        cacheLookups += 1;
        return {
          id: '018f8652-3cb6-7d52-904b-cce7901d7e23',
          rowVersion: 2,
          status: 'succeeded' as const,
        };
      },
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'creator' as const,
        rowVersion: 1,
        worldId,
      }),
      latestRevisionNumber: async () => 1,
      lockGenerationUser: async () => undefined,
      transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(repository),
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      config,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async () => undefined },
      'cursor-secret-at-least-32-characters',
    );

    await expect(
      service.startGeneration(
        actor,
        worldId,
        { prompt: 'An energy-scarce floating city-state governed by competing guilds.' },
        {
          idempotencyKey: 'manifest-cache-parent-001',
          requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        },
      ),
    ).rejects.toMatchObject({ code: 'MANIFEST_PARENT_REQUIRED', statusCode: 409 });
    expect(cacheLookups).toBe(0);
  });

  it('requires immutable generation warnings after current-catalog revalidation', async () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({
      catalog,
      prompt: 'An energy-scarce floating city governed by competing guilds.',
      seed: 'approval-warning-snapshot',
    });
    const currentCatalog = {
      primitives: catalog.primitives.map((primitive) => ({
        ...primitive,
        lifecycle: primitive.kind === 'currency' ? ('deprecated' as const) : primitive.lifecycle,
      })),
    };
    const validation = attachManifestGenerationWarnings(
      validateWorldManifest(fallback.envelope.manifest, currentCatalog),
      fallback.envelope.warnings,
    );
    const revisionId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
    const repository = {
      beginIdempotency: async () => ({ kind: 'new' as const }),
      catalogForManifest: async () => currentCatalog,
      completeIdempotency: async () => undefined,
      generationWarnings: async () => fallback.envelope.warnings,
      getRevision: async () => ({
        approvalStatus: 'draft' as const,
        approvedAt: null,
        approvedBy: null,
        contentHash: fallback.contentHash,
        createdAt: '2026-07-21T12:00:00.000Z',
        createdBy: actor.user.id,
        generationRunId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
        id: revisionId,
        manifest: fallback.envelope.manifest,
        manifestSchemaVersion: 1 as const,
        parentRevisionId: null,
        revisionNumber: 1,
        rowVersion: 1,
        source: 'generation' as const,
        worldId,
      }),
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'creator' as const,
        rowVersion: 1,
        worldId,
      }),
      latestRevisionNumber: async () => 1,
      putValidationReport: async () => ({
        catalogSnapshotHash: validation.catalogSnapshotHash,
        createdAt: '2026-07-21T12:00:00.000Z',
        diagnostics: validation.diagnostics,
        id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        manifestRevisionId: revisionId,
        reportHash: validation.reportHash,
        valid: validation.valid,
        validatorVersion: 1 as const,
      }),
      transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(repository),
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      config,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async () => undefined },
      'cursor-secret-at-least-32-characters',
    );

    await expect(
      service.approve(
        actor,
        worldId,
        revisionId,
        {
          acknowledgedWarningCodes: ['MANIFEST_PRIMITIVE_DEPRECATED'],
          confirmationName: 'Anvil Reach',
          expectedContentHash: fallback.contentHash,
          expectedWorldVersion: 1,
        },
        {
          idempotencyKey: 'manifest-warning-requirement-001',
          requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        },
      ),
    ).rejects.toMatchObject({
      code: 'MANIFEST_WARNING_ACKNOWLEDGEMENT_REQUIRED',
      details: {
        requiredWarningCodes: [
          'FALLBACK_TEMPLATE_USED',
          'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
          'MANIFEST_PRIMITIVE_DEPRECATED',
        ],
      },
    });
  });

  it('keeps approval creator-only even for a world administrator', async () => {
    const repository = {
      beginIdempotency: async () => ({ kind: 'new' as const }),
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'administrator' as const,
        rowVersion: 1,
        worldId,
      }),
      insertAudit: async () => undefined,
      transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(repository),
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      config,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async () => undefined },
      'cursor-secret-at-least-32-characters',
    );

    await expect(
      service.approve(
        actor,
        worldId,
        '018f8652-3cb6-7d52-904b-cce7901d7e23',
        {
          acknowledgedWarningCodes: [],
          confirmationName: 'Anvil Reach',
          expectedContentHash: 'a'.repeat(64),
          expectedWorldVersion: 1,
        },
        {
          idempotencyKey: 'manifest-approve-001',
          requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('rejects unsafe YAML inside the durable command transaction', async () => {
    let transacted = false;
    const repository = {
      beginIdempotency: async () => ({ kind: 'new' as const }),
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'creator' as const,
        rowVersion: 1,
        worldId,
      }),
      transaction: async (operation: (value: unknown) => Promise<unknown>) => {
        transacted = true;
        return operation(repository);
      },
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      config,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async () => undefined },
      'cursor-secret-at-least-32-characters',
    );

    await expect(
      service.createRevision(
        actor,
        worldId,
        {
          baseRevisionId: null,
          expectedHash: null,
          format: 'yaml',
          jsonOrYaml: 'metadata: &unsafe\n  name: Bad\ncopy: *unsafe\n',
        },
        {
          idempotencyKey: 'manifest-revision-001',
          requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        },
      ),
    ).rejects.toMatchObject({ code: 'MANIFEST_YAML_INVALID', statusCode: 400 });
    expect(transacted).toBe(true);
  });

  it('returns stable diagnostics for schema-invalid safe YAML before catalog lookup', async () => {
    let catalogLookups = 0;
    const repository = {
      activeGenerationCounts: async () => ({ user: 0, world: 0 }),
      beginIdempotency: async () => ({ kind: 'new' as const }),
      catalogForManifest: async () => {
        catalogLookups += 1;
        throw new Error('catalog lookup must not run');
      },
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'creator' as const,
        rowVersion: 1,
        worldId,
      }),
      latestRevisionNumber: async () => 0,
      transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(repository),
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      config,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async () => undefined },
      'cursor-secret-at-least-32-characters',
    );

    let failure: unknown;
    try {
      await service.createRevision(
        actor,
        worldId,
        {
          baseRevisionId: null,
          expectedHash: null,
          format: 'yaml',
          jsonOrYaml: 'metadata:\n  name: "Bad"\n',
        },
        {
          idempotencyKey: 'manifest-invalid-json-001',
          requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'MANIFEST_INVALID', statusCode: 400 });
    const diagnostics = (failure as { details?: { diagnostics?: unknown } }).details?.diagnostics;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(
      (diagnostics as { code?: unknown }[]).some(
        (diagnostic) => diagnostic.code === 'MANIFEST_SCHEMA_INVALID',
      ),
    ).toBe(true);
    expect(catalogLookups).toBe(0);
  });

  it('paginates the complete contract-bounded diff with a revision-bound signed cursor', async () => {
    const fallback = createDeterministicFallback({
      catalog: starterManifestCatalog(),
      prompt: 'An energy-scarce floating city governed by competing guilds.',
      seed: 'service-large-diff',
    });
    const before = structuredClone(fallback.envelope.manifest);
    const after = structuredClone(before);
    before.extensions['worldgraph.diff-fixture'] = Array.from({ length: 7 }, () =>
      Array.from({ length: 200 }, () => 0),
    );
    after.extensions['worldgraph.diff-fixture'] = Array.from({ length: 7 }, () =>
      Array.from({ length: 200 }, () => 1),
    );
    const fromRevisionId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
    const toRevisionId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
    const repository = {
      getRevision: async (_worldId: string, revisionId: string) =>
        revisionId === fromRevisionId
          ? { contentHash: 'a'.repeat(64), id: fromRevisionId, manifest: before }
          : revisionId === toRevisionId
            ? { contentHash: 'b'.repeat(64), id: toRevisionId, manifest: after }
            : null,
      getWorldAccess: async () => ({
        currentApprovedManifestRevisionId: null,
        lifecycle: 'draft' as const,
        manifestSchemaVersion: null,
        name: 'Anvil Reach',
        role: 'observer' as const,
        rowVersion: 1,
        worldId,
      }),
    } as unknown as ManifestRepository;
    const service = new ManifestService(
      repository,
      config,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      ids(),
      { publish: async () => undefined },
      'cursor-secret-at-least-32-characters',
    );

    const first = await service.diff(actor, worldId, {
      fromRevisionId,
      limit: '200',
      toRevisionId,
    });
    expect(first.counts).toEqual({ added: 0, changed: 1_400, removed: 0 });
    expect(first.entries).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.diff(actor, worldId, {
      cursor: first.nextCursor!,
      fromRevisionId,
      limit: '200',
      toRevisionId,
    });
    expect(second.entries).toHaveLength(200);
    expect(second.entries[0]).toMatchObject({
      pointer: '/extensions/worldgraph.diff-fixture/1/0',
    });
    await expect(
      service.diff(actor, worldId, {
        cursor: `${first.nextCursor}a`,
        fromRevisionId,
        limit: '200',
        toRevisionId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR', statusCode: 400 });
  });
});
