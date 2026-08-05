import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { RuntimeConfig } from '@worldgraph/config';
import {
  AcceptInvitationRequestSchema,
  AuthenticatedSessionSchema,
  ChangeMembershipRoleRequestSchema,
  CreateInvitationRequestSchema,
  CreateWorldRequestSchema,
  CreatorOverrideRequestSchema,
  CsrfResponseSchema,
  ErrorEnvelopeSchema,
  IdempotencyKeySchema,
  InvitationSchema,
  LoginRequestSchema,
  MembershipSchema,
  RecentCredentialProofSchema,
  RegisterRequestSchema,
  RemoveMembershipRequestSchema,
  RenameWorldRequestSchema,
  WorldSchema,
  type AcceptInvitationRequest,
  type ChangeMembershipRoleRequest,
  type CreateInvitationRequest,
  type CreateWorldRequest,
  type CreatorOverrideRequest,
  type LoginRequest,
  type RegisterRequest,
  type RemoveMembershipRequest,
  type RenameWorldRequest,
} from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';

import { ApplicationError } from '../application/errors.js';
import { hashSecret, normalizeEmail } from '../identity/security.js';
import type { AuthenticatedActor, IdentityService } from '../identity/service.js';
import type { WorldService } from '../worlds/service.js';
import type { PrimitiveService } from '../primitives/service.js';
import type { ManifestService } from '../manifests/service.js';
import type { CompilationService } from '../compilation/service.js';
import type { WorldCommandService } from '../commands/service.js';
import {
  GovernanceApprovalRequestTransportSchema,
  GovernanceApprovalResponseTransportSchema,
  type GovernanceApprovalRequestTransport,
  RecentCredentialRequestTransportSchema,
  type RecentCredentialRequestTransport,
} from '../commands/api-contracts.js';
import type { EconomyQueryService } from '../economy/service.js';
import type { CommerceReadService } from '../economy/commerce-read-service.js';
import type { GovernanceReadService } from '../governance/service.js';
import { registerCommerceReadRoutes } from './commerce-read-routes.js';
import { registerCommandRoutes } from './command-routes.js';
import { registerCompilerRoutes } from './compiler-routes.js';
import { registerEconomyRoutes } from './economy-routes.js';
import { registerGeographyRoutes } from '../geography/routes.js';
import { registerGovernanceRoutes } from './governance-routes.js';
import { registerManifestRoutes } from './manifest-routes.js';
import { registerPrimitiveRoutes } from './primitive-routes.js';

const SESSION_COOKIE = 'wg_session';
const CSRF_COOKIE = 'wg_csrf';
const UuidParams = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const ChildParams = Type.Object(
  { id: Type.String({ format: 'uuid' }), userId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const InvitationParams = Type.Object(
  { id: Type.String({ format: 'uuid' }), invitationId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const MutationHeaders = Type.Object(
  {
    'idempotency-key': IdempotencyKeySchema,
    'x-csrf-token': Type.Optional(Type.String({ maxLength: 128, minLength: 32 })),
  },
  { additionalProperties: true },
);
const ReauthenticationHeaders = Type.Object(
  { 'x-csrf-token': Type.Optional(Type.String({ maxLength: 128, minLength: 32 })) },
  { additionalProperties: true },
);
const PageSchema = <T>(item: T) =>
  Type.Object(
    { items: Type.Array(item as never, { maxItems: 100 }), nextCursor: Type.Null() },
    { additionalProperties: false },
  );
const MembershipMutationResponse = Type.Object(
  {
    membership: Type.Object(
      {
        role: Type.Optional(
          Type.Union([
            Type.Literal('administrator'),
            Type.Literal('player'),
            Type.Literal('observer'),
          ]),
        ),
        rowVersion: Type.Integer({ minimum: 1 }),
        userId: Type.String({ format: 'uuid' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const AcceptInvitationResponse = Type.Object(
  {
    membership: Type.Object(
      {
        role: Type.Union([Type.Literal('player'), Type.Literal('observer')]),
        worldId: Type.String({ format: 'uuid' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const CreatorOverrideResponse = Type.Object(
  {
    membership: Type.Object(
      {
        role: Type.Literal('player'),
        rowVersion: Type.Integer({ minimum: 1 }),
        userId: Type.String({ format: 'uuid' }),
      },
      { additionalProperties: false },
    ),
    override: Type.Object(
      {
        action: Type.Literal('membership.force_demote_administrator'),
        auditRecordId: Type.String({ format: 'uuid' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const AuditRecordResponse = Type.Object(
  {
    action: Type.String({ maxLength: 160 }),
    actorUserId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    category: Type.String({ maxLength: 80 }),
    id: Type.String({ format: 'uuid' }),
    occurredAt: Type.String({ format: 'date-time' }),
    outcome: Type.String({ maxLength: 20 }),
    reasonCode: Type.String({ maxLength: 120 }),
    targetId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    targetType: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export interface DomainServices {
  commerceReads?: CommerceReadService;
  commands?: WorldCommandService;
  compilation?: CompilationService;
  economy?: EconomyQueryService;
  governance?: GovernanceReadService;
  identity: IdentityService;
  manifests?: ManifestService;
  pool?: Pool;
  primitives?: PrimitiveService;
  worlds: WorldService;
}

export async function registerDomainRoutes(
  app: FastifyInstance,
  services: DomainServices,
  config: RuntimeConfig,
): Promise<void> {
  if (!config.authPepper) throw new Error('Domain routes require authentication configuration.');
  const registerRateLimit = authenticationRateLimit(app, config.authPepper, 'register', 5, 25);
  const loginRateLimit = authenticationRateLimit(app, config.authPepper, 'login', 8, 40);
  const reauthenticationRateLimit = sessionAuthenticationRateLimit(app, config.authPepper);
  const commonErrors = {
    400: ErrorEnvelopeSchema,
    401: ErrorEnvelopeSchema,
    403: ErrorEnvelopeSchema,
    404: ErrorEnvelopeSchema,
    409: ErrorEnvelopeSchema,
    429: ErrorEnvelopeSchema,
  };

  app.post<{ Body: RegisterRequest }>(
    '/api/v1/auth/register',
    {
      preHandler: registerRateLimit,
      schema: {
        body: RegisterRequestSchema,
        response: { 201: AuthenticatedSessionSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      assertAllowedOrigin(request, config);
      const issue = await services.identity.register(
        request.body,
        fingerprint(request),
        request.id,
        request.cookies[SESSION_COOKIE],
      );
      setSessionCookies(reply, issue, config);
      return reply.code(201).send(issue.response);
    },
  );

  app.post<{ Body: LoginRequest }>(
    '/api/v1/auth/login',
    {
      preHandler: loginRateLimit,
      schema: {
        body: LoginRequestSchema,
        response: { 200: AuthenticatedSessionSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      assertAllowedOrigin(request, config);
      const issue = await services.identity.login(
        request.body,
        fingerprint(request),
        request.id,
        request.cookies[SESSION_COOKIE],
      );
      setSessionCookies(reply, issue, config);
      return issue.response;
    },
  );

  app.get(
    '/api/v1/auth/me',
    { schema: { response: { 200: AuthenticatedSessionSchema, 401: ErrorEnvelopeSchema } } },
    async (request) => {
      const actor = await authenticate(request, services.identity);
      return { session: actor.session, user: actor.user };
    },
  );

  app.post(
    '/api/v1/auth/csrf',
    {
      schema: {
        response: { 200: CsrfResponseSchema, 401: ErrorEnvelopeSchema, 403: ErrorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const actor = await authenticate(request, services.identity);
      assertAllowedOrigin(request, config);
      const csrfToken = await services.identity.rotateCsrf(actor);
      setCsrfCookie(reply, csrfToken, config);
      return { csrfToken };
    },
  );

  app.post<{ Body: RecentCredentialRequestTransport }>(
    '/api/v1/auth/reauthenticate',
    {
      preHandler: reauthenticationRateLimit,
      schema: {
        body: RecentCredentialRequestTransportSchema,
        headers: ReauthenticationHeaders,
        response: { 200: RecentCredentialProofSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      const proof = await services.identity.reauthenticate(actor, request.body, request.id);
      return reply.header('cache-control', 'no-store').send(proof);
    },
  );

  app.post<{ Body: GovernanceApprovalRequestTransport }>(
    '/api/v1/auth/governance-approval',
    {
      preHandler: reauthenticationRateLimit,
      schema: {
        body: GovernanceApprovalRequestTransportSchema,
        headers: MutationHeaders,
        response: { 200: GovernanceApprovalResponseTransportSchema, ...commonErrors },
      },
    },
    async (request, reply) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      const approval = await services.identity.approveGovernanceOperation(
        actor,
        request.body,
        request.id,
        request.headers['idempotency-key'] as string,
      );
      return reply.header('cache-control', 'no-store').send(approval);
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      schema: {
        response: { 204: Type.Null(), 401: ErrorEnvelopeSchema, 403: ErrorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      let actor: AuthenticatedActor;
      try {
        actor = await authenticatedMutation(request, services.identity, config);
      } catch (error) {
        if (error instanceof ApplicationError && error.code === 'UNAUTHORIZED') {
          clearSessionCookies(reply, config);
          return reply.code(204).send();
        }
        throw error;
      }
      await services.identity.logout(actor, request.id);
      clearSessionCookies(reply, config);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/worlds',
    { schema: { response: { 200: PageSchema(WorldSchema), 401: ErrorEnvelopeSchema } } },
    async (request) => ({
      items: await services.worlds.listWorlds(await authenticate(request, services.identity)),
      nextCursor: null,
    }),
  );

  app.post<{ Body: CreateWorldRequest; Headers: MutationHeaderValues }>(
    '/api/v1/worlds',
    {
      schema: {
        body: CreateWorldRequestSchema,
        headers: MutationHeaders,
        response: { 201: Type.Object({ world: WorldSchema }), ...commonErrors },
      },
    },
    async (request, reply) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      const world = await services.worlds.createWorld(actor, request.body, commandContext(request));
      return reply.code(201).send({ world });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id',
    {
      schema: {
        params: UuidParams,
        response: { 200: Type.Object({ world: WorldSchema }), ...commonErrors },
      },
    },
    async (request) => ({
      world: await services.worlds.getWorld(
        await authenticate(request, services.identity),
        request.params.id,
      ),
    }),
  );

  app.patch<{ Body: RenameWorldRequest; Headers: MutationHeaderValues; Params: { id: string } }>(
    '/api/v1/worlds/:id',
    {
      schema: {
        body: RenameWorldRequestSchema,
        headers: MutationHeaders,
        params: UuidParams,
        response: { 200: Type.Object({ world: WorldSchema }), ...commonErrors },
      },
    },
    async (request) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      return {
        world: await services.worlds.renameWorld(
          actor,
          request.params.id,
          request.body,
          commandContext(request),
        ),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/memberships',
    {
      schema: {
        params: UuidParams,
        response: { 200: PageSchema(MembershipSchema), ...commonErrors },
      },
    },
    async (request) => ({
      items: await services.worlds.listMemberships(
        await authenticate(request, services.identity),
        request.params.id,
      ),
      nextCursor: null,
    }),
  );

  app.patch<{
    Body: ChangeMembershipRoleRequest;
    Headers: MutationHeaderValues;
    Params: { id: string; userId: string };
  }>(
    '/api/v1/worlds/:id/memberships/:userId',
    {
      schema: {
        body: ChangeMembershipRoleRequestSchema,
        headers: MutationHeaders,
        params: ChildParams,
        response: { 200: MembershipMutationResponse, ...commonErrors },
      },
    },
    async (request) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      return services.worlds.changeMembershipRole(
        actor,
        request.params.id,
        request.params.userId,
        request.body,
        commandContext(request),
      );
    },
  );

  app.delete<{
    Body: RemoveMembershipRequest;
    Headers: MutationHeaderValues;
    Params: { id: string; userId: string };
  }>(
    '/api/v1/worlds/:id/memberships/:userId',
    {
      schema: {
        body: RemoveMembershipRequestSchema,
        headers: MutationHeaders,
        params: ChildParams,
        response: { 200: MembershipMutationResponse, ...commonErrors },
      },
    },
    async (request) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      return services.worlds.removeMembership(
        actor,
        request.params.id,
        request.params.userId,
        request.body,
        commandContext(request),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/invitations',
    {
      schema: {
        params: UuidParams,
        response: { 200: PageSchema(InvitationSchema), ...commonErrors },
      },
    },
    async (request) => ({
      items: await services.worlds.listInvitations(
        await authenticate(request, services.identity),
        request.params.id,
      ),
      nextCursor: null,
    }),
  );

  app.post<{
    Body: CreateInvitationRequest;
    Headers: MutationHeaderValues;
    Params: { id: string };
  }>(
    '/api/v1/worlds/:id/invitations',
    {
      schema: {
        body: CreateInvitationRequestSchema,
        headers: MutationHeaders,
        params: UuidParams,
        response: {
          201: Type.Object({
            invitation: InvitationSchema,
            rawToken: Type.String({ minLength: 32, maxLength: 128 }),
          }),
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      return reply
        .code(201)
        .send(
          await services.worlds.createInvitation(
            actor,
            request.params.id,
            request.body,
            commandContext(request),
          ),
        );
    },
  );

  app.post<{ Headers: MutationHeaderValues; Params: { id: string; invitationId: string } }>(
    '/api/v1/worlds/:id/invitations/:invitationId/revoke',
    {
      schema: {
        headers: MutationHeaders,
        params: InvitationParams,
        response: { 200: Type.Object({ invitation: InvitationSchema }), ...commonErrors },
      },
    },
    async (request) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      return {
        invitation: await services.worlds.revokeInvitation(
          actor,
          request.params.id,
          request.params.invitationId,
          commandContext(request),
        ),
      };
    },
  );

  app.post<{ Body: AcceptInvitationRequest; Headers: MutationHeaderValues }>(
    '/api/v1/invitations/accept',
    {
      schema: {
        body: AcceptInvitationRequestSchema,
        headers: MutationHeaders,
        response: { 200: AcceptInvitationResponse, ...commonErrors },
      },
    },
    async (request) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      return services.worlds.acceptInvitation(actor, request.body, commandContext(request));
    },
  );

  app.post<{
    Body: CreatorOverrideRequest;
    Headers: MutationHeaderValues;
    Params: { id: string };
  }>(
    '/api/v1/worlds/:id/creator-overrides',
    {
      schema: {
        body: CreatorOverrideRequestSchema,
        headers: MutationHeaders,
        params: UuidParams,
        response: { 200: CreatorOverrideResponse, ...commonErrors },
      },
    },
    async (request) => {
      const actor = await authenticatedMutation(request, services.identity, config);
      return services.worlds.creatorOverride(
        actor,
        request.params.id,
        request.body,
        commandContext(request),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/authority/audit',
    {
      schema: {
        params: UuidParams,
        response: { 200: PageSchema(AuditRecordResponse), ...commonErrors },
      },
    },
    async (request) => ({
      items: await services.worlds.listAuthorityAudit(
        await authenticate(request, services.identity),
        request.params.id,
      ),
      nextCursor: null,
    }),
  );

  if (services.primitives) {
    await registerPrimitiveRoutes(app, services.primitives, services.identity, config);
  }
  if (services.manifests) {
    await registerManifestRoutes(app, services.manifests, {
      authenticate: (request) => authenticate(request, services.identity),
      command: (request) => commandContext(request),
      mutation: (request) => authenticatedMutation(request, services.identity, config),
    });
  }
  if (services.compilation) {
    await registerCompilerRoutes(app, services.compilation, {
      authenticate: (request) => authenticate(request, services.identity),
      command: (request) => commandContext(request),
      mutation: (request) => authenticatedMutation(request, services.identity, config),
    });
  }
  if (services.commands) {
    await registerCommandRoutes(app, services.commands, {
      authenticate: (request) => authenticate(request, services.identity),
      mutation: (request) => authenticatedMutation(request, services.identity, config),
      recentCredential: (actor, proofToken, command) =>
        services.identity.governanceRecentCredential(actor, proofToken, command),
    });
  }
  if (services.economy) {
    await registerEconomyRoutes(app, services.economy, {
      authenticate: (request) => authenticate(request, services.identity),
      mutation: (request) => authenticatedMutation(request, services.identity, config),
    });
  }
  if (services.commerceReads) {
    await registerCommerceReadRoutes(app, services.commerceReads, {
      authenticate: (request) => authenticate(request, services.identity),
    });
  }
  if (services.governance) {
    await registerGovernanceRoutes(app, services.governance, {
      authenticate: (request) => authenticate(request, services.identity),
    });
  }
  if (services.pool) {
    await registerGeographyRoutes(app, services.pool, {
      authenticate: (request) => authenticate(request, services.identity),
      mutation: (request) => authenticatedMutation(request, services.identity, config),
    });
  }
}

interface MutationHeaderValues {
  'idempotency-key': string;
  'x-csrf-token'?: string;
}

function commandContext(request: FastifyRequest) {
  return {
    idempotencyKey: request.headers['idempotency-key'] as string,
    requestId: request.id,
  };
}

async function authenticate(
  request: FastifyRequest,
  identity: IdentityService,
): Promise<AuthenticatedActor> {
  return identity.authenticate(request.cookies[SESSION_COOKIE]);
}

async function authenticatedMutation(
  request: FastifyRequest,
  identity: IdentityService,
  config: RuntimeConfig,
): Promise<AuthenticatedActor> {
  const actor = await authenticate(request, identity);
  assertAllowedOrigin(request, config);
  identity.assertCsrf(
    actor,
    request.cookies[CSRF_COOKIE],
    typeof request.headers['x-csrf-token'] === 'string'
      ? request.headers['x-csrf-token']
      : undefined,
  );
  return actor;
}

function assertAllowedOrigin(request: FastifyRequest, config: RuntimeConfig): void {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
    throw new ApplicationError('CSRF_INVALID', 'The request origin is not allowed.', 403);
  }
}

function fingerprint(request: FastifyRequest) {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip,
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}

function authenticationRateLimit(
  app: FastifyInstance,
  pepper: string,
  flow: 'login' | 'register',
  accountMaximum: number,
  networkMaximum: number,
) {
  const account = app.createRateLimit({
    keyGenerator: (request) => {
      const body = request.body as { email?: unknown } | undefined;
      const normalized =
        typeof body?.email === 'string' ? normalizeEmail(body.email).slice(0, 320) : 'invalid';
      return hashSecret(normalized, pepper, `worldgraph.rate_limit.${flow}.account.v1`).toString(
        'hex',
      );
    },
    max: accountMaximum,
    timeWindow: '1 minute',
  });
  const network = app.createRateLimit({
    keyGenerator: (request) =>
      hashSecret(
        coarseNetworkAddress(request.ip),
        pepper,
        `worldgraph.rate_limit.${flow}.network.v1`,
      ).toString('hex'),
    max: networkMaximum,
    timeWindow: '1 minute',
  });
  return async (request: FastifyRequest): Promise<void> => {
    const [accountResult, networkResult] = await Promise.all([account(request), network(request)]);
    const accountExceeded = !accountResult.isAllowed && accountResult.isExceeded;
    const networkExceeded = !networkResult.isAllowed && networkResult.isExceeded;
    if (accountExceeded || networkExceeded) {
      telemetry.identityAttempts.add(1, { flow, outcome: 'rate_limited' });
      throw new ApplicationError('RATE_LIMITED', 'Too many authentication attempts.', 429);
    }
  };
}

function sessionAuthenticationRateLimit(app: FastifyInstance, pepper: string) {
  const session = app.createRateLimit({
    keyGenerator: (request) =>
      hashSecret(
        request.cookies[SESSION_COOKIE] ?? 'anonymous',
        pepper,
        'worldgraph.rate_limit.reauthenticate.session.v1',
      ).toString('hex'),
    max: 5,
    timeWindow: '1 minute',
  });
  const network = app.createRateLimit({
    keyGenerator: (request) =>
      hashSecret(
        coarseNetworkAddress(request.ip),
        pepper,
        'worldgraph.rate_limit.reauthenticate.network.v1',
      ).toString('hex'),
    max: 20,
    timeWindow: '1 minute',
  });
  return async (request: FastifyRequest): Promise<void> => {
    const [sessionResult, networkResult] = await Promise.all([session(request), network(request)]);
    if (
      (!sessionResult.isAllowed && sessionResult.isExceeded) ||
      (!networkResult.isAllowed && networkResult.isExceeded)
    ) {
      telemetry.identityAttempts.add(1, { flow: 'reauthenticate', outcome: 'rate_limited' });
      throw new ApplicationError('RATE_LIMITED', 'Too many authentication attempts.', 429);
    }
  };
}

function coarseNetworkAddress(address: string): string {
  const value = address.trim();
  if (value.includes('.')) return value.split('.').slice(0, 3).join('.');
  return value.split(':').slice(0, 4).join(':');
}

function setSessionCookies(
  reply: FastifyReply,
  issue: {
    csrfToken: string;
    response: { session: { absoluteExpiresAt: string } };
    sessionToken: string;
  },
  config: RuntimeConfig,
): void {
  const options = cookieOptions(config);
  reply.setCookie(SESSION_COOKIE, issue.sessionToken, {
    ...options,
    expires: new Date(issue.response.session.absoluteExpiresAt),
    httpOnly: true,
  });
  setCsrfCookie(reply, issue.csrfToken, config);
}

function setCsrfCookie(reply: FastifyReply, csrfToken: string, config: RuntimeConfig): void {
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    ...cookieOptions(config),
    httpOnly: false,
    path: '/',
  });
}

function clearSessionCookies(reply: FastifyReply, config: RuntimeConfig): void {
  const options = cookieOptions(config);
  reply.clearCookie(SESSION_COOKIE, options);
  reply.clearCookie(CSRF_COOKIE, { ...options, path: '/' });
}

function cookieOptions(config: RuntimeConfig) {
  return {
    path: '/api/v1',
    sameSite: 'lax' as const,
    secure: config.environment === 'production',
  };
}
