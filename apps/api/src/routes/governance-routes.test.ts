import Fastify, { type FastifyInstance } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '../application/errors.js';
import { PostgresGovernanceReadRepository } from '../governance/repository.js';
import { GovernanceReadService } from '../governance/service.js';
import type { AuthenticatedActor } from '../identity/service.js';
import { registerGovernanceRoutes } from './governance-routes.js';

const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const foreignWorldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const proposalId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const actor = {
  user: { id: actorId, platformRole: 'user' },
} as AuthenticatedActor;

describe('governance read routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('returns the same non-enumerating result for cross-world list and item reads', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = async <Row extends QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<Row>> => {
      if (/^(?:begin|commit|rollback)/iu.test(text)) return emptyResult<Row>();
      queries.push(values ? { text, values } : { text });
      return emptyResult<Row>();
    };
    const repository = new PostgresGovernanceReadRepository({
      async connect() {
        return { query, release() {} };
      },
      query,
    });
    const authenticate = vi.fn(async () => actor);
    const app = testApp();
    apps.push(app);
    await registerGovernanceRoutes(
      app,
      new GovernanceReadService(repository, 'governance-route-test-cursor-secret'),
      { authenticate },
    );

    const [list, item] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/worlds/${foreignWorldId}/governance/proposals?limit=100`,
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/worlds/${foreignWorldId}/governance/proposals/${proposalId}/result`,
      }),
    ]);

    for (const response of [list, item]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
      });
    }
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.text).toContain('from world_memberships membership');
      expect(query.text).not.toContain('from proposals proposal');
      expect(query.text).not.toContain('from proposal_results result');
      expect(query.values).toEqual([foreignWorldId, actorId]);
    }
  });
});

function emptyResult<Row extends QueryResultRow>(): QueryResult<Row> {
  return { command: 'SELECT', fields: [], oid: 0, rowCount: 0, rows: [] };
}

function testApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    discriminator: true,
    removeAdditional: false,
    strict: true,
  });
  addFormats(ajv);
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema));
  app.setErrorHandler((error, request, reply) => {
    const failure =
      error instanceof ApplicationError
        ? error
        : new ApplicationError('INTERNAL_ERROR', 'The request failed.', 500);
    return reply.code(failure.statusCode).send({
      error: { code: failure.code, message: failure.message, requestId: request.id },
    });
  });
  return app;
}
