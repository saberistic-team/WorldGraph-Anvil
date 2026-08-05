import { createHash } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  ErrorEnvelopeSchema,
  LedgerPositiveIntegerStringSchema,
  LedgerUuidSchema,
  ScheduledActionV1Schema,
} from '@worldgraph/contracts';

import type { AuthenticatedActor } from '../identity/service.js';
import type { GovernanceRecentCredentialProof } from '@worldgraph/governance-command';
import { ApplicationError } from '../application/errors.js';
import {
  ScheduledActionPageTransportSchema,
  SimulationBatchPageTransportSchema,
  SimulationClockViewTransportSchema,
  SimulationListQueryTransportSchema,
  SubmitWorldCommandSchema,
  WorldCommandResultTransportSchema,
  WorldHistoryDetailTransportSchema,
  WorldHistoryPageTransportSchema,
  WorldHistoryQueryTransportSchema,
  WorldRuntimeHeadTransportSchema,
  type SimulationListQueryTransport,
  type SubmitWorldCommand,
  type WorldHistoryQueryTransport,
} from '../commands/api-contracts.js';
import type { WorldCommandService } from '../commands/service.js';

const WorldParams = Type.Object({ id: LedgerUuidSchema }, { additionalProperties: false });
const CommandParams = Type.Object({ commandId: LedgerUuidSchema }, { additionalProperties: false });
const HistoryParams = Type.Object(
  { id: LedgerUuidSchema, ledgerSequence: LedgerPositiveIntegerStringSchema },
  { additionalProperties: false },
);
const ScheduledActionParams = Type.Object(
  { id: LedgerUuidSchema, scheduleId: LedgerUuidSchema },
  { additionalProperties: false },
);
const MutationHeaders = Type.Object(
  {
    'x-csrf-token': Type.Optional(Type.String({ maxLength: 128, minLength: 32 })),
    'x-recent-credential-proof': Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: true },
);
const CommandOrErrorSchema = Type.Union([WorldCommandResultTransportSchema, ErrorEnvelopeSchema]);
const commonErrors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  500: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
};

export interface CommandRouteAuthentication {
  authenticate(request: FastifyRequest): Promise<AuthenticatedActor>;
  mutation(request: FastifyRequest): Promise<AuthenticatedActor>;
  recentCredential?(
    actor: AuthenticatedActor,
    proofToken: string | undefined,
    command: SubmitWorldCommand,
  ): GovernanceRecentCredentialProof;
}

function commandRateLimitKey(request: FastifyRequest): string {
  const worldId = (request.params as { id?: string } | undefined)?.id ?? 'unknown-world';
  const session = request.cookies.wg_session ?? 'anonymous';
  const actorSessionHash = createHash('sha256').update(session, 'utf8').digest('base64url');
  return `${request.ip}:world-command:${worldId}:${actorSessionHash}`;
}

export async function registerCommandRoutes(
  app: FastifyInstance,
  service: WorldCommandService,
  authentication: CommandRouteAuthentication,
): Promise<void> {
  app.post<{ Body: SubmitWorldCommand; Params: { id: string } }>(
    '/api/v1/worlds/:id/commands',
    {
      config: {
        rateLimit: { keyGenerator: commandRateLimitKey, max: 30, timeWindow: '1 minute' },
      },
      schema: {
        body: SubmitWorldCommandSchema,
        headers: MutationHeaders,
        params: WorldParams,
        response: {
          200: WorldCommandResultTransportSchema,
          403: CommandOrErrorSchema,
          404: CommandOrErrorSchema,
          409: CommandOrErrorSchema,
          422: CommandOrErrorSchema,
          401: ErrorEnvelopeSchema,
          429: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
          503: ErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = await authentication.mutation(request);
      const recentCredential = privilegedGovernanceCommand(request.body.type)
        ? authentication.recentCredential?.(
            actor,
            typeof request.headers['x-recent-credential-proof'] === 'string'
              ? request.headers['x-recent-credential-proof']
              : undefined,
            request.body,
          )
        : undefined;
      if (privilegedGovernanceCommand(request.body.type) && !recentCredential) {
        throw new ApplicationError(
          'RECENT_CREDENTIAL_REQUIRED',
          'Recent password verification is required.',
          403,
        );
      }
      const outcome = await service.submit(
        actor,
        request.params.id,
        request.body,
        request.id,
        recentCredential,
      );
      return reply.code(outcome.httpStatus).send(outcome.result);
    },
  );

  app.get<{ Params: { commandId: string } }>(
    '/api/v1/commands/:commandId',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: CommandParams,
        response: { 200: WorldCommandResultTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.command(await authentication.authenticate(request), request.params.commandId),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/runtime-head',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        response: { 200: WorldRuntimeHeadTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.runtimeHead(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/simulation/clock',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        response: { 200: SimulationClockViewTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.simulationClock(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: SimulationListQueryTransport }>(
    '/api/v1/worlds/:id/simulation/schedule',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        querystring: SimulationListQueryTransportSchema,
        response: { 200: ScheduledActionPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.schedule(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string; scheduleId: string } }>(
    '/api/v1/worlds/:id/simulation/schedule/:scheduleId',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: ScheduledActionParams,
        response: { 200: ScheduledActionV1Schema, ...commonErrors },
      },
    },
    async (request) =>
      service.scheduledAction(
        await authentication.authenticate(request),
        request.params.id,
        request.params.scheduleId,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: SimulationListQueryTransport }>(
    '/api/v1/worlds/:id/simulation/batches',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        querystring: SimulationListQueryTransportSchema,
        response: { 200: SimulationBatchPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.simulationBatches(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: WorldHistoryQueryTransport }>(
    '/api/v1/worlds/:id/history',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        querystring: WorldHistoryQueryTransportSchema,
        response: { 200: WorldHistoryPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.history(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string; ledgerSequence: string } }>(
    '/api/v1/worlds/:id/history/:ledgerSequence',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: HistoryParams,
        response: { 200: WorldHistoryDetailTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.historyEntry(
        await authentication.authenticate(request),
        request.params.id,
        request.params.ledgerSequence,
      ),
  );
}

function privilegedGovernanceCommand(type: string): boolean {
  return type === 'ExecuteCreatorOverrideV1' || type === 'RepairGovernanceResultV1';
}
