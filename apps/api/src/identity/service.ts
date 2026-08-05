import type { RuntimeConfig } from '@worldgraph/config';
import type {
  AuthenticatedSession,
  Clock,
  IdGenerator,
  LoginRequest,
  RecentCredentialProof,
  RegisterRequest,
} from '@worldgraph/contracts';
import {
  governanceRecentCredentialCommandHashV1,
  governanceTwoPersonApprovalBindingHashV1,
  governanceTwoPersonApprovalRequestHashV1,
  type GovernanceRecentCredentialProof,
  type GovernanceTwoPersonCommand,
} from '@worldgraph/governance-command';
import { telemetry } from '@worldgraph/observability';

import { ApplicationError } from '../application/errors.js';
import type { NotificationSink } from '../application/notifications.js';
import type {
  GovernanceApprovalRequestTransport,
  GovernanceApprovalResponseTransport,
  RecentCredentialRequestTransport,
} from '../commands/api-contracts.js';
import type { ActorRecord, SessionWrite } from '../repositories/postgres-repository.js';
import type { PostgresRepository } from '../repositories/postgres-repository.js';
import type { Argon2idPasswordHasher } from './security.js';
import {
  deriveInvitationToken,
  generateOpaqueToken,
  hashSecret,
  normalizeDisplayName,
  normalizeEmail,
  redactAuditMetadata,
  secretsMatch,
} from './security.js';

export interface RequestFingerprint {
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionIssue {
  csrfToken: string;
  response: AuthenticatedSession;
  sessionToken: string;
}

type IdentityRuntimeConfig = RuntimeConfig & { authPepper: string };

export type AuthenticatedActor = ActorRecord;

export class IdentityService {
  private dummyHash: Promise<string> | undefined;

  public constructor(
    private readonly repository: PostgresRepository,
    private readonly config: IdentityRuntimeConfig,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly passwordHasher: Argon2idPasswordHasher,
    private readonly notifications: NotificationSink,
  ) {}

  public invitationToken(invitationId: string): string {
    return deriveInvitationToken(invitationId, this.config.authPepper);
  }

  public tokenHash(
    rawToken: string,
    domain: 'csrf' | 'invitation' | 'session' | 'step_up',
  ): Buffer {
    return hashSecret(rawToken, this.config.authPepper, `worldgraph.${domain}.v1`);
  }

  public async register(
    input: RegisterRequest,
    fingerprint: RequestFingerprint,
    requestId: string,
    previousSessionToken?: string,
  ): Promise<SessionIssue> {
    if (!this.config.enableLocalRegistration) {
      throw new ApplicationError(
        'REGISTRATION_UNAVAILABLE',
        'Registration could not be completed.',
        403,
      );
    }
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    const passwordHash = await this.passwordHasher.hash(input.password);
    const userId = this.ids.next();
    const issue = this.newSession(userId, fingerprint);

    const response = await this.repository.transaction(async (repository) => {
      if (previousSessionToken) {
        await repository.revokeSessionByTokenHash(
          this.tokenHash(previousSessionToken, 'session'),
          'session_rotation',
        );
      }
      const user = await repository.insertUser({ displayName, email, id: userId, passwordHash });
      const session = await repository.insertSession(issue.write);
      await repository.insertAudit({
        action: 'identity.registered',
        actorUserId: user.id,
        category: 'identity',
        correlationId: requestId,
        id: this.ids.next(),
        metadata: redactAuditMetadata({ registrationMode: 'closed_alpha_local' }),
        outcome: 'allowed',
        reasonCode: 'IDENTITY_REGISTERED',
        requestId,
        targetId: user.id,
        targetType: 'user',
      });
      return { session, user };
    });
    await this.notifications.publish({
      id: this.ids.next(),
      occurredAt: this.clock.now().toISOString(),
      payload: { userId },
      schemaVersion: 1,
      type: 'IdentityRegistered',
    });
    telemetry.identityAttempts.add(1, { flow: 'register', outcome: 'succeeded' });
    telemetry.sessionLifecycle.add(1, { outcome: 'created' });
    return { csrfToken: issue.csrfToken, response, sessionToken: issue.sessionToken };
  }

  public async login(
    input: LoginRequest,
    fingerprint: RequestFingerprint,
    requestId: string,
    previousSessionToken?: string,
  ): Promise<SessionIssue> {
    const email = normalizeEmail(input.email);
    const credential = await this.repository.findCredential(email);
    const encodedHash = credential?.passwordHash ?? (await this.getDummyHash());
    const valid = await this.passwordHasher.verify(encodedHash, input.password);
    if (!credential || !valid) {
      await this.repository.insertAudit({
        action: 'identity.login',
        actorUserId: null,
        category: 'identity',
        correlationId: requestId,
        id: this.ids.next(),
        metadata: { credentialResult: 'generic_failure' },
        outcome: 'denied',
        reasonCode: 'AUTHENTICATION_FAILED',
        requestId,
      });
      telemetry.identityAttempts.add(1, { flow: 'login', outcome: 'failed' });
      throw new ApplicationError('AUTHENTICATION_FAILED', 'Authentication failed.', 401);
    }
    const issue = this.newSession(credential.user.id, fingerprint);
    const response = await this.repository.transaction(async (repository) => {
      if (previousSessionToken) {
        await repository.revokeSessionByTokenHash(
          this.tokenHash(previousSessionToken, 'session'),
          'session_rotation',
        );
      }
      const session = await repository.insertSession(issue.write);
      await repository.touchLogin(credential.user.id);
      await repository.insertAudit({
        action: 'identity.login',
        actorUserId: credential.user.id,
        category: 'identity',
        correlationId: requestId,
        id: this.ids.next(),
        outcome: 'allowed',
        reasonCode: 'AUTHENTICATION_SUCCEEDED',
        requestId,
        targetId: session.id,
        targetType: 'session',
      });
      return { session, user: credential.user };
    });
    telemetry.identityAttempts.add(1, { flow: 'login', outcome: 'succeeded' });
    telemetry.sessionLifecycle.add(1, { outcome: 'created' });
    return { csrfToken: issue.csrfToken, response, sessionToken: issue.sessionToken };
  }

  public async authenticate(sessionToken: string | undefined): Promise<AuthenticatedActor> {
    if (!sessionToken || sessionToken.length < 32 || sessionToken.length > 128) {
      throw new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401);
    }
    const actor = await this.repository.authenticateSession(
      this.tokenHash(sessionToken, 'session'),
      this.config.sessionIdleTtlSeconds,
    );
    if (!actor) throw new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401);
    return actor;
  }

  public async reauthenticate(
    actor: AuthenticatedActor,
    input: RecentCredentialRequestTransport,
    requestId: string,
  ): Promise<RecentCredentialProof> {
    const credential = await this.repository.findCredential(actor.user.email);
    const encodedHash = credential?.passwordHash ?? (await this.getDummyHash());
    const valid = await this.passwordHasher.verify(encodedHash, input.password);
    if (!credential || credential.user.id !== actor.user.id || !valid) {
      await this.repository.insertAudit({
        action: 'identity.reauthenticate',
        actorUserId: actor.user.id,
        category: 'identity',
        correlationId: requestId,
        id: this.ids.next(),
        metadata: { credentialResult: 'generic_failure', commandType: input.command.type },
        outcome: 'denied',
        reasonCode: 'REAUTHENTICATION_FAILED',
        requestId,
        targetId: actor.session.id,
        targetType: 'session',
      });
      telemetry.identityAttempts.add(1, { flow: 'reauthenticate', outcome: 'failed' });
      throw new ApplicationError('REAUTHENTICATION_FAILED', 'Reauthentication failed.', 401);
    }

    const world = await this.repository.getWorld(
      actor.user.id,
      input.worldId,
      false,
      actor.user.platformRole === 'platform_admin',
    );
    if (!world)
      throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);

    const verifiedAt = this.clock.now();
    const configuredExpiry =
      verifiedAt.getTime() + (this.config.governanceStepUpTtlSeconds ?? 300) * 1_000;
    const expiresAt = new Date(
      Math.min(
        configuredExpiry,
        new Date(actor.session.idleExpiresAt).getTime(),
        new Date(actor.session.absoluteExpiresAt).getTime(),
      ),
    );
    if (expiresAt.getTime() <= verifiedAt.getTime()) {
      throw new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401);
    }

    const proofToken = generateOpaqueToken();
    const proofId = this.ids.next();
    const auditRecordId = this.ids.next();
    const commandRequestHash = governanceRecentCredentialCommandHashV1(
      this.completeOperatorCommand(actor, input.command),
    );
    await this.repository.transaction(async (repository) => {
      await repository.insertAudit({
        action: 'identity.reauthenticate',
        actorUserId: actor.user.id,
        category: 'identity',
        correlationId: requestId,
        id: auditRecordId,
        metadata: redactAuditMetadata({
          commandId: input.command.commandId,
          commandRequestHash: commandRequestHash.toString('hex'),
          commandType: input.command.type,
          method: 'password',
        }),
        outcome: 'allowed',
        reasonCode: 'RECENT_CREDENTIAL_VERIFIED',
        requestId,
        targetId: proofId,
        targetType: 'recent_credential_proof',
        worldId: input.worldId,
      });
      await repository.issueRecentCredentialProof({
        auditRecordId,
        commandId: input.command.commandId,
        commandRequestHash,
        commandType: input.command.type,
        expiresAt,
        id: proofId,
        proofHash: this.tokenHash(proofToken, 'step_up'),
        requestId,
        sessionId: actor.session.id,
        userId: actor.user.id,
        verifiedAt,
        worldId: input.worldId,
      });
    });
    telemetry.identityAttempts.add(1, { flow: 'reauthenticate', outcome: 'succeeded' });
    return { expiresAt: expiresAt.toISOString(), proofToken };
  }

  public async approveGovernanceOperation(
    actor: AuthenticatedActor,
    input: GovernanceApprovalRequestTransport,
    requestId: string,
    idempotencyKey: string,
  ): Promise<GovernanceApprovalResponseTransport> {
    const credential = await this.repository.findCredential(actor.user.email);
    const encodedHash = credential?.passwordHash ?? (await this.getDummyHash());
    const valid = await this.passwordHasher.verify(encodedHash, input.password);
    if (!credential || credential.user.id !== actor.user.id || !valid) {
      await this.repository.insertAudit({
        action: 'governance.approval.authenticate',
        actorUserId: actor.user.id,
        category: 'governance_approval',
        correlationId: requestId,
        id: this.ids.next(),
        metadata: redactAuditMetadata({
          commandType: input.command.type,
          credentialResult: 'generic_failure',
        }),
        outcome: 'denied',
        reasonCode: 'REAUTHENTICATION_FAILED',
        requestId,
        targetId: input.command.commandId,
        targetType: 'command',
      });
      telemetry.identityAttempts.add(1, { flow: 'governance_approval', outcome: 'failed' });
      throw new ApplicationError('REAUTHENTICATION_FAILED', 'Reauthentication failed.', 401);
    }

    const world = await this.repository.getWorld(
      actor.user.id,
      input.worldId,
      false,
      actor.user.platformRole === 'platform_admin',
    );
    if (!world)
      throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);

    const command = input.command;
    const bindingHash = governanceTwoPersonApprovalBindingHashV1(command);
    const override = command.type === 'ExecuteCreatorOverrideV1';
    const action = override ? 'governance.approve_override' : 'governance.approve_repair';
    const reasonCode = override
      ? 'GOVERNANCE_OVERRIDE_SECOND_APPROVAL'
      : 'GOVERNANCE_REPAIR_SECOND_APPROVAL';
    const authorized =
      actor.user.platformRole === 'platform_admin' ||
      world.role === 'creator' ||
      world.role === 'administrator';
    if (!authorized) {
      await this.repository.insertAudit({
        action,
        actorUserId: actor.user.id,
        category: 'governance_approval',
        correlationId: requestId,
        id: this.ids.next(),
        metadata: redactAuditMetadata({ bindingHash, commandType: command.type }),
        outcome: 'denied',
        reasonCode: 'GOVERNANCE_APPROVAL_FORBIDDEN',
        requestId,
        targetId: command.commandId,
        targetType: 'command',
        worldId: input.worldId,
      });
      throw new ApplicationError(
        'AUTHORIZATION_DENIED',
        'You are not authorized to approve this governance operation.',
        403,
      );
    }

    const approvedAt = this.clock.now();
    const expiresAt = new Date(
      Math.min(
        approvedAt.getTime() + 15 * 60 * 1_000,
        new Date(actor.session.idleExpiresAt).getTime(),
        new Date(actor.session.absoluteExpiresAt).getTime(),
      ),
    );
    if (expiresAt.getTime() <= approvedAt.getTime()) {
      throw new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401);
    }

    const approvalId = this.ids.next();
    const response: GovernanceApprovalResponseTransport = {
      approvalId,
      commandId: command.commandId,
      expiresAt: expiresAt.toISOString(),
    };
    const identity = {
      actorId: actor.user.id,
      expiresAt: new Date(approvedAt.getTime() + 86_400_000),
      key: idempotencyKey,
      requestHash: governanceTwoPersonApprovalRequestHashV1(input.worldId, command),
      scope: 'governance.approval.issue',
    };
    const result = await this.repository.transaction(async (repository) => {
      const started = await repository.beginIdempotency(identity);
      if (started.kind === 'replay') {
        telemetry.idempotency.add(1, { outcome: 'replay' });
        return governanceApprovalReplay(started.body);
      }
      telemetry.idempotency.add(1, { outcome: 'new' });
      await repository.insertAudit({
        action,
        actorUserId: actor.user.id,
        category: 'governance_approval',
        correlationId: requestId,
        id: approvalId,
        metadata: redactAuditMetadata({
          approvalExpiresAt: response.expiresAt,
          approvalIssuedAt: approvedAt.toISOString(),
          bindingHash,
          commandType: command.type,
          sessionId: actor.session.id,
        }),
        outcome: 'allowed',
        reasonCode,
        requestId,
        targetId: command.commandId,
        targetType: 'command',
        worldId: input.worldId,
      });
      await repository.completeIdempotency(identity, 200, response);
      return response;
    });
    telemetry.identityAttempts.add(1, { flow: 'governance_approval', outcome: 'succeeded' });
    return result;
  }

  public governanceRecentCredential(
    actor: AuthenticatedActor,
    proofToken: string | undefined,
    command: unknown,
  ): GovernanceRecentCredentialProof {
    if (proofToken === undefined) {
      throw new ApplicationError(
        'RECENT_CREDENTIAL_REQUIRED',
        'Recent password verification is required.',
        403,
      );
    }
    if (proofToken.length < 32 || proofToken.length > 128) {
      throw new ApplicationError(
        'RECENT_CREDENTIAL_INVALID',
        'The recent-credential proof is invalid or expired.',
        403,
      );
    }
    return {
      commandRequestHash: governanceRecentCredentialCommandHashV1(
        this.completeOperatorCommand(actor, command),
      ),
      proofHash: this.tokenHash(proofToken, 'step_up'),
      sessionId: actor.session.id,
      userId: actor.user.id,
    };
  }

  public assertCsrf(
    actor: AuthenticatedActor,
    cookieToken: string | undefined,
    headerToken: string | undefined,
  ): void {
    if (!cookieToken || !headerToken) {
      throw new ApplicationError('CSRF_INVALID', 'The CSRF token is invalid.', 403);
    }
    const cookieBytes = Buffer.from(cookieToken);
    const headerBytes = Buffer.from(headerToken);
    if (
      !secretsMatch(cookieBytes, headerBytes) ||
      !secretsMatch(this.tokenHash(headerToken, 'csrf'), actor.csrfHash)
    ) {
      throw new ApplicationError('CSRF_INVALID', 'The CSRF token is invalid.', 403);
    }
  }

  public async rotateCsrf(actor: AuthenticatedActor): Promise<string> {
    const csrfToken = generateOpaqueToken();
    const rotated = await this.repository.rotateCsrf(
      actor.session.id,
      this.tokenHash(csrfToken, 'csrf'),
    );
    if (!rotated) throw new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401);
    return csrfToken;
  }

  public async logout(actor: AuthenticatedActor, requestId: string): Promise<void> {
    await this.repository.transaction(async (repository) => {
      await repository.revokeSession(actor.session.id, 'user_logout');
      await repository.insertAudit({
        action: 'identity.logout',
        actorUserId: actor.user.id,
        category: 'identity',
        correlationId: requestId,
        id: this.ids.next(),
        outcome: 'allowed',
        reasonCode: 'SESSION_REVOKED',
        requestId,
        targetId: actor.session.id,
        targetType: 'session',
      });
    });
    telemetry.sessionLifecycle.add(1, { outcome: 'revoked' });
  }

  private async getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwordHasher.hash('Generic authentication fallback');
    return this.dummyHash;
  }

  private completeOperatorCommand(
    actor: AuthenticatedActor,
    command: unknown,
  ): GovernanceTwoPersonCommand {
    if (typeof command !== 'object' || command === null || Array.isArray(command)) {
      throw new ApplicationError(
        'RECENT_CREDENTIAL_INVALID',
        'The recent-credential proof is invalid or expired.',
        403,
      );
    }
    return {
      ...command,
      actorMode: actor.user.platformRole === 'platform_admin' ? 'administrator' : 'creator',
    } as GovernanceTwoPersonCommand;
  }

  private newSession(
    userId: string,
    fingerprint: RequestFingerprint,
  ): {
    csrfToken: string;
    sessionToken: string;
    write: SessionWrite;
  } {
    const now = this.clock.now();
    const sessionToken = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();
    const absoluteExpiresAt = new Date(
      now.getTime() + this.config.sessionAbsoluteTtlSeconds * 1_000,
    );
    const idleExpiresAt = new Date(
      Math.min(
        absoluteExpiresAt.getTime(),
        now.getTime() + this.config.sessionIdleTtlSeconds * 1_000,
      ),
    );
    return {
      csrfToken,
      sessionToken,
      write: {
        absoluteExpiresAt,
        csrfHash: this.tokenHash(csrfToken, 'csrf'),
        id: this.ids.next(),
        idleExpiresAt,
        ipPrefixHash: fingerprint.ipAddress
          ? this.tokenHash(coarseAddress(fingerprint.ipAddress), 'session')
          : null,
        tokenHash: this.tokenHash(sessionToken, 'session'),
        userAgentHash: fingerprint.userAgent
          ? this.tokenHash(fingerprint.userAgent.slice(0, 500), 'session')
          : null,
        userId,
      },
    };
  }
}

function governanceApprovalReplay(
  body: Record<string, unknown>,
): GovernanceApprovalResponseTransport {
  if (
    typeof body.approvalId !== 'string' ||
    typeof body.commandId !== 'string' ||
    typeof body.expiresAt !== 'string'
  ) {
    throw new ApplicationError(
      'IDEMPOTENCY_RECORD_INVALID',
      'The stored idempotency response is invalid.',
      500,
    );
  }
  return {
    approvalId: body.approvalId,
    commandId: body.commandId,
    expiresAt: body.expiresAt,
  };
}

function coarseAddress(address: string): string {
  const value = address.trim();
  if (value.includes('.')) return value.split('.').slice(0, 3).join('.');
  return value.split(':').slice(0, 4).join(':');
}
