import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ErrorEnvelopeSchema } from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';
import {
  GovernanceAuditPageV1Schema,
  GovernanceCandidacyPageV1Schema,
  GovernanceCharterViewV1Schema,
  GovernanceElectionPageV1Schema,
  GovernanceElectionParamsSchema,
  GovernanceElectionReceiptViewV1Schema,
  GovernanceElectionResultViewV1Schema,
  GovernanceInstitutionPageV1Schema,
  GovernanceLawPageV1Schema,
  GovernanceOfficePageV1Schema,
  GovernanceOfficeTermPageV1Schema,
  GovernancePageQuerySchema,
  GovernanceProposalPageV1Schema,
  GovernanceProposalParamsSchema,
  GovernanceProposalReceiptViewV1Schema,
  GovernanceProposalResultViewV1Schema,
  GovernanceUiCapabilitiesViewV1Schema,
  GovernanceStreamQuerySchema,
  GovernanceWorldParamsSchema,
  type GovernancePageQuery,
  type GovernanceStreamQuery,
} from '../governance/api-contracts.js';
import type { GovernanceReadService } from '../governance/service.js';
import type { AuthenticatedActor } from '../identity/service.js';

const commonErrors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  500: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
};

export interface GovernanceReadAuthentication {
  authenticate(request: FastifyRequest): Promise<AuthenticatedActor>;
}

export async function registerGovernanceRoutes(
  app: FastifyInstance,
  service: GovernanceReadService,
  authentication: GovernanceReadAuthentication,
): Promise<void> {
  const read = { rateLimit: { max: 120, timeWindow: '1 minute' } };

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/governance/charter',
    {
      config: read,
      schema: {
        params: GovernanceWorldParamsSchema,
        response: { 200: GovernanceCharterViewV1Schema, ...commonErrors },
      },
    },
    async (request) =>
      service.charter(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/governance/capabilities',
    {
      config: read,
      schema: {
        params: GovernanceWorldParamsSchema,
        response: { 200: GovernanceUiCapabilitiesViewV1Schema, ...commonErrors },
      },
    },
    async (request) =>
      service.capabilities(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: GovernancePageQuery }>(
    '/api/v1/worlds/:id/governance/institutions',
    pageRoute(GovernanceInstitutionPageV1Schema),
    async (request) =>
      service.institutions(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: GovernancePageQuery }>(
    '/api/v1/worlds/:id/governance/laws',
    pageRoute(GovernanceLawPageV1Schema),
    async (request) =>
      service.laws(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string }; Querystring: GovernancePageQuery }>(
    '/api/v1/worlds/:id/governance/offices',
    pageRoute(GovernanceOfficePageV1Schema),
    async (request) =>
      service.offices(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string }; Querystring: GovernancePageQuery }>(
    '/api/v1/worlds/:id/governance/terms',
    pageRoute(GovernanceOfficeTermPageV1Schema),
    async (request) =>
      service.terms(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string }; Querystring: GovernancePageQuery }>(
    '/api/v1/worlds/:id/governance/proposals',
    pageRoute(GovernanceProposalPageV1Schema),
    async (request) =>
      service.proposals(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string; proposalId: string } }>(
    '/api/v1/worlds/:id/governance/proposals/:proposalId/receipt',
    itemRoute(GovernanceProposalParamsSchema, GovernanceProposalReceiptViewV1Schema),
    async (request) =>
      service.proposalReceipt(
        await authentication.authenticate(request),
        request.params.id,
        request.params.proposalId,
      ),
  );

  app.get<{ Params: { id: string; proposalId: string } }>(
    '/api/v1/worlds/:id/governance/proposals/:proposalId/result',
    itemRoute(GovernanceProposalParamsSchema, GovernanceProposalResultViewV1Schema),
    async (request) =>
      service.proposalResult(
        await authentication.authenticate(request),
        request.params.id,
        request.params.proposalId,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: GovernancePageQuery }>(
    '/api/v1/worlds/:id/governance/elections',
    pageRoute(GovernanceElectionPageV1Schema),
    async (request) =>
      service.elections(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{
    Params: { electionId: string; id: string };
    Querystring: GovernancePageQuery;
  }>(
    '/api/v1/worlds/:id/governance/elections/:electionId/candidates',
    {
      config: read,
      schema: {
        params: GovernanceElectionParamsSchema,
        querystring: GovernancePageQuerySchema,
        response: { 200: GovernanceCandidacyPageV1Schema, ...commonErrors },
      },
    },
    async (request) =>
      service.candidacies(
        await authentication.authenticate(request),
        request.params.id,
        request.params.electionId,
        request.query,
      ),
  );

  app.get<{ Params: { electionId: string; id: string } }>(
    '/api/v1/worlds/:id/governance/elections/:electionId/receipt',
    itemRoute(GovernanceElectionParamsSchema, GovernanceElectionReceiptViewV1Schema),
    async (request) =>
      service.electionReceipt(
        await authentication.authenticate(request),
        request.params.id,
        request.params.electionId,
      ),
  );

  app.get<{ Params: { electionId: string; id: string } }>(
    '/api/v1/worlds/:id/governance/elections/:electionId/result',
    itemRoute(GovernanceElectionParamsSchema, GovernanceElectionResultViewV1Schema),
    async (request) =>
      service.electionResult(
        await authentication.authenticate(request),
        request.params.id,
        request.params.electionId,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: GovernancePageQuery }>(
    '/api/v1/worlds/:id/governance/audit',
    pageRoute(GovernanceAuditPageV1Schema),
    async (request) =>
      service.audit(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string }; Querystring: GovernanceStreamQuery }>(
    '/api/v1/worlds/:id/governance/stream',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        params: GovernanceWorldParamsSchema,
        querystring: GovernanceStreamQuerySchema,
        response: commonErrors,
      },
    },
    async (request, reply) => {
      const actor = await authentication.authenticate(request);
      const after = streamCursor(request.headers['last-event-id'], request.query.after);
      return streamGovernance(reply, request, service, actor, request.params.id, after);
    },
  );

  function pageRoute(responseSchema: object) {
    return {
      config: read,
      schema: {
        params: GovernanceWorldParamsSchema,
        querystring: GovernancePageQuerySchema,
        response: { 200: responseSchema, ...commonErrors },
      },
    };
  }

  function itemRoute(paramsSchema: object, responseSchema: object) {
    return {
      config: read,
      schema: {
        params: paramsSchema,
        response: { 200: responseSchema, ...commonErrors },
      },
    };
  }
}

async function streamGovernance(
  reply: FastifyReply,
  request: FastifyRequest,
  service: GovernanceReadService,
  actor: AuthenticatedActor,
  worldId: string,
  initialCursor: string,
): Promise<void> {
  let cursor = initialCursor;
  let lastHeartbeat = Date.now();
  const closeAt = Date.now() + 55_000;
  const disconnected = new Promise<void>((resolve) => request.raw.once('close', resolve));
  reply.hijack();
  reply.raw.writeHead(200, {
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  });
  reply.raw.write(': worldgraph-governance-stream-v1\n\n');

  try {
    while (!reply.raw.destroyed && Date.now() < closeAt) {
      const batch = await service.streamBatch(actor, worldId, cursor);
      for (const event of batch.events) {
        reply.raw.write(`id: ${event.eventCursor}\n`);
        reply.raw.write(`event: ${event.eventType}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      cursor = batch.nextCursor;
      if (batch.events.length > 0) {
        lastHeartbeat = Date.now();
        continue;
      }
      if (Date.now() - lastHeartbeat >= 15_000) {
        reply.raw.write(`: heartbeat ${cursor}\n\n`);
        lastHeartbeat = Date.now();
      }
      await Promise.race([delay(750), disconnected]);
    }
  } finally {
    if (!reply.raw.destroyed) reply.raw.end();
  }
}

function streamCursor(lastEventId: string | string[] | undefined, queryAfter?: string): string {
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  const value = header ?? queryAfter ?? '0';
  if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    throw new ApplicationError('CURSOR_INVALID', 'The governance event cursor is invalid.', 400);
  }
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
