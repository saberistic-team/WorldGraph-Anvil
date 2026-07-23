import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  Invitation,
  Membership,
  PlatformRole,
  SafeUser,
  SessionView,
  World,
  WorldRole,
} from '@worldgraph/contracts';

import { ApplicationError, isPostgresError } from '../application/errors.js';
import {
  appendAcceptedLegacyMutation,
  appendRejectedLegacyMutation,
  type AppendLegacyMutationInput,
  type LegacyLedgerAppendResult,
  type RejectLegacyMutationInput,
} from '../commands/legacy-mutation-ledger.js';

interface Executor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface CredentialRecord {
  passwordHash: string;
  user: SafeUser;
}

export interface ActorRecord {
  csrfHash: Buffer;
  session: SessionView;
  user: SafeUser;
}

export interface SessionWrite {
  absoluteExpiresAt: Date;
  csrfHash: Buffer;
  id: string;
  idleExpiresAt: Date;
  ipPrefixHash: Buffer | null;
  tokenHash: Buffer;
  userAgentHash: Buffer | null;
  userId: string;
}

export interface AuditWrite {
  action: string;
  actorUserId: string | null;
  category: string;
  correlationId: string;
  id: string;
  metadata?: Record<string, unknown>;
  outcome: string;
  reasonCode: string;
  requestId: string;
  targetId?: string | null;
  targetType?: string | null;
  worldId?: string | null;
}

export interface IdempotencyWrite {
  actorId: string;
  expiresAt: Date;
  key: string;
  requestHash: Buffer;
  scope: string;
}

export type IdempotencyStart =
  { kind: 'new' } | { body: Record<string, unknown>; kind: 'replay'; status: number };

interface UserRow extends QueryResultRow {
  auth_version: number;
  display_name: string | null;
  email: string;
  id: string;
  password_hash: string;
  platform_role: PlatformRole;
  row_version: number;
  status: 'active' | 'disabled';
}

interface SessionActorRow extends UserRow {
  absolute_expires_at: Date;
  csrf_hash: Buffer;
  idle_expires_at: Date;
  session_id: string;
}

interface WorldRow extends QueryResultRow {
  active_world_version_id: string | null;
  created_at: Date;
  current_approved_manifest_revision_id: string | null;
  id: string;
  lifecycle: 'active' | 'compile_failed' | 'compiling' | 'draft' | 'manifest_approved';
  manifest_schema_version: 1 | null;
  name: string;
  role: WorldRole | null;
  row_version: number;
  slug: string;
  updated_at: Date;
}

function safeUser(row: UserRow): SafeUser {
  return {
    displayName: row.display_name,
    email: row.email,
    id: row.id,
    platformRole: row.platform_role,
    rowVersion: row.row_version,
    status: row.status,
  };
}

function worldView(row: WorldRow): World {
  return {
    activeWorldVersionId: row.active_world_version_id,
    createdAt: row.created_at.toISOString(),
    currentApprovedManifestRevisionId: row.current_approved_manifest_revision_id,
    id: row.id,
    lifecycle: row.lifecycle,
    manifestSchemaVersion: row.manifest_schema_version,
    name: row.name,
    role: row.role,
    rowVersion: row.row_version,
    slug: row.slug,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly executor: Executor = pool,
  ) {}

  public async transaction<T>(
    operation: (repository: PostgresRepository) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client: PoolClient = await this.pool.connect();
      try {
        await client.query('begin isolation level serializable');
        const result = await operation(new PostgresRepository(this.pool, client));
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if ((isPostgresError(error, '40001') || isPostgresError(error, '40P01')) && attempt < 2) {
          await boundedRetryDelay(attempt);
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new ApplicationError(
      'SERIALIZATION_RETRY_EXHAUSTED',
      'The mutation could not be ordered safely. Retry with the same idempotency key.',
      503,
    );
  }

  public async appendLegacyMutation(
    input: AppendLegacyMutationInput,
  ): Promise<LegacyLedgerAppendResult> {
    return appendAcceptedLegacyMutation(this.executor, input);
  }

  public async rejectLegacyMutation(
    input: RejectLegacyMutationInput,
  ): Promise<LegacyLedgerAppendResult> {
    return appendRejectedLegacyMutation(this.executor, input);
  }

  public async findCredential(normalizedEmail: string): Promise<CredentialRecord | null> {
    const result = await this.executor.query<UserRow>(
      `select id, email::text, password_hash, display_name, status, platform_role,
              auth_version, row_version
         from users
        where email = $1 and status = 'active'`,
      [normalizedEmail],
    );
    const row = result.rows[0];
    return row ? { passwordHash: row.password_hash, user: safeUser(row) } : null;
  }

  public async insertUser(input: {
    displayName: string | null;
    email: string;
    id: string;
    passwordHash: string;
  }): Promise<SafeUser> {
    try {
      const result = await this.executor.query<UserRow>(
        `insert into users (id, email, password_hash, display_name)
         values ($1, $2, $3, $4)
         returning id, email::text, password_hash, display_name, status, platform_role,
                   auth_version, row_version`,
        [input.id, input.email, input.passwordHash, input.displayName],
      );
      return safeUser(result.rows[0]!);
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        throw new ApplicationError(
          'REGISTRATION_UNAVAILABLE',
          'Registration could not be completed.',
          409,
        );
      }
      throw error;
    }
  }

  public async insertSession(input: SessionWrite): Promise<SessionView> {
    const result = await this.executor.query<{
      absolute_expires_at: Date;
      id: string;
      idle_expires_at: Date;
    }>(
      `insert into sessions
        (id, user_id, token_hash, csrf_hash, auth_version, idle_expires_at,
         absolute_expires_at, ip_prefix_hash, user_agent_hash)
       select $1, u.id, $2, $3, u.auth_version, $4, $5, $6, $7
         from users u where u.id = $8 and u.status = 'active'
       returning id, idle_expires_at, absolute_expires_at`,
      [
        input.id,
        input.tokenHash,
        input.csrfHash,
        input.idleExpiresAt,
        input.absoluteExpiresAt,
        input.ipPrefixHash,
        input.userAgentHash,
        input.userId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('AUTHENTICATION_FAILED', 'Authentication failed.', 401);
    return {
      absoluteExpiresAt: row.absolute_expires_at.toISOString(),
      id: row.id,
      idleExpiresAt: row.idle_expires_at.toISOString(),
    };
  }

  public async authenticateSession(
    tokenHash: Buffer,
    idleTtlSeconds: number,
  ): Promise<ActorRecord | null> {
    const result = await this.executor.query<SessionActorRow>(
      `update sessions s
          set last_seen_at = now(),
              idle_expires_at = least(s.absolute_expires_at, now() + ($2::text || ' seconds')::interval)
         from users u
        where s.token_hash = $1
          and s.user_id = u.id
          and s.revoked_at is null
          and s.idle_expires_at > now()
          and s.absolute_expires_at > now()
          and s.auth_version = u.auth_version
          and u.status = 'active'
       returning u.id, u.email::text, u.password_hash, u.display_name, u.status,
                 u.platform_role, u.auth_version, u.row_version,
                 s.id as session_id, s.csrf_hash, s.idle_expires_at, s.absolute_expires_at`,
      [tokenHash, idleTtlSeconds],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      csrfHash: row.csrf_hash,
      session: {
        absoluteExpiresAt: row.absolute_expires_at.toISOString(),
        id: row.session_id,
        idleExpiresAt: row.idle_expires_at.toISOString(),
      },
      user: safeUser(row),
    };
  }

  public async rotateCsrf(sessionId: string, csrfHash: Buffer): Promise<boolean> {
    const result = await this.executor.query(
      `update sessions set csrf_hash = $2
        where id = $1 and revoked_at is null and idle_expires_at > now()
          and absolute_expires_at > now()`,
      [sessionId, csrfHash],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.executor.query(
      `update sessions
          set revoked_at = coalesce(revoked_at, now()),
              revoke_reason = coalesce(revoke_reason, $2)
        where id = $1`,
      [sessionId, reason],
    );
  }

  public async revokeSessionByTokenHash(tokenHash: Buffer, reason: string): Promise<boolean> {
    const result = await this.executor.query(
      `update sessions
          set revoked_at = coalesce(revoked_at, now()),
              revoke_reason = coalesce(revoke_reason, $2)
        where token_hash = $1 and revoked_at is null`,
      [tokenHash, reason],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async touchLogin(userId: string): Promise<void> {
    await this.executor.query('update users set last_login_at = now() where id = $1', [userId]);
  }

  public async worldLedgerAnchored(worldId: string): Promise<boolean> {
    const result = await this.executor.query<{ anchored: boolean }>(
      `select exists (
         select 1
           from world_runtime_heads runtime
           join world_ledger_heads ledger on ledger.world_id = runtime.world_id
          where runtime.world_id = $1
            and runtime.ledger_anchored_at is not null
            and ledger.anchored_at is not null
            and runtime.ledger_anchor_event_id = ledger.anchor_event_id
            and runtime.anchor_artifact_hash = ledger.anchor_artifact_hash
       ) anchored`,
      [worldId],
    );
    return result.rows[0]?.anchored === true;
  }

  public async insertAudit(input: AuditWrite): Promise<void> {
    await this.executor.query(
      `insert into security_audit_records
        (id, actor_user_id, world_id, category, action, outcome, reason_code,
         target_type, target_id, request_id, correlation_id, redacted_metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.id,
        input.actorUserId,
        input.worldId ?? null,
        input.category,
        input.action,
        input.outcome,
        input.reasonCode,
        input.targetType ?? null,
        input.targetId ?? null,
        input.requestId,
        input.correlationId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  public async beginIdempotency(input: IdempotencyWrite): Promise<IdempotencyStart> {
    const inserted = await this.executor.query(
      `insert into idempotency_records
        (scope, actor_id, key, request_hash, state, created_at, expires_at)
       values ($1,$2,$3,$4,'processing',now(),$5)
       on conflict do nothing`,
      [input.scope, input.actorId, input.key, input.requestHash, input.expiresAt],
    );
    if ((inserted.rowCount ?? 0) === 1) return { kind: 'new' };
    const existing = await this.executor.query<{
      request_hash: Buffer;
      response_body: Record<string, unknown> | null;
      response_status: number | null;
      state: 'processing' | 'completed';
    }>(
      `select request_hash, response_status, response_body, state
         from idempotency_records
        where scope = $1 and actor_id = $2 and key = $3
        for update`,
      [input.scope, input.actorId, input.key],
    );
    const row = existing.rows[0];
    if (!row || !row.request_hash.equals(input.requestHash)) {
      throw new ApplicationError(
        'IDEMPOTENCY_KEY_REUSED',
        'The idempotency key was already used for a different request.',
        409,
      );
    }
    if (row.state !== 'completed' || row.response_status === null || row.response_body === null) {
      throw new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        'The original request is still being processed.',
        409,
      );
    }
    return { body: row.response_body, kind: 'replay', status: row.response_status };
  }

  public async completeIdempotency(
    input: Pick<IdempotencyWrite, 'actorId' | 'key' | 'scope'>,
    status: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.executor.query(
      `update idempotency_records
          set state = 'completed', response_status = $4, response_body = $5
        where scope = $1 and actor_id = $2 and key = $3 and state = 'processing'`,
      [input.scope, input.actorId, input.key, status, JSON.stringify(body)],
    );
  }

  public async listWorlds(userId: string, limit = 50): Promise<World[]> {
    const result = await this.executor.query<WorldRow>(
      `select w.id, w.slug::text, w.name, w.lifecycle, w.row_version,
              w.active_world_version_id,
              w.current_approved_manifest_revision_id, w.manifest_schema_version,
              w.created_at, w.updated_at, m.role
         from world_memberships m
         join worlds w on w.id = m.world_id and w.archived_at is null
        where m.user_id = $1 and m.status = 'active'
        order by w.created_at desc, w.id desc
        limit $2`,
      [userId, limit],
    );
    return result.rows.map(worldView);
  }

  public async getWorld(
    userId: string,
    worldId: string,
    lock = false,
    platformAdmin = false,
  ): Promise<World | null> {
    const result = await this.executor.query<WorldRow>(
      `select w.id, w.slug::text, w.name, w.lifecycle, w.row_version,
              w.active_world_version_id,
              w.current_approved_manifest_revision_id, w.manifest_schema_version,
              w.created_at, w.updated_at, m.role
         from worlds w
         left join world_memberships m
           on m.world_id = w.id and m.user_id = $2 and m.status = 'active'
        where w.id = $1 and (m.user_id is not null or $3::boolean)
          and w.archived_at is null
        ${lock ? 'for update of w' : ''}`,
      [worldId, userId, platformAdmin],
    );
    const row = result.rows[0];
    return row ? worldView(row) : null;
  }

  public async createWorld(input: {
    actorUserId: string;
    id: string;
    name: string;
    slug: string;
  }): Promise<World> {
    try {
      const inserted = await this.executor.query<WorldRow>(
        `with new_world as (
           insert into worlds (id, slug, name, created_by_user_id)
           values ($1,$2,$3,$4)
           returning id, slug, name, lifecycle, row_version,
                     active_world_version_id,
                     current_approved_manifest_revision_id, manifest_schema_version,
                     created_at, updated_at
         ), membership as (
           insert into world_memberships
             (world_id, user_id, role, status, granted_by_user_id)
           select id, $4, 'creator', 'active', $4 from new_world
         )
         select id, slug::text, name, lifecycle, row_version, created_at, updated_at,
                active_world_version_id,
                current_approved_manifest_revision_id, manifest_schema_version,
                'creator'::world_role as role
           from new_world`,
        [input.id, input.slug, input.name, input.actorUserId],
      );
      return worldView(inserted.rows[0]!);
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        throw new ApplicationError('WORLD_SLUG_TAKEN', 'That world slug is unavailable.', 409);
      }
      throw error;
    }
  }

  public async renameWorld(
    worldId: string,
    name: string,
    expectedRowVersion: number,
  ): Promise<WorldRow> {
    const result = await this.executor.query<WorldRow>(
      `update worlds
          set name = $2, row_version = row_version + 1, updated_at = now()
        where id = $1 and row_version = $3 and archived_at is null
       returning id, slug::text, name, lifecycle, row_version, created_at, updated_at,
                 active_world_version_id,
                 current_approved_manifest_revision_id, manifest_schema_version,
                 'creator'::world_role as role`,
      [worldId, name, expectedRowVersion],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('STALE_VERSION', 'The world has changed.', 409);
    return row;
  }

  public worldFromRow(row: WorldRow): World {
    return worldView(row);
  }

  public async listMemberships(worldId: string): Promise<Membership[]> {
    const result = await this.executor.query<{
      display_name: string | null;
      id: string;
      joined_at: Date;
      membership_row_version: number;
      membership_status: 'active' | 'removed';
      role: WorldRole;
    }>(
      `select u.id, u.display_name, m.role, m.status as membership_status,
              m.row_version as membership_row_version,
              m.joined_at
         from world_memberships m
         join users u on u.id = m.user_id
        where m.world_id = $1 and m.status = 'active'
        order by case m.role when 'creator' then 0 when 'administrator' then 1 else 2 end,
                 u.display_name nulls last, u.id`,
      [worldId],
    );
    return result.rows.map((row) => ({
      joinedAt: row.joined_at.toISOString(),
      role: row.role,
      rowVersion: row.membership_row_version,
      status: row.membership_status,
      user: { displayName: row.display_name, id: row.id },
    }));
  }

  public async getMembership(
    worldId: string,
    userId: string,
    lock = false,
  ): Promise<{
    role: WorldRole;
    rowVersion: number;
    status: 'active' | 'removed';
    userId: string;
  } | null> {
    const result = await this.executor.query<{
      role: WorldRole;
      row_version: number;
      status: 'active' | 'removed';
      user_id: string;
    }>(
      `select user_id, role, status, row_version
         from world_memberships
        where world_id = $1 and user_id = $2
        ${lock ? 'for update' : ''}`,
      [worldId, userId],
    );
    const row = result.rows[0];
    return row
      ? { role: row.role, rowVersion: row.row_version, status: row.status, userId: row.user_id }
      : null;
  }

  public async changeMembershipRole(input: {
    expectedRowVersion: number;
    role: Exclude<WorldRole, 'creator'>;
    targetUserId: string;
    worldId: string;
  }): Promise<{ role: WorldRole; rowVersion: number; userId: string }> {
    await this.executor.query('select id from worlds where id = $1 for update', [input.worldId]);
    const result = await this.executor.query<{
      role: WorldRole;
      row_version: number;
      user_id: string;
    }>(
      `update world_memberships
          set role = $3, row_version = row_version + 1, updated_at = now()
        where world_id = $1 and user_id = $2 and status = 'active'
          and row_version = $4 and role <> 'creator'
       returning user_id, role, row_version`,
      [input.worldId, input.targetUserId, input.role, input.expectedRowVersion],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('STALE_VERSION', 'The membership has changed.', 409);
    return { role: row.role, rowVersion: row.row_version, userId: row.user_id };
  }

  public async removeMembership(input: {
    expectedRowVersion: number;
    targetUserId: string;
    worldId: string;
  }): Promise<{ rowVersion: number; userId: string }> {
    await this.executor.query('select id from worlds where id = $1 for update', [input.worldId]);
    const result = await this.executor.query<{ row_version: number; user_id: string }>(
      `update world_memberships
          set status = 'removed', removed_at = now(), row_version = row_version + 1,
              updated_at = now()
        where world_id = $1 and user_id = $2 and status = 'active'
          and row_version = $3 and role <> 'creator'
       returning user_id, row_version`,
      [input.worldId, input.targetUserId, input.expectedRowVersion],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('STALE_VERSION', 'The membership has changed.', 409);
    return { rowVersion: row.row_version, userId: row.user_id };
  }

  public async createInvitation(input: {
    createdByUserId: string;
    email: string;
    expiresAt: Date;
    id: string;
    role: 'player' | 'observer';
    tokenHash: Buffer;
    worldId: string;
  }): Promise<Invitation> {
    await this.executor.query(
      `update world_invitations
          set status = 'expired', row_version = row_version + 1
        where world_id = $1 and email = $2 and status = 'pending' and expires_at <= now()`,
      [input.worldId, input.email],
    );
    try {
      const result = await this.executor.query<{
        created_at: Date;
        email: string;
        expires_at: Date;
        id: string;
        intended_role: 'player' | 'observer';
        row_version: number;
        status: 'pending';
      }>(
        `insert into world_invitations
          (id, world_id, email, intended_role, token_hash, expires_at, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, email::text, intended_role, status, expires_at, created_at, row_version`,
        [
          input.id,
          input.worldId,
          input.email,
          input.role,
          input.tokenHash,
          input.expiresAt,
          input.createdByUserId,
        ],
      );
      return invitationView(result.rows[0]!);
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        throw new ApplicationError(
          'INVITATION_ALREADY_PENDING',
          'An active invitation already exists.',
          409,
        );
      }
      throw error;
    }
  }

  public async listInvitations(worldId: string): Promise<Invitation[]> {
    await this.executor.query(
      `update world_invitations set status = 'expired', row_version = row_version + 1
        where world_id = $1 and status = 'pending' and expires_at <= now()`,
      [worldId],
    );
    const result = await this.executor.query<{
      created_at: Date;
      email: string;
      expires_at: Date;
      id: string;
      intended_role: 'player' | 'observer';
      row_version: number;
      status: 'pending' | 'accepted' | 'revoked' | 'expired';
    }>(
      `select id, email::text, intended_role, status, expires_at, created_at, row_version
         from world_invitations where world_id = $1
        order by created_at desc, id desc limit 100`,
      [worldId],
    );
    return result.rows.map(invitationView);
  }

  public async revokeInvitation(worldId: string, invitationId: string): Promise<Invitation> {
    const result = await this.executor.query<{
      created_at: Date;
      email: string;
      expires_at: Date;
      id: string;
      intended_role: 'player' | 'observer';
      row_version: number;
      status: 'revoked';
    }>(
      `update world_invitations
          set status = 'revoked', revoked_at = now(), row_version = row_version + 1
        where id = $2 and world_id = $1 and status = 'pending'
       returning id, email::text, intended_role, status, expires_at, created_at, row_version`,
      [worldId, invitationId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('NOT_FOUND', 'The invitation was not found.', 404);
    return invitationView(row);
  }

  public async acceptInvitation(input: {
    email: string;
    tokenHash: Buffer;
    userId: string;
  }): Promise<{ invitationId: string; role: 'player' | 'observer'; worldId: string }> {
    const invitation = await this.executor.query<{
      id: string;
      intended_role: 'player' | 'observer';
      world_id: string;
    }>(
      `select id, world_id, intended_role
         from world_invitations
        where token_hash = $1 and email = $2 and status = 'pending' and expires_at > now()
        for update`,
      [input.tokenHash, input.email],
    );
    const row = invitation.rows[0];
    if (!row) {
      throw new ApplicationError('INVITATION_NOT_AVAILABLE', 'The invitation is unavailable.', 409);
    }
    await this.executor.query(
      `insert into world_memberships
        (world_id, user_id, role, status, granted_by_user_id)
       select $1, $2, $3, 'active', created_by_user_id
         from world_invitations where id = $4
       on conflict (world_id, user_id) do update
         set role = excluded.role, status = 'active', removed_at = null,
             row_version = world_memberships.row_version + 1, updated_at = now()
       where world_memberships.status = 'removed'`,
      [row.world_id, input.userId, row.intended_role, row.id],
    );
    const updated = await this.executor.query(
      `update world_invitations
          set status = 'accepted', accepted_by_user_id = $2, accepted_at = now(),
              row_version = row_version + 1
        where id = $1 and status = 'pending'`,
      [row.id, input.userId],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new ApplicationError('INVITATION_NOT_AVAILABLE', 'The invitation is unavailable.', 409);
    }
    return { invitationId: row.id, role: row.intended_role, worldId: row.world_id };
  }

  public async insertCreatorOverride(input: {
    action: string;
    actorUserId: string;
    auditRecordId: string;
    authorityRuleId: string;
    commandId: string;
    id: string;
    reason: string;
    targetId: string;
    targetType: string;
    worldId: string;
  }): Promise<void> {
    await this.executor.query(
      `insert into creator_override_records
        (id, world_id, actor_user_id, action, target_type, target_id, reason,
         authority_rule_id, command_id, audit_record_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.id,
        input.worldId,
        input.actorUserId,
        input.action,
        input.targetType,
        input.targetId,
        input.reason,
        input.authorityRuleId,
        input.commandId,
        input.auditRecordId,
      ],
    );
  }

  public async listAuthorityAudit(worldId: string): Promise<Record<string, unknown>[]> {
    const result = await this.executor.query<{
      action: string;
      actor_user_id: string | null;
      category: string;
      id: string;
      occurred_at: Date;
      outcome: string;
      reason_code: string;
      target_id: string | null;
      target_type: string | null;
    }>(
      `select id, actor_user_id, category, action, outcome, reason_code,
              target_type, target_id, occurred_at
         from security_audit_records
        where world_id = $1
        order by occurred_at desc, id desc limit 100`,
      [worldId],
    );
    return result.rows.map((row) => ({
      action: row.action,
      actorUserId: row.actor_user_id,
      category: row.category,
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      outcome: row.outcome,
      reasonCode: row.reason_code,
      targetId: row.target_id,
      targetType: row.target_type,
    }));
  }
}

function invitationView(row: {
  created_at: Date;
  email: string;
  expires_at: Date;
  id: string;
  intended_role: 'player' | 'observer';
  row_version: number;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}): Invitation {
  return {
    createdAt: row.created_at.toISOString(),
    email: row.email,
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    intendedRole: row.intended_role,
    rowVersion: row.row_version,
    status: row.status,
  };
}

async function boundedRetryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 5 : 20));
}
