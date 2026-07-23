import type { RuntimeConfig } from '@worldgraph/config';
import type {
  AuthenticatedSession,
  Clock,
  IdGenerator,
  LoginRequest,
  RegisterRequest,
} from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';

import { ApplicationError } from '../application/errors.js';
import type { NotificationSink } from '../application/notifications.js';
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

  public tokenHash(rawToken: string, domain: 'csrf' | 'invitation' | 'session'): Buffer {
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

function coarseAddress(address: string): string {
  const value = address.trim();
  if (value.includes('.')) return value.split('.').slice(0, 3).join('.');
  return value.split(':').slice(0, 4).join(':');
}
