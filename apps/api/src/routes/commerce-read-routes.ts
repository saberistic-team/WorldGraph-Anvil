import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ErrorEnvelopeSchema } from '@worldgraph/contracts';

import {
  CommerceBusinessPageSchema,
  CommerceEmploymentCandidatePageSchema,
  CommerceEmploymentContractPageSchema,
  CommerceEmploymentOfferPageSchema,
  CommerceFacilityPageSchema,
  CommerceInventoryPageSchema,
  CommerceJobPageSchema,
  CommerceMarketListingPageSchema,
  CommerceMarketTradePageSchema,
  CommerceProductionRunPageSchema,
  CommercePurchasePreviewSchema,
  CommerceReadListingParamsSchema,
  CommerceReadBusinessParamsSchema,
  CommerceReadPageQuerySchema,
  CommerceReadWorldParamsSchema,
  CommerceRecipePageSchema,
  CommerceReconciliationSummaryV1Schema,
  CommerceResourcePageSchema,
  CommerceTaxAssessmentPageSchema,
  CommerceTransactionPageSchema,
  CommerceTreasurySummarySchema,
  EmploymentPageQuerySchema,
  InventoryPageQuerySchema,
  MarketListingPageQuerySchema,
  MarketTradePageQuerySchema,
  ProductionRunPageQuerySchema,
  PurchasePreviewQuerySchema,
  ResourcePageQuerySchema,
  type CommerceReadPageQuery,
  type EmploymentPageQuery,
  type InventoryPageQuery,
  type MarketListingPageQuery,
  type MarketTradePageQuery,
  type ProductionRunPageQuery,
  type PurchasePreviewQuery,
  type ResourcePageQuery,
} from '../economy/commerce-read-contracts.js';
import type { CommerceReadService } from '../economy/commerce-read-service.js';
import type { AuthenticatedActor } from '../identity/service.js';

const commonErrors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  500: ErrorEnvelopeSchema,
};

export interface CommerceReadAuthentication {
  authenticate(request: FastifyRequest): Promise<AuthenticatedActor>;
}

export async function registerCommerceReadRoutes(
  app: FastifyInstance,
  service: CommerceReadService,
  authentication: CommerceReadAuthentication,
): Promise<void> {
  const read = { rateLimit: { max: 120, timeWindow: '1 minute' } };

  app.get<{ Params: { id: string }; Querystring: ResourcePageQuery }>(
    '/api/v1/worlds/:id/economy/resources',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: ResourcePageQuerySchema,
        response: { 200: CommerceResourcePageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.resources(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: CommerceReadPageQuery }>(
    '/api/v1/worlds/:id/economy/recipes',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceRecipePageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.recipes(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string }; Querystring: InventoryPageQuery }>(
    '/api/v1/worlds/:id/economy/inventories',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: InventoryPageQuerySchema,
        response: { 200: CommerceInventoryPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.inventories(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: CommerceReadPageQuery }>(
    '/api/v1/worlds/:id/economy/businesses',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceBusinessPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.businesses(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: CommerceReadPageQuery }>(
    '/api/v1/worlds/:id/economy/facilities',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceFacilityPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.facilities(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: CommerceReadPageQuery }>(
    '/api/v1/worlds/:id/economy/employment/offers',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceEmploymentOfferPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.employmentOffers(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{
    Params: { businessId: string; id: string };
    Querystring: CommerceReadPageQuery;
  }>(
    '/api/v1/worlds/:id/economy/businesses/:businessId/employment-candidates',
    {
      config: read,
      schema: {
        params: CommerceReadBusinessParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceEmploymentCandidatePageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.employmentCandidates(
        await authentication.authenticate(request),
        request.params.id,
        request.params.businessId,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: EmploymentPageQuery }>(
    '/api/v1/worlds/:id/economy/employment/contracts',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: EmploymentPageQuerySchema,
        response: { 200: CommerceEmploymentContractPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.employmentContracts(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: CommerceReadPageQuery }>(
    '/api/v1/worlds/:id/economy/employment/jobs',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceJobPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.jobs(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string }; Querystring: ProductionRunPageQuery }>(
    '/api/v1/worlds/:id/economy/production-runs',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: ProductionRunPageQuerySchema,
        response: { 200: CommerceProductionRunPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.productionRuns(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: MarketListingPageQuery }>(
    '/api/v1/worlds/:id/economy/market/listings',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: MarketListingPageQuerySchema,
        response: { 200: CommerceMarketListingPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.marketListings(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: MarketTradePageQuery }>(
    '/api/v1/worlds/:id/economy/market/trades',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: MarketTradePageQuerySchema,
        response: { 200: CommerceMarketTradePageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.marketTrades(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{
    Params: { id: string; listingId: string };
    Querystring: PurchasePreviewQuery;
  }>(
    '/api/v1/worlds/:id/economy/market/listings/:listingId/purchase-preview',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: CommerceReadListingParamsSchema,
        querystring: PurchasePreviewQuerySchema,
        response: { 200: CommercePurchasePreviewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.purchasePreview(
        await authentication.authenticate(request),
        request.params.id,
        request.params.listingId,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: CommerceReadPageQuery }>(
    '/api/v1/worlds/:id/economy/transactions',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceTransactionPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.transactions(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/economy/treasury',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        response: { 200: CommerceTreasurySummarySchema, ...commonErrors },
      },
    },
    async (request) =>
      service.treasury(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: CommerceReadPageQuery }>(
    '/api/v1/worlds/:id/economy/tax-assessments',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        querystring: CommerceReadPageQuerySchema,
        response: { 200: CommerceTaxAssessmentPageSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.taxAssessments(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/economy/reconciliation',
    {
      config: read,
      schema: {
        params: CommerceReadWorldParamsSchema,
        response: { 200: CommerceReconciliationSummaryV1Schema, ...commonErrors },
      },
    },
    async (request) =>
      service.reconciliation(await authentication.authenticate(request), request.params.id),
  );
}
