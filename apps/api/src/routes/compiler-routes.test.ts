import Fastify, { type FastifyInstance } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { HARBOR_CITY_ECONOMY_PRIMITIVES, STARTER_PRIMITIVES } from '@worldgraph/catalog';
import {
  compileWorld,
  createCompilerInputBundle,
  memberPrincipalKey,
  verifyCompiledArtifact,
} from '@worldgraph/compiler';
import {
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_VERSION,
  type CompiledArtifactV3,
} from '@worldgraph/contracts';
import {
  createDeterministicHarborCityFallback,
  harborCityManifestCatalog,
} from '@worldgraph/manifests';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedActor } from '../identity/service.js';
import type { CompilationService } from '../compilation/service.js';
import { registerCompilerRoutes, type CompilerRouteAuthentication } from './compiler-routes.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const runId = '018f8652-3cb6-7d52-904b-cce7901d7e30';
const revisionId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
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

const authentication: CompilerRouteAuthentication = {
  authenticate: async () => actor,
  command: () => ({ idempotencyKey: 'compiler-route-test', requestId: 'request-test' }),
  mutation: async () => actor,
};

function currentCompiledArtifact(): CompiledArtifactV3 {
  const fallback = createDeterministicHarborCityFallback({
    catalog: harborCityManifestCatalog(),
    prompt:
      'A harbor city with guild workshops, iron and energy production, paid jobs, a fixed-price market, and public sales tax.',
    seed: 'compiler-route-artifact-v2',
  });
  const pinned = new Set(fallback.envelope.manifest.primitiveRefs.map((entry) => entry.key));
  const result = compileWorld(
    createCompilerInputBundle({
      activeMembers: [
        {
          principalKey: memberPrincipalKey(worldId, actor.user.id),
          role: 'creator',
        },
      ],
      manifest: fallback.envelope.manifest,
      primitives: [...STARTER_PRIMITIVES, ...HARBOR_CITY_ECONOMY_PRIMITIVES]
        .filter((primitive) => pinned.has(primitive.input.key))
        .map((primitive) => ({
          contentHash: primitive.contentHash,
          definition: primitive.input,
          lifecycle: 'published' as const,
          primitiveVersionId: primitive.versionId,
        })),
      seed: 'compiler-route-artifact-v2',
    }),
  );
  if (!result.artifact) throw new Error('Current compiler fixture did not emit an artifact.');
  return result.artifact;
}

function testApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
  });
  addFormats(ajv);
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema));
  app.setErrorHandler((error, _request, reply) => {
    const validationFailed = typeof error === 'object' && error !== null && 'validation' in error;

    return reply.code(validationFailed ? 400 : 500).send({
      error: {
        code: validationFailed ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR',
        message: validationFailed ? 'Request invalid.' : 'Failed.',
        requestId: '018f8652-3cb6-7d52-904b-cce7901d7e99',
      },
    });
  });
  return app;
}

function run() {
  return {
    artifactHash: null,
    completedAt: null,
    compilerConfigVersion: 1 as const,
    compilerVersion: '1.0.0' as const,
    diagnostics: [],
    id: runId,
    inputHash: 'a'.repeat(64),
    manifestRevisionId: revisionId,
    progressPercent: 0,
    queuedAt: '2026-07-21T12:00:00.000Z',
    requestedByUserId: actor.user.id,
    rowVersion: 1,
    seed: 'route-seed',
    stage: 'queued' as const,
    startedAt: null,
    status: 'queued' as const,
    worldId,
  };
}

describe('compiler routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('registers every nested artifact/diagnostic/neighbor schema and validates starts', async () => {
    const start = vi.fn(async () => ({
      rowVersion: 1,
      runId,
      stage: 'queued' as const,
      status: 'queued' as const,
    }));
    const service = {
      artifact: async () => {
        throw new Error('not invoked');
      },
      cancel: async () => run(),
      get: async () => run(),
      getEntity: async () => {
        throw new Error('not invoked');
      },
      listEntities: async () => {
        throw new Error('not invoked');
      },
      listRelationships: async () => {
        throw new Error('not invoked');
      },
      neighbors: async () => {
        throw new Error('not invoked');
      },
      retry: async () => ({
        rowVersion: 2,
        runId,
        stage: 'queued' as const,
        status: 'queued' as const,
      }),
      runtimeSummary: async () => {
        throw new Error('not invoked');
      },
      start,
    } as unknown as CompilationService;
    const app = testApp();
    apps.push(app);
    await registerCompilerRoutes(app, service, authentication);

    const invalid = await app.inject({
      headers: { 'idempotency-key': 'compiler-route-test' },
      method: 'POST',
      payload: {
        clientCompiledArtifact: {},
        expectedManifestHash: 'a'.repeat(64),
        manifestRevisionId: revisionId,
        seed: 'route-seed',
      },
      url: `/api/v1/worlds/${worldId}/compilations`,
    });
    const accepted = await app.inject({
      headers: { 'idempotency-key': 'compiler-route-test' },
      method: 'POST',
      payload: {
        expectedManifestHash: 'a'.repeat(64),
        manifestRevisionId: revisionId,
        seed: 'route-seed',
      },
      url: `/api/v1/worlds/${worldId}/compilations`,
    });
    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/compilations/${runId}/diagnostics`,
    });

    expect(invalid.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(202);
    expect(start).toHaveBeenCalledOnce();
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual({ diagnostics: [], inputHash: 'a'.repeat(64), runId });
  });

  it('rejects unbounded graph query controls before the service', async () => {
    const listEntities = vi.fn();
    const app = testApp();
    apps.push(app);
    await registerCompilerRoutes(
      app,
      { listEntities } as unknown as CompilationService,
      authentication,
    );
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/entities?limit=101`,
    });
    expect(response.statusCode).toBe(400);
    expect(listEntities).not.toHaveBeenCalled();
  });

  it('serializes the complete verifiable artifact for the current compiler pair', async () => {
    const artifact = currentCompiledArtifact();
    const app = testApp();
    apps.push(app);
    await registerCompilerRoutes(
      app,
      { artifact: async () => artifact } as unknown as CompilationService,
      authentication,
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/compilations/${runId}/artifact`,
    });
    const serialized = response.json<CompiledArtifactV3>();

    expect(response.statusCode, response.body).toBe(200);
    expect(serialized).toEqual(artifact);
    expect(serialized).toMatchObject({
      artifactSchemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
      world: {
        artifactSchemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
        compilerVersion: COMPILER_VERSION,
        economySeedPlan: { economySeedPlanSchemaVersion: 2 },
      },
    });
    expect(verifyCompiledArtifact(serialized)).toMatchObject({ valid: true });
  });

  it('serializes discriminated graph payloads without strict-schema warnings', async () => {
    const listEntities = vi.fn(async () => ({
      items: [
        {
          createdWorldVersionId: revisionId,
          entitySchemaVersion: 1,
          entityType: 'district',
          logicalKey: 'district:civic-platform',
          retiredWorldVersionId: null,
          rowVersion: 0,
          state: { name: 'Civic Platform', parameters: {}, primitiveRef: 'civic-district' },
          worldId,
        },
      ],
      nextCursor: null,
      runtime: {
        activeWorldVersionId: revisionId,
        stateRevision: 0,
        worldVersionNumber: 1,
      },
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = testApp();
    apps.push(app);
    await registerCompilerRoutes(
      app,
      { listEntities } as unknown as CompilationService,
      authentication,
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/entities`,
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      items: Array<{ entityType: string; state: Record<string, unknown> }>;
    }>();
    expect(payload.items[0]).toMatchObject({
      entityType: 'district',
      state: { name: 'Civic Platform', parameters: {}, primitiveRef: 'civic-district' },
    });
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
