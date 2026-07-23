import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ErrorEnvelopeSchema } from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import {
  AssetPageQuerySchema,
  AssetPageTransportSchema,
  AssetViewTransportSchema,
  ControlledWalletPageTransportSchema,
  CurrencyPageTransportSchema,
  EconomyRepairApprovalHeadersSchema,
  EconomyRepairApprovalRequestV1Schema,
  EconomyRepairApprovalV1Schema,
  EconomyRepairPlanParamsSchema,
  EconomyRepairPlanViewTransportSchema,
  EconomyAssetParamsSchema,
  EconomyPageQuerySchema,
  EconomySummaryTransportSchema,
  EconomyWalletParamsSchema,
  EconomyWorldParamsSchema,
  OfferPageQuerySchema,
  OfferPageTransportSchema,
  WalletTransactionPageTransportSchema,
  type AssetPageQueryTransport,
  type EconomyPageQueryTransport,
  type EconomyRepairApprovalHeadersTransport,
  type EconomyRepairApprovalRequestTransport,
  type OfferPageQueryTransport,
} from '../economy/api-contracts.js';
import type { EconomyQueryService } from '../economy/service.js';

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

export interface EconomyRouteAuthentication {
  authenticate(request: FastifyRequest): Promise<AuthenticatedActor>;
  mutation(request: FastifyRequest): Promise<AuthenticatedActor>;
}

export async function registerEconomyRoutes(
  app: FastifyInstance,
  service: EconomyQueryService,
  authentication: EconomyRouteAuthentication,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/economy/summary',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EconomyWorldParamsSchema,
        response: { 200: EconomySummaryTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.summary(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string; planId: string } }>(
    '/api/v1/worlds/:id/economy/repair-plans/:planId',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: EconomyRepairPlanParamsSchema,
        response: { 200: EconomyRepairPlanViewTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.repairPlan(
        await authentication.authenticate(request),
        request.params.id,
        request.params.planId,
      ),
  );

  app.post<{
    Body: EconomyRepairApprovalRequestTransport;
    Headers: EconomyRepairApprovalHeadersTransport;
    Params: { id: string; planId: string };
  }>(
    '/api/v1/worlds/:id/economy/repair-plans/:planId/approvals',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: EconomyRepairApprovalRequestV1Schema,
        headers: EconomyRepairApprovalHeadersSchema,
        params: EconomyRepairPlanParamsSchema,
        response: { 200: EconomyRepairApprovalV1Schema, ...commonErrors },
      },
    },
    async (request) => {
      if (request.headers['idempotency-key'] !== request.body.approvalId) {
        throw new ApplicationError(
          'IDEMPOTENCY_KEY_MISMATCH',
          'The idempotency key must match the approval id.',
          400,
        );
      }
      return service.approveRepair(
        await authentication.mutation(request),
        request.params.id,
        request.params.planId,
        request.body,
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/economy/currencies',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EconomyWorldParamsSchema,
        response: { 200: CurrencyPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.currencies(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: EconomyPageQueryTransport }>(
    '/api/v1/worlds/:id/economy/wallets',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EconomyWorldParamsSchema,
        querystring: EconomyPageQuerySchema,
        response: { 200: ControlledWalletPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.wallets(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{
    Params: { id: string; walletId: string };
    Querystring: EconomyPageQueryTransport;
  }>(
    '/api/v1/worlds/:id/economy/wallets/:walletId/transactions',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EconomyWalletParamsSchema,
        querystring: EconomyPageQuerySchema,
        response: { 200: WalletTransactionPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.walletTransactions(
        await authentication.authenticate(request),
        request.params.id,
        request.params.walletId,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: AssetPageQueryTransport }>(
    '/api/v1/worlds/:id/assets',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EconomyWorldParamsSchema,
        querystring: AssetPageQuerySchema,
        response: { 200: AssetPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.assets(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { assetKey: string; id: string } }>(
    '/api/v1/worlds/:id/assets/:assetKey',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EconomyAssetParamsSchema,
        response: { 200: AssetViewTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.asset(
        await authentication.authenticate(request),
        request.params.id,
        request.params.assetKey,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: OfferPageQueryTransport }>(
    '/api/v1/worlds/:id/asset-transfer-offers',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EconomyWorldParamsSchema,
        querystring: OfferPageQuerySchema,
        response: { 200: OfferPageTransportSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.offers(await authentication.authenticate(request), request.params.id, request.query),
  );
}
