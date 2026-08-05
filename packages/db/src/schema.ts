import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType: () => 'extensions.citext',
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const int8range = customType<{ data: string }>({
  dataType: () => 'int8range',
});

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'extensions.vector(1536)',
  fromDriver: (value) =>
    value
      .slice(1, -1)
      .split(',')
      .map((entry) => Number(entry)),
  toDriver: (value) => `[${value.join(',')}]`,
});

export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const platformRole = pgEnum('platform_role', ['user', 'platform_admin']);
export const worldLifecycle = pgEnum('world_lifecycle', [
  'draft',
  'manifest_approved',
  'compiling',
  'active',
  'compile_failed',
]);
export const worldRole = pgEnum('world_role', ['creator', 'administrator', 'player', 'observer']);
export const membershipStatus = pgEnum('membership_status', ['active', 'removed']);
export const invitationStatus = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);
export const idempotencyState = pgEnum('idempotency_state', ['processing', 'completed']);
export const primitiveKind = pgEnum('primitive_kind', [
  'government',
  'election',
  'currency',
  'tax',
  'resource',
  'production_recipe',
  'terrain',
  'district',
  'building',
  'organization',
  'office',
  'legal_right',
  'player_role',
  'visual_style',
  'simulation_rule',
  'event_template',
]);
export const primitiveLifecycle = pgEnum('primitive_lifecycle', [
  'draft',
  'published',
  'deprecated',
]);
export const primitiveIndexStatus = pgEnum('primitive_index_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'dead',
  'stale',
  'disabled',
]);
export const manifestGenerationStatus = pgEnum('manifest_generation_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const manifestGenerationMode = pgEnum('manifest_generation_mode', ['provider', 'fallback']);
export const manifestRevisionSource = pgEnum('manifest_revision_source', [
  'generation',
  'manual',
  'import',
]);
export const manifestApprovalStatus = pgEnum('manifest_approval_status', [
  'draft',
  'approved',
  'superseded',
  'rejected',
]);
export const manifestProvenanceSource = pgEnum('manifest_provenance_source', [
  'prompt',
  'primitive',
  'model',
  'fallback',
  'manual',
]);
export const worldCompilationStatus = pgEnum('world_compilation_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const worldCompilationStage = pgEnum('world_compilation_stage', [
  'queued',
  'validating',
  'compiling',
  'seeding',
  'activated',
  'failed',
  'cancelled',
]);
export const worldVersionStatus = pgEnum('world_version_status', [
  'staging',
  'active',
  'superseded',
]);
export const commandActorType = pgEnum('command_actor_type', [
  'user',
  'system',
  'ai',
  'platform_admin',
]);
export const commandRecordStatus = pgEnum('command_record_status', [
  'received',
  'accepted',
  'rejected',
  'failed',
]);
export const payloadClassification = pgEnum('payload_classification', [
  'public',
  'member',
  'private',
  'secret',
]);
export const ledgerEntryKind = pgEnum('ledger_entry_kind', [
  'command_accepted',
  'command_rejected',
  'domain_event',
  'override',
  'repair_anchor',
]);
export const projectionCheckpointStatus = pgEnum('projection_checkpoint_status', [
  'current',
  'rebuilding',
  'diverged',
  'failed',
]);
export const outboxMessageStatus = pgEnum('outbox_message_status', [
  'pending',
  'published',
  'dead',
]);
export const historyVisibility = pgEnum('history_visibility', [
  'public',
  'member',
  'creator',
  'operator',
  'participant',
]);
export const projectionReplayStatus = pgEnum('projection_replay_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const simulationClockMode = pgEnum('simulation_clock_mode', ['paused', 'running', 'error']);
export const scheduledActionStatus = pgEnum('scheduled_action_status', [
  'scheduled',
  'completed',
  'cancelled',
  'failed',
]);
export const simulationBatchStatus = pgEnum('simulation_batch_status', [
  'running',
  'completed',
  'failed',
]);
export const simulationFailureStatus = pgEnum('simulation_failure_status', ['open', 'resolved']);
export const economySeedPlanSource = pgEnum('economy_seed_plan_source', [
  'compiler_1_2',
  'compiler_1_1',
  'legacy_1_0_adapter',
]);
export const currencyStatus = pgEnum('currency_status', ['active', 'frozen', 'retired']);
export const walletKind = pgEnum('wallet_kind', ['player', 'organization', 'treasury']);
export const walletStatus = pgEnum('wallet_status', ['active', 'frozen', 'closed']);
export const financialTransactionKind = pgEnum('financial_transaction_kind', [
  'initialization',
  'issuance',
  'transfer',
  'asset_purchase',
  'compensation',
  'market_purchase',
  'payroll',
  'periodic_tax',
]);
export const assetStatus = pgEnum('asset_status', ['active', 'retired']);
export const assetTransferKind = pgEnum('asset_transfer_kind', [
  'initial',
  'grant',
  'purchase',
  'compensation',
]);
export const assetTransferOfferStatus = pgEnum('asset_transfer_offer_status', [
  'open',
  'accepted',
  'cancelled',
  'expired',
]);
export const economyReconciliationStatus = pgEnum('economy_reconciliation_status', [
  'pending',
  'current',
  'mismatch',
  'failed',
]);
export const economyReconciliationRunStatus = pgEnum('economy_reconciliation_run_status', [
  'matched',
  'mismatch',
]);
export const economyParticipantVisibility = pgEnum('economy_participant_visibility', [
  'participant',
  'operator',
  'business',
  'contract',
  'inventory',
  'listing',
  'production',
  'trade',
  'tax',
]);
export const resourceTypeStatus = pgEnum('resource_type_status', ['active', 'retired']);
export const inventoryMovementKind = pgEnum('inventory_movement_kind', [
  'initial',
  'production_consume',
  'production_output',
  'market_trade',
]);
export const inventoryReservationPurpose = pgEnum('inventory_reservation_purpose', [
  'production_input',
  'market_listing',
]);
export const inventoryReservationStatus = pgEnum('inventory_reservation_status', [
  'active',
  'consumed',
  'released',
  'expired',
]);
export const businessStatus = pgEnum('business_status', ['active', 'suspended', 'closed']);
export const businessFacilityStatus = pgEnum('business_facility_status', [
  'active',
  'disabled',
  'retired',
]);
export const productionRunStatus = pgEnum('production_run_status', [
  'scheduled',
  'reserving',
  'ready',
  'completed',
  'failed',
  'cancelled',
]);
export const employmentOfferStatus = pgEnum('employment_offer_status', [
  'open',
  'closed',
  'retired',
]);
export const employmentContractStatus = pgEnum('employment_contract_status', [
  'offered',
  'active',
  'ended',
  'cancelled',
]);
export const wageRuleKind = pgEnum('wage_rule_kind', ['per_shift', 'per_output']);
export const payrollStatus = pgEnum('payroll_status', ['pending', 'paid', 'failed']);
export const marketListingStatus = pgEnum('market_listing_status', [
  'open',
  'filled',
  'cancelled',
  'expired',
]);
export const taxPolicyType = pgEnum('tax_policy_type', [
  'transaction',
  'sales',
  'payroll',
  'periodic_flat',
  'marketplace_fee',
]);
export const taxCollectionMode = pgEnum('tax_collection_mode', [
  'added_to_payer',
  'withheld_from_recipient',
]);
export const taxPolicyStatus = pgEnum('tax_policy_status', ['active', 'disabled', 'retired']);
export const economyRepairKind = pgEnum('economy_repair_kind', [
  'reverse_financial_transaction',
  'reverse_asset_transfer',
  'reverse_asset_purchase',
]);
export const economyRepairReasonCode = pgEnum('economy_repair_reason_code', [
  'DUPLICATE_EFFECT',
  'ERRONEOUS_EFFECT',
  'INCIDENT_RECOVERY',
]);
export const economyRepairApprovalAuthority = pgEnum('economy_repair_approval_authority', [
  'creator',
  'platform_admin',
]);

const timestamptz = (name: string) => timestamp(name, { mode: 'date', withTimezone: true });

export const platformMetadata = pgTable(
  'platform_metadata',
  {
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    key: text('key').primaryKey(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    value: jsonb('value').notNull(),
    valueSchemaVersion: integer('value_schema_version').notNull(),
  },
  (table) => [
    check('platform_metadata_value_schema_version_positive', sql`${table.valueSchemaVersion} > 0`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name'),
    status: userStatus('status').default('active').notNull(),
    platformRole: platformRole('platform_role').default('user').notNull(),
    authVersion: integer('auth_version').default(1).notNull(),
    rowVersion: integer('row_version').default(1).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    lastLoginAt: timestamptz('last_login_at'),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    check(
      'users_email_shape',
      sql`char_length(${table.email}::text) between 3 and 320
          and ${table.email}::text = btrim(${table.email}::text)
          and ${table.email}::text = lower(${table.email}::text)
          and ${table.email}::text !~ '[[:cntrl:]]'`,
    ),
    check(
      'users_password_hash_bounded',
      sql`char_length(${table.passwordHash}) between 20 and 1024`,
    ),
    check(
      'users_display_name_bounded',
      sql`${table.displayName} is null or (
          char_length(btrim(${table.displayName})) between 1 and 80
          and ${table.displayName} = btrim(${table.displayName})
          and ${table.displayName} !~ '[[:cntrl:]]'
        )`,
    ),
    check('users_versions_positive', sql`${table.authVersion} > 0 and ${table.rowVersion} > 0`),
    check(
      'users_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}
          and (${table.lastLoginAt} is null or ${table.lastLoginAt} >= ${table.createdAt})`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: bytea('token_hash').notNull(),
    csrfHash: bytea('csrf_hash').notNull(),
    authVersion: integer('auth_version').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    lastSeenAt: timestamptz('last_seen_at').defaultNow().notNull(),
    idleExpiresAt: timestamptz('idle_expires_at').notNull(),
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokeReason: text('revoke_reason'),
    ipPrefixHash: bytea('ip_prefix_hash'),
    userAgentHash: bytea('user_agent_hash'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_active_idx')
      .on(table.userId, table.absoluteExpiresAt)
      .where(sql`${table.revokedAt} is null`),
    index('sessions_cleanup_idx').on(
      sql`least(${table.idleExpiresAt}, ${table.absoluteExpiresAt})`,
      table.id,
    ),
    check(
      'sessions_hash_lengths',
      sql`octet_length(${table.tokenHash}) = 32
          and octet_length(${table.csrfHash}) = 32
          and (${table.ipPrefixHash} is null or octet_length(${table.ipPrefixHash}) = 32)
          and (${table.userAgentHash} is null or octet_length(${table.userAgentHash}) = 32)`,
    ),
    check('sessions_auth_version_positive', sql`${table.authVersion} > 0`),
    check(
      'sessions_expiry_ordered',
      sql`${table.lastSeenAt} >= ${table.createdAt}
          and ${table.idleExpiresAt} > ${table.lastSeenAt}
          and ${table.absoluteExpiresAt} >= ${table.idleExpiresAt}`,
    ),
    check(
      'sessions_revocation_consistent',
      sql`(${table.revokedAt} is null and ${table.revokeReason} is null)
          or (
            ${table.revokedAt} is not null
            and ${table.revokeReason} is not null
            and ${table.revokedAt} >= ${table.createdAt}
            and char_length(btrim(${table.revokeReason})) between 1 and 160
            and ${table.revokeReason} = btrim(${table.revokeReason})
            and ${table.revokeReason} !~ '[[:cntrl:]]'
          )`,
    ),
  ],
);

export const worlds = pgTable(
  'worlds',
  {
    id: uuid('id').primaryKey(),
    slug: citext('slug').notNull(),
    name: text('name').notNull(),
    lifecycle: worldLifecycle('lifecycle').default('draft').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rowVersion: integer('row_version').default(1).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    archivedAt: timestamptz('archived_at'),
    // The cyclic same-world FK to manifest_revisions is defined by migration 0005.
    currentApprovedManifestRevisionId: uuid('current_approved_manifest_revision_id'),
    manifestSchemaVersion: integer('manifest_schema_version'),
    // The cyclic same-world FK to world_versions is defined by migration 0006.
    activeWorldVersionId: uuid('active_world_version_id'),
  },
  (table) => [
    uniqueIndex('worlds_slug_unique').on(table.slug),
    index('worlds_creator_idx').on(table.createdByUserId, table.createdAt),
    index('worlds_active_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.archivedAt} is null`),
    check(
      'worlds_slug_shape',
      sql`char_length(${table.slug}::text) between 3 and 63
          and ${table.slug}::text = lower(${table.slug}::text)
          and ${table.slug}::text ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`,
    ),
    check(
      'worlds_name_bounded',
      sql`char_length(btrim(${table.name})) between 1 and 120
          and ${table.name} = btrim(${table.name})
          and ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check('worlds_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'worlds_manifest_schema_version_known',
      sql`${table.manifestSchemaVersion} is null or ${table.manifestSchemaVersion} = 1`,
    ),
    check(
      'worlds_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}
          and (${table.archivedAt} is null or ${table.archivedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const worldMemberships = pgTable(
  'world_memberships',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: worldRole('role').notNull(),
    status: membershipStatus('status').default('active').notNull(),
    rowVersion: integer('row_version').default(1).notNull(),
    joinedAt: timestamptz('joined_at').defaultNow().notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    removedAt: timestamptz('removed_at'),
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.worldId, table.userId] }),
    uniqueIndex('world_memberships_one_active_creator_idx')
      .on(table.worldId)
      .where(sql`${table.role} = 'creator' and ${table.status} = 'active'`),
    index('world_memberships_user_status_idx').on(table.userId, table.status, table.worldId),
    index('world_memberships_world_status_idx').on(
      table.worldId,
      table.status,
      table.role,
      table.userId,
    ),
    check('world_memberships_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'world_memberships_status_consistent',
      sql`(${table.status} = 'active' and ${table.removedAt} is null)
          or (${table.status} = 'removed' and ${table.removedAt} is not null)`,
    ),
    check(
      'world_memberships_timestamps_ordered',
      sql`${table.joinedAt} >= ${table.createdAt}
          and ${table.updatedAt} >= ${table.createdAt}
          and (${table.removedAt} is null or ${table.removedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const worldInvitations = pgTable(
  'world_invitations',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    email: citext('email').notNull(),
    intendedRole: worldRole('intended_role').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    status: invitationStatus('status').default('pending').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    acceptedAt: timestamptz('accepted_at'),
    revokedAt: timestamptz('revoked_at'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    rowVersion: integer('row_version').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('world_invitations_token_hash_unique').on(table.tokenHash),
    uniqueIndex('world_invitations_one_pending_email_idx')
      .on(table.worldId, table.email)
      .where(sql`${table.status} = 'pending'`),
    index('world_invitations_world_status_idx').on(
      table.worldId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('world_invitations_expiry_idx')
      .on(table.expiresAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    check(
      'world_invitations_email_shape',
      sql`char_length(${table.email}::text) between 3 and 320
          and ${table.email}::text = btrim(${table.email}::text)
          and ${table.email}::text = lower(${table.email}::text)
          and ${table.email}::text !~ '[[:cntrl:]]'`,
    ),
    check(
      'world_invitations_role_restricted',
      sql`${table.intendedRole} in ('player', 'observer')`,
    ),
    check('world_invitations_token_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
    check('world_invitations_row_version_positive', sql`${table.rowVersion} > 0`),
    check('world_invitations_expiry_ordered', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'world_invitations_status_consistent',
      sql`(${table.status} = 'pending'
            and ${table.acceptedByUserId} is null
            and ${table.acceptedAt} is null
            and ${table.revokedAt} is null)
          or (${table.status} = 'accepted'
            and ${table.acceptedByUserId} is not null
            and ${table.acceptedAt} is not null
            and ${table.acceptedAt} >= ${table.createdAt}
            and ${table.acceptedAt} <= ${table.expiresAt}
            and ${table.revokedAt} is null)
          or (${table.status} = 'revoked'
            and ${table.acceptedByUserId} is null
            and ${table.acceptedAt} is null
            and ${table.revokedAt} is not null
            and ${table.revokedAt} >= ${table.createdAt})
          or (${table.status} = 'expired'
            and ${table.acceptedByUserId} is null
            and ${table.acceptedAt} is null
            and ${table.revokedAt} is null)`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    scope: text('scope').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    state: idempotencyState('state').default('processing').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.actorId, table.key] }),
    index('idempotency_records_cleanup_idx').on(
      table.expiresAt,
      table.scope,
      table.actorId,
      table.key,
    ),
    check(
      'idempotency_records_scope_bounded',
      sql`char_length(${table.scope}) between 1 and 160
          and ${table.scope} = btrim(${table.scope})
          and ${table.scope} ~ '^[a-z0-9][a-z0-9._:/-]*$'`,
    ),
    check(
      'idempotency_records_key_bounded',
      sql`char_length(${table.key}) between 8 and 128
          and ${table.key} = btrim(${table.key})
          and ${table.key} !~ '[[:cntrl:]]'`,
    ),
    check('idempotency_records_request_hash_length', sql`octet_length(${table.requestHash}) = 32`),
    check(
      'idempotency_records_response_bounded',
      sql`${table.responseBody} is null or pg_column_size(${table.responseBody}) <= 65536`,
    ),
    check(
      'idempotency_records_response_has_no_secret_keys',
      sql`${table.responseBody} is null
          or not worldgraph_jsonb_has_sensitive_key(${table.responseBody})`,
    ),
    check(
      'idempotency_records_state_consistent',
      sql`(${table.state} = 'processing'
            and ${table.responseStatus} is null
            and ${table.responseBody} is null)
          or (${table.state} = 'completed'
            and ${table.responseStatus} between 100 and 599
            and ${table.responseBody} is not null)`,
    ),
    check('idempotency_records_expiry_ordered', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const securityAuditRecords = pgTable(
  'security_audit_records',
  {
    id: uuid('id').primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    worldId: uuid('world_id').references(() => worlds.id, { onDelete: 'restrict' }),
    category: text('category').notNull(),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    reasonCode: text('reason_code').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    requestId: text('request_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    redactedMetadata: jsonb('redacted_metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    occurredAt: timestamptz('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('security_audit_records_actor_world_link_unique').on(
      table.id,
      table.worldId,
      table.actorUserId,
    ),
    index('security_audit_records_world_cursor_idx').on(table.worldId, table.occurredAt, table.id),
    index('security_audit_records_actor_cursor_idx').on(
      table.actorUserId,
      table.occurredAt,
      table.id,
    ),
    index('security_audit_records_category_cursor_idx').on(
      table.category,
      table.occurredAt,
      table.id,
    ),
    check(
      'security_audit_records_category_bounded',
      sql`char_length(${table.category}) between 1 and 80
          and ${table.category} ~ '^[a-z][a-z0-9._-]*$'`,
    ),
    check(
      'security_audit_records_action_bounded',
      sql`char_length(${table.action}) between 1 and 160
          and ${table.action} ~ '^[a-z][a-zA-Z0-9._:-]*$'`,
    ),
    check(
      'security_audit_records_outcome_known',
      sql`${table.outcome} in ('allowed', 'denied', 'succeeded', 'failed')`,
    ),
    check(
      'security_audit_records_reason_code_bounded',
      sql`char_length(${table.reasonCode}) between 1 and 120
          and ${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
    check(
      'security_audit_records_target_consistent',
      sql`(${table.targetType} is null and ${table.targetId} is null)
          or (${table.targetType} is not null
            and ${table.targetId} is not null
            and char_length(${table.targetType}) between 1 and 80
            and ${table.targetType} ~ '^[a-z][a-z0-9._-]*$')`,
    ),
    check(
      'security_audit_records_request_id_bounded',
      sql`char_length(${table.requestId}) between 1 and 128
          and ${table.requestId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'security_audit_records_correlation_id_bounded',
      sql`char_length(${table.correlationId}) between 1 and 128
          and ${table.correlationId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'security_audit_records_metadata_object',
      sql`jsonb_typeof(${table.redactedMetadata}) = 'object'
          and pg_column_size(${table.redactedMetadata}) <= 16384
          and not worldgraph_jsonb_has_sensitive_key(${table.redactedMetadata})`,
    ),
  ],
);

export const creatorOverrideRecords = pgTable(
  'creator_override_records',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reason: text('reason').notNull(),
    authorityRuleId: text('authority_rule_id').notNull(),
    commandId: uuid('command_id').notNull(),
    auditRecordId: uuid('audit_record_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('creator_override_records_command_unique').on(table.commandId),
    uniqueIndex('creator_override_records_audit_unique').on(table.auditRecordId),
    index('creator_override_records_world_cursor_idx').on(table.worldId, table.createdAt, table.id),
    foreignKey({
      columns: [table.auditRecordId, table.worldId, table.actorUserId],
      foreignColumns: [
        securityAuditRecords.id,
        securityAuditRecords.worldId,
        securityAuditRecords.actorUserId,
      ],
      name: 'creator_override_records_audit_link',
    }).onDelete('restrict'),
    check(
      'creator_override_records_action_bounded',
      sql`char_length(${table.action}) between 1 and 160
          and ${table.action} ~ '^[a-z][a-zA-Z0-9._:-]*$'`,
    ),
    check(
      'creator_override_records_target_type_bounded',
      sql`char_length(${table.targetType}) between 1 and 80
          and ${table.targetType} ~ '^[a-z][a-z0-9._-]*$'`,
    ),
    check(
      'creator_override_records_reason_bounded',
      sql`char_length(btrim(${table.reason})) between 1 and 500
          and ${table.reason} = btrim(${table.reason})
          and ${table.reason} !~ '[[:cntrl:]]'`,
    ),
    check(
      'creator_override_records_rule_bounded',
      sql`char_length(${table.authorityRuleId}) between 1 and 160
          and ${table.authorityRuleId} ~ '^[a-z][a-zA-Z0-9._:-]*$'`,
    ),
  ],
);

export const primitiveFamilies = pgTable(
  'primitive_families',
  {
    id: uuid('id').primaryKey(),
    stableKey: citext('stable_key').notNull(),
    kind: primitiveKind('kind').notNull(),
    displayName: text('display_name').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('primitive_families_stable_key_unique').on(table.stableKey),
    index('primitive_families_kind_key_idx').on(table.kind, table.stableKey),
    check(
      'primitive_families_key_shape',
      sql`char_length(${table.stableKey}::text) between 5 and 160 and ${table.stableKey}::text = lower(${table.stableKey}::text) and ${table.stableKey}::text ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*){2,}$'`,
    ),
    check(
      'primitive_families_display_name_bounded',
      sql`char_length(btrim(${table.displayName})) between 1 and 120 and ${table.displayName} = btrim(${table.displayName}) and ${table.displayName} !~ '[[:cntrl:]]'`,
    ),
    check('primitive_families_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const primitiveVersions = pgTable(
  'primitive_versions',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => primitiveFamilies.id, { onDelete: 'restrict' }),
    semver: text('semver').notNull(),
    semverMajor: numeric('semver_major').notNull(),
    semverMinor: numeric('semver_minor').notNull(),
    semverPatch: numeric('semver_patch').notNull(),
    semverPrerelease: text('semver_prerelease'),
    semverBuild: text('semver_build'),
    primitiveSchemaVersion: integer('primitive_schema_version').notNull(),
    lifecycle: primitiveLifecycle('lifecycle').default('draft').notNull(),
    displayName: text('display_name').notNull(),
    documentation: text('documentation').notNull(),
    parameterSchema: jsonb('parameter_schema').$type<Record<string, unknown>>().notNull(),
    defaults: jsonb('defaults').$type<Record<string, unknown>>().notNull(),
    compatibility: jsonb('compatibility').$type<Record<string, unknown>>().notNull(),
    behaviorRef: text('behavior_ref'),
    visualHints: jsonb('visual_hints').$type<Record<string, unknown>>().notNull(),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull(),
    contentHash: bytea('content_hash').notNull(),
    rowVersion: integer('row_version').default(1).notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    publishedByUserId: uuid('published_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    publishedAt: timestamptz('published_at'),
    deprecatedByUserId: uuid('deprecated_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    deprecatedAt: timestamptz('deprecated_at'),
    deprecationReason: text('deprecation_reason'),
  },
  (table) => [
    uniqueIndex('primitive_versions_family_semver_unique').on(table.familyId, table.semver),
    uniqueIndex('primitive_versions_content_identity').on(table.id, table.contentHash),
    uniqueIndex('primitive_versions_resolution_identity').on(
      table.id,
      table.familyId,
      table.contentHash,
    ),
    index('primitive_versions_family_lifecycle_idx').on(
      table.familyId,
      table.lifecycle,
      table.semverMajor.desc(),
      table.semverMinor.desc(),
      table.semverPatch.desc(),
      table.semver.desc(),
    ),
    index('primitive_versions_lifecycle_published_idx')
      .on(table.lifecycle, table.publishedAt.desc(), table.id)
      .where(sql`${table.lifecycle} in ('published', 'deprecated')`),
    index('primitive_versions_lifecycle_semver_idx').on(
      table.lifecycle,
      sql`worldgraph_semver_sort_key(${table.semver}) collate "C" desc`,
      sql`${table.semver} collate "C" desc`,
      table.id.desc(),
    ),
    check(
      'primitive_versions_semver_shape',
      sql`char_length(${table.semver}) between 5 and 64 and ${table.semver} ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' and ${table.semverMajor} >= 0 and ${table.semverMinor} >= 0 and ${table.semverPatch} >= 0 and ${table.semverMajor} = trunc(${table.semverMajor}) and ${table.semverMinor} = trunc(${table.semverMinor}) and ${table.semverPatch} = trunc(${table.semverPatch}) and ${table.semverMajor} = split_part(${table.semver}, '.', 1)::numeric and ${table.semverMinor} = split_part(${table.semver}, '.', 2)::numeric and ${table.semverPatch} = substring(split_part(${table.semver}, '.', 3) from '^[0-9]+')::numeric and ${table.semverPrerelease} is not distinct from substring(${table.semver} from '-([^+]+)') and ${table.semverBuild} is not distinct from substring(${table.semver} from '\+(.+)$')`,
    ),
    check('primitive_versions_schema_version_known', sql`${table.primitiveSchemaVersion} = 1`),
    check(
      'primitive_versions_display_name_bounded',
      sql`char_length(btrim(${table.displayName})) between 1 and 120 and ${table.displayName} = btrim(${table.displayName}) and ${table.displayName} !~ '[[:cntrl:]]'`,
    ),
    check(
      'primitive_versions_documentation_bounded',
      sql`char_length(${table.documentation}) between 1 and 32000 and translate(${table.documentation}, E'\n\t', '') !~ '[[:cntrl:]]'`,
    ),
    check(
      'primitive_versions_json_shapes',
      sql`jsonb_typeof(${table.parameterSchema}) = 'object' and jsonb_typeof(${table.defaults}) = 'object' and jsonb_typeof(${table.compatibility}) = 'object' and jsonb_typeof(${table.visualHints}) = 'object' and jsonb_typeof(${table.provenance}) = 'object' and pg_column_size(${table.parameterSchema}) <= 65536 and pg_column_size(${table.defaults}) <= 32768 and pg_column_size(${table.compatibility}) <= 16384 and pg_column_size(${table.visualHints}) <= 16384 and pg_column_size(${table.provenance}) <= 16384 and not worldgraph_jsonb_has_sensitive_key(${table.provenance})`,
    ),
    check(
      'primitive_versions_behavior_ref_bounded',
      sql`${table.behaviorRef} is null or (char_length(${table.behaviorRef}) between 1 and 160 and ${table.behaviorRef} ~ '^[a-z][a-z0-9._-]*$')`,
    ),
    check('primitive_versions_hash_length', sql`octet_length(${table.contentHash}) = 32`),
    check('primitive_versions_row_version_positive', sql`${table.rowVersion} > 0`),
    check('primitive_versions_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'primitive_versions_lifecycle_consistent',
      sql`(${table.lifecycle} = 'draft' and ${table.publishedByUserId} is null and ${table.publishedAt} is null and ${table.deprecatedByUserId} is null and ${table.deprecatedAt} is null and ${table.deprecationReason} is null) or (${table.lifecycle} = 'published' and ${table.publishedByUserId} is not null and ${table.publishedAt} is not null and ${table.publishedAt} >= ${table.createdAt} and ${table.updatedAt} >= ${table.publishedAt} and ${table.deprecatedByUserId} is null and ${table.deprecatedAt} is null and ${table.deprecationReason} is null) or (${table.lifecycle} = 'deprecated' and ${table.publishedByUserId} is not null and ${table.publishedAt} is not null and ${table.deprecatedByUserId} is not null and ${table.deprecatedAt} is not null and ${table.deprecatedAt} >= ${table.publishedAt} and ${table.updatedAt} >= ${table.deprecatedAt} and char_length(btrim(${table.deprecationReason})) between 10 and 500 and ${table.deprecationReason} = btrim(${table.deprecationReason}) and ${table.deprecationReason} !~ '[[:cntrl:]]')`,
    ),
  ],
);

export const primitiveTags = pgTable(
  'primitive_tags',
  {
    primitiveVersionId: uuid('primitive_version_id')
      .notNull()
      .references(() => primitiveVersions.id, { onDelete: 'cascade' }),
    tag: citext('tag').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.primitiveVersionId, table.tag] }),
    index('primitive_tags_tag_version_idx').on(table.tag, table.primitiveVersionId),
    check(
      'primitive_tags_shape',
      sql`char_length(${table.tag}::text) between 1 and 64 and ${table.tag}::text = lower(${table.tag}::text) and ${table.tag}::text ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  ],
);

export const primitiveDependencies = pgTable(
  'primitive_dependencies',
  {
    primitiveVersionId: uuid('primitive_version_id')
      .notNull()
      .references(() => primitiveVersions.id, { onDelete: 'cascade' }),
    dependencyFamilyId: uuid('dependency_family_id')
      .notNull()
      .references(() => primitiveFamilies.id, { onDelete: 'restrict' }),
    versionRange: text('version_range').notNull(),
    required: boolean('required').default(true).notNull(),
    parameterMapping: jsonb('parameter_mapping')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    resolvedVersionId: uuid('resolved_version_id').references(() => primitiveVersions.id, {
      onDelete: 'restrict',
    }),
    resolvedContentHash: bytea('resolved_content_hash'),
  },
  (table) => [
    primaryKey({ columns: [table.primitiveVersionId, table.dependencyFamilyId] }),
    foreignKey({
      columns: [table.resolvedVersionId, table.dependencyFamilyId, table.resolvedContentHash],
      foreignColumns: [
        primitiveVersions.id,
        primitiveVersions.familyId,
        primitiveVersions.contentHash,
      ],
      name: 'primitive_dependencies_resolution_identity',
    }).onDelete('restrict'),
    index('primitive_dependencies_resolved_idx')
      .on(table.resolvedVersionId, table.primitiveVersionId)
      .where(sql`${table.resolvedVersionId} is not null`),
    check(
      'primitive_dependencies_no_self_edge',
      sql`${table.primitiveVersionId} <> ${table.resolvedVersionId}`,
    ),
    check(
      'primitive_dependencies_range_bounded',
      sql`char_length(btrim(${table.versionRange})) between 1 and 100 and ${table.versionRange} = btrim(${table.versionRange}) and ${table.versionRange} !~ '[[:cntrl:]]'`,
    ),
    check(
      'primitive_dependencies_mapping_bounded',
      sql`jsonb_typeof(${table.parameterMapping}) = 'object' and pg_column_size(${table.parameterMapping}) <= 16384`,
    ),
    check(
      'primitive_dependencies_resolution_pair',
      sql`(${table.resolvedVersionId} is null and ${table.resolvedContentHash} is null) or (${table.resolvedVersionId} is not null and octet_length(${table.resolvedContentHash}) = 32)`,
    ),
  ],
);

export const primitiveSearchDocuments = pgTable(
  'primitive_search_documents',
  {
    primitiveVersionId: uuid('primitive_version_id').primaryKey(),
    indexSchemaVersion: integer('index_schema_version').notNull(),
    contentHash: bytea('content_hash').notNull(),
    searchVector: tsvector('search_vector').notNull(),
    normalizedText: text('normalized_text').notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    // Drizzle 0.45 cannot express constraint deferrability. Migration 0004
    // defines this composite FK as DEFERRABLE INITIALLY DEFERRED.
    foreignKey({
      columns: [table.primitiveVersionId, table.contentHash],
      foreignColumns: [primitiveVersions.id, primitiveVersions.contentHash],
      name: 'primitive_search_documents_version_hash_fk',
    }).onDelete('cascade'),
    index('primitive_search_documents_vector_idx').using('gin', table.searchVector),
    check('primitive_search_documents_schema_known', sql`${table.indexSchemaVersion} = 1`),
    check('primitive_search_documents_hash_length', sql`octet_length(${table.contentHash}) = 32`),
    check(
      'primitive_search_documents_text_bounded',
      sql`char_length(${table.normalizedText}) between 1 and 40000 and translate(${table.normalizedText}, E'\n\t', '') !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const primitiveEmbeddings = pgTable(
  'primitive_embeddings',
  {
    id: uuid('id').primaryKey(),
    primitiveVersionId: uuid('primitive_version_id')
      .notNull()
      .references(() => primitiveVersions.id, { onDelete: 'cascade' }),
    providerConfigurationId: text('provider_configuration_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    contentHash: bytea('content_hash').notNull(),
    embedding: vector1536('embedding').notNull(),
    tokenEstimate: integer('token_estimate'),
    costEstimateMicrounits: bigint('cost_estimate_microunits', { mode: 'number' }),
    latencyMs: integer('latency_ms'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('primitive_embeddings_cache_unique').on(
      table.primitiveVersionId,
      table.providerConfigurationId,
      table.model,
      table.contentHash,
    ),
    check(
      'primitive_embeddings_provider_bounded',
      sql`char_length(${table.providerConfigurationId}) between 1 and 120 and char_length(${table.provider}) between 1 and 120 and char_length(${table.model}) between 1 and 160 and ${table.providerConfigurationId} = btrim(${table.providerConfigurationId}) and ${table.provider} = btrim(${table.provider}) and ${table.model} = btrim(${table.model}) and ${table.providerConfigurationId} !~ '[[:cntrl:]]' and ${table.provider} !~ '[[:cntrl:]]' and ${table.model} !~ '[[:cntrl:]]'`,
    ),
    check(
      'primitive_embeddings_dimensions_exact',
      sql`${table.dimensions} = 1536 and extensions.vector_dims(${table.embedding}) = 1536`,
    ),
    check('primitive_embeddings_hash_length', sql`octet_length(${table.contentHash}) = 32`),
    check(
      'primitive_embeddings_metrics_nonnegative',
      sql`(${table.tokenEstimate} is null or ${table.tokenEstimate} >= 0) and (${table.costEstimateMicrounits} is null or ${table.costEstimateMicrounits} >= 0) and (${table.latencyMs} is null or ${table.latencyMs} >= 0)`,
    ),
  ],
);

export const primitiveIndexJobs = pgTable(
  'primitive_index_jobs',
  {
    primitiveVersionId: uuid('primitive_version_id')
      .notNull()
      .references(() => primitiveVersions.id, { onDelete: 'cascade' }),
    contentHash: bytea('content_hash').notNull(),
    indexSchemaVersion: integer('index_schema_version').notNull(),
    providerConfigurationId: text('provider_configuration_id').notNull(),
    status: primitiveIndexStatus('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastErrorCode: text('last_error_code'),
    queuedAt: timestamptz('queued_at').defaultNow().notNull(),
    claimedAt: timestamptz('claimed_at'),
    nextAttemptAt: timestamptz('next_attempt_at').defaultNow().notNull(),
    completedAt: timestamptz('completed_at'),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.primitiveVersionId,
        table.contentHash,
        table.indexSchemaVersion,
        table.providerConfigurationId,
      ],
    }),
    index('primitive_index_jobs_pending_idx')
      .on(table.nextAttemptAt, table.queuedAt, table.primitiveVersionId)
      .where(sql`${table.status} in ('pending', 'failed')`),
    check('primitive_index_jobs_hash_length', sql`octet_length(${table.contentHash}) = 32`),
    check('primitive_index_jobs_schema_known', sql`${table.indexSchemaVersion} = 1`),
    check(
      'primitive_index_jobs_provider_bounded',
      sql`char_length(${table.providerConfigurationId}) between 1 and 120 and ${table.providerConfigurationId} = btrim(${table.providerConfigurationId}) and ${table.providerConfigurationId} !~ '[[:cntrl:]]'`,
    ),
    check('primitive_index_jobs_attempts_bounded', sql`${table.attempts} between 0 and 5`),
    check(
      'primitive_index_jobs_error_allowlisted',
      sql`${table.lastErrorCode} is null or ${table.lastErrorCode} in ('PROVIDER_DISABLED', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_FAILED', 'VECTOR_INVALID', 'CONTENT_STALE')`,
    ),
    check(
      'primitive_index_jobs_state_consistent',
      sql`(${table.status} = 'pending' and ${table.attempts} = 0 and ${table.claimedAt} is null and ${table.completedAt} is null and ${table.lastErrorCode} is null) or (${table.status} = 'running' and ${table.attempts} between 1 and 5 and ${table.claimedAt} is not null and ${table.completedAt} is null and ${table.lastErrorCode} is null) or (${table.status} = 'failed' and ${table.attempts} between 1 and 4 and ${table.claimedAt} is not null and ${table.completedAt} is null and ${table.lastErrorCode} is not null) or (${table.status} in ('dead', 'stale') and ${table.attempts} between 1 and 5 and ${table.claimedAt} is not null and ${table.completedAt} is not null and ${table.lastErrorCode} is not null) or (${table.status} = 'completed' and ${table.attempts} between 1 and 5 and ${table.claimedAt} is not null and ${table.completedAt} is not null and ${table.lastErrorCode} is null) or (${table.status} = 'disabled' and ${table.attempts} between 1 and 5 and ${table.claimedAt} is not null and ${table.completedAt} is not null and ${table.lastErrorCode} = 'PROVIDER_DISABLED')`,
    ),
    check(
      'primitive_index_jobs_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.queuedAt} and ${table.nextAttemptAt} >= ${table.queuedAt} and (${table.claimedAt} is null or ${table.claimedAt} >= ${table.queuedAt}) and (${table.completedAt} is null or ${table.completedAt} >= ${table.queuedAt}) and (${table.completedAt} is null or ${table.claimedAt} is null or ${table.completedAt} >= ${table.claimedAt}) and (${table.claimedAt} is null or ${table.updatedAt} >= ${table.claimedAt}) and (${table.completedAt} is null or ${table.updatedAt} >= ${table.completedAt})`,
    ),
  ],
);

export const worldPromptSubmissions = pgTable(
  'world_prompt_submissions',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    submittedByUserId: uuid('submitted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    promptText: text('prompt_text'),
    normalizedHash: bytea('normalized_hash').notNull(),
    clientSeed: text('client_seed'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    retentionUntil: timestamptz('retention_until').notNull(),
    redactedAt: timestamptz('redacted_at'),
  },
  (table) => [
    uniqueIndex('world_prompt_submissions_world_identity').on(table.id, table.worldId),
    index('world_prompt_submissions_world_cursor_idx').on(
      table.worldId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('world_prompt_submissions_retention_idx')
      .on(table.retentionUntil, table.id)
      .where(sql`${table.promptText} is not null`),
    check(
      'world_prompt_submissions_prompt_state',
      sql`(
          ${table.promptText} is not null
          and ${table.redactedAt} is null
          and char_length(${table.promptText}) between 1 and 8000
          and translate(${table.promptText}, E'\n\t', '') !~ '[[:cntrl:]]'
        ) or (
          ${table.promptText} is null
          and ${table.redactedAt} is not null
          and ${table.redactedAt} >= ${table.retentionUntil}
        )`,
    ),
    check('world_prompt_submissions_hash_length', sql`octet_length(${table.normalizedHash}) = 32`),
    check(
      'world_prompt_submissions_seed_bounded',
      sql`${table.clientSeed} is null or (
          char_length(${table.clientSeed}) between 1 and 128
          and ${table.clientSeed} = btrim(${table.clientSeed})
          and ${table.clientSeed} !~ '[[:cntrl:]]'
        )`,
    ),
    check(
      'world_prompt_submissions_retention_ordered',
      sql`${table.retentionUntil} > ${table.createdAt}
          and (${table.redactedAt} is null or ${table.redactedAt} >= ${table.retentionUntil})`,
    ),
  ],
);

export const manifestGenerationRuns = pgTable(
  'manifest_generation_runs',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    promptSubmissionId: uuid('prompt_submission_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: manifestGenerationStatus('status').default('queued').notNull(),
    generatorSchemaVersion: integer('generator_schema_version').notNull(),
    promptTemplateVersion: integer('prompt_template_version').notNull(),
    stage: text('stage').default('queued').notNull(),
    progressPercent: integer('progress_percent').default(0).notNull(),
    generationMode: manifestGenerationMode('generation_mode'),
    providerConfigurationId: text('provider_configuration_id').notNull(),
    provider: text('provider'),
    model: text('model'),
    // Migration 0005 adds the cyclic same-world/content FK after manifest_revisions exists.
    parentRevisionId: uuid('parent_revision_id'),
    expectedParentContentHash: bytea('expected_parent_content_hash'),
    seed: text('seed').notNull(),
    inputHash: bytea('input_hash').notNull(),
    primitiveCatalogSnapshotHash: bytea('primitive_catalog_snapshot_hash'),
    resolvedInputHash: bytea('resolved_input_hash'),
    outputReview: jsonb('output_review').$type<Record<string, unknown>>(),
    // Migration 0005 adds the cyclic same-world FK after manifest_revisions exists.
    outputRevisionId: uuid('output_revision_id'),
    attempts: integer('attempts').default(0).notNull(),
    repairAttempts: integer('repair_attempts').default(0).notNull(),
    providerCallCount: integer('provider_call_count').default(0).notNull(),
    inputTokenCount: integer('input_token_count'),
    outputTokenCount: integer('output_token_count'),
    costEstimateMicrounits: bigint('cost_estimate_microunits', { mode: 'number' }),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    queuedAt: timestamptz('queued_at').defaultNow().notNull(),
    nextAttemptAt: timestamptz('next_attempt_at').defaultNow().notNull(),
    claimToken: uuid('claim_token'),
    claimedAt: timestamptz('claimed_at'),
    heartbeatAt: timestamptz('heartbeat_at'),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    rowVersion: integer('row_version').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('manifest_generation_runs_world_identity').on(table.id, table.worldId),
    foreignKey({
      columns: [table.promptSubmissionId, table.worldId],
      foreignColumns: [worldPromptSubmissions.id, worldPromptSubmissions.worldId],
      name: 'manifest_generation_runs_prompt_world_fk',
    }).onDelete('restrict'),
    index('manifest_generation_runs_queue_idx')
      .on(table.nextAttemptAt, table.queuedAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    index('manifest_generation_runs_running_lease_idx')
      .on(table.heartbeatAt, table.claimedAt, table.id)
      .where(sql`${table.status} = 'running'`),
    index('manifest_generation_runs_world_cursor_idx').on(
      table.worldId,
      table.queuedAt.desc(),
      table.id.desc(),
    ),
    index('manifest_generation_runs_requester_status_idx').on(
      table.requestedByUserId,
      table.status,
      table.queuedAt.desc(),
      table.id.desc(),
    ),
    uniqueIndex('manifest_generation_runs_output_unique_idx')
      .on(table.outputRevisionId)
      .where(sql`${table.outputRevisionId} is not null`),
    index('manifest_generation_runs_input_cache_idx').on(
      table.worldId,
      table.inputHash,
      table.promptTemplateVersion,
      table.queuedAt.desc(),
      table.id.desc(),
    ),
    index('manifest_generation_runs_resolved_input_cache_idx')
      .on(table.worldId, table.resolvedInputHash, table.queuedAt.desc(), table.id.desc())
      .where(sql`${table.resolvedInputHash} is not null`),
    uniqueIndex('manifest_generation_runs_one_active_root_world_idx')
      .on(table.worldId)
      .where(sql`${table.parentRevisionId} is null and ${table.status} in ('queued', 'running')`),
    check('manifest_generation_runs_schema_known', sql`${table.generatorSchemaVersion} = 1`),
    check('manifest_generation_runs_template_known', sql`${table.promptTemplateVersion} = 1`),
    check(
      'manifest_generation_runs_stage_known',
      sql`${table.stage} in (
        'queued', 'intent', 'retrieval', 'generation', 'repair',
        'fallback', 'validation', 'persisting', 'complete'
      )`,
    ),
    check(
      'manifest_generation_runs_progress_bounded',
      sql`${table.progressPercent} between 0 and 100`,
    ),
    check(
      'manifest_generation_runs_provider_configuration_bounded',
      sql`char_length(${table.providerConfigurationId}) between 1 and 120
          and ${table.providerConfigurationId} = btrim(${table.providerConfigurationId})
          and ${table.providerConfigurationId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'manifest_generation_runs_provider_pair',
      sql`(${table.provider} is null and ${table.model} is null) or (
          ${table.provider} is not null and ${table.model} is not null
          and char_length(${table.provider}) between 1 and 120
          and char_length(${table.model}) between 1 and 160
          and ${table.provider} = btrim(${table.provider})
          and ${table.model} = btrim(${table.model})
          and ${table.provider} !~ '[[:cntrl:]]'
          and ${table.model} !~ '[[:cntrl:]]'
        )`,
    ),
    check(
      'manifest_generation_runs_mode_provider_consistent',
      sql`${table.generationMode} is distinct from 'provider'::manifest_generation_mode
          or (${table.provider} is not null and ${table.model} is not null)`,
    ),
    check(
      'manifest_generation_runs_seed_bounded',
      sql`char_length(${table.seed}) between 1 and 128
          and ${table.seed} = btrim(${table.seed})
          and ${table.seed} !~ '[[:cntrl:]]'`,
    ),
    check(
      'manifest_generation_runs_parent_input_consistent',
      sql`(${table.parentRevisionId} is null and ${table.expectedParentContentHash} is null)
          or (${table.parentRevisionId} is not null
            and ${table.expectedParentContentHash} is not null
            and octet_length(${table.expectedParentContentHash}) = 32)`,
    ),
    check('manifest_generation_runs_input_hash_length', sql`octet_length(${table.inputHash}) = 32`),
    check('manifest_generation_runs_attempts_bounded', sql`${table.attempts} between 0 and 3`),
    check(
      'manifest_generation_runs_repair_attempts_bounded',
      sql`${table.repairAttempts} between 0 and 2`,
    ),
    check(
      'manifest_generation_runs_provider_call_count_bounded',
      sql`${table.providerCallCount} between 0 and 9`,
    ),
    check(
      'manifest_generation_runs_catalog_hash_length',
      sql`(${table.primitiveCatalogSnapshotHash} is null and ${table.resolvedInputHash} is null)
          or (${table.primitiveCatalogSnapshotHash} is not null
            and ${table.resolvedInputHash} is not null
            and octet_length(${table.primitiveCatalogSnapshotHash}) = 32
            and octet_length(${table.resolvedInputHash}) = 32)`,
    ),
    check(
      'manifest_generation_runs_output_review_bounded',
      sql`${table.outputReview} is null or (
          jsonb_typeof(${table.outputReview}) = 'object'
          and pg_column_size(${table.outputReview}) <= 262144
          and not worldgraph_jsonb_has_sensitive_key(${table.outputReview})
        )`,
    ),
    check(
      'manifest_generation_runs_metrics_nonnegative',
      sql`(${table.inputTokenCount} is null or ${table.inputTokenCount} >= 0)
          and (${table.outputTokenCount} is null or ${table.outputTokenCount} >= 0)
          and (${table.costEstimateMicrounits} is null or ${table.costEstimateMicrounits} >= 0)
          and (${table.latencyMs} is null or ${table.latencyMs} >= 0)`,
    ),
    check(
      'manifest_generation_runs_error_bounded',
      sql`${table.errorCode} is null or (
          char_length(${table.errorCode}) between 1 and 100
          and ${table.errorCode} ~ '^[A-Z][A-Z0-9_]*$'
        )`,
    ),
    check('manifest_generation_runs_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'manifest_generation_runs_state_consistent',
      sql`(${table.status} = 'queued' and ${table.attempts} between 0 and 2
            and ${table.stage} = 'queued' and ${table.progressPercent} between 0 and 99
            and ${table.completedAt} is null and ${table.outputRevisionId} is null
            and ${table.errorCode} is null and ${table.claimToken} is null
            and ((${table.attempts} = 0 and ${table.startedAt} is null
              and ${table.claimedAt} is null and ${table.heartbeatAt} is null)
              or (${table.attempts} > 0 and ${table.startedAt} is not null
                and ${table.claimedAt} is not null and ${table.heartbeatAt} is not null)))
          or (${table.status} = 'running' and ${table.attempts} between 1 and 3
            and ${table.startedAt} is not null and ${table.completedAt} is null
            and ${table.outputRevisionId} is null and ${table.errorCode} is null
            and ${table.claimToken} is not null and ${table.claimedAt} is not null
            and ${table.heartbeatAt} is not null and ${table.stage} not in ('queued', 'complete')
            and ${table.progressPercent} between 1 and 99)
          or (${table.status} = 'succeeded' and ${table.attempts} between 1 and 3
            and ${table.startedAt} is not null and ${table.completedAt} is not null
            and ${table.outputRevisionId} is not null and ${table.errorCode} is null
            and ${table.claimToken} is null and ${table.claimedAt} is not null
            and ${table.heartbeatAt} is not null and ${table.stage} = 'complete'
            and ${table.progressPercent} = 100 and ${table.generationMode} is not null
            and ${table.primitiveCatalogSnapshotHash} is not null
            and ${table.resolvedInputHash} is not null and ${table.outputReview} is not null)
          or (${table.status} = 'failed' and ${table.attempts} between 1 and 3
            and ${table.startedAt} is not null and ${table.completedAt} is not null
            and ${table.outputRevisionId} is null and ${table.errorCode} is not null
            and ${table.claimToken} is null and ${table.claimedAt} is not null
            and ${table.heartbeatAt} is not null and ${table.stage} <> 'complete'
            and ${table.progressPercent} between 1 and 99)
          or (${table.status} = 'cancelled' and ${table.attempts} between 0 and 3
            and ${table.completedAt} is not null and ${table.outputRevisionId} is null
            and ${table.errorCode} is null and ${table.claimToken} is null
            and ${table.stage} <> 'complete' and ${table.progressPercent} between 0 and 99
            and ((${table.attempts} = 0 and ${table.startedAt} is null
              and ${table.claimedAt} is null and ${table.heartbeatAt} is null)
              or (${table.attempts} > 0 and ${table.startedAt} is not null
                and ${table.claimedAt} is not null and ${table.heartbeatAt} is not null)))`,
    ),
    check(
      'manifest_generation_runs_timestamps_ordered',
      sql`${table.nextAttemptAt} >= ${table.queuedAt} and ${table.updatedAt} >= ${table.queuedAt}
          and (${table.claimedAt} is null or ${table.claimedAt} >= ${table.queuedAt})
          and (${table.heartbeatAt} is null or ${table.claimedAt} is null
            or ${table.heartbeatAt} >= ${table.claimedAt})
          and (${table.startedAt} is null or ${table.startedAt} >= ${table.queuedAt})
          and (${table.completedAt} is null or ${table.completedAt} >= ${table.queuedAt})
          and (${table.completedAt} is null or ${table.startedAt} is null
            or ${table.completedAt} >= ${table.startedAt})
          and (${table.heartbeatAt} is null or ${table.updatedAt} >= ${table.heartbeatAt})
          and (${table.startedAt} is null or ${table.updatedAt} >= ${table.startedAt})
          and (${table.completedAt} is null or ${table.updatedAt} >= ${table.completedAt})`,
    ),
  ],
);

export const manifestProviderCalls = pgTable(
  'manifest_provider_calls',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => manifestGenerationRuns.id, { onDelete: 'restrict' }),
    claimToken: uuid('claim_token').notNull(),
    runAttempt: integer('run_attempt').notNull(),
    callNumber: integer('call_number').notNull(),
    callKind: text('call_kind').notNull(),
    providerConfigurationId: text('provider_configuration_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    usageDate: date('usage_date', { mode: 'string' }).notNull(),
    status: text('status').default('reserved').notNull(),
    reservedCostMicrounits: bigint('reserved_cost_microunits', { mode: 'number' }).notNull(),
    reservedInputTokens: integer('reserved_input_tokens').notNull(),
    reservedOutputTokens: integer('reserved_output_tokens').notNull(),
    actualCostMicrounits: bigint('actual_cost_microunits', { mode: 'number' }),
    actualInputTokens: integer('actual_input_tokens'),
    actualOutputTokens: integer('actual_output_tokens'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    settledAt: timestamptz('settled_at'),
  },
  (table) => [
    uniqueIndex('manifest_provider_calls_run_number_unique').on(table.runId, table.callNumber),
    index('manifest_provider_calls_daily_budget_idx').on(table.usageDate, table.status, table.id),
    index('manifest_provider_calls_run_idx').on(table.runId, table.createdAt, table.id),
    check('manifest_provider_calls_attempt_bounded', sql`${table.runAttempt} between 1 and 3`),
    check('manifest_provider_calls_number_bounded', sql`${table.callNumber} between 1 and 9`),
    check('manifest_provider_calls_kind_known', sql`${table.callKind} in ('generate','repair')`),
    check(
      'manifest_provider_calls_identity_bounded',
      sql`char_length(${table.providerConfigurationId}) between 1 and 120
          and char_length(${table.provider}) between 1 and 120
          and char_length(${table.model}) between 1 and 160
          and ${table.providerConfigurationId} = btrim(${table.providerConfigurationId})
          and ${table.provider} = btrim(${table.provider})
          and ${table.model} = btrim(${table.model})
          and ${table.providerConfigurationId} !~ '[[:cntrl:]]'
          and ${table.provider} !~ '[[:cntrl:]]'
          and ${table.model} !~ '[[:cntrl:]]'`,
    ),
    check(
      'manifest_provider_calls_reservation_bounded',
      sql`${table.reservedCostMicrounits} between 0 and 2147483647
          and ${table.reservedInputTokens} between 1 and 100000
          and ${table.reservedOutputTokens} between 1 and 100000`,
    ),
    check(
      'manifest_provider_calls_state_consistent',
      sql`(${table.status} = 'reserved'
            and ${table.actualCostMicrounits} is null
            and ${table.actualInputTokens} is null
            and ${table.actualOutputTokens} is null
            and ${table.settledAt} is null)
          or (${table.status} = 'settled'
            and ${table.actualCostMicrounits} between 0 and 2147483647
            and ${table.actualInputTokens} between 0 and 100000
            and ${table.actualOutputTokens} between 0 and 100000
            and ${table.actualCostMicrounits} <= ${table.reservedCostMicrounits}
            and ${table.actualInputTokens} <= ${table.reservedInputTokens}
            and ${table.actualOutputTokens} <= ${table.reservedOutputTokens}
            and ${table.settledAt} is not null)
          or (${table.status} = 'released'
            and ${table.actualCostMicrounits} is null
            and ${table.actualInputTokens} is null
            and ${table.actualOutputTokens} is null
            and ${table.settledAt} is not null)`,
    ),
    check(
      'manifest_provider_calls_timestamps_ordered',
      sql`${table.settledAt} is null or ${table.settledAt} >= ${table.createdAt}`,
    ),
  ],
);

export const generationRetrievalItems = pgTable(
  'generation_retrieval_items',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => manifestGenerationRuns.id, { onDelete: 'restrict' }),
    rank: integer('rank').notNull(),
    primitiveVersionId: uuid('primitive_version_id').notNull(),
    retrievalScore: doublePrecision('retrieval_score').notNull(),
    reason: jsonb('reason').$type<Record<string, unknown>>().notNull(),
    contentHash: bytea('content_hash').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.rank] }),
    uniqueIndex('generation_retrieval_items_run_primitive_unique').on(
      table.runId,
      table.primitiveVersionId,
    ),
    foreignKey({
      columns: [table.primitiveVersionId, table.contentHash],
      foreignColumns: [primitiveVersions.id, primitiveVersions.contentHash],
      name: 'generation_retrieval_items_primitive_identity_fk',
    }).onDelete('restrict'),
    index('generation_retrieval_items_primitive_idx').on(table.primitiveVersionId, table.runId),
    check('generation_retrieval_items_rank_bounded', sql`${table.rank} between 1 and 500`),
    check(
      'generation_retrieval_items_score_bounded',
      sql`${table.retrievalScore} >= 0 and ${table.retrievalScore} <= 1000000`,
    ),
    check(
      'generation_retrieval_items_reason_bounded',
      sql`jsonb_typeof(${table.reason}) = 'object'
          and pg_column_size(${table.reason}) <= 32768
          and not worldgraph_jsonb_has_sensitive_key(${table.reason})`,
    ),
    check('generation_retrieval_items_hash_length', sql`octet_length(${table.contentHash}) = 32`),
  ],
);

export const manifestRevisions = pgTable(
  'manifest_revisions',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    revisionNumber: bigint('revision_number', { mode: 'number' }).notNull(),
    parentRevisionId: uuid('parent_revision_id'),
    manifestSchemaVersion: integer('manifest_schema_version').notNull(),
    canonicalManifest: jsonb('canonical_manifest').$type<Record<string, unknown>>().notNull(),
    contentHash: bytea('content_hash').notNull(),
    source: manifestRevisionSource('source').notNull(),
    generationRunId: uuid('generation_run_id'),
    generationClaimToken: uuid('generation_claim_token'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    approvalStatus: manifestApprovalStatus('approval_status').default('draft').notNull(),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    approvedAt: timestamptz('approved_at'),
    generationWarnings: jsonb('generation_warnings')
      .$type<unknown[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    warningAcknowledgements: jsonb('warning_acknowledgements')
      .$type<unknown[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    rowVersion: integer('row_version').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('manifest_revisions_world_identity').on(table.id, table.worldId),
    uniqueIndex('manifest_revisions_world_content_identity').on(
      table.id,
      table.worldId,
      table.contentHash,
    ),
    uniqueIndex('manifest_revisions_world_number_unique').on(table.worldId, table.revisionNumber),
    uniqueIndex('manifest_revisions_world_content_unique').on(table.worldId, table.contentHash),
    foreignKey({
      columns: [table.parentRevisionId, table.worldId],
      foreignColumns: [table.id, table.worldId],
      name: 'manifest_revisions_parent_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.generationRunId, table.worldId],
      foreignColumns: [manifestGenerationRuns.id, manifestGenerationRuns.worldId],
      name: 'manifest_revisions_generation_world_fk',
    }).onDelete('restrict'),
    index('manifest_revisions_world_cursor_idx').on(
      table.worldId,
      table.revisionNumber.desc(),
      table.id.desc(),
    ),
    index('manifest_revisions_world_status_idx').on(
      table.worldId,
      table.approvalStatus,
      table.revisionNumber.desc(),
      table.id.desc(),
    ),
    uniqueIndex('manifest_revisions_one_approved_world_idx')
      .on(table.worldId)
      .where(sql`${table.approvalStatus} = 'approved'`),
    uniqueIndex('manifest_revisions_generation_run_unique_idx')
      .on(table.generationRunId)
      .where(sql`${table.generationRunId} is not null`),
    check(
      'manifest_revisions_number_bounded',
      sql`${table.revisionNumber} between 1 and 2147483647`,
    ),
    check(
      'manifest_revisions_parent_not_self',
      sql`${table.parentRevisionId} is null or ${table.parentRevisionId} <> ${table.id}`,
    ),
    check('manifest_revisions_schema_known', sql`${table.manifestSchemaVersion} = 1`),
    check(
      'manifest_revisions_manifest_bounded',
      sql`jsonb_typeof(${table.canonicalManifest}) = 'object'
          and pg_column_size(${table.canonicalManifest}) <= 1048576`,
    ),
    check('manifest_revisions_hash_length', sql`octet_length(${table.contentHash}) = 32`),
    check(
      'manifest_revisions_source_consistent',
      sql`(${table.source} = 'generation' and ${table.generationRunId} is not null
            and ${table.generationClaimToken} is not null)
          or (${table.source} in ('manual', 'import') and ${table.generationRunId} is null
            and ${table.generationClaimToken} is null)`,
    ),
    check(
      'manifest_revisions_generation_warnings_bounded',
      sql`jsonb_typeof(${table.generationWarnings}) = 'array'
          and jsonb_array_length(${table.generationWarnings}) <= 32
          and pg_column_size(${table.generationWarnings}) <= 65536
          and not worldgraph_jsonb_has_sensitive_key(${table.generationWarnings})`,
    ),
    check(
      'manifest_revisions_warning_acknowledgements_bounded',
      sql`jsonb_typeof(${table.warningAcknowledgements}) = 'array'
          and pg_column_size(${table.warningAcknowledgements}) <= 16384
          and not worldgraph_jsonb_has_sensitive_key(${table.warningAcknowledgements})`,
    ),
    check('manifest_revisions_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'manifest_revisions_approval_consistent',
      sql`(${table.approvalStatus} in ('draft', 'rejected')
            and ${table.approvedByUserId} is null and ${table.approvedAt} is null
            and ${table.warningAcknowledgements} = '[]'::jsonb)
          or (${table.approvalStatus} in ('approved', 'superseded')
            and ${table.approvedByUserId} is not null and ${table.approvedAt} is not null
            and ${table.approvedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const manifestValidationReports = pgTable(
  'manifest_validation_reports',
  {
    id: uuid('id').primaryKey(),
    manifestRevisionId: uuid('manifest_revision_id')
      .notNull()
      .references(() => manifestRevisions.id, { onDelete: 'restrict' }),
    validatorVersion: integer('validator_version').notNull(),
    primitiveCatalogSnapshotHash: bytea('primitive_catalog_snapshot_hash').notNull(),
    valid: boolean('valid').notNull(),
    diagnostics: jsonb('diagnostics').$type<unknown[]>().notNull(),
    reportHash: bytea('report_hash').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('manifest_validation_reports_identity_unique').on(
      table.manifestRevisionId,
      table.validatorVersion,
      table.primitiveCatalogSnapshotHash,
    ),
    index('manifest_validation_reports_revision_lookup_idx').on(
      table.manifestRevisionId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('manifest_validation_reports_validator_known', sql`${table.validatorVersion} = 1`),
    check(
      'manifest_validation_reports_catalog_hash_length',
      sql`octet_length(${table.primitiveCatalogSnapshotHash}) = 32`,
    ),
    check(
      'manifest_validation_reports_diagnostics_bounded',
      sql`jsonb_typeof(${table.diagnostics}) = 'array'
          and pg_column_size(${table.diagnostics}) <= 131072
          and not worldgraph_jsonb_has_sensitive_key(${table.diagnostics})`,
    ),
    check(
      'manifest_validation_reports_report_hash_length',
      sql`octet_length(${table.reportHash}) = 32`,
    ),
  ],
);

export const manifestFieldProvenance = pgTable(
  'manifest_field_provenance',
  {
    manifestRevisionId: uuid('manifest_revision_id')
      .notNull()
      .references(() => manifestRevisions.id, { onDelete: 'restrict' }),
    jsonPointer: text('json_pointer').notNull(),
    sourceType: manifestProvenanceSource('source_type').notNull(),
    sourceRef: text('source_ref').notNull(),
    sourceHash: bytea('source_hash').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.manifestRevisionId, table.jsonPointer, table.sourceType, table.sourceRef],
    }),
    index('manifest_field_provenance_source_idx').on(
      table.sourceType,
      table.sourceHash,
      table.manifestRevisionId,
    ),
    check(
      'manifest_field_provenance_pointer_bounded',
      sql`char_length(${table.jsonPointer}) <= 500
          and (${table.jsonPointer} = '' or left(${table.jsonPointer}, 1) = '/')
          and ${table.jsonPointer} !~ '[[:cntrl:]]'`,
    ),
    check(
      'manifest_field_provenance_ref_bounded',
      sql`char_length(${table.sourceRef}) between 1 and 256
          and ${table.sourceRef} = btrim(${table.sourceRef})
          and ${table.sourceRef} !~ '[[:cntrl:]]'`,
    ),
    check('manifest_field_provenance_hash_length', sql`octet_length(${table.sourceHash}) = 32`),
  ],
);

export const worldCompilationRuns = pgTable(
  'world_compilation_runs',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    manifestRevisionId: uuid('manifest_revision_id').notNull(),
    manifestContentHash: bytea('manifest_content_hash').notNull(),
    inputHash: bytea('input_hash').notNull(),
    compilerVersion: text('compiler_version').notNull(),
    compilerConfigVersion: integer('compiler_config_version').notNull(),
    seed: text('seed').notNull(),
    status: worldCompilationStatus('status').default('queued').notNull(),
    stage: worldCompilationStage('stage').default('queued').notNull(),
    progressPercent: integer('progress_percent').default(0).notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    diagnostics: jsonb('diagnostics')
      .$type<unknown[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    artifactHash: bytea('artifact_hash'),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamptz('next_attempt_at').defaultNow().notNull(),
    claimToken: uuid('claim_token'),
    claimedAt: timestamptz('claimed_at'),
    heartbeatAt: timestamptz('heartbeat_at'),
    queuedAt: timestamptz('queued_at').defaultNow().notNull(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    rowVersion: integer('row_version').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('world_compilation_runs_world_identity').on(table.id, table.worldId),
    uniqueIndex('world_compilation_runs_exact_identity').on(
      table.id,
      table.worldId,
      table.manifestRevisionId,
      table.compilerVersion,
      table.compilerConfigVersion,
      table.seed,
      table.artifactHash,
    ),
    uniqueIndex('world_compilation_runs_input_identity').on(
      table.worldId,
      table.inputHash,
      table.compilerVersion,
      table.compilerConfigVersion,
      table.seed,
    ),
    uniqueIndex('world_compilation_runs_idempotency_unique').on(
      table.worldId,
      table.requestedByUserId,
      table.idempotencyKey,
    ),
    uniqueIndex('world_compilation_runs_one_active_world_idx')
      .on(table.worldId)
      .where(sql`${table.status} in ('queued', 'running')`),
    uniqueIndex('world_compilation_runs_claim_token_unique_idx')
      .on(table.claimToken)
      .where(sql`${table.claimToken} is not null`),
    index('world_compilation_runs_queue_idx')
      .on(table.nextAttemptAt, table.queuedAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    index('world_compilation_runs_running_lease_idx')
      .on(table.heartbeatAt, table.claimedAt, table.id)
      .where(sql`${table.status} = 'running'`),
    index('world_compilation_runs_world_cursor_idx').on(
      table.worldId,
      table.queuedAt.desc(),
      table.id.desc(),
    ),
    foreignKey({
      columns: [table.manifestRevisionId, table.worldId, table.manifestContentHash],
      foreignColumns: [
        manifestRevisions.id,
        manifestRevisions.worldId,
        manifestRevisions.contentHash,
      ],
      name: 'world_compilation_runs_manifest_exact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.requestedByUserId],
      foreignColumns: [worldMemberships.worldId, worldMemberships.userId],
      name: 'world_compilation_runs_requester_membership_fk',
    }).onDelete('restrict'),
    check(
      'world_compilation_runs_hash_lengths',
      sql`octet_length(${table.manifestContentHash}) = 32
          and octet_length(${table.inputHash}) = 32
          and (${table.artifactHash} is null or octet_length(${table.artifactHash}) = 32)`,
    ),
    check(
      'world_compilation_runs_compiler_known',
      sql`${table.compilerVersion} in ('1.0.0','1.1.0','1.2.0') and ${table.compilerConfigVersion} = 1`,
    ),
    check(
      'world_compilation_runs_seed_bounded',
      sql`char_length(${table.seed}) between 1 and 128
          and ${table.seed} = btrim(${table.seed}) and ${table.seed} !~ '[[:cntrl:]]'`,
    ),
    check(
      'world_compilation_runs_idempotency_bounded',
      sql`char_length(${table.idempotencyKey}) between 8 and 128
          and ${table.idempotencyKey} = btrim(${table.idempotencyKey})
          and ${table.idempotencyKey} !~ '[[:cntrl:]]'`,
    ),
    check(
      'world_compilation_runs_diagnostics_bounded',
      sql`jsonb_typeof(${table.diagnostics}) = 'array'
          and jsonb_array_length(${table.diagnostics}) <= 256
          and pg_column_size(${table.diagnostics}) <= 262144
          and not worldgraph_jsonb_has_sensitive_key(${table.diagnostics})
          and not worldgraph_jsonb_has_compiler_private_key(${table.diagnostics})`,
    ),
    check('world_compilation_runs_attempts_bounded', sql`${table.attempts} between 0 and 3`),
    check(
      'world_compilation_runs_progress_bounded',
      sql`${table.progressPercent} between 0 and 100`,
    ),
    check('world_compilation_runs_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'world_compilation_runs_state_consistent',
      sql`(${table.status} = 'queued' and ${table.stage} = 'queued'
            and ${table.progressPercent} = 0 and ${table.diagnostics} = '[]'::jsonb
            and ${table.artifactHash} is null and ${table.claimToken} is null
            and ${table.claimedAt} is null and ${table.heartbeatAt} is null
            and ${table.startedAt} is null and ${table.completedAt} is null)
          or (${table.status} = 'running' and ${table.stage} in ('validating','compiling','seeding')
            and ${table.progressPercent} between 1 and 99 and ${table.attempts} between 1 and 3
            and ${table.artifactHash} is null and ${table.claimToken} is not null
            and ${table.claimedAt} is not null and ${table.heartbeatAt} is not null
            and ${table.startedAt} is not null and ${table.completedAt} is null)
          or (${table.status} = 'succeeded' and ${table.stage} = 'activated'
            and ${table.progressPercent} = 100 and ${table.attempts} between 1 and 3
            and ${table.artifactHash} is not null and ${table.claimToken} is null
            and ${table.claimedAt} is not null and ${table.heartbeatAt} is not null
            and ${table.startedAt} is not null and ${table.completedAt} is not null)
          or (${table.status} = 'failed' and ${table.stage} = 'failed'
            and ${table.progressPercent} between 1 and 99 and ${table.attempts} between 1 and 3
            and ${table.artifactHash} is null and jsonb_array_length(${table.diagnostics}) > 0
            and ${table.claimToken} is null and ${table.claimedAt} is not null
            and ${table.heartbeatAt} is not null and ${table.startedAt} is not null
            and ${table.completedAt} is not null)
          or (${table.status} = 'cancelled' and ${table.stage} = 'cancelled'
            and ${table.progressPercent} between 0 and 100 and ${table.artifactHash} is null
            and ${table.claimToken} is null and ${table.completedAt} is not null
            and ((${table.attempts} = 0 and ${table.claimedAt} is null
              and ${table.heartbeatAt} is null and ${table.startedAt} is null)
              or ${table.attempts} between 1 and 3))`,
    ),
    check(
      'world_compilation_runs_timestamps_ordered',
      sql`${table.nextAttemptAt} >= ${table.queuedAt} and ${table.updatedAt} >= ${table.queuedAt}
          and (${table.claimedAt} is null or ${table.claimedAt} >= ${table.queuedAt})
          and (${table.heartbeatAt} is null or ${table.claimedAt} is null
            or ${table.heartbeatAt} >= ${table.claimedAt})
          and (${table.startedAt} is null or ${table.startedAt} >= ${table.queuedAt})
          and (${table.completedAt} is null or ${table.completedAt} >= ${table.queuedAt})
          and (${table.completedAt} is null or ${table.startedAt} is null
            or ${table.completedAt} >= ${table.startedAt})
          and (${table.heartbeatAt} is null or ${table.updatedAt} >= ${table.heartbeatAt})
          and (${table.completedAt} is null or ${table.updatedAt} >= ${table.completedAt})`,
    ),
  ],
);

export const compiledWorldArtifacts = pgTable(
  'compiled_world_artifacts',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    compilationRunId: uuid('compilation_run_id').notNull(),
    artifactKind: text('artifact_kind').notNull(),
    artifactSchemaVersion: integer('artifact_schema_version').notNull(),
    canonicalContent: jsonb('canonical_content').$type<Record<string, unknown>>().notNull(),
    contentHash: bytea('content_hash').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('compiled_world_artifacts_run_kind_unique').on(
      table.compilationRunId,
      table.artifactKind,
    ),
    foreignKey({
      columns: [table.compilationRunId, table.worldId],
      foreignColumns: [worldCompilationRuns.id, worldCompilationRuns.worldId],
      name: 'compiled_world_artifacts_run_world_fk',
    }).onDelete('restrict'),
    index('compiled_world_artifacts_world_idx').on(
      table.worldId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      'compiled_world_artifacts_kind_known',
      sql`${table.artifactKind} in ('compiler_input','compiled_world','visual_plan')`,
    ),
    check(
      'compiled_world_artifacts_schema_known',
      sql`(${table.artifactKind} = 'compiled_world' and ${table.artifactSchemaVersion} in (1,2,3))
          or (${table.artifactKind} in ('compiler_input','visual_plan')
            and ${table.artifactSchemaVersion} = 1)`,
    ),
    check(
      'compiled_world_artifacts_content_bounded',
      sql`jsonb_typeof(${table.canonicalContent}) = 'object'
          and pg_column_size(${table.canonicalContent}) <= case ${table.artifactKind}
            when 'compiler_input' then 67108864
            when 'compiled_world' then 8388608
            when 'visual_plan' then 1048576
            else 0 end
          and not worldgraph_jsonb_has_sensitive_key(${table.canonicalContent})
          and not worldgraph_jsonb_has_compiler_private_key(${table.canonicalContent})`,
    ),
    check('compiled_world_artifacts_hash_length', sql`octet_length(${table.contentHash}) = 32`),
  ],
);

export const worldVersions = pgTable(
  'world_versions',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    versionNumber: bigint('version_number', { mode: 'number' }).notNull(),
    parentWorldVersionId: uuid('parent_world_version_id'),
    manifestRevisionId: uuid('manifest_revision_id').notNull(),
    compilationRunId: uuid('compilation_run_id').notNull(),
    worldSchemaVersion: integer('world_schema_version').notNull(),
    compilerVersion: text('compiler_version').notNull(),
    compilerConfigVersion: integer('compiler_config_version').notNull(),
    seed: text('seed').notNull(),
    artifactHash: bytea('artifact_hash').notNull(),
    status: worldVersionStatus('status').default('staging').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    activatedAt: timestamptz('activated_at'),
  },
  (table) => [
    uniqueIndex('world_versions_world_identity').on(table.id, table.worldId),
    uniqueIndex('world_versions_world_number_unique').on(table.worldId, table.versionNumber),
    uniqueIndex('world_versions_compilation_run_unique').on(table.compilationRunId),
    uniqueIndex('world_versions_one_active_world_idx')
      .on(table.worldId)
      .where(sql`${table.status} = 'active'`),
    index('world_versions_world_cursor_idx').on(
      table.worldId,
      table.versionNumber.desc(),
      table.id.desc(),
    ),
    foreignKey({
      columns: [table.parentWorldVersionId, table.worldId],
      foreignColumns: [table.id, table.worldId],
      name: 'world_versions_parent_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.manifestRevisionId, table.worldId],
      foreignColumns: [manifestRevisions.id, manifestRevisions.worldId],
      name: 'world_versions_manifest_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.createdByUserId],
      foreignColumns: [worldMemberships.worldId, worldMemberships.userId],
      name: 'world_versions_creator_membership_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.compilationRunId,
        table.worldId,
        table.manifestRevisionId,
        table.compilerVersion,
        table.compilerConfigVersion,
        table.seed,
        table.artifactHash,
      ],
      foreignColumns: [
        worldCompilationRuns.id,
        worldCompilationRuns.worldId,
        worldCompilationRuns.manifestRevisionId,
        worldCompilationRuns.compilerVersion,
        worldCompilationRuns.compilerConfigVersion,
        worldCompilationRuns.seed,
        worldCompilationRuns.artifactHash,
      ],
      name: 'world_versions_run_exact_fk',
    }).onDelete('restrict'),
    check(
      'world_versions_number_parent_consistent',
      sql`${table.versionNumber} between 1 and 2147483647
          and ((${table.versionNumber} = 1 and ${table.parentWorldVersionId} is null)
            or (${table.versionNumber} > 1 and ${table.parentWorldVersionId} is not null))`,
    ),
    check('world_versions_schema_known', sql`${table.worldSchemaVersion} = 1`),
    check(
      'world_versions_compiler_known',
      sql`${table.compilerVersion} in ('1.0.0','1.1.0','1.2.0') and ${table.compilerConfigVersion} = 1`,
    ),
    check(
      'world_versions_seed_bounded',
      sql`char_length(${table.seed}) between 1 and 128
          and ${table.seed} = btrim(${table.seed}) and ${table.seed} !~ '[[:cntrl:]]'`,
    ),
    check('world_versions_artifact_hash_length', sql`octet_length(${table.artifactHash}) = 32`),
    check(
      'world_versions_status_consistent',
      sql`(${table.status} = 'staging' and ${table.activatedAt} is null)
          or (${table.status} in ('active','superseded') and ${table.activatedAt} is not null)`,
    ),
  ],
);

export const worldEntities = pgTable(
  'world_entities',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    logicalKey: citext('logical_key').notNull(),
    entityType: text('entity_type').notNull(),
    entitySchemaVersion: integer('entity_schema_version').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    createdWorldVersionId: uuid('created_world_version_id').notNull(),
    retiredWorldVersionId: uuid('retired_world_version_id'),
    rowVersion: bigint('row_version', { mode: 'number' }).default(0).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('world_entities_world_logical_key_unique').on(table.worldId, table.logicalKey),
    uniqueIndex('world_entities_world_identity').on(table.worldId, table.id),
    foreignKey({
      columns: [table.createdWorldVersionId, table.worldId],
      foreignColumns: [worldVersions.id, worldVersions.worldId],
      name: 'world_entities_created_version_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.retiredWorldVersionId, table.worldId],
      foreignColumns: [worldVersions.id, worldVersions.worldId],
      name: 'world_entities_retired_version_world_fk',
    }).onDelete('restrict'),
    index('world_entities_world_type_key_idx').on(
      table.worldId,
      table.entityType,
      table.logicalKey,
    ),
    index('world_entities_world_active_key_idx')
      .on(table.worldId, table.logicalKey)
      .where(sql`${table.retiredWorldVersionId} is null`),
    index('world_entities_world_display_name_idx')
      .on(table.worldId, sql`((${table.state} ->> 'displayName')) collate "C"`, table.logicalKey)
      .where(sql`${table.retiredWorldVersionId} is null and ${table.state} ? 'displayName'`),
    check(
      'world_entities_logical_key_shape',
      sql`char_length(${table.logicalKey}::text) between 3 and 240
          and ${table.logicalKey}::text = lower(${table.logicalKey}::text)
          and ${table.logicalKey}::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'`,
    ),
    check(
      'world_entities_type_shape',
      sql`char_length(${table.entityType}) between 1 and 80
          and ${table.entityType} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      'world_entities_type_known',
      sql`${table.entityType} in (
        'district', 'institution', 'organization', 'actor_blueprint',
        'account_principal', 'player_character', 'primitive_instance',
        'currency_definition_intent', 'resource_definition_intent',
        'production_definition_intent', 'tax_definition_intent',
        'economy_configuration', 'simulation_configuration', 'visual_plan'
      )`,
    ),
    check('world_entities_schema_known', sql`${table.entitySchemaVersion} = 1`),
    check(
      'world_entities_state_bounded',
      sql`jsonb_typeof(${table.state}) = 'object' and pg_column_size(${table.state}) <= 262144
          and not worldgraph_jsonb_has_sensitive_key(${table.state})
          and not worldgraph_jsonb_has_compiler_private_key(${table.state})`,
    ),
    check(
      'world_entities_state_matches_type',
      sql`worldgraph_world_entity_state_is_valid(
        ${table.entityType}, ${table.entitySchemaVersion}, ${table.state}
      )`,
    ),
    check(
      'world_entities_versions_distinct',
      sql`${table.retiredWorldVersionId} is null
          or ${table.retiredWorldVersionId} <> ${table.createdWorldVersionId}`,
    ),
    check('world_entities_row_version_nonnegative', sql`${table.rowVersion} >= 0`),
    check('world_entities_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const worldRelationships = pgTable(
  'world_relationships',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    logicalKey: citext('logical_key').notNull(),
    relationshipType: text('relationship_type').notNull(),
    sourceEntityId: uuid('source_entity_id').notNull(),
    targetEntityId: uuid('target_entity_id').notNull(),
    relationshipSchemaVersion: integer('relationship_schema_version').notNull(),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdWorldVersionId: uuid('created_world_version_id').notNull(),
    retiredWorldVersionId: uuid('retired_world_version_id'),
    rowVersion: bigint('row_version', { mode: 'number' }).default(0).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('world_relationships_world_logical_key_unique').on(table.worldId, table.logicalKey),
    uniqueIndex('world_relationships_world_identity').on(table.worldId, table.id),
    foreignKey({
      columns: [table.worldId, table.sourceEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'world_relationships_source_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.targetEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'world_relationships_target_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdWorldVersionId, table.worldId],
      foreignColumns: [worldVersions.id, worldVersions.worldId],
      name: 'world_relationships_created_version_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.retiredWorldVersionId, table.worldId],
      foreignColumns: [worldVersions.id, worldVersions.worldId],
      name: 'world_relationships_retired_version_world_fk',
    }).onDelete('restrict'),
    index('world_relationships_source_type_idx').on(
      table.worldId,
      table.sourceEntityId,
      table.relationshipType,
      table.logicalKey,
    ),
    index('world_relationships_target_type_idx').on(
      table.worldId,
      table.targetEntityId,
      table.relationshipType,
      table.logicalKey,
    ),
    index('world_relationships_active_type_idx')
      .on(table.worldId, table.relationshipType, table.logicalKey)
      .where(sql`${table.retiredWorldVersionId} is null`),
    uniqueIndex('world_relationships_active_account_control_target_idx')
      .on(table.worldId, table.targetEntityId)
      .where(
        sql`${table.relationshipType} = 'account_controls'
          and ${table.retiredWorldVersionId} is null`,
      ),
    uniqueIndex('world_relationships_active_account_control_pair_idx')
      .on(table.worldId, table.sourceEntityId, table.targetEntityId)
      .where(
        sql`${table.relationshipType} = 'account_controls'
          and ${table.retiredWorldVersionId} is null`,
      ),
    check(
      'world_relationships_logical_key_shape',
      sql`char_length(${table.logicalKey}::text) between 5 and 240
          and ${table.logicalKey}::text = lower(${table.logicalKey}::text)
          and ${table.logicalKey}::text ~ '^rel:[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*$'`,
    ),
    check(
      'world_relationships_type_shape',
      sql`char_length(${table.relationshipType}) between 1 and 80
          and ${table.relationshipType} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      'world_relationships_type_known',
      sql`${table.relationshipType} in (
        'account_controls', 'connected_to', 'cooperates_with', 'governs',
        'instantiates', 'located_in', 'member_of', 'participates_in',
        'rivals', 'supplies', 'uses_primitive'
      )`,
    ),
    check('world_relationships_schema_known', sql`${table.relationshipSchemaVersion} = 1`),
    check(
      'world_relationships_attributes_bounded',
      sql`jsonb_typeof(${table.attributes}) = 'object'
          and pg_column_size(${table.attributes}) <= 65536
          and not worldgraph_jsonb_has_sensitive_key(${table.attributes})
          and not worldgraph_jsonb_has_compiler_private_key(${table.attributes})`,
    ),
    check(
      'world_relationships_attributes_match_type',
      sql`worldgraph_world_relationship_attributes_are_valid(
        ${table.relationshipType}, ${table.relationshipSchemaVersion}, ${table.attributes}
      )`,
    ),
    check(
      'world_relationships_versions_distinct',
      sql`${table.retiredWorldVersionId} is null
          or ${table.retiredWorldVersionId} <> ${table.createdWorldVersionId}`,
    ),
    check('world_relationships_row_version_nonnegative', sql`${table.rowVersion} >= 0`),
    check('world_relationships_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const worldEntityControllers = pgTable(
  'world_entity_controllers',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    entityId: uuid('entity_id').notNull(),
    controlScope: text('control_scope').notNull(),
    grantedWorldVersionId: uuid('granted_world_version_id').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    primaryKey({ columns: [table.worldId, table.userId, table.entityId, table.controlScope] }),
    foreignKey({
      columns: [table.worldId, table.userId],
      foreignColumns: [worldMemberships.worldId, worldMemberships.userId],
      name: 'world_entity_controllers_membership_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.entityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'world_entity_controllers_entity_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.grantedWorldVersionId, table.worldId],
      foreignColumns: [worldVersions.id, worldVersions.worldId],
      name: 'world_entity_controllers_version_world_fk',
    }).onDelete('restrict'),
    uniqueIndex('world_entity_controllers_one_active_entity_idx')
      .on(table.worldId, table.entityId)
      .where(sql`${table.revokedAt} is null`),
    index('world_entity_controllers_user_active_idx')
      .on(table.worldId, table.userId, table.entityId)
      .where(sql`${table.revokedAt} is null`),
    check('world_entity_controllers_scope_known', sql`${table.controlScope} = 'primary'`),
  ],
);

export const worldRuntimeHeads = pgTable(
  'world_runtime_heads',
  {
    worldId: uuid('world_id')
      .primaryKey()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    activeWorldVersionId: uuid('active_world_version_id').notNull(),
    stateRevision: bigint('state_revision', { mode: 'bigint' }).default(0n).notNull(),
    lastLedgerSequence: bigint('last_ledger_sequence', { mode: 'bigint' }).default(0n).notNull(),
    lastEventSequence: bigint('last_event_sequence', { mode: 'bigint' }).default(0n).notNull(),
    ledgerAnchoredAt: timestamptz('ledger_anchored_at'),
    ledgerAnchorEventId: uuid('ledger_anchor_event_id'),
    anchorArtifactHash: bytea('anchor_artifact_hash'),
    ledgerSchemaVersion: integer('ledger_schema_version').default(1).notNull(),
    eventSchemaVersion: integer('event_schema_version').default(1).notNull(),
    projectionSchemaVersion: integer('projection_schema_version').default(1).notNull(),
    projectionChecksum: bytea('projection_checksum'),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.activeWorldVersionId, table.worldId],
      foreignColumns: [worldVersions.id, worldVersions.worldId],
      name: 'world_runtime_heads_active_version_world_fk',
    }).onDelete('restrict'),
    check(
      'world_runtime_heads_revisions_nonnegative',
      sql`${table.stateRevision} >= 0 and ${table.lastLedgerSequence} >= 0
          and ${table.lastEventSequence} >= 0`,
    ),
    check(
      'world_runtime_heads_ledger_fields_valid',
      sql`${table.ledgerSchemaVersion} = 1 and ${table.eventSchemaVersion} = 1
          and ${table.projectionSchemaVersion} = 1
          and (${table.projectionChecksum} is null
            or octet_length(${table.projectionChecksum}) = 32)
          and (${table.anchorArtifactHash} is null
            or octet_length(${table.anchorArtifactHash}) = 32)`,
    ),
  ],
);

export const commandRecords = pgTable(
  'command_records',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id').references(() => worlds.id, { onDelete: 'restrict' }),
    commandType: text('command_type').notNull(),
    commandSchemaVersion: integer('command_schema_version').notNull(),
    actorType: commandActorType('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    payloadHash: bytea('payload_hash').notNull(),
    payloadClassification: payloadClassification('payload_classification').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    rateLimitScopeHash: bytea('rate_limit_scope_hash'),
    expectedWorldVersion: bigint('expected_world_version', { mode: 'bigint' }),
    expectedStateRevision: bigint('expected_state_revision', { mode: 'bigint' }),
    expectedAggregateVersion: bigint('expected_aggregate_version', { mode: 'bigint' }),
    expectedTick: bigint('expected_tick', { mode: 'bigint' }),
    openedStateRevision: bigint('opened_state_revision', { mode: 'bigint' }),
    openedLedgerSequence: bigint('opened_ledger_sequence', { mode: 'bigint' }),
    openedEventSequence: bigint('opened_event_sequence', { mode: 'bigint' }),
    openedProjectionChecksum: bytea('opened_projection_checksum'),
    writeGateOpenedAt: timestamptz('write_gate_opened_at'),
    status: commandRecordStatus('status').default('received').notNull(),
    rejectionCode: text('rejection_code'),
    authorizationRuleId: text('authorization_rule_id'),
    overrideId: uuid('override_id').references(() => creatorOverrideRecords.id, {
      onDelete: 'restrict',
    }),
    correlationId: uuid('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    requestedAt: timestamptz('requested_at').defaultNow().notNull(),
    decidedAt: timestamptz('decided_at'),
    resultingStateRevision: bigint('resulting_state_revision', { mode: 'bigint' }),
    responseSummary: jsonb('response_summary').$type<Record<string, unknown>>(),
  },
  (table) => [
    unique('command_records_world_identity').on(table.id, table.worldId),
    unique('command_records_idempotency_unique')
      .on(table.worldId, table.actorType, table.actorId, table.commandType, table.idempotencyKey)
      .nullsNotDistinct(),
    index('command_records_world_status_cursor_idx').on(
      table.worldId,
      table.status,
      table.requestedAt.desc(),
      table.id.desc(),
    ),
    index('command_records_actor_cursor_idx').on(
      table.actorType,
      table.actorId,
      table.requestedAt.desc(),
      table.id.desc(),
    ),
    index('command_records_commerce_rate_scope_idx')
      .on(
        table.worldId,
        table.actorType,
        table.actorId,
        table.commandType,
        table.rateLimitScopeHash,
        table.requestedAt.desc(),
      )
      .where(
        sql`${table.rateLimitScopeHash} is not null
          and ${table.commandType} in (
            'PerformJobV1','StartProductionRunV1',
            'CreateMarketListingV1','PurchaseMarketListingV1'
          )`,
      ),
    check(
      'command_records_type_shape',
      sql`char_length(${table.commandType}) between 3 and 120
          and ${table.commandType} ~ '^[A-Z][A-Za-z0-9]*V[1-9][0-9]*$'`,
    ),
    check(
      'command_records_schema_storable',
      sql`${table.commandSchemaVersion} between 1 and 2147483647`,
    ),
    check(
      'command_records_hash_lengths',
      sql`octet_length(${table.payloadHash}) = 32 and octet_length(${table.requestHash}) = 32`,
    ),
    check(
      'command_records_rate_limit_scope_hash_valid',
      sql`${table.rateLimitScopeHash} is null
          or octet_length(${table.rateLimitScopeHash}) = 32`,
    ),
    check(
      'command_records_expected_versions_valid',
      sql`(${table.expectedWorldVersion} is null or ${table.expectedWorldVersion} > 0)
          and (${table.expectedStateRevision} is null or ${table.expectedStateRevision} >= 0)
          and (${table.expectedAggregateVersion} is null
            or ${table.expectedAggregateVersion} >= 0)`,
    ),
  ],
);

export const worldLedgerHeads = pgTable(
  'world_ledger_heads',
  {
    worldId: uuid('world_id')
      .primaryKey()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    nextLedgerSequence: bigint('next_ledger_sequence', { mode: 'bigint' }).default(1n).notNull(),
    nextEventSequence: bigint('next_event_sequence', { mode: 'bigint' }).default(1n).notNull(),
    lastEntryHash: bytea('last_entry_hash'),
    ledgerSchemaVersion: integer('ledger_schema_version').default(1).notNull(),
    anchoredAt: timestamptz('anchored_at'),
    anchorEventId: uuid('anchor_event_id'),
    anchorArtifactHash: bytea('anchor_artifact_hash'),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'world_ledger_heads_sequences_positive',
      sql`${table.nextLedgerSequence} > 0 and ${table.nextEventSequence} > 0`,
    ),
    check('world_ledger_heads_schema_known', sql`${table.ledgerSchemaVersion} = 1`),
  ],
);

export const aggregateStreamHeads = pgTable(
  'aggregate_stream_heads',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    currentVersion: bigint('current_version', { mode: 'bigint' }).notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.worldId, table.aggregateType, table.aggregateId] }),
    check('aggregate_stream_heads_version_positive', sql`${table.currentVersion} > 0`),
  ],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    worldEventSequence: bigint('world_event_sequence', { mode: 'bigint' }).notNull(),
    commandId: uuid('command_id').notNull(),
    eventOrdinal: integer('event_ordinal').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).notNull(),
    eventType: text('event_type').notNull(),
    eventSchemaVersion: integer('event_schema_version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    eventHash: bytea('event_hash').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    recordedAt: timestamptz('recorded_at').defaultNow().notNull(),
    resultingStateRevision: bigint('resulting_state_revision', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    unique('domain_events_world_identity').on(table.worldId, table.id),
    unique('domain_events_world_sequence_unique').on(table.worldId, table.worldEventSequence),
    unique('domain_events_command_ordinal_unique').on(table.commandId, table.eventOrdinal),
    unique('domain_events_aggregate_version_unique').on(
      table.worldId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'domain_events_command_world_fk',
    }).onDelete('restrict'),
    index('domain_events_world_type_cursor_idx').on(
      table.worldId,
      table.eventType,
      table.worldEventSequence.desc(),
    ),
    index('domain_events_world_aggregate_cursor_idx').on(
      table.worldId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion.desc(),
    ),
    check(
      'domain_events_sequences_positive',
      sql`${table.worldEventSequence} > 0 and ${table.eventOrdinal} >= 0
          and ${table.aggregateVersion} > 0 and ${table.resultingStateRevision} >= 0`,
    ),
    check('domain_events_schema_known', sql`${table.eventSchemaVersion} = 1`),
    check('domain_events_hash_length', sql`octet_length(${table.eventHash}) = 32`),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    ledgerSequence: bigint('ledger_sequence', { mode: 'bigint' }).notNull(),
    entryKind: ledgerEntryKind('entry_kind').notNull(),
    commandId: uuid('command_id'),
    eventId: uuid('event_id'),
    actorType: commandActorType('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    publicSummaryCode: text('public_summary_code').notNull(),
    redactedDetails: jsonb('redacted_details')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    previousHash: bytea('previous_hash').notNull(),
    entryHash: bytea('entry_hash').notNull(),
    recordedAt: timestamptz('recorded_at').defaultNow().notNull(),
  },
  (table) => [
    unique('ledger_entries_world_identity').on(table.worldId, table.id),
    unique('ledger_entries_world_sequence_unique').on(table.worldId, table.ledgerSequence),
    unique('ledger_entries_event_unique').on(table.eventId),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'ledger_entries_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'ledger_entries_event_world_fk',
    }).onDelete('restrict'),
    index('ledger_entries_world_actor_cursor_idx').on(
      table.worldId,
      table.actorType,
      table.actorId,
      table.ledgerSequence.desc(),
    ),
    check('ledger_entries_sequence_positive', sql`${table.ledgerSequence} > 0`),
    check(
      'ledger_entries_hash_lengths',
      sql`octet_length(${table.previousHash}) = 32 and octet_length(${table.entryHash}) = 32`,
    ),
  ],
);

export const projectionCheckpoints = pgTable(
  'projection_checkpoints',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    projectionName: text('projection_name').notNull(),
    projectionSchemaVersion: integer('projection_schema_version').notNull(),
    lastEventSequence: bigint('last_event_sequence', { mode: 'bigint' }).notNull(),
    checksum: bytea('checksum').notNull(),
    status: projectionCheckpointStatus('status').default('current').notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.worldId, table.projectionName] }),
    check('projection_checkpoints_version_known', sql`${table.projectionSchemaVersion} = 1`),
    check('projection_checkpoints_sequence_nonnegative', sql`${table.lastEventSequence} >= 0`),
    check('projection_checkpoints_hash_length', sql`octet_length(${table.checksum}) = 32`),
  ],
);

export const eventConsumerReceipts = pgTable(
  'event_consumer_receipts',
  {
    consumerName: text('consumer_name').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id, { onDelete: 'restrict' }),
    processedAt: timestamptz('processed_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.consumerName, table.eventId] })],
);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id'),
    messageType: text('message_type').notNull(),
    messageSchemaVersion: integer('message_schema_version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxMessageStatus('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamptz('available_at').defaultNow().notNull(),
    lockedAt: timestamptz('locked_at'),
    lockedBy: text('locked_by'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    publishedAt: timestamptz('published_at'),
  },
  (table) => [
    unique('outbox_messages_event_unique').on(table.messageType, table.eventId),
    unique('outbox_messages_world_identity').on(table.worldId, table.id),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'outbox_messages_event_world_fk',
    }).onDelete('restrict'),
    index('outbox_messages_pending_idx')
      .on(table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    check('outbox_messages_schema_known', sql`${table.messageSchemaVersion} = 1`),
    check('outbox_messages_attempts_nonnegative', sql`${table.attempts} >= 0`),
  ],
);

export const outboxRetryIntents = pgTable(
  'outbox_retry_intents',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    outboxMessageId: uuid('outbox_message_id').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    auditId: uuid('audit_id').notNull(),
    reason: text('reason').notNull(),
    previousAttempts: integer('previous_attempts').notNull(),
    executionGateHash: bytea('execution_gate_hash').notNull(),
    requeuedAt: timestamptz('requeued_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.worldId, table.outboxMessageId],
      foreignColumns: [outboxMessages.worldId, outboxMessages.id],
      name: 'outbox_retry_intents_message_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.auditId, table.worldId, table.actorUserId],
      foreignColumns: [
        securityAuditRecords.id,
        securityAuditRecords.worldId,
        securityAuditRecords.actorUserId,
      ],
      name: 'outbox_retry_intents_audit_fk',
    }).onDelete('restrict'),
    index('outbox_retry_intents_world_cursor_idx').on(
      table.worldId,
      table.requeuedAt.desc(),
      table.id.desc(),
    ),
    check(
      'outbox_retry_intents_reason_valid',
      sql`worldgraph_outbox_retry_reason_is_valid(${table.reason})`,
    ),
    check('outbox_retry_intents_attempts_positive', sql`${table.previousAttempts} > 0`),
    check(
      'outbox_retry_intents_gate_hash_length',
      sql`octet_length(${table.executionGateHash}) = 32`,
    ),
    check(
      'outbox_retry_intents_timestamp_canonical',
      sql`${table.requeuedAt} = date_trunc('milliseconds', ${table.requeuedAt})`,
    ),
  ],
);

export const worldHistoryEntries = pgTable(
  'world_history_entries',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    ledgerSequence: bigint('ledger_sequence', { mode: 'bigint' }).notNull(),
    commandId: uuid('command_id'),
    eventId: uuid('event_id'),
    eventType: text('event_type'),
    historySchemaVersion: integer('history_schema_version').default(1).notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    category: text('category').notNull(),
    titleKey: text('title_key').notNull(),
    summaryArgs: jsonb('summary_args')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    actorType: commandActorType('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    visibility: historyVisibility('visibility').default('member').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    resultingStateRevision: bigint('resulting_state_revision', { mode: 'bigint' }),
  },
  (table) => [
    primaryKey({ columns: [table.worldId, table.ledgerSequence] }),
    foreignKey({
      columns: [table.worldId, table.ledgerSequence],
      foreignColumns: [ledgerEntries.worldId, ledgerEntries.ledgerSequence],
      name: 'world_history_entries_ledger_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'world_history_entries_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'world_history_entries_event_world_fk',
    }).onDelete('restrict'),
    index('world_history_entries_filter_cursor_idx').on(
      table.worldId,
      table.visibility,
      table.category,
      table.actorType,
      table.occurredAt.desc(),
      table.ledgerSequence.desc(),
    ),
    index('world_history_entries_target_cursor_idx')
      .on(table.worldId, table.targetType, table.targetId, table.ledgerSequence.desc())
      .where(sql`${table.targetType} is not null`),
    check('world_history_entries_schema_known', sql`${table.historySchemaVersion} = 1`),
  ],
);

export const projectionReplayRuns = pgTable(
  'projection_replay_runs',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    projectionName: text('projection_name').notNull(),
    targetSchemaVersion: integer('target_schema_version').notNull(),
    requestedByActorType: commandActorType('requested_by_actor_type').notNull(),
    requestedByActorId: text('requested_by_actor_id').notNull(),
    fromEventSequence: bigint('from_event_sequence', { mode: 'bigint' }).default(1n).notNull(),
    toEventSequence: bigint('to_event_sequence', { mode: 'bigint' }).notNull(),
    status: projectionReplayStatus('status').default('pending').notNull(),
    sourceChecksum: bytea('source_checksum').notNull(),
    replayChecksum: bytea('replay_checksum'),
    firstDivergenceSequence: bigint('first_divergence_sequence', { mode: 'bigint' }),
    failureCode: text('failure_code'),
    reason: text('reason').notNull(),
    requestedAt: timestamptz('requested_at').defaultNow().notNull(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('projection_replay_runs_world_cursor_idx').on(
      table.worldId,
      table.requestedAt.desc(),
      table.id.desc(),
    ),
    check('projection_replay_runs_schema_known', sql`${table.targetSchemaVersion} = 1`),
    check(
      'projection_replay_runs_sequences_valid',
      sql`${table.fromEventSequence} > 0
          and ${table.toEventSequence} >= ${table.fromEventSequence}`,
    ),
  ],
);

export const shadowWorldEntities = pgTable(
  'shadow_world_entities',
  {
    replayRunId: uuid('replay_run_id')
      .notNull()
      .references(() => projectionReplayRuns.id, { onDelete: 'cascade' }),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    entityId: uuid('entity_id').notNull(),
    logicalKey: text('logical_key').notNull(),
    entityType: text('entity_type').notNull(),
    entitySchemaVersion: integer('entity_schema_version').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    rowVersion: bigint('row_version', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.replayRunId, table.entityId] }),
    unique('shadow_world_entities_key_unique').on(table.replayRunId, table.logicalKey),
  ],
);

export const shadowWorldRelationships = pgTable(
  'shadow_world_relationships',
  {
    replayRunId: uuid('replay_run_id')
      .notNull()
      .references(() => projectionReplayRuns.id, { onDelete: 'cascade' }),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    relationshipId: uuid('relationship_id').notNull(),
    logicalKey: text('logical_key').notNull(),
    relationshipType: text('relationship_type').notNull(),
    sourceEntityId: uuid('source_entity_id').notNull(),
    targetEntityId: uuid('target_entity_id').notNull(),
    relationshipSchemaVersion: integer('relationship_schema_version').notNull(),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    rowVersion: bigint('row_version', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.replayRunId, table.relationshipId] }),
    unique('shadow_world_relationships_key_unique').on(table.replayRunId, table.logicalKey),
    foreignKey({
      columns: [table.replayRunId, table.sourceEntityId],
      foreignColumns: [shadowWorldEntities.replayRunId, shadowWorldEntities.entityId],
      name: 'shadow_world_relationships_source_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.replayRunId, table.targetEntityId],
      foreignColumns: [shadowWorldEntities.replayRunId, shadowWorldEntities.entityId],
      name: 'shadow_world_relationships_target_fk',
    }).onDelete('restrict'),
  ],
);

export const shadowWorldEntityControllers = pgTable(
  'shadow_world_entity_controllers',
  {
    replayRunId: uuid('replay_run_id')
      .notNull()
      .references(() => projectionReplayRuns.id, { onDelete: 'cascade' }),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    entityId: uuid('entity_id').notNull(),
    controlScope: text('control_scope').notNull(),
    principalKey: text('principal_key').notNull(),
    entityLogicalKey: text('entity_logical_key').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.replayRunId, table.userId, table.entityId, table.controlScope],
    }),
    foreignKey({
      columns: [table.replayRunId, table.entityId],
      foreignColumns: [shadowWorldEntities.replayRunId, shadowWorldEntities.entityId],
      name: 'shadow_world_entity_controllers_entity_fk',
    }).onDelete('restrict'),
    check('shadow_world_entity_controllers_scope_known', sql`${table.controlScope} = 'primary'`),
  ],
);

export const worldSimulationClocks = pgTable(
  'world_simulation_clocks',
  {
    worldId: uuid('world_id')
      .primaryKey()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    clockSchemaVersion: integer('clock_schema_version').default(1).notNull(),
    epochAt: timestamptz('epoch_at').notNull(),
    currentTick: bigint('current_tick', { mode: 'bigint' }).default(0n).notNull(),
    worldMillisecondsPerTick: bigint('world_milliseconds_per_tick', {
      mode: 'bigint',
    }).notNull(),
    wallCadenceMilliseconds: integer('wall_cadence_milliseconds').notNull(),
    mode: simulationClockMode('mode').default('paused').notNull(),
    maxBatchTicks: integer('max_batch_ticks').notNull(),
    maxCatchUpTicks: integer('max_catch_up_ticks').notNull(),
    prngAlgorithmVersion: text('prng_algorithm_version').notNull(),
    outcomeHash: bytea('outcome_hash').notNull(),
    lastWallAnchorAt: timestamptz('last_wall_anchor_at'),
    rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
    updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('world_simulation_clocks_schema_known', sql`${table.clockSchemaVersion} = 1`),
    check('world_simulation_clocks_tick_nonnegative', sql`${table.currentTick} >= 0`),
    check(
      'world_simulation_clocks_world_tick_duration_bounded',
      sql`${table.worldMillisecondsPerTick} between 1 and 31536000000`,
    ),
    check(
      'world_simulation_clocks_cadence_bounded',
      sql`${table.wallCadenceMilliseconds} between 100 and 86400000`,
    ),
    check(
      'world_simulation_clocks_batch_bounds',
      sql`${table.maxBatchTicks} between 1 and 256
          and ${table.maxCatchUpTicks} between 1 and 4096
          and ${table.maxCatchUpTicks} >= ${table.maxBatchTicks}`,
    ),
    check(
      'world_simulation_clocks_prng_known',
      sql`${table.prngAlgorithmVersion} = 'xorshift32-sha256-v1'`,
    ),
    check(
      'world_simulation_clocks_outcome_hash_length',
      sql`octet_length(${table.outcomeHash}) = 32`,
    ),
    check(
      'world_simulation_clocks_mode_anchor_shape',
      sql`(${table.mode} = 'running' and ${table.lastWallAnchorAt} is not null)
          or (${table.mode} in ('paused','error') and ${table.lastWallAnchorAt} is null)`,
    ),
    check(
      'world_simulation_clocks_versions_positive',
      sql`${table.rowVersion} > 0 and ${table.updatedStateRevision} > 0`,
    ),
  ],
);

export const worldScheduleHeads = pgTable(
  'world_schedule_heads',
  {
    worldId: uuid('world_id')
      .primaryKey()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    nextScheduleSequence: bigint('next_schedule_sequence', { mode: 'bigint' })
      .default(1n)
      .notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('world_schedule_heads_sequence_positive', sql`${table.nextScheduleSequence} > 0`),
  ],
);

export const scheduledActions = pgTable(
  'scheduled_actions',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    scheduleSequence: bigint('schedule_sequence', { mode: 'bigint' }).notNull(),
    dueTick: bigint('due_tick', { mode: 'bigint' }).notNull(),
    priority: integer('priority').notNull(),
    actionType: text('action_type').notNull(),
    actionSchemaVersion: integer('action_schema_version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: bytea('payload_hash').notNull(),
    processVersion: text('process_version').notNull(),
    status: scheduledActionStatus('status').default('scheduled').notNull(),
    createdByActorType: commandActorType('created_by_actor_type').notNull(),
    createdByActorId: text('created_by_actor_id').notNull(),
    createdCommandId: uuid('created_command_id').notNull(),
    completedEventId: uuid('completed_event_id'),
    cancelledCommandId: uuid('cancelled_command_id'),
    createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
    completedStateRevision: bigint('completed_state_revision', { mode: 'bigint' }),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('scheduled_actions_world_identity').on(table.worldId, table.id),
    unique('scheduled_actions_world_sequence_unique').on(table.worldId, table.scheduleSequence),
    unique('scheduled_actions_completed_event_unique').on(table.completedEventId),
    foreignKey({
      columns: [table.createdCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'scheduled_actions_created_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.completedEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'scheduled_actions_completed_event_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.cancelledCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'scheduled_actions_cancelled_command_world_fk',
    }).onDelete('restrict'),
    index('scheduled_actions_due_idx')
      .on(table.worldId, table.dueTick, table.priority, table.scheduleSequence, table.id)
      .where(sql`${table.status} = 'scheduled'`),
    index('scheduled_actions_world_status_cursor_idx').on(
      table.worldId,
      table.status,
      table.dueTick,
      table.scheduleSequence,
      table.id,
    ),
    check(
      'scheduled_actions_sequence_tick_valid',
      sql`${table.scheduleSequence} > 0 and ${table.dueTick} >= 0`,
    ),
    check('scheduled_actions_priority_bounded', sql`${table.priority} between -1000 and 1000`),
    check(
      'scheduled_actions_registry_known',
      sql`${table.actionType} in (
            'EmitWorldNoticeV1','CompleteProductionRunV1','SettlePayrollV1',
            'ExpireMarketListingV1','AssessPeriodicTaxV1'
          )
          and ${table.actionSchemaVersion} = 1 and ${table.processVersion} = '1.0.0'`,
    ),
    check(
      'scheduled_actions_actor_bounded',
      sql`${table.createdByActorType} in ('user','system','platform_admin')
          and char_length(${table.createdByActorId}) between 3 and 160
          and ${table.createdByActorId} = btrim(${table.createdByActorId})
          and ${table.createdByActorId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'scheduled_actions_payload_safe',
      sql`jsonb_typeof(${table.payload}) = 'object'
          and pg_column_size(${table.payload}) <= 4096
          and not worldgraph_jsonb_has_sensitive_key(${table.payload})
          and not worldgraph_jsonb_has_compiler_private_key(${table.payload})
          and case ${table.actionType}
            when 'EmitWorldNoticeV1' then
              ${table.payload} = jsonb_build_object(
                'text',${table.payload}->>'text','visibility',${table.payload}->>'visibility'
              )
              and char_length(${table.payload}->>'text') between 1 and 500
              and translate(${table.payload}->>'text',E'\t\n\r','') !~ '[[:cntrl:]]'
              and ${table.payload}->>'visibility' in ('public','member','creator')
            when 'CompleteProductionRunV1' then
              ${table.payload} = jsonb_build_object(
                'productionRunId',${table.payload}->>'productionRunId'
              )
              and ${table.payload}->>'productionRunId'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            when 'SettlePayrollV1' then
              ${table.payload} = jsonb_build_object(
                'payrollRecordId',${table.payload}->>'payrollRecordId'
              )
              and ${table.payload}->>'payrollRecordId'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            when 'ExpireMarketListingV1' then
              ${table.payload} = jsonb_build_object('listingId',${table.payload}->>'listingId')
              and ${table.payload}->>'listingId'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            when 'AssessPeriodicTaxV1' then
              ${table.payload} = jsonb_build_object(
                'taxPolicyId',${table.payload}->>'taxPolicyId'
              )
              and ${table.payload}->>'taxPolicyId'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            else false
          end`,
    ),
    check(
      'scheduled_actions_payload_hash_valid',
      sql`octet_length(${table.payloadHash}) = 32
          and ${table.payloadHash} = extensions.digest(
            convert_to(worldgraph_canonical_jsonb(${table.payload}),'UTF8'),'sha256'
          )`,
    ),
    check(
      'scheduled_actions_revisions_valid',
      sql`${table.createdStateRevision} > 0
          and (${table.completedStateRevision} is null
            or ${table.completedStateRevision} >= ${table.createdStateRevision})`,
    ),
    check(
      'scheduled_actions_status_shape',
      sql`(${table.status} = 'scheduled' and ${table.completedEventId} is null
            and ${table.cancelledCommandId} is null and ${table.completedStateRevision} is null)
          or (${table.status} = 'completed' and ${table.completedEventId} is not null
            and ${table.cancelledCommandId} is null and ${table.completedStateRevision} is not null)
          or (${table.status} = 'cancelled' and ${table.completedEventId} is null
            and ${table.cancelledCommandId} is not null and ${table.completedStateRevision} is not null)
          or (${table.status} = 'failed' and ${table.completedEventId} is null
            and ${table.cancelledCommandId} is null and ${table.completedStateRevision} is not null)`,
    ),
    check('scheduled_actions_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const simulationBatchRuns = pgTable(
  'simulation_batch_runs',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    batchSchemaVersion: integer('batch_schema_version').default(1).notNull(),
    fromTick: bigint('from_tick', { mode: 'bigint' }).notNull(),
    toTick: bigint('to_tick', { mode: 'bigint' }).notNull(),
    batchKey: bytea('batch_key').notNull(),
    processRegistryVersion: integer('process_registry_version').notNull(),
    inputChecksum: bytea('input_checksum').notNull(),
    outcomeHash: bytea('outcome_hash'),
    status: simulationBatchStatus('status').default('running').notNull(),
    attempts: integer('attempts').default(1).notNull(),
    commandId: uuid('command_id'),
    errorCode: text('error_code'),
    startedAt: timestamptz('started_at').defaultNow().notNull(),
    completedAt: timestamptz('completed_at'),
  },
  (table) => [
    unique('simulation_batch_runs_world_identity').on(table.worldId, table.id),
    unique('simulation_batch_runs_batch_key_unique').on(table.worldId, table.batchKey),
    unique('simulation_batch_runs_identity_unique').on(
      table.worldId,
      table.fromTick,
      table.toTick,
      table.inputChecksum,
      table.processRegistryVersion,
    ),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'simulation_batch_runs_command_world_fk',
    }).onDelete('restrict'),
    index('simulation_batch_runs_world_cursor_idx').on(
      table.worldId,
      table.startedAt.desc(),
      table.id.desc(),
    ),
    index('simulation_batch_runs_running_idx')
      .on(table.startedAt, table.worldId, table.id)
      .where(sql`${table.status} = 'running'`),
    check('simulation_batch_runs_schema_known', sql`${table.batchSchemaVersion} = 1`),
    check(
      'simulation_batch_runs_tick_range_valid',
      sql`${table.fromTick} >= 0 and (
            (${table.toTick} > ${table.fromTick}
              and ${table.toTick} - ${table.fromTick} between 1 and 256)
            or (${table.status} = 'failed' and ${table.toTick} = ${table.fromTick}
              and ${table.errorCode} = 'SIMULATION_INTEGER_OVERFLOW')
          )`,
    ),
    check('simulation_batch_runs_registry_known', sql`${table.processRegistryVersion} in (1,2)`),
    check(
      'simulation_batch_runs_hash_lengths',
      sql`octet_length(${table.batchKey}) = 32
          and octet_length(${table.inputChecksum}) = 32
          and (${table.outcomeHash} is null or octet_length(${table.outcomeHash}) = 32)`,
    ),
    check('simulation_batch_runs_attempts_bounded', sql`${table.attempts} between 1 and 100`),
    check(
      'simulation_batch_runs_error_code_shape',
      sql`${table.errorCode} is null or (
          char_length(${table.errorCode}) between 3 and 100
          and ${table.errorCode} ~ '^[A-Z][A-Z0-9_]*$')`,
    ),
    check(
      'simulation_batch_runs_status_shape',
      sql`(${table.status} = 'running' and ${table.outcomeHash} is null
            and ${table.errorCode} is null and ${table.completedAt} is null)
          or (${table.status} = 'completed' and ${table.outcomeHash} is not null
            and ${table.commandId} is not null and ${table.errorCode} is null
            and ${table.completedAt} is not null)
          or (${table.status} = 'failed' and ${table.outcomeHash} is null
            and ${table.errorCode} is not null and ${table.completedAt} is not null)`,
    ),
    check(
      'simulation_batch_runs_timestamps_ordered',
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const simulationWorkerLeases = pgTable(
  'simulation_worker_leases',
  {
    worldId: uuid('world_id')
      .primaryKey()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    leaseOwner: text('lease_owner').notNull(),
    fencingToken: bigint('fencing_token', { mode: 'bigint' }).notNull(),
    leasedUntil: timestamptz('leased_until').notNull(),
    heartbeatAt: timestamptz('heartbeat_at').notNull(),
  },
  (table) => [
    index('simulation_worker_leases_expiry_idx').on(table.leasedUntil, table.worldId),
    check(
      'simulation_worker_leases_owner_bounded',
      sql`char_length(${table.leaseOwner}) between 3 and 160
          and ${table.leaseOwner} = btrim(${table.leaseOwner})
          and ${table.leaseOwner} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'`,
    ),
    check('simulation_worker_leases_fencing_positive', sql`${table.fencingToken} > 0`),
    check(
      'simulation_worker_leases_timestamps_valid',
      sql`${table.leasedUntil} >= ${table.heartbeatAt}`,
    ),
  ],
);

export const simulationFailures = pgTable(
  'simulation_failures',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    failureSchemaVersion: integer('failure_schema_version').default(1).notNull(),
    batchRunId: uuid('batch_run_id').notNull(),
    tick: bigint('tick', { mode: 'bigint' }).notNull(),
    scheduleId: uuid('schedule_id'),
    processType: text('process_type').notNull(),
    processVersion: text('process_version').notNull(),
    errorCode: text('error_code').notNull(),
    redactedContext: jsonb('redacted_context')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    attempts: integer('attempts').notNull(),
    status: simulationFailureStatus('status').default('open').notNull(),
    openedAt: timestamptz('opened_at').defaultNow().notNull(),
    resolvedByActorId: text('resolved_by_actor_id'),
    resolvedAt: timestamptz('resolved_at'),
    resolutionCommandId: uuid('resolution_command_id'),
  },
  (table) => [
    unique('simulation_failures_world_identity').on(table.worldId, table.id),
    foreignKey({
      columns: [table.worldId, table.batchRunId],
      foreignColumns: [simulationBatchRuns.worldId, simulationBatchRuns.id],
      name: 'simulation_failures_batch_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.scheduleId],
      foreignColumns: [scheduledActions.worldId, scheduledActions.id],
      name: 'simulation_failures_schedule_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.resolutionCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'simulation_failures_resolution_command_world_fk',
    }).onDelete('restrict'),
    index('simulation_failures_open_world_idx')
      .on(table.worldId, table.tick, table.openedAt, table.id)
      .where(sql`${table.status} = 'open'`),
    check('simulation_failures_schema_known', sql`${table.failureSchemaVersion} = 1`),
    check('simulation_failures_tick_nonnegative', sql`${table.tick} >= 0`),
    check(
      'simulation_failures_process_known',
      sql`(${table.processType} in (
              'EmitWorldNoticeV1','CompleteProductionRunV1','SettlePayrollV1',
              'ExpireMarketListingV1','AssessPeriodicTaxV1'
            ) and ${table.processVersion} = '1.0.0' and ${table.scheduleId} is not null)
          or (${table.processType} = 'WorldClockV1'
            and ${table.processVersion} = '1.0.0'
            and ${table.scheduleId} is null
            and ${table.errorCode} = 'SIMULATION_INTEGER_OVERFLOW')`,
    ),
    check(
      'simulation_failures_error_code_shape',
      sql`char_length(${table.errorCode}) between 3 and 100
          and ${table.errorCode} ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
    check(
      'simulation_failures_context_safe',
      sql`jsonb_typeof(${table.redactedContext}) = 'object'
          and pg_column_size(${table.redactedContext}) <= 16384
          and not worldgraph_jsonb_has_sensitive_key(${table.redactedContext})
          and not worldgraph_jsonb_has_compiler_private_key(${table.redactedContext})`,
    ),
    check('simulation_failures_attempts_bounded', sql`${table.attempts} between 1 and 100`),
    check(
      'simulation_failures_status_shape',
      sql`(${table.status} = 'open' and ${table.resolvedByActorId} is null
            and ${table.resolvedAt} is null and ${table.resolutionCommandId} is null)
          or (${table.status} = 'resolved' and ${table.resolvedByActorId} is not null
            and char_length(${table.resolvedByActorId}) between 3 and 160
            and ${table.resolvedByActorId} = btrim(${table.resolvedByActorId})
            and ${table.resolvedByActorId} !~ '[[:cntrl:]]'
            and ${table.resolvedAt} is not null and ${table.resolutionCommandId} is not null)`,
    ),
    check(
      'simulation_failures_timestamps_ordered',
      sql`${table.resolvedAt} is null or ${table.resolvedAt} >= ${table.openedAt}`,
    ),
  ],
);

export const compiledEconomySeedPlans = pgTable(
  'compiled_economy_seed_plans',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    worldVersionId: uuid('world_version_id').notNull(),
    compilationRunId: uuid('compilation_run_id').notNull(),
    sourceArtifactId: uuid('source_artifact_id')
      .notNull()
      .references(() => compiledWorldArtifacts.id, { onDelete: 'restrict' }),
    seedPlanSchemaVersion: integer('seed_plan_schema_version').notNull(),
    sourceKind: economySeedPlanSource('source_kind').notNull(),
    sourceCompilerVersion: text('source_compiler_version').notNull(),
    sourceAdapterId: text('source_adapter_id').notNull(),
    sourceAdapterVersion: text('source_adapter_version').notNull(),
    canonicalPlan: jsonb('canonical_plan').$type<Record<string, unknown>>().notNull(),
    planHash: bytea('plan_hash').notNull(),
    sourceArtifactHash: bytea('source_artifact_hash').notNull(),
    adoptedCommandId: uuid('adopted_command_id'),
    adoptedEventId: uuid('adopted_event_id'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('compiled_economy_seed_plans_world_version_unique').on(table.worldVersionId),
    uniqueIndex('compiled_economy_seed_plans_world_identity').on(table.worldId, table.id),
    uniqueIndex('compiled_economy_seed_plans_world_version_hash_unique').on(
      table.worldId,
      table.worldVersionId,
      table.planHash,
    ),
    foreignKey({
      columns: [table.worldVersionId, table.worldId],
      foreignColumns: [worldVersions.id, worldVersions.worldId],
      name: 'compiled_economy_seed_plans_version_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.compilationRunId, table.worldId],
      foreignColumns: [worldCompilationRuns.id, worldCompilationRuns.worldId],
      name: 'compiled_economy_seed_plans_run_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.adoptedCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'compiled_economy_seed_plans_adoption_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.adoptedEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'compiled_economy_seed_plans_adoption_event_world_fk',
    }).onDelete('restrict'),
    index('compiled_economy_seed_plans_world_source_idx').on(
      table.worldId,
      table.sourceKind,
      table.createdAt,
      table.id,
    ),
    check('compiled_economy_seed_plans_schema_known', sql`${table.seedPlanSchemaVersion} in (1,2)`),
    check(
      'compiled_economy_seed_plans_hash_lengths',
      sql`octet_length(${table.planHash}) = 32 and octet_length(${table.sourceArtifactHash}) = 32`,
    ),
    check(
      'compiled_economy_seed_plans_content_safe',
      sql`jsonb_typeof(${table.canonicalPlan}) = 'object'
          and pg_column_size(${table.canonicalPlan}) <= 1048576
          and ${table.canonicalPlan} ->> 'economySeedPlanSchemaVersion'
            = ${table.seedPlanSchemaVersion}::text
          and not worldgraph_jsonb_has_sensitive_key(${table.canonicalPlan})
          and not worldgraph_jsonb_has_compiler_private_key(${table.canonicalPlan})`,
    ),
    check(
      'compiled_economy_seed_plans_plan_hash_valid',
      sql`${table.planHash} = extensions.digest(convert_to(worldgraph_canonical_jsonb(
            jsonb_build_object('domain',case ${table.seedPlanSchemaVersion}
                when 1 then 'worldgraph.economy-seed-plan.v1'
                else 'worldgraph.economy-seed-plan.v2'
              end,
              'plan',${table.canonicalPlan})
          ),'UTF8'),'sha256')`,
    ),
    check(
      'compiled_economy_seed_plans_source_shape',
      sql`(${table.sourceKind} = 'compiler_1_1'
            and ${table.seedPlanSchemaVersion} = 1
            and ${table.sourceCompilerVersion} = '1.1.0'
            and ${table.sourceAdapterId} = 'CompiledEconomySeedAdapterV1'
            and ${table.sourceAdapterVersion} = '1.0.0'
            and ${table.adoptedCommandId} is null and ${table.adoptedEventId} is null)
          or (${table.sourceKind} = 'compiler_1_2'
            and ${table.seedPlanSchemaVersion} = 2
            and ${table.sourceCompilerVersion} in ('1.2.0','1.3.0')
            and ${table.sourceAdapterId} = 'CompiledEconomySeedAdapterV2'
            and ${table.sourceAdapterVersion} = '1.0.0'
            and ${table.adoptedCommandId} is null and ${table.adoptedEventId} is null)
          or (${table.sourceKind} = 'legacy_1_0_adapter'
            and ${table.seedPlanSchemaVersion} = 1
            and ${table.sourceCompilerVersion} = '1.0.0'
            and ${table.sourceAdapterId} = 'LegacyEconomySeedAdapterV1'
            and ${table.sourceAdapterVersion} = '1.0.0'
            and ${table.adoptedCommandId} is not null
            and ${table.adoptedEventId} is not null)`,
    ),
    check(
      'compiled_economy_seed_plans_semantics_valid',
      sql`worldgraph_economy_seed_plan_is_valid(${table.canonicalPlan})`,
    ),
  ],
);

export const currencies = pgTable(
  'currencies',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    stableKey: citext('stable_key').notNull(),
    code: citext('code').notNull(),
    name: text('name').notNull(),
    minorUnitScale: smallint('minor_unit_scale').notNull(),
    maxSupplyMinor: bigint('max_supply_minor', { mode: 'bigint' }),
    issuerEntityId: uuid('issuer_entity_id'),
    currencySchemaVersion: integer('currency_schema_version').default(1).notNull(),
    status: currencyStatus('status').default('active').notNull(),
    rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
    createdEventId: uuid('created_event_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('currencies_world_identity').on(table.worldId, table.id),
    uniqueIndex('currencies_world_stable_key_unique').on(table.worldId, table.stableKey),
    uniqueIndex('currencies_world_code_unique').on(table.worldId, table.code),
    foreignKey({
      columns: [table.worldId, table.issuerEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'currencies_issuer_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.createdEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'currencies_created_event_world_fk',
    }).onDelete('restrict'),
    check('currencies_schema_known', sql`${table.currencySchemaVersion} = 1`),
    check('currencies_scale_bounded', sql`${table.minorUnitScale} between 0 and 6`),
    check(
      'currencies_supply_cap_nonnegative',
      sql`${table.maxSupplyMinor} is null or ${table.maxSupplyMinor} >= 0`,
    ),
    check(
      'currencies_key_shape',
      sql`char_length(${table.stableKey}::text) between 3 and 240
          and ${table.stableKey}::text = lower(${table.stableKey}::text)
          and ${table.stableKey}::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'`,
    ),
    check(
      'currencies_code_shape',
      sql`${table.code}::text = upper(${table.code}::text)
          and ${table.code}::text ~ '^[A-Z][A-Z0-9]{2,11}$'`,
    ),
    check(
      'currencies_name_bounded',
      sql`char_length(btrim(${table.name})) between 1 and 100
          and ${table.name} = btrim(${table.name})
          and ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check('currencies_versions_positive', sql`${table.rowVersion} > 0`),
    check('currencies_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const currencySupply = pgTable(
  'currency_supply',
  {
    currencyId: uuid('currency_id').primaryKey(),
    worldId: uuid('world_id').notNull(),
    currentSupplyMinor: bigint('current_supply_minor', { mode: 'bigint' }).default(0n).notNull(),
    rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
    updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('currency_supply_world_identity').on(table.worldId, table.currencyId),
    foreignKey({
      columns: [table.worldId, table.currencyId],
      foreignColumns: [currencies.worldId, currencies.id],
      name: 'currency_supply_currency_world_fk',
    }).onDelete('restrict'),
    check('currency_supply_nonnegative', sql`${table.currentSupplyMinor} >= 0`),
    check(
      'currency_supply_versions_positive',
      sql`${table.rowVersion} > 0 and ${table.updatedStateRevision} > 0`,
    ),
  ],
);

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    currencyId: uuid('currency_id').notNull(),
    stableKey: citext('stable_key').notNull(),
    ownerEntityId: uuid('owner_entity_id').notNull(),
    walletKind: walletKind('wallet_kind').notNull(),
    status: walletStatus('status').default('active').notNull(),
    walletSchemaVersion: integer('wallet_schema_version').default(1).notNull(),
    rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
    createdEventId: uuid('created_event_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
    closedAt: timestamptz('closed_at'),
  },
  (table) => [
    uniqueIndex('wallets_world_identity').on(table.worldId, table.id),
    uniqueIndex('wallets_world_currency_identity').on(table.worldId, table.currencyId, table.id),
    uniqueIndex('wallets_world_stable_key_unique').on(table.worldId, table.stableKey),
    uniqueIndex('wallets_world_currency_owner_unique').on(
      table.worldId,
      table.currencyId,
      table.ownerEntityId,
    ),
    foreignKey({
      columns: [table.worldId, table.currencyId],
      foreignColumns: [currencies.worldId, currencies.id],
      name: 'wallets_currency_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.ownerEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'wallets_owner_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.createdEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'wallets_created_event_world_fk',
    }).onDelete('restrict'),
    index('wallets_world_owner_status_idx').on(
      table.worldId,
      table.ownerEntityId,
      table.status,
      table.currencyId,
      table.id,
    ),
    check('wallets_schema_known', sql`${table.walletSchemaVersion} = 1`),
    check(
      'wallets_key_shape',
      sql`char_length(${table.stableKey}::text) between 3 and 240
          and ${table.stableKey}::text = lower(${table.stableKey}::text)
          and ${table.stableKey}::text ~ '^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)+$'`,
    ),
    check('wallets_versions_positive', sql`${table.rowVersion} > 0`),
    check(
      'wallets_status_shape',
      sql`(${table.status} in ('active','frozen') and ${table.closedAt} is null)
          or (${table.status} = 'closed' and ${table.closedAt} is not null)`,
    ),
    check(
      'wallets_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}
          and (${table.closedAt} is null or ${table.closedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const walletBalances = pgTable(
  'wallet_balances',
  {
    walletId: uuid('wallet_id').primaryKey(),
    worldId: uuid('world_id').notNull(),
    currencyId: uuid('currency_id').notNull(),
    availableMinor: bigint('available_minor', { mode: 'bigint' }).default(0n).notNull(),
    rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
    updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('wallet_balances_world_currency_identity').on(
      table.worldId,
      table.currencyId,
      table.walletId,
    ),
    foreignKey({
      columns: [table.worldId, table.currencyId, table.walletId],
      foreignColumns: [wallets.worldId, wallets.currencyId, wallets.id],
      name: 'wallet_balances_wallet_world_currency_fk',
    }).onDelete('restrict'),
    check('wallet_balances_nonnegative', sql`${table.availableMinor} >= 0`),
    check(
      'wallet_balances_versions_positive',
      sql`${table.rowVersion} > 0 and ${table.updatedStateRevision} > 0`,
    ),
  ],
);

export const financialTransactions = pgTable(
  'financial_transactions',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    currencyId: uuid('currency_id').notNull(),
    transactionKind: financialTransactionKind('transaction_kind').notNull(),
    supplyDeltaMinor: bigint('supply_delta_minor', { mode: 'bigint' }).notNull(),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull(),
    memoCode: text('memo_code').notNull(),
    memoText: text('memo_text'),
    reversalOfTransactionId: uuid('reversal_of_transaction_id'),
    occurredTick: bigint('occurred_tick', { mode: 'bigint' }).notNull(),
    stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('financial_transactions_world_identity').on(table.worldId, table.id),
    uniqueIndex('financial_transactions_world_currency_identity').on(
      table.worldId,
      table.currencyId,
      table.id,
    ),
    uniqueIndex('financial_transactions_command_unique').on(table.commandId),
    uniqueIndex('financial_transactions_event_unique').on(table.eventId),
    uniqueIndex('financial_transactions_one_compensation_idx')
      .on(table.reversalOfTransactionId)
      .where(sql`${table.reversalOfTransactionId} is not null`),
    foreignKey({
      columns: [table.worldId, table.currencyId],
      foreignColumns: [currencies.worldId, currencies.id],
      name: 'financial_transactions_currency_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'financial_transactions_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'financial_transactions_event_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.currencyId, table.reversalOfTransactionId],
      foreignColumns: [table.worldId, table.currencyId, table.id],
      name: 'financial_transactions_reversal_world_currency_fk',
    }).onDelete('restrict'),
    index('financial_transactions_wallet_cursor_idx').on(
      table.worldId,
      table.currencyId,
      table.occurredTick.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('financial_transactions_commerce_timeline_idx')
      .on(table.worldId, table.occurredTick.desc(), table.createdAt.desc(), table.id.desc())
      // This inverse set keeps the M08→M09 enum expansion atomic. Replace it
      // before adding a future non-commerce transaction kind.
      .where(
        sql`${table.transactionKind} not in (
          'initialization', 'issuance', 'transfer', 'asset_purchase', 'compensation'
        )`,
      ),
    check(
      'financial_transactions_tick_revision_valid',
      sql`${table.occurredTick} >= 0 and ${table.stateRevision} > 0`,
    ),
    check(
      'financial_transactions_memo_code_shape',
      sql`char_length(${table.memoCode}) between 1 and 80
          and ${table.memoCode} ~ '^[a-z][a-z0-9._-]*$'`,
    ),
    check(
      'financial_transactions_memo_text_safe',
      sql`${table.memoText} is null or (
            char_length(${table.memoText}) between 1 and 280
            and ${table.memoText} = btrim(${table.memoText})
            and translate(${table.memoText}, E'\t\n\r', '') !~ '[[:cntrl:]]'
          )`,
    ),
    check(
      'financial_transactions_reversal_not_self',
      sql`${table.reversalOfTransactionId} is null
          or ${table.reversalOfTransactionId} <> ${table.id}`,
    ),
    check(
      'financial_transactions_reversal_shape',
      sql`(${table.transactionKind} = 'compensation'
            and ${table.reversalOfTransactionId} is not null)
          or (${table.transactionKind} <> 'compensation'
            and ${table.reversalOfTransactionId} is null)`,
    ),
  ],
);

export const walletPostings = pgTable(
  'wallet_postings',
  {
    id: uuid('id').primaryKey(),
    transactionId: uuid('transaction_id').notNull(),
    worldId: uuid('world_id').notNull(),
    currencyId: uuid('currency_id').notNull(),
    walletId: uuid('wallet_id').notNull(),
    postingOrdinal: integer('posting_ordinal').notNull(),
    signedAmountMinor: bigint('signed_amount_minor', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('wallet_postings_transaction_ordinal_unique').on(
      table.transactionId,
      table.postingOrdinal,
    ),
    foreignKey({
      columns: [table.worldId, table.currencyId, table.transactionId],
      foreignColumns: [
        financialTransactions.worldId,
        financialTransactions.currencyId,
        financialTransactions.id,
      ],
      name: 'wallet_postings_transaction_world_currency_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.currencyId, table.walletId],
      foreignColumns: [wallets.worldId, wallets.currencyId, wallets.id],
      name: 'wallet_postings_wallet_world_currency_fk',
    }).onDelete('restrict'),
    index('wallet_postings_wallet_cursor_idx').on(
      table.worldId,
      table.walletId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('wallet_postings_ordinal_valid', sql`${table.postingOrdinal} between 0 and 100`),
    check('wallet_postings_amount_nonzero', sql`${table.signedAmountMinor} <> 0`),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    stableKey: citext('stable_key').notNull(),
    assetType: text('asset_type').notNull(),
    worldEntityId: uuid('world_entity_id'),
    assetSchemaVersion: integer('asset_schema_version').default(1).notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    transferable: boolean('transferable').notNull(),
    status: assetStatus('status').default('active').notNull(),
    createdEventId: uuid('created_event_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    retiredAt: timestamptz('retired_at'),
  },
  (table) => [
    uniqueIndex('assets_world_identity').on(table.worldId, table.id),
    uniqueIndex('assets_world_stable_key_unique').on(table.worldId, table.stableKey),
    uniqueIndex('assets_world_entity_unique').on(table.worldId, table.worldEntityId),
    foreignKey({
      columns: [table.worldId, table.worldEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'assets_entity_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.createdEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'assets_created_event_world_fk',
    }).onDelete('restrict'),
    index('assets_world_type_status_idx').on(
      table.worldId,
      table.assetType,
      table.status,
      table.stableKey,
      table.id,
    ),
    check('assets_schema_known', sql`${table.assetSchemaVersion} = 1`),
    check(
      'assets_type_shape',
      sql`char_length(${table.assetType}) between 1 and 80 and ${table.assetType} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      'assets_metadata_safe',
      sql`jsonb_typeof(${table.metadata}) = 'object'
          and worldgraph_jsonb_has_exact_keys(
            ${table.metadata},array['displayName','provenance']
          )
          and char_length(${table.metadata} ->> 'displayName') between 1 and 100
          and ${table.metadata} ->> 'displayName' = btrim(${table.metadata} ->> 'displayName')
          and (${table.metadata} ->> 'displayName') !~ '[[:cntrl:]]'
          and char_length(${table.metadata} ->> 'provenance') between 3 and 80
          and ${table.metadata} ->> 'provenance' ~ '^[a-z][a-z0-9._-]*$'`,
    ),
    check(
      'assets_status_shape',
      sql`(${table.status} = 'active' and ${table.retiredAt} is null)
          or (${table.status} = 'retired' and ${table.retiredAt} is not null)`,
    ),
    check(
      'assets_timestamps_ordered',
      sql`${table.retiredAt} is null or ${table.retiredAt} >= ${table.createdAt}`,
    ),
  ],
);

export const assetOwnership = pgTable(
  'asset_ownership',
  {
    assetId: uuid('asset_id').primaryKey(),
    worldId: uuid('world_id').notNull(),
    ownerEntityId: uuid('owner_entity_id').notNull(),
    ownershipVersion: bigint('ownership_version', { mode: 'bigint' }).notNull(),
    acquiredEventId: uuid('acquired_event_id').notNull(),
    updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('asset_ownership_world_identity').on(table.worldId, table.assetId),
    uniqueIndex('asset_ownership_event_asset_unique').on(table.acquiredEventId, table.assetId),
    uniqueIndex('asset_ownership_noninitial_event_unique')
      .on(table.acquiredEventId)
      .where(sql`${table.ownershipVersion} > 1`),
    foreignKey({
      columns: [table.worldId, table.assetId],
      foreignColumns: [assets.worldId, assets.id],
      name: 'asset_ownership_asset_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.ownerEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'asset_ownership_owner_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.acquiredEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'asset_ownership_event_world_fk',
    }).onDelete('restrict'),
    index('asset_ownership_world_owner_idx').on(table.worldId, table.ownerEntityId, table.assetId),
    check(
      'asset_ownership_versions_positive',
      sql`${table.ownershipVersion} > 0 and ${table.updatedStateRevision} > 0`,
    ),
  ],
);

export const assetTransfers = pgTable(
  'asset_transfers',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    assetId: uuid('asset_id').notNull(),
    fromOwnerEntityId: uuid('from_owner_entity_id'),
    toOwnerEntityId: uuid('to_owner_entity_id').notNull(),
    transferKind: assetTransferKind('transfer_kind').notNull(),
    financialTransactionId: uuid('financial_transaction_id'),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull(),
    occurredTick: bigint('occurred_tick', { mode: 'bigint' }).notNull(),
    stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    reversalOfTransferId: uuid('reversal_of_transfer_id'),
  },
  (table) => [
    uniqueIndex('asset_transfers_world_identity').on(table.worldId, table.id),
    uniqueIndex('asset_transfers_event_asset_unique').on(table.eventId, table.assetId),
    uniqueIndex('asset_transfers_command_asset_unique').on(table.commandId, table.assetId),
    uniqueIndex('asset_transfers_financial_transaction_unique').on(table.financialTransactionId),
    uniqueIndex('asset_transfers_noninitial_event_unique')
      .on(table.eventId)
      .where(sql`${table.transferKind} <> 'initial'`),
    uniqueIndex('asset_transfers_one_compensation_idx')
      .on(table.reversalOfTransferId)
      .where(sql`${table.reversalOfTransferId} is not null`),
    foreignKey({
      columns: [table.worldId, table.assetId],
      foreignColumns: [assets.worldId, assets.id],
      name: 'asset_transfers_asset_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.fromOwnerEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'asset_transfers_from_owner_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.toOwnerEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'asset_transfers_to_owner_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.financialTransactionId],
      foreignColumns: [financialTransactions.worldId, financialTransactions.id],
      name: 'asset_transfers_financial_transaction_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'asset_transfers_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'asset_transfers_event_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.reversalOfTransferId],
      foreignColumns: [table.worldId, table.id],
      name: 'asset_transfers_reversal_world_fk',
    }).onDelete('restrict'),
    index('asset_transfers_asset_cursor_idx').on(
      table.worldId,
      table.assetId,
      table.stateRevision.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      'asset_transfers_tick_revision_valid',
      sql`${table.occurredTick} >= 0 and ${table.stateRevision} > 0`,
    ),
    check(
      'asset_transfers_owner_shape',
      sql`(${table.transferKind} = 'initial' and ${table.fromOwnerEntityId} is null
            and ${table.financialTransactionId} is null)
          or (${table.transferKind} in ('grant','compensation')
            and ${table.fromOwnerEntityId} is not null
            and ${table.financialTransactionId} is null)
          or (${table.transferKind} = 'purchase' and ${table.fromOwnerEntityId} is not null
            and ${table.financialTransactionId} is not null)`,
    ),
    check(
      'asset_transfers_owners_distinct',
      sql`${table.fromOwnerEntityId} is null
          or ${table.fromOwnerEntityId} <> ${table.toOwnerEntityId}`,
    ),
    check(
      'asset_transfers_reversal_not_self',
      sql`${table.reversalOfTransferId} is null
          or ${table.reversalOfTransferId} <> ${table.id}`,
    ),
    check(
      'asset_transfers_reversal_shape',
      sql`(${table.transferKind} = 'compensation'
            and ${table.reversalOfTransferId} is not null)
          or (${table.transferKind} <> 'compensation'
            and ${table.reversalOfTransferId} is null)`,
    ),
  ],
);

export const assetTransferOffers = pgTable(
  'asset_transfer_offers',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    assetId: uuid('asset_id').notNull(),
    sellerEntityId: uuid('seller_entity_id').notNull(),
    buyerEntityId: uuid('buyer_entity_id'),
    currencyId: uuid('currency_id').notNull(),
    sellerWalletId: uuid('seller_wallet_id').notNull(),
    priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
    expiresAtTick: bigint('expires_at_tick', { mode: 'bigint' }).notNull(),
    createdAtTick: bigint('created_at_tick', { mode: 'bigint' }).notNull(),
    status: assetTransferOfferStatus('status').default('open').notNull(),
    createdCommandId: uuid('created_command_id').notNull(),
    createdEventId: uuid('created_event_id').notNull(),
    terminalCommandId: uuid('terminal_command_id'),
    terminalEventId: uuid('terminal_event_id'),
    acceptedFinancialTransactionId: uuid('accepted_financial_transaction_id'),
    acceptedAssetTransferId: uuid('accepted_asset_transfer_id'),
    rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
    createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
    terminalStateRevision: bigint('terminal_state_revision', { mode: 'bigint' }),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('asset_transfer_offers_world_identity').on(table.worldId, table.id),
    uniqueIndex('asset_transfer_offers_created_command_unique').on(table.createdCommandId),
    uniqueIndex('asset_transfer_offers_created_event_unique').on(table.createdEventId),
    uniqueIndex('asset_transfer_offers_terminal_command_unique').on(table.terminalCommandId),
    uniqueIndex('asset_transfer_offers_terminal_event_unique').on(table.terminalEventId),
    uniqueIndex('asset_transfer_offers_financial_transaction_unique').on(
      table.acceptedFinancialTransactionId,
    ),
    uniqueIndex('asset_transfer_offers_asset_transfer_unique').on(table.acceptedAssetTransferId),
    uniqueIndex('asset_transfer_offers_one_open_asset_idx')
      .on(table.worldId, table.assetId)
      .where(sql`${table.status} = 'open'`),
    foreignKey({
      columns: [table.worldId, table.assetId],
      foreignColumns: [assets.worldId, assets.id],
      name: 'asset_transfer_offers_asset_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.sellerEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'asset_transfer_offers_seller_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.buyerEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'asset_transfer_offers_buyer_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.currencyId],
      foreignColumns: [currencies.worldId, currencies.id],
      name: 'asset_transfer_offers_currency_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.currencyId, table.sellerWalletId],
      foreignColumns: [wallets.worldId, wallets.currencyId, wallets.id],
      name: 'asset_transfer_offers_seller_wallet_world_currency_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'asset_transfer_offers_created_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.createdEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'asset_transfer_offers_created_event_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.terminalCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'asset_transfer_offers_terminal_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.terminalEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'asset_transfer_offers_terminal_event_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.acceptedFinancialTransactionId],
      foreignColumns: [financialTransactions.worldId, financialTransactions.id],
      name: 'asset_transfer_offers_financial_transaction_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.acceptedAssetTransferId],
      foreignColumns: [assetTransfers.worldId, assetTransfers.id],
      name: 'asset_transfer_offers_asset_transfer_world_fk',
    }).onDelete('restrict'),
    index('asset_transfer_offers_due_idx')
      .on(table.expiresAtTick, table.worldId, table.id)
      .where(sql`${table.status} = 'open'`),
    index('asset_transfer_offers_participant_idx').on(
      table.worldId,
      table.sellerEntityId,
      table.buyerEntityId,
      table.status,
      table.id,
    ),
    check(
      'asset_transfer_offers_price_tick_valid',
      sql`${table.priceMinor} > 0 and ${table.createdAtTick} >= 0
          and ${table.expiresAtTick} > ${table.createdAtTick}`,
    ),
    check(
      'asset_transfer_offers_versions_positive',
      sql`${table.rowVersion} > 0 and ${table.createdStateRevision} > 0
          and (${table.terminalStateRevision} is null
            or ${table.terminalStateRevision} > ${table.createdStateRevision})`,
    ),
    check(
      'asset_transfer_offers_parties_distinct',
      sql`${table.buyerEntityId} is null or ${table.buyerEntityId} <> ${table.sellerEntityId}`,
    ),
    check(
      'asset_transfer_offers_status_shape',
      sql`(${table.status} = 'open' and ${table.terminalCommandId} is null
            and ${table.terminalEventId} is null and ${table.terminalStateRevision} is null
            and ${table.acceptedFinancialTransactionId} is null
            and ${table.acceptedAssetTransferId} is null)
          or (${table.status} = 'accepted' and ${table.terminalCommandId} is not null
            and ${table.terminalEventId} is not null
            and ${table.terminalStateRevision} is not null
            and ${table.acceptedFinancialTransactionId} is not null
            and ${table.acceptedAssetTransferId} is not null)
          or (${table.status} in ('cancelled','expired')
            and ${table.terminalCommandId} is not null
            and ${table.terminalEventId} is not null
            and ${table.terminalStateRevision} is not null
            and ${table.acceptedFinancialTransactionId} is null
            and ${table.acceptedAssetTransferId} is null)`,
    ),
    check(
      'asset_transfer_offers_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const worldEconomyHeads = pgTable(
  'world_economy_heads',
  {
    worldId: uuid('world_id')
      .primaryKey()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    economySchemaVersion: integer('economy_schema_version').default(1).notNull(),
    sourceWorldVersionId: uuid('source_world_version_id').notNull(),
    seedPlanHash: bytea('seed_plan_hash').notNull(),
    initializedCommandId: uuid('initialized_command_id').notNull(),
    initializedEventId: uuid('initialized_event_id').notNull(),
    checksum: bytea('checksum').notNull(),
    rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
    updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
    reconciliationStatus: economyReconciliationStatus('reconciliation_status')
      .default('pending')
      .notNull(),
    lastReconciledStateRevision: bigint('last_reconciled_state_revision', { mode: 'bigint' }),
    lastReconciliationRunId: uuid('last_reconciliation_run_id'),
    initializedAt: timestamptz('initialized_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('world_economy_heads_initialized_command_unique').on(table.initializedCommandId),
    uniqueIndex('world_economy_heads_initialized_event_unique').on(table.initializedEventId),
    foreignKey({
      columns: [table.worldId, table.sourceWorldVersionId, table.seedPlanHash],
      foreignColumns: [
        compiledEconomySeedPlans.worldId,
        compiledEconomySeedPlans.worldVersionId,
        compiledEconomySeedPlans.planHash,
      ],
      name: 'world_economy_heads_plan_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.initializedCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'world_economy_heads_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.initializedEventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'world_economy_heads_event_world_fk',
    }).onDelete('restrict'),
    check('world_economy_heads_schema_known', sql`${table.economySchemaVersion} = 1`),
    check(
      'world_economy_heads_hash_lengths',
      sql`octet_length(${table.seedPlanHash}) = 32 and octet_length(${table.checksum}) = 32`,
    ),
    check(
      'world_economy_heads_versions_positive',
      sql`${table.rowVersion} > 0 and ${table.updatedStateRevision} > 0`,
    ),
    check(
      'world_economy_heads_reconciliation_shape',
      sql`(${table.reconciliationStatus} = 'pending'
            and ${table.lastReconciledStateRevision} is null
            and ${table.lastReconciliationRunId} is null)
          or (${table.reconciliationStatus} in ('current','mismatch','failed')
            and ${table.lastReconciledStateRevision} is not null
            and ${table.lastReconciliationRunId} is not null)`,
    ),
    check(
      'world_economy_heads_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.initializedAt}`,
    ),
    // The cyclic FK to economy_reconciliation_runs is installed by migration 0009.
  ],
);

export const economyReconciliationRuns = pgTable(
  'economy_reconciliation_runs',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    reconciliationSchemaVersion: integer('reconciliation_schema_version').default(1).notNull(),
    sourceStateRevision: bigint('source_state_revision', { mode: 'bigint' }).notNull(),
    sourceEventSequence: bigint('source_event_sequence', { mode: 'bigint' }).notNull(),
    status: economyReconciliationRunStatus('status').notNull(),
    liveWalletChecksum: bytea('live_wallet_checksum').notNull(),
    rebuiltWalletChecksum: bytea('rebuilt_wallet_checksum').notNull(),
    liveSupplyChecksum: bytea('live_supply_checksum').notNull(),
    rebuiltSupplyChecksum: bytea('rebuilt_supply_checksum').notNull(),
    liveOwnershipChecksum: bytea('live_ownership_checksum').notNull(),
    rebuiltOwnershipChecksum: bytea('rebuilt_ownership_checksum').notNull(),
    liveProjectionChecksum: bytea('live_projection_checksum').notNull(),
    rebuiltJournalChecksum: bytea('rebuilt_journal_checksum').notNull(),
    walletCount: integer('wallet_count').notNull(),
    currencyCount: integer('currency_count').notNull(),
    assetCount: integer('asset_count').notNull(),
    mismatchCount: integer('mismatch_count').notNull(),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('economy_reconciliation_runs_world_identity').on(table.worldId, table.id),
    uniqueIndex('economy_reconciliation_runs_command_unique').on(table.commandId),
    uniqueIndex('economy_reconciliation_runs_event_unique').on(table.eventId),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'economy_reconciliation_runs_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'economy_reconciliation_runs_event_world_fk',
    }).onDelete('restrict'),
    index('economy_reconciliation_runs_world_cursor_idx').on(
      table.worldId,
      table.sourceStateRevision.desc(),
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      'economy_reconciliation_runs_schema_known',
      sql`${table.reconciliationSchemaVersion} = 1`,
    ),
    check(
      'economy_reconciliation_runs_source_valid',
      sql`${table.sourceStateRevision} > 0 and ${table.sourceEventSequence} > 0`,
    ),
    check(
      'economy_reconciliation_runs_hash_lengths',
      sql`octet_length(${table.liveWalletChecksum}) = 32
          and octet_length(${table.rebuiltWalletChecksum}) = 32
          and octet_length(${table.liveSupplyChecksum}) = 32
          and octet_length(${table.rebuiltSupplyChecksum}) = 32
          and octet_length(${table.liveOwnershipChecksum}) = 32
          and octet_length(${table.rebuiltOwnershipChecksum}) = 32
          and octet_length(${table.liveProjectionChecksum}) = 32
          and octet_length(${table.rebuiltJournalChecksum}) = 32`,
    ),
    check(
      'economy_reconciliation_runs_counts_valid',
      sql`${table.walletCount} >= 0 and ${table.currencyCount} >= 0
          and ${table.assetCount} >= 0 and ${table.mismatchCount} >= 0
          and ((${table.status} = 'matched' and ${table.mismatchCount} = 0)
            or (${table.status} = 'mismatch' and ${table.mismatchCount} > 0))`,
    ),
  ],
);

export const economyReconciliationItems = pgTable(
  'economy_reconciliation_items',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => economyReconciliationRuns.id, {
        onDelete: 'restrict',
      }),
    itemOrdinal: integer('item_ordinal').notNull(),
    itemKind: text('item_kind').notNull(),
    itemKey: text('item_key').notNull(),
    itemKeyHash: bytea('item_key_hash').notNull(),
    expectedValue: text('expected_value'),
    actualValue: text('actual_value'),
    mismatchCode: text('mismatch_code').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.itemOrdinal] }),
    check(
      'economy_reconciliation_items_ordinal_bounded',
      sql`${table.itemOrdinal} between 0 and 9999`,
    ),
    check(
      'economy_reconciliation_items_kind_shape',
      sql`${table.itemKind} in ('wallet_balance','currency_supply','asset_ownership')`,
    ),
    check(
      'economy_reconciliation_items_key_hash_length',
      sql`octet_length(${table.itemKeyHash}) = 32`,
    ),
    check(
      'economy_reconciliation_items_key_shape',
      sql`char_length(${table.itemKey}) between 1 and 240
          and ${table.itemKey} = btrim(${table.itemKey})
          and ${table.itemKey} !~ '[[:cntrl:]]'
          and ${table.itemKeyHash} = extensions.digest(
            convert_to(${table.itemKey},'UTF8'),'sha256')`,
    ),
    check(
      'economy_reconciliation_items_value_shape',
      sql`(${table.expectedValue} is null
            or ${table.expectedValue} ~ '^(0|-?[1-9][0-9]{0,18}|[a-f0-9]{64})$')
          and (${table.actualValue} is null
            or ${table.actualValue} ~ '^(0|-?[1-9][0-9]{0,18}|[a-f0-9]{64})$')
          and ${table.expectedValue} is distinct from ${table.actualValue}`,
    ),
    check(
      'economy_reconciliation_items_code_shape',
      sql`char_length(${table.mismatchCode}) between 3 and 100
          and ${table.mismatchCode} ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
  ],
);

export const economyParticipantHistory = pgTable(
  'economy_participant_history',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    ledgerSequence: bigint('ledger_sequence', { mode: 'bigint' }).notNull(),
    userId: uuid('user_id').notNull(),
    participantEntityId: uuid('participant_entity_id').notNull(),
    counterpartyEntityId: uuid('counterparty_entity_id'),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull(),
    category: text('category').notNull(),
    summaryCode: text('summary_code').notNull(),
    summaryArgs: jsonb('summary_args')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    visibility: economyParticipantVisibility('visibility').default('participant').notNull(),
    stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.worldId, table.ledgerSequence, table.userId] }),
    foreignKey({
      columns: [table.worldId, table.userId],
      foreignColumns: [worldMemberships.worldId, worldMemberships.userId],
      name: 'economy_participant_history_membership_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.participantEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'economy_participant_history_participant_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.counterpartyEntityId],
      foreignColumns: [worldEntities.worldId, worldEntities.id],
      name: 'economy_participant_history_counterparty_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.ledgerSequence],
      foreignColumns: [ledgerEntries.worldId, ledgerEntries.ledgerSequence],
      name: 'economy_participant_history_ledger_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'economy_participant_history_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'economy_participant_history_event_world_fk',
    }).onDelete('restrict'),
    index('economy_participant_history_user_cursor_idx').on(
      table.worldId,
      table.userId,
      table.ledgerSequence.desc(),
    ),
    check(
      'economy_participant_history_sequence_revision_positive',
      sql`${table.ledgerSequence} > 0 and ${table.stateRevision} > 0`,
    ),
    check(
      'economy_participant_history_category_shape',
      sql`${table.category} in (
        'currency','asset','offer','issuance','wallet','reconciliation','repair','payroll'
      )`,
    ),
    check(
      'economy_participant_history_summary_code_shape',
      sql`char_length(${table.summaryCode}) between 3 and 100
          and ${table.summaryCode} ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
    check(
      'economy_participant_history_summary_safe',
      sql`jsonb_typeof(${table.summaryArgs}) = 'object'
          and pg_column_size(${table.summaryArgs}) <= 4096
          and not worldgraph_jsonb_has_sensitive_key(${table.summaryArgs})
          and not worldgraph_jsonb_has_compiler_private_key(${table.summaryArgs})
          and not ${table.summaryArgs} ?| array['memo','memoText','balance','availableMinor']`,
    ),
  ],
);

export const economyRepairPlans = pgTable(
  'economy_repair_plans',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    repairPlanSchemaVersion: integer('repair_plan_schema_version').default(1).notNull(),
    reservedCommandId: uuid('reserved_command_id').notNull(),
    sourceCommandId: uuid('source_command_id').notNull(),
    repairKind: economyRepairKind('repair_kind').notNull(),
    sourceFinancialTransactionId: uuid('source_financial_transaction_id'),
    sourceAssetTransferId: uuid('source_asset_transfer_id'),
    compensationTransactionId: uuid('compensation_transaction_id'),
    compensationTransferId: uuid('compensation_transfer_id'),
    sourceWorldVersion: bigint('source_world_version', { mode: 'bigint' }).notNull(),
    sourceStateRevision: bigint('source_state_revision', { mode: 'bigint' }).notNull(),
    sourceEventSequence: bigint('source_event_sequence', { mode: 'bigint' }).notNull(),
    sourceEconomyHeadVersion: bigint('source_economy_head_version', {
      mode: 'bigint',
    }).notNull(),
    sourceEconomyChecksum: bytea('source_economy_checksum').notNull(),
    sourceReconciliationRunId: uuid('source_reconciliation_run_id').notNull(),
    canonicalDelta: jsonb('canonical_delta').$type<Record<string, unknown>>().notNull(),
    deltaHash: bytea('delta_hash').notNull(),
    planHash: bytea('plan_hash').notNull(),
    reasonCode: economyRepairReasonCode('reason_code').notNull(),
    incidentReason: text('incident_reason').notNull(),
    pitrNotUsedReason: text('pitr_not_used_reason').notNull(),
    preparedByUserId: uuid('prepared_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    preparationAuditId: uuid('preparation_audit_id').notNull(),
    preparedAt: timestamptz('prepared_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('economy_repair_plans_world_identity').on(table.worldId, table.id),
    uniqueIndex('economy_repair_plans_reserved_command_unique').on(table.reservedCommandId),
    uniqueIndex('economy_repair_plans_plan_hash_unique').on(table.planHash),
    uniqueIndex('economy_repair_plans_preparation_audit_unique').on(table.preparationAuditId),
    foreignKey({
      columns: [table.sourceCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'economy_repair_plans_source_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.sourceFinancialTransactionId],
      foreignColumns: [financialTransactions.worldId, financialTransactions.id],
      name: 'economy_repair_plans_source_financial_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.sourceAssetTransferId],
      foreignColumns: [assetTransfers.worldId, assetTransfers.id],
      name: 'economy_repair_plans_source_transfer_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.sourceReconciliationRunId],
      foreignColumns: [economyReconciliationRuns.worldId, economyReconciliationRuns.id],
      name: 'economy_repair_plans_reconciliation_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.preparationAuditId, table.worldId, table.preparedByUserId],
      foreignColumns: [
        securityAuditRecords.id,
        securityAuditRecords.worldId,
        securityAuditRecords.actorUserId,
      ],
      name: 'economy_repair_plans_preparation_audit_fk',
    }).onDelete('restrict'),
    index('economy_repair_plans_world_source_idx').on(
      table.worldId,
      table.sourceCommandId,
      table.preparedAt.desc(),
      table.id.desc(),
    ),
    index('economy_repair_plans_expiry_idx').on(table.expiresAt, table.worldId, table.id),
    check('economy_repair_plans_schema_known', sql`${table.repairPlanSchemaVersion} = 1`),
    check(
      'economy_repair_plans_versions_valid',
      sql`${table.sourceWorldVersion} > 0
          and ${table.sourceStateRevision} >= 0
          and ${table.sourceEventSequence} > 0
          and ${table.sourceEconomyHeadVersion} > 0`,
    ),
    check(
      'economy_repair_plans_hash_lengths',
      sql`octet_length(${table.sourceEconomyChecksum}) = 32
          and octet_length(${table.deltaHash}) = 32
          and octet_length(${table.planHash}) = 32`,
    ),
    check(
      'economy_repair_plans_reason_shape',
      sql`worldgraph_economy_repair_reason_is_valid(${table.incidentReason})
          and worldgraph_economy_repair_reason_is_valid(${table.pitrNotUsedReason})`,
    ),
    check(
      'economy_repair_plans_time_window_exact',
      sql`${table.preparedAt} = date_trunc('milliseconds', ${table.preparedAt})
          and ${table.expiresAt} = ${table.preparedAt} + interval '24 hours'`,
    ),
    check(
      'economy_repair_plans_identities_distinct',
      sql`${table.id} <> ${table.reservedCommandId}
          and ${table.id} <> ${table.sourceCommandId}
          and ${table.reservedCommandId} <> ${table.sourceCommandId}
          and (${table.compensationTransactionId} is null
            or ${table.compensationTransactionId} not in (
              ${table.id},${table.reservedCommandId},${table.sourceCommandId}
            ))
          and (${table.compensationTransferId} is null
            or ${table.compensationTransferId} not in (
              ${table.id},${table.reservedCommandId},${table.sourceCommandId}
            ))
          and (${table.compensationTransactionId} is null
            or ${table.compensationTransferId} is null
            or ${table.compensationTransactionId} <> ${table.compensationTransferId})`,
    ),
    check(
      'economy_repair_plans_kind_shape',
      sql`(${table.repairKind} = 'reverse_financial_transaction'
            and ${table.sourceFinancialTransactionId} is not null
            and ${table.sourceAssetTransferId} is null
            and ${table.compensationTransactionId} is not null
            and ${table.compensationTransferId} is null)
          or (${table.repairKind} = 'reverse_asset_transfer'
            and ${table.sourceFinancialTransactionId} is null
            and ${table.sourceAssetTransferId} is not null
            and ${table.compensationTransactionId} is null
            and ${table.compensationTransferId} is not null)
          or (${table.repairKind} = 'reverse_asset_purchase'
            and ${table.sourceFinancialTransactionId} is not null
            and ${table.sourceAssetTransferId} is not null
            and ${table.compensationTransactionId} is not null
            and ${table.compensationTransferId} is not null)`,
    ),
    check(
      'economy_repair_plans_delta_safe',
      sql`jsonb_typeof(${table.canonicalDelta}) = 'object'
          and pg_column_size(${table.canonicalDelta}) <= 32768
          and not worldgraph_jsonb_has_sensitive_key(${table.canonicalDelta})
          and not worldgraph_jsonb_has_compiler_private_key(${table.canonicalDelta})`,
    ),
  ],
);

export const economyRepairApprovals = pgTable(
  'economy_repair_approvals',
  {
    id: uuid('id').primaryKey(),
    repairPlanId: uuid('repair_plan_id').notNull(),
    worldId: uuid('world_id').notNull(),
    authorityKind: economyRepairApprovalAuthority('authority_kind').notNull(),
    approverUserId: uuid('approver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    creatorOverrideId: uuid('creator_override_id').references(() => creatorOverrideRecords.id, {
      onDelete: 'restrict',
    }),
    approvedPlanHash: bytea('approved_plan_hash').notNull(),
    auditRecordId: uuid('audit_record_id').notNull(),
    approvedAt: timestamptz('approved_at').notNull(),
  },
  (table) => [
    uniqueIndex('economy_repair_approvals_plan_authority_unique').on(
      table.repairPlanId,
      table.authorityKind,
    ),
    uniqueIndex('economy_repair_approvals_plan_approver_unique').on(
      table.repairPlanId,
      table.approverUserId,
    ),
    uniqueIndex('economy_repair_approvals_creator_override_unique').on(table.creatorOverrideId),
    uniqueIndex('economy_repair_approvals_audit_record_unique').on(table.auditRecordId),
    foreignKey({
      columns: [table.worldId, table.repairPlanId],
      foreignColumns: [economyRepairPlans.worldId, economyRepairPlans.id],
      name: 'economy_repair_approvals_plan_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.auditRecordId, table.worldId, table.approverUserId],
      foreignColumns: [
        securityAuditRecords.id,
        securityAuditRecords.worldId,
        securityAuditRecords.actorUserId,
      ],
      name: 'economy_repair_approvals_audit_fk',
    }).onDelete('restrict'),
    index('economy_repair_approvals_world_plan_idx').on(
      table.worldId,
      table.repairPlanId,
      table.authorityKind,
    ),
    check(
      'economy_repair_approvals_hash_length',
      sql`octet_length(${table.approvedPlanHash}) = 32`,
    ),
    check(
      'economy_repair_approvals_authority_shape',
      sql`(${table.authorityKind} = 'creator' and ${table.creatorOverrideId} is not null)
          or (${table.authorityKind} = 'platform_admin'
            and ${table.creatorOverrideId} is null)`,
    ),
    check(
      'economy_repair_approvals_timestamp_canonical',
      sql`${table.approvedAt} = date_trunc('milliseconds', ${table.approvedAt})`,
    ),
  ],
);

export const economyRepairExecutions = pgTable(
  'economy_repair_executions',
  {
    id: uuid('id').primaryKey(),
    repairPlanId: uuid('repair_plan_id').notNull(),
    worldId: uuid('world_id').notNull(),
    sourceCommandId: uuid('source_command_id').notNull(),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull(),
    ledgerEntryId: uuid('ledger_entry_id').notNull(),
    financialTransactionId: uuid('financial_transaction_id'),
    assetTransferId: uuid('asset_transfer_id'),
    executedByUserId: uuid('executed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    executionAuditId: uuid('execution_audit_id').notNull(),
    resultingStateRevision: bigint('resulting_state_revision', { mode: 'bigint' }).notNull(),
    resultingEventSequence: bigint('resulting_event_sequence', { mode: 'bigint' }).notNull(),
    resultingLedgerSequence: bigint('resulting_ledger_sequence', { mode: 'bigint' }).notNull(),
    resultingEconomyHeadVersion: bigint('resulting_economy_head_version', {
      mode: 'bigint',
    }).notNull(),
    resultingEconomyChecksum: bytea('resulting_economy_checksum').notNull(),
    executedAt: timestamptz('executed_at').notNull(),
  },
  (table) => [
    uniqueIndex('economy_repair_executions_plan_unique').on(table.repairPlanId),
    uniqueIndex('economy_repair_executions_world_identity').on(table.worldId, table.id),
    uniqueIndex('economy_repair_executions_source_command_unique').on(table.sourceCommandId),
    uniqueIndex('economy_repair_executions_command_unique').on(table.commandId),
    uniqueIndex('economy_repair_executions_event_unique').on(table.eventId),
    uniqueIndex('economy_repair_executions_ledger_entry_unique').on(table.ledgerEntryId),
    uniqueIndex('economy_repair_executions_financial_transaction_unique').on(
      table.financialTransactionId,
    ),
    uniqueIndex('economy_repair_executions_asset_transfer_unique').on(table.assetTransferId),
    uniqueIndex('economy_repair_executions_execution_audit_unique').on(table.executionAuditId),
    foreignKey({
      columns: [table.worldId, table.repairPlanId],
      foreignColumns: [economyRepairPlans.worldId, economyRepairPlans.id],
      name: 'economy_repair_executions_plan_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.sourceCommandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'economy_repair_executions_source_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'economy_repair_executions_command_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.eventId],
      foreignColumns: [domainEvents.worldId, domainEvents.id],
      name: 'economy_repair_executions_event_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.ledgerEntryId],
      foreignColumns: [ledgerEntries.worldId, ledgerEntries.id],
      name: 'economy_repair_executions_ledger_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.financialTransactionId],
      foreignColumns: [financialTransactions.worldId, financialTransactions.id],
      name: 'economy_repair_executions_financial_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.worldId, table.assetTransferId],
      foreignColumns: [assetTransfers.worldId, assetTransfers.id],
      name: 'economy_repair_executions_transfer_world_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.executionAuditId, table.worldId, table.executedByUserId],
      foreignColumns: [
        securityAuditRecords.id,
        securityAuditRecords.worldId,
        securityAuditRecords.actorUserId,
      ],
      name: 'economy_repair_executions_audit_fk',
    }).onDelete('restrict'),
    index('economy_repair_executions_world_cursor_idx').on(
      table.worldId,
      table.executedAt.desc(),
      table.id.desc(),
    ),
    check(
      'economy_repair_executions_sequences_positive',
      sql`${table.resultingStateRevision} > 0
          and ${table.resultingEventSequence} > 0
          and ${table.resultingLedgerSequence} > 0
          and ${table.resultingEconomyHeadVersion} > 0`,
    ),
    check(
      'economy_repair_executions_checksum_length',
      sql`octet_length(${table.resultingEconomyChecksum}) = 32`,
    ),
    check(
      'economy_repair_executions_timestamp_canonical',
      sql`${table.executedAt} = date_trunc('milliseconds', ${table.executedAt})`,
    ),
  ],
);

export const economyCommandWriteSnapshots = pgTable(
  'economy_command_write_snapshots',
  {
    commandId: uuid('command_id').primaryKey(),
    worldId: uuid('world_id').notNull(),
    economyStateExists: boolean('economy_state_exists').notNull(),
    openedHeadRowVersion: bigint('opened_head_row_version', { mode: 'bigint' }),
    openedHeadChecksum: bytea('opened_head_checksum'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'economy_command_write_snapshots_command_world_fk',
    }).onDelete('restrict'),
    check(
      'economy_command_write_snapshots_head_shape',
      sql`(not ${table.economyStateExists}
            and ${table.openedHeadRowVersion} is null
            and ${table.openedHeadChecksum} is null)
          or (${table.economyStateExists}
            and ${table.openedHeadRowVersion} > 0
            and octet_length(${table.openedHeadChecksum}) = 32)`,
    ),
  ],
);

export const economyCommandMutations = pgTable(
  'economy_command_mutations',
  {
    commandId: uuid('command_id').notNull(),
    worldId: uuid('world_id').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    operation: text('operation').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.commandId, table.mutationKind, table.targetId] }),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'economy_command_mutations_command_world_fk',
    }).onDelete('restrict'),
    index('economy_command_mutations_world_command_idx').on(
      table.worldId,
      table.commandId,
      table.mutationKind,
      table.targetId,
    ),
    check(
      'economy_command_mutations_kind_known',
      sql`${table.mutationKind} in (
        'currency','currency_supply','wallet','wallet_balance','asset',
        'asset_ownership','asset_transfer_offer','economy_head'
      )`,
    ),
    check(
      'economy_command_mutations_operation_known',
      sql`${table.operation} in ('insert','update')`,
    ),
  ],
);

// Milestone 9: authoritative closed-loop commerce and its immutable journals.
export const worldEconomyExpansionHeads = pgTable('world_economy_expansion_heads', {
  worldId: uuid('world_id').primaryKey(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  seedPlanHash: bytea('seed_plan_hash').notNull(),
  expansionSchemaVersion: integer('expansion_schema_version').default(1).notNull(),
  projectionSchemaVersion: integer('projection_schema_version').default(1).notNull(),
  checksum: bytea('checksum').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
  initializedCommandId: uuid('initialized_command_id').notNull().unique(),
  initializedEventId: uuid('initialized_event_id').notNull().unique(),
  reconciliationStatus: economyReconciliationStatus('reconciliation_status')
    .default('pending')
    .notNull(),
  lastReconciledStateRevision: bigint('last_reconciled_state_revision', { mode: 'bigint' }),
  lastReconciliationRunId: uuid('last_reconciliation_run_id'),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const resourceTypes = pgTable('resource_types', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  displayName: text('display_name').notNull(),
  unitCode: text('unit_code').notNull(),
  quantityScale: smallint('quantity_scale').notNull(),
  tags: text('tags')
    .array()
    .default(sql`'{}'::text[]`)
    .notNull(),
  primitiveRef: text('primitive_ref').notNull(),
  primitiveKey: citext('primitive_key').notNull(),
  primitiveVersion: text('primitive_version').notNull(),
  primitiveVersionId: uuid('primitive_version_id').notNull(),
  primitiveContentHash: bytea('primitive_content_hash').notNull(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  sourcePlanHash: bytea('source_plan_hash').notNull(),
  resourceSchemaVersion: integer('resource_schema_version').default(1).notNull(),
  status: resourceTypeStatus('status').default('active').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const productionRecipes = pgTable('production_recipes', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  displayName: text('display_name').notNull(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  sourcePlanHash: bytea('source_plan_hash').notNull(),
  recipeSchemaVersion: integer('recipe_schema_version').default(1).notNull(),
  status: resourceTypeStatus('status').default('active').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const productionRecipeVersions = pgTable('production_recipe_versions', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  recipeId: uuid('recipe_id').notNull(),
  version: integer('version').notNull(),
  recipeVersionSchemaVersion: integer('recipe_version_schema_version').default(1).notNull(),
  canonicalSeedInputs: jsonb('canonical_seed_inputs').notNull(),
  canonicalSeedOutputs: jsonb('canonical_seed_outputs').notNull(),
  canonicalInputs: jsonb('canonical_inputs').notNull(),
  canonicalOutputs: jsonb('canonical_outputs').notNull(),
  durationTicks: bigint('duration_ticks', { mode: 'bigint' }).notNull(),
  facilityRequirements: jsonb('facility_requirements')
    .default(sql`'{}'::jsonb`)
    .notNull(),
  primitiveRef: text('primitive_ref').notNull(),
  primitiveKey: citext('primitive_key').notNull(),
  primitiveVersion: text('primitive_version').notNull(),
  primitiveVersionId: uuid('primitive_version_id').notNull(),
  primitiveContentHash: bytea('primitive_content_hash').notNull(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  sourcePlanHash: bytea('source_plan_hash').notNull(),
  checksum: bytea('checksum').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const inventories = pgTable('inventories', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  ownerEntityId: uuid('owner_entity_id').notNull(),
  containerAssetId: uuid('container_asset_id'),
  resourceTypeId: uuid('resource_type_id').notNull(),
  quantity: numeric('quantity', { precision: 30, scale: 12 }).default('0').notNull(),
  reservedQuantity: numeric('reserved_quantity', { precision: 30, scale: 12 })
    .default('0')
    .notNull(),
  inventorySchemaVersion: integer('inventory_schema_version').default(1).notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const inventoryMovements = pgTable('inventory_movements', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  resourceTypeId: uuid('resource_type_id').notNull(),
  fromInventoryId: uuid('from_inventory_id'),
  toInventoryId: uuid('to_inventory_id'),
  quantity: numeric('quantity', { precision: 30, scale: 12 }).notNull(),
  movementKind: inventoryMovementKind('movement_kind').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceOrdinal: integer('source_ordinal').notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  occurredTick: bigint('occurred_tick', { mode: 'bigint' }).notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  displayName: text('display_name').notNull(),
  backingOrganizationEntityId: uuid('backing_organization_entity_id').notNull(),
  walletId: uuid('wallet_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  status: businessStatus('status').default('active').notNull(),
  metadata: jsonb('metadata')
    .default(sql`'{}'::jsonb`)
    .notNull(),
  businessSchemaVersion: integer('business_schema_version').default(1).notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  closedAt: timestamptz('closed_at'),
});

export const businessFacilities = pgTable('business_facilities', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  businessId: uuid('business_id').notNull(),
  facilityAssetId: uuid('facility_asset_id').notNull(),
  facilitySchemaVersion: integer('facility_schema_version').default(1).notNull(),
  status: businessFacilityStatus('status').default('active').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const businessFacilityRecipeVersions = pgTable(
  'business_facility_recipe_versions',
  {
    worldId: uuid('world_id').notNull(),
    facilityId: uuid('facility_id').notNull(),
    recipeVersionId: uuid('recipe_version_id').notNull(),
    configuredCommandId: uuid('configured_command_id').notNull(),
    configuredEventId: uuid('configured_event_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.facilityId, table.recipeVersionId] })],
);

export const productionRuns = pgTable('production_runs', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  businessId: uuid('business_id').notNull(),
  facilityId: uuid('facility_id').notNull(),
  recipeVersionId: uuid('recipe_version_id').notNull(),
  scheduledActionId: uuid('scheduled_action_id').notNull().unique(),
  quantity: numeric('quantity', { precision: 30, scale: 12 }).notNull(),
  status: productionRunStatus('status').notNull(),
  dueTick: bigint('due_tick', { mode: 'bigint' }).notNull(),
  inputSnapshot: jsonb('input_snapshot').notNull(),
  outputSnapshot: jsonb('output_snapshot').notNull(),
  snapshotChecksum: bytea('snapshot_checksum').notNull(),
  failureCode: text('failure_code'),
  productionRunSchemaVersion: integer('production_run_schema_version').default(1).notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  startCommandId: uuid('start_command_id').notNull().unique(),
  startEventId: uuid('start_event_id').notNull().unique(),
  terminalCommandId: uuid('terminal_command_id').unique(),
  terminalEventId: uuid('terminal_event_id').unique(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  terminalStateRevision: bigint('terminal_state_revision', { mode: 'bigint' }),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  completedAt: timestamptz('completed_at'),
});

export const productionRunTransitions = pgTable(
  'production_run_transitions',
  {
    runId: uuid('run_id').notNull(),
    worldId: uuid('world_id').notNull(),
    transitionVersion: bigint('transition_version', { mode: 'bigint' }).notNull(),
    status: productionRunStatus('status').notNull(),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull().unique(),
    occurredTick: bigint('occurred_tick', { mode: 'bigint' }).notNull(),
    stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
    snapshotHash: bytea('snapshot_hash').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.transitionVersion] })],
);

export const employmentOffers = pgTable('employment_offers', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  businessId: uuid('business_id').notNull(),
  roleCode: text('role_code').notNull(),
  wageMinor: bigint('wage_minor', { mode: 'bigint' }).notNull(),
  currencyId: uuid('currency_id').notNull(),
  cadenceTicks: bigint('cadence_ticks', { mode: 'bigint' }).notNull(),
  maxPaymentsPerPeriod: integer('max_payments_per_period').notNull(),
  status: employmentOfferStatus('status').default('open').notNull(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  sourcePlanHash: bytea('source_plan_hash').notNull(),
  employmentOfferSchemaVersion: integer('employment_offer_schema_version').default(1).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  closedAt: timestamptz('closed_at'),
});

export const employmentContracts = pgTable('employment_contracts', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  businessId: uuid('business_id').notNull(),
  sourceOfferId: uuid('source_offer_id'),
  workerEntityId: uuid('worker_entity_id').notNull(),
  employerWalletId: uuid('employer_wallet_id').notNull(),
  workerWalletId: uuid('worker_wallet_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  roleCode: text('role_code').notNull(),
  wageRule: wageRuleKind('wage_rule').notNull(),
  wageMinor: bigint('wage_minor', { mode: 'bigint' }).notNull(),
  cadenceTicks: bigint('cadence_ticks', { mode: 'bigint' }),
  outputRule: jsonb('output_rule'),
  cooldownTicks: bigint('cooldown_ticks', { mode: 'bigint' }).default(0n).notNull(),
  rewardCapMinor: bigint('reward_cap_minor', { mode: 'bigint' }).notNull(),
  maxPaymentsPerPeriod: integer('max_payments_per_period').default(1).notNull(),
  effectiveFromTick: bigint('effective_from_tick', { mode: 'bigint' }).notNull(),
  effectiveUntilTick: bigint('effective_until_tick', { mode: 'bigint' }),
  status: employmentContractStatus('status').default('offered').notNull(),
  exclusiveSlotKey: text('exclusive_slot_key'),
  employmentContractSchemaVersion: integer('employment_contract_schema_version')
    .default(1)
    .notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull().unique(),
  createdEventId: uuid('created_event_id').notNull().unique(),
  acceptedCommandId: uuid('accepted_command_id').unique(),
  acceptedEventId: uuid('accepted_event_id').unique(),
  terminalCommandId: uuid('terminal_command_id').unique(),
  terminalEventId: uuid('terminal_event_id').unique(),
  terminalReason: text('terminal_reason'),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  acceptedStateRevision: bigint('accepted_state_revision', { mode: 'bigint' }),
  terminalStateRevision: bigint('terminal_state_revision', { mode: 'bigint' }),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  endedAt: timestamptz('ended_at'),
});

export const workRecords = pgTable('work_records', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  contractId: uuid('contract_id').notNull(),
  workKey: text('work_key').notNull(),
  performedTick: bigint('performed_tick', { mode: 'bigint' }).notNull(),
  validatedOutput: jsonb('validated_output')
    .default(sql`'{}'::jsonb`)
    .notNull(),
  grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull().unique(),
  eventId: uuid('event_id').notNull().unique(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const payrollRecords = pgTable('payroll_records', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  contractId: uuid('contract_id').notNull(),
  workRecordId: uuid('work_record_id').notNull().unique(),
  scheduledActionId: uuid('scheduled_action_id').notNull().unique(),
  payPeriodKey: text('pay_period_key').notNull(),
  grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
  taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
  netMinor: bigint('net_minor', { mode: 'bigint' }).notNull(),
  taxPolicyId: uuid('tax_policy_id'),
  financialTransactionId: uuid('financial_transaction_id').unique(),
  status: payrollStatus('status').notNull(),
  errorCode: text('error_code'),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull().unique(),
  createdEventId: uuid('created_event_id').notNull().unique(),
  terminalCommandId: uuid('terminal_command_id').unique(),
  terminalEventId: uuid('terminal_event_id').unique(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  terminalStateRevision: bigint('terminal_state_revision', { mode: 'bigint' }),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  terminalAt: timestamptz('terminal_at'),
});

export const taxPolicies = pgTable('tax_policies', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  policyVersion: integer('policy_version').notNull(),
  authorityEntityId: uuid('authority_entity_id').notNull(),
  treasuryWalletId: uuid('treasury_wallet_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  taxType: taxPolicyType('tax_type').notNull(),
  collectionMode: taxCollectionMode('collection_mode').notNull(),
  roundingMode: text('rounding_mode').default('floor').notNull(),
  rateBasisPoints: integer('rate_basis_points'),
  fixedAmountMinor: bigint('fixed_amount_minor', { mode: 'bigint' }),
  applicability: jsonb('applicability')
    .default(sql`'{}'::jsonb`)
    .notNull(),
  effectiveFromTick: bigint('effective_from_tick', { mode: 'bigint' }).notNull(),
  effectiveUntilTick: bigint('effective_until_tick', { mode: 'bigint' }),
  primitiveRef: text('primitive_ref').notNull(),
  primitiveKey: citext('primitive_key').notNull(),
  primitiveVersion: text('primitive_version').notNull(),
  primitiveVersionId: uuid('primitive_version_id').notNull(),
  primitiveContentHash: bytea('primitive_content_hash').notNull(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  sourcePlanHash: bytea('source_plan_hash').notNull(),
  status: taxPolicyStatus('status').default('active').notNull(),
  calculationVersion: integer('calculation_version').default(1).notNull(),
  taxPolicySchemaVersion: integer('tax_policy_schema_version').default(1).notNull(),
  checksum: bytea('checksum').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const marketListings = pgTable('market_listings', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  sellerEntityId: uuid('seller_entity_id').notNull(),
  sellerInventoryId: uuid('seller_inventory_id').notNull(),
  resourceTypeId: uuid('resource_type_id').notNull(),
  sellerWalletId: uuid('seller_wallet_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  scheduledActionId: uuid('scheduled_action_id').notNull().unique(),
  offeredQuantity: numeric('offered_quantity', { precision: 30, scale: 12 }).notNull(),
  remainingQuantity: numeric('remaining_quantity', { precision: 30, scale: 12 }).notNull(),
  reservedQuantity: numeric('reserved_quantity', { precision: 30, scale: 12 }).notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
  status: marketListingStatus('status').default('open').notNull(),
  expiresAtTick: bigint('expires_at_tick', { mode: 'bigint' }).notNull(),
  marketListingSchemaVersion: integer('market_listing_schema_version').default(1).notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull().unique(),
  createdEventId: uuid('created_event_id').notNull().unique(),
  terminalCommandId: uuid('terminal_command_id').unique(),
  terminalEventId: uuid('terminal_event_id').unique(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  terminalStateRevision: bigint('terminal_state_revision', { mode: 'bigint' }),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  terminalAt: timestamptz('terminal_at'),
});

export const inventoryReservations = pgTable('inventory_reservations', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  inventoryId: uuid('inventory_id').notNull(),
  purposeType: inventoryReservationPurpose('purpose_type').notNull(),
  purposeId: uuid('purpose_id').notNull(),
  quantity: numeric('quantity', { precision: 30, scale: 12 }).notNull(),
  status: inventoryReservationStatus('status').default('active').notNull(),
  expiresAtTick: bigint('expires_at_tick', { mode: 'bigint' }),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  terminalCommandId: uuid('terminal_command_id'),
  terminalEventId: uuid('terminal_event_id'),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  terminalStateRevision: bigint('terminal_state_revision', { mode: 'bigint' }),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  terminalAt: timestamptz('terminal_at'),
});

export const marketTrades = pgTable('market_trades', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  listingId: uuid('listing_id').notNull(),
  buyerEntityId: uuid('buyer_entity_id').notNull(),
  sellerEntityId: uuid('seller_entity_id').notNull(),
  buyerInventoryId: uuid('buyer_inventory_id').notNull(),
  sellerInventoryId: uuid('seller_inventory_id').notNull(),
  quantity: numeric('quantity', { precision: 30, scale: 12 }).notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
  grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
  buyerTotalMinor: bigint('buyer_total_minor', { mode: 'bigint' }).notNull(),
  sellerNetMinor: bigint('seller_net_minor', { mode: 'bigint' }).notNull(),
  taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
  feeMinor: bigint('fee_minor', { mode: 'bigint' }).notNull(),
  currencyId: uuid('currency_id').notNull(),
  walletTransactionId: uuid('wallet_transaction_id').notNull().unique(),
  occurredTick: bigint('occurred_tick', { mode: 'bigint' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  commandId: uuid('command_id').notNull().unique(),
  eventId: uuid('event_id').notNull().unique(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  roundingPolicyVersion: integer('rounding_policy_version').default(1).notNull(),
  marketTradeSchemaVersion: integer('market_trade_schema_version').default(1).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const taxAssessments = pgTable(
  'tax_assessments',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id').notNull(),
    policyId: uuid('policy_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    payerEntityId: uuid('payer_entity_id').notNull(),
    payerWalletId: uuid('payer_wallet_id').notNull(),
    treasuryWalletId: uuid('treasury_wallet_id').notNull(),
    currencyId: uuid('currency_id').notNull(),
    basisMinor: bigint('basis_minor', { mode: 'bigint' }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    settlementTransactionId: uuid('settlement_transaction_id').notNull(),
    occurredTick: bigint('occurred_tick', { mode: 'bigint' }).notNull(),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull().unique(),
    stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
    taxAssessmentSchemaVersion: integer('tax_assessment_schema_version').default(1).notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('tax_assessments_world_cursor_idx').on(
      table.worldId,
      table.occurredTick.desc(),
      table.id.desc(),
    ),
  ],
);

export const payrollPolicySelectionFacts = pgTable('payroll_policy_selection_facts', {
  payrollRecordId: uuid('payroll_record_id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  workRecordId: uuid('work_record_id').notNull().unique(),
  taxPolicyId: uuid('tax_policy_id'),
  grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
  taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
  netMinor: bigint('net_minor', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull().unique(),
  eventId: uuid('event_id').notNull().unique(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  evidenceChecksum: bytea('evidence_checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const commerceCommandPayloadFacts = pgTable('commerce_command_payload_facts', {
  commandId: uuid('command_id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  commandType: text('command_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  authority: jsonb('authority').$type<Record<string, unknown>>().notNull(),
  evidenceSource: text('evidence_source').notNull(),
  payloadHash: bytea('payload_hash').notNull(),
  authorityHash: bytea('authority_hash').notNull(),
  evidenceChecksum: bytea('evidence_checksum').notNull(),
  boundaryEventSequence: bigint('boundary_event_sequence', { mode: 'bigint' }).notNull(),
  boundaryHeadChecksum: bytea('boundary_head_checksum').notNull(),
  boundaryCheckpointChecksum: bytea('boundary_checkpoint_checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const economyExpansionReconciliationRuns = pgTable('economy_expansion_reconciliation_runs', {
  id: uuid('id').primaryKey(),
  worldId: uuid('world_id').notNull(),
  reconciliationSchemaVersion: integer('reconciliation_schema_version').default(3).notNull(),
  sourceStateRevision: bigint('source_state_revision', { mode: 'bigint' }).notNull(),
  sourceEventSequence: bigint('source_event_sequence', { mode: 'bigint' }).notNull(),
  status: economyReconciliationRunStatus('status').notNull(),
  liveInventoryChecksum: bytea('live_inventory_checksum').notNull(),
  rebuiltInventoryChecksum: bytea('rebuilt_inventory_checksum').notNull(),
  liveReservationChecksum: bytea('live_reservation_checksum').notNull(),
  rebuiltReservationChecksum: bytea('rebuilt_reservation_checksum').notNull(),
  liveTradeChecksum: bytea('live_trade_checksum').notNull(),
  rebuiltTradeChecksum: bytea('rebuilt_trade_checksum').notNull(),
  livePayrollChecksum: bytea('live_payroll_checksum').notNull(),
  rebuiltPayrollChecksum: bytea('rebuilt_payroll_checksum').notNull(),
  liveTaxChecksum: bytea('live_tax_checksum').notNull(),
  rebuiltTaxChecksum: bytea('rebuilt_tax_checksum').notNull(),
  liveProjectionChecksum: bytea('live_projection_checksum').notNull(),
  rebuiltJournalChecksum: bytea('rebuilt_journal_checksum').notNull(),
  resourceCount: integer('resource_count').notNull(),
  inventoryCount: integer('inventory_count').notNull(),
  tradeCount: integer('trade_count').notNull(),
  assessmentCount: integer('assessment_count').notNull(),
  mismatchCount: integer('mismatch_count').notNull(),
  commandId: uuid('command_id').notNull().unique(),
  eventId: uuid('event_id').notNull().unique(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const economyExpansionReconciliationItems = pgTable(
  'economy_expansion_reconciliation_items',
  {
    runId: uuid('run_id').notNull(),
    itemOrdinal: integer('item_ordinal').notNull(),
    itemKind: text('item_kind').notNull(),
    itemKey: text('item_key').notNull(),
    itemKeyHash: bytea('item_key_hash').notNull(),
    expectedValue: text('expected_value'),
    actualValue: text('actual_value'),
    mismatchCode: text('mismatch_code').notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.itemOrdinal] })],
);

export const economyExpansionCommandWriteSnapshots = pgTable(
  'economy_expansion_command_write_snapshots',
  {
    commandId: uuid('command_id').primaryKey(),
    worldId: uuid('world_id').notNull(),
    expansionStateExists: boolean('expansion_state_exists').notNull(),
    openedHeadRowVersion: bigint('opened_head_row_version', { mode: 'bigint' }),
    openedHeadChecksum: bytea('opened_head_checksum'),
    openedCheckpointEventSequence: bigint('opened_checkpoint_event_sequence', {
      mode: 'bigint',
    }),
    openedCheckpointChecksum: bytea('opened_checkpoint_checksum'),
    openedCheckpointStatus: projectionCheckpointStatus('opened_checkpoint_status'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
);

export const commerceProjectionRepairPlans = pgTable(
  'commerce_projection_repair_plans',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id').notNull(),
    repairPlanSchemaVersion: integer('repair_plan_schema_version').default(1).notNull(),
    reservedCommandId: uuid('reserved_command_id').notNull().unique(),
    reservedEventId: uuid('reserved_event_id').notNull().unique(),
    reservedLedgerEntryId: uuid('reserved_ledger_entry_id').notNull().unique(),
    sourceWorldVersion: bigint('source_world_version', { mode: 'bigint' }).notNull(),
    sourceStateRevision: bigint('source_state_revision', { mode: 'bigint' }).notNull(),
    sourceEventSequence: bigint('source_event_sequence', { mode: 'bigint' }).notNull(),
    sourceLedgerSequence: bigint('source_ledger_sequence', { mode: 'bigint' }).notNull(),
    sourceEconomyHeadVersion: bigint('source_economy_head_version', {
      mode: 'bigint',
    }).notNull(),
    sourceEconomyChecksum: bytea('source_economy_checksum').notNull(),
    sourceExpansionHeadVersion: bigint('source_expansion_head_version', {
      mode: 'bigint',
    }).notNull(),
    sourceExpansionChecksum: bytea('source_expansion_checksum').notNull(),
    sourceReconciliationRunId: uuid('source_reconciliation_run_id').notNull(),
    sourceReconciliationLiveChecksum: bytea('source_reconciliation_live_checksum').notNull(),
    sourceReconciliationRebuiltChecksum: bytea('source_reconciliation_rebuilt_checksum').notNull(),
    reason: text('reason').notNull(),
    preparedByUserId: uuid('prepared_by_user_id').notNull(),
    preparationAuditId: uuid('preparation_audit_id').notNull().unique(),
    planHash: bytea('plan_hash').notNull().unique(),
    preparedAt: timestamptz('prepared_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    unique('commerce_projection_repair_plans_world_identity').on(table.worldId, table.id),
    index('commerce_projection_repair_plans_world_prepared_idx').on(
      table.worldId,
      table.preparedAt,
      table.id,
    ),
    index('commerce_projection_repair_plans_expiry_idx').on(
      table.expiresAt,
      table.worldId,
      table.id,
    ),
  ],
);

export const commerceProjectionRepairPlanItems = pgTable(
  'commerce_projection_repair_plan_items',
  {
    repairPlanId: uuid('repair_plan_id').notNull(),
    worldId: uuid('world_id').notNull(),
    itemOrdinal: integer('item_ordinal').notNull(),
    inventoryId: uuid('inventory_id').notNull(),
    repairFactId: uuid('repair_fact_id').notNull().unique(),
    expectedRowVersion: bigint('expected_row_version', { mode: 'bigint' }).notNull(),
    actualQuantity: numeric('actual_quantity', { precision: 30, scale: 12 }).notNull(),
    actualReservedQuantity: numeric('actual_reserved_quantity', {
      precision: 30,
      scale: 12,
    }).notNull(),
    repairedQuantity: numeric('repaired_quantity', { precision: 30, scale: 12 }).notNull(),
    repairedReservedQuantity: numeric('repaired_reserved_quantity', {
      precision: 30,
      scale: 12,
    }).notNull(),
    mismatchKinds: text('mismatch_kinds').array().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repairPlanId, table.itemOrdinal] }),
    unique('commerce_projection_repair_plan_items_inventory_unique').on(
      table.repairPlanId,
      table.inventoryId,
    ),
    index('commerce_projection_repair_plan_items_inventory_idx').on(
      table.worldId,
      table.inventoryId,
      table.repairPlanId,
    ),
  ],
);

export const commerceProjectionRepairApprovals = pgTable('commerce_projection_repair_approvals', {
  id: uuid('id').primaryKey(),
  repairPlanId: uuid('repair_plan_id').notNull().unique(),
  worldId: uuid('world_id').notNull(),
  approverUserId: uuid('approver_user_id').notNull(),
  approvedPlanHash: bytea('approved_plan_hash').notNull(),
  overrideId: uuid('override_id').notNull().unique(),
  auditRecordId: uuid('audit_record_id').notNull().unique(),
  approvedAt: timestamptz('approved_at').notNull(),
});

export const commerceProjectionRepairFacts = pgTable(
  'commerce_projection_repair_facts',
  {
    id: uuid('id').primaryKey(),
    repairPlanId: uuid('repair_plan_id').notNull(),
    worldId: uuid('world_id').notNull(),
    itemOrdinal: integer('item_ordinal').notNull(),
    inventoryId: uuid('inventory_id').notNull(),
    actualQuantity: numeric('actual_quantity', { precision: 30, scale: 12 }).notNull(),
    actualReservedQuantity: numeric('actual_reserved_quantity', {
      precision: 30,
      scale: 12,
    }).notNull(),
    repairedQuantity: numeric('repaired_quantity', { precision: 30, scale: 12 }).notNull(),
    repairedReservedQuantity: numeric('repaired_reserved_quantity', {
      precision: 30,
      scale: 12,
    }).notNull(),
    mismatchKinds: text('mismatch_kinds').array().notNull(),
    sourceReconciliationRunId: uuid('source_reconciliation_run_id').notNull(),
    commandId: uuid('command_id').notNull(),
    eventId: uuid('event_id').notNull(),
    resultingStateRevision: bigint('resulting_state_revision', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('commerce_projection_repair_facts_plan_item_unique').on(
      table.repairPlanId,
      table.itemOrdinal,
    ),
    unique('commerce_projection_repair_facts_inventory_unique').on(
      table.repairPlanId,
      table.inventoryId,
    ),
  ],
);

export const commerceProjectionRepairExecutions = pgTable('commerce_projection_repair_executions', {
  id: uuid('id').primaryKey(),
  repairPlanId: uuid('repair_plan_id').notNull().unique(),
  worldId: uuid('world_id').notNull(),
  approvalId: uuid('approval_id').notNull().unique(),
  commandId: uuid('command_id').notNull().unique(),
  eventId: uuid('event_id').notNull().unique(),
  ledgerEntryId: uuid('ledger_entry_id').notNull().unique(),
  reconciliationRunId: uuid('reconciliation_run_id').notNull().unique(),
  executedByUserId: uuid('executed_by_user_id').notNull(),
  executionAuditId: uuid('execution_audit_id').notNull().unique(),
  repairFactCount: integer('repair_fact_count').notNull(),
  resultingStateRevision: bigint('resulting_state_revision', { mode: 'bigint' }).notNull(),
  resultingEventSequence: bigint('resulting_event_sequence', { mode: 'bigint' }).notNull(),
  resultingLedgerSequence: bigint('resulting_ledger_sequence', { mode: 'bigint' }).notNull(),
  resultingExpansionHeadVersion: bigint('resulting_expansion_head_version', {
    mode: 'bigint',
  }).notNull(),
  resultingChecksum: bytea('resulting_checksum').notNull(),
  executedAt: timestamptz('executed_at').notNull(),
});

export const compiledGovernanceSeedPlans = pgTable('compiled_governance_seed_plans', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  worldVersionId: uuid('world_version_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceCompilerVersion: text('source_compiler_version').notNull(),
  sourceArtifactHash: bytea('source_artifact_hash').notNull(),
  governanceSeedPlanSchemaVersion: integer('governance_seed_plan_schema_version')
    .default(1)
    .notNull(),
  canonicalPlan: jsonb('canonical_plan').notNull(),
  planHash: bytea('plan_hash').notNull(),
  adoptedCommandId: uuid('adopted_command_id'),
  adoptedEventId: uuid('adopted_event_id'),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const worldGovernanceHeads = pgTable('world_governance_heads', {
  worldId: uuid('world_id').primaryKey().notNull(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  seedPlanHash: bytea('seed_plan_hash').notNull(),
  governanceSchemaVersion: integer('governance_schema_version').default(1).notNull(),
  projectionSchemaVersion: integer('projection_schema_version').default(1).notNull(),
  checksum: bytea('checksum').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
  initializedCommandId: uuid('initialized_command_id').notNull(),
  initializedEventId: uuid('initialized_event_id').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const governingCharters = pgTable('governing_charters', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  jurisdictionEntityId: uuid('jurisdiction_entity_id').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const governingCharterVersions = pgTable('governing_charter_versions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  charterId: uuid('charter_id').notNull(),
  charterVersion: integer('charter_version').notNull(),
  sourceWorldVersionId: uuid('source_world_version_id').notNull(),
  seedPlanHash: bytea('seed_plan_hash').notNull(),
  policyDslVersion: integer('policy_dsl_version').default(1).notNull(),
  canonicalPolicyDocument: jsonb('canonical_policy_document').notNull(),
  checksum: bytea('checksum').notNull(),
  effectiveFromTick: bigint('effective_from_tick', { mode: 'bigint' }).notNull(),
  declaredUntilTick: bigint('declared_until_tick', { mode: 'bigint' }),
  provenance: jsonb().default({}).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const charterAuthorityIntervals = pgTable('charter_authority_intervals', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  charterId: uuid('charter_id').notNull(),
  charterVersionId: uuid('charter_version_id').notNull(),
  effectiveTicks: int8range('effective_ticks').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  updatedCommandId: uuid('updated_command_id').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const institutions = pgTable('institutions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  entityId: uuid('entity_id').notNull(),
  charterVersionId: uuid('charter_version_id').notNull(),
  jurisdictionEntityId: uuid('jurisdiction_entity_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  institutionType: text('institution_type').notNull(),
  status: text().default('active').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const institutionPowers = pgTable('institution_powers', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  institutionId: uuid('institution_id').notNull(),
  charterVersionId: uuid('charter_version_id').notNull(),
  powerKey: text('power_key').notNull(),
  actionCode: text('action_code').notNull(),
  resourceType: text('resource_type').notNull(),
  scopePolicy: jsonb('scope_policy').notNull(),
  policyDslVersion: integer('policy_dsl_version').default(1).notNull(),
  checksum: bytea('checksum').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const laws = pgTable('laws', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  jurisdictionEntityId: uuid('jurisdiction_entity_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  title: text().notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const lawVersions = pgTable('law_versions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  lawId: uuid('law_id').notNull(),
  lawVersion: integer('law_version').notNull(),
  versionKind: text('version_kind').notNull(),
  initialStatus: text('initial_status').default('scheduled').notNull(),
  title: text().notNull(),
  summary: text().notNull(),
  policyAst: jsonb('policy_ast').notNull(),
  actionEffects: jsonb('action_effects').notNull(),
  policyDslVersion: integer('policy_dsl_version').default(1).notNull(),
  supersedesVersionId: uuid('supersedes_version_id'),
  sourceProposalResultId: uuid('source_proposal_result_id'),
  sourceActionOrdinal: integer('source_action_ordinal'),
  effectiveFromTick: bigint('effective_from_tick', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const lawEffectivityTransitions = pgTable('law_effectivity_transitions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  lawId: uuid('law_id').notNull(),
  lawVersionId: uuid('law_version_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  effectiveTick: bigint('effective_tick', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const lawAuthorityIntervals = pgTable('law_authority_intervals', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  lawId: uuid('law_id').notNull(),
  lawVersionId: uuid('law_version_id').notNull(),
  effectiveTicks: int8range('effective_ticks').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  updatedCommandId: uuid('updated_command_id').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const politicalOffices = pgTable('political_offices', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  institutionId: uuid('institution_id').notNull(),
  charterVersionId: uuid('charter_version_id').notNull(),
  stableKey: citext('stable_key').notNull(),
  title: text().notNull(),
  selectionMethod: text('selection_method').notNull(),
  seatCount: integer('seat_count').notNull(),
  termTicks: bigint('term_ticks', { mode: 'bigint' }).notNull(),
  eligibilityPolicy: jsonb('eligibility_policy').notNull(),
  tiePolicy: text('tie_policy').notNull(),
  vacancyPolicy: text('vacancy_policy').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const politicalOfficeSeats = pgTable('political_office_seats', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  officeId: uuid('office_id').notNull(),
  seatOrdinal: integer('seat_ordinal').notNull(),
  stableKey: citext('stable_key').notNull(),
  status: text().default('active').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const officePowers = pgTable(
  'office_powers',
  {
    id: uuid().primaryKey().notNull(),
    worldId: uuid('world_id').notNull(),
    officeId: uuid('office_id').notNull(),
    charterVersionId: uuid('charter_version_id').notNull(),
    powerKey: text('power_key').notNull(),
    actionCode: text('action_code').notNull(),
    resourceType: text('resource_type').notNull(),
    scopePolicy: jsonb('scope_policy').notNull(),
    policyDslVersion: integer('policy_dsl_version').default(1).notNull(),
    checksum: bytea('checksum').notNull(),
    createdCommandId: uuid('created_command_id').notNull(),
    createdEventId: uuid('created_event_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('office_powers_world_charter_identity').on(
      table.worldId,
      table.id,
      table.charterVersionId,
    ),
  ],
);

export const officePowerDelegations = pgTable('office_power_delegations', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  officePowerId: uuid('office_power_id').notNull(),
  charterVersionId: uuid('charter_version_id').notNull(),
  granteeOrganizationEntityId: uuid('grantee_organization_entity_id').notNull(),
  delegationKey: text('delegation_key').notNull(),
  checksum: bytea('checksum').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const proposals = pgTable('proposals', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  institutionId: uuid('institution_id').notNull(),
  jurisdictionEntityId: uuid('jurisdiction_entity_id').notNull(),
  proposerEntityId: uuid('proposer_entity_id').notNull(),
  proposalType: text('proposal_type').notNull(),
  proposalSchemaVersion: integer('proposal_schema_version').default(1).notNull(),
  title: text().notNull(),
  body: text().notNull(),
  status: text().default('draft').notNull(),
  sponsorshipClosesTick: bigint('sponsorship_closes_tick', { mode: 'bigint' }).notNull(),
  debateClosesTick: bigint('debate_closes_tick', { mode: 'bigint' }).notNull(),
  votingOpensTick: bigint('voting_opens_tick', { mode: 'bigint' }).notNull(),
  votingClosesTick: bigint('voting_closes_tick', { mode: 'bigint' }).notNull(),
  minimumSponsors: integer('minimum_sponsors').notNull(),
  quorumNumerator: integer('quorum_numerator').notNull(),
  quorumDenominator: integer('quorum_denominator').notNull(),
  thresholdNumerator: integer('threshold_numerator').notNull(),
  thresholdDenominator: integer('threshold_denominator').notNull(),
  ballotMode: text('ballot_mode').notNull(),
  ballotDisclosure: text('ballot_disclosure').notNull(),
  allowBallotReplacement: boolean('allow_ballot_replacement').default(false).notNull(),
  targetVersions: jsonb('target_versions').default({}).notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const proposalActions = pgTable('proposal_actions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  actionOrdinal: integer('action_ordinal').notNull(),
  actionKind: text('action_kind').notNull(),
  actionSchemaVersion: integer('action_schema_version').default(1).notNull(),
  targetKind: text('target_kind'),
  targetId: uuid('target_id'),
  expectedTargetVersion: bigint('expected_target_version', { mode: 'bigint' }),
  actionPayload: jsonb('action_payload').notNull(),
  provenance: jsonb().default({}).notNull(),
  checksum: bytea('checksum').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const proposalSponsors = pgTable('proposal_sponsors', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  sponsorEntityId: uuid('sponsor_entity_id').notNull(),
  sponsoredTick: bigint('sponsored_tick', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const proposalTransitions = pgTable('proposal_transitions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  effectiveTick: bigint('effective_tick', { mode: 'bigint' }).notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).notNull(),
  reasonCode: text('reason_code').notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const elections = pgTable('elections', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  institutionId: uuid('institution_id').notNull(),
  officeId: uuid('office_id').notNull(),
  seatId: uuid('seat_id').notNull(),
  electionKind: text('election_kind').notNull(),
  status: text().default('nominations_scheduled').notNull(),
  nominationOpensTick: bigint('nomination_opens_tick', { mode: 'bigint' }).notNull(),
  nominationClosesTick: bigint('nomination_closes_tick', { mode: 'bigint' }).notNull(),
  votingOpensTick: bigint('voting_opens_tick', { mode: 'bigint' }).notNull(),
  votingClosesTick: bigint('voting_closes_tick', { mode: 'bigint' }).notNull(),
  certificationTick: bigint('certification_tick', { mode: 'bigint' }).notNull(),
  termStartsTick: bigint('term_starts_tick', { mode: 'bigint' }).notNull(),
  quorumNumerator: integer('quorum_numerator').notNull(),
  quorumDenominator: integer('quorum_denominator').notNull(),
  tieRule: text('tie_rule').notNull(),
  ballotMode: text('ballot_mode').notNull(),
  ballotDisclosure: text('ballot_disclosure').notNull(),
  allowBallotReplacement: boolean('allow_ballot_replacement').default(false).notNull(),
  electionRuleSnapshot: jsonb('election_rule_snapshot').notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const governanceContests = pgTable('governance_contests', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestKind: text('contest_kind').notNull(),
  ballotMode: text('ballot_mode').notNull(),
  ballotDisclosure: text('ballot_disclosure').notNull(),
  status: text().default('scheduled').notNull(),
  opensTick: bigint('opens_tick', { mode: 'bigint' }).notNull(),
  closesTick: bigint('closes_tick', { mode: 'bigint' }).notNull(),
  allowReplacement: boolean('allow_replacement').default(false).notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).default(1n).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const proposalContests = pgTable('proposal_contests', {
  contestId: uuid('contest_id').primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  question: text().notNull(),
});

export const electionContests = pgTable('election_contests', {
  contestId: uuid('contest_id').primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  electionId: uuid('election_id').notNull(),
  officeId: uuid('office_id').notNull(),
  seatId: uuid('seat_id').notNull(),
  contestOrdinal: integer('contest_ordinal').notNull(),
  seatsToFill: integer('seats_to_fill').default(1).notNull(),
});

export const candidacies = pgTable('candidacies', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  electionId: uuid('election_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  candidateEntityId: uuid('candidate_entity_id').notNull(),
  status: text().default('nominated').notNull(),
  nominationTick: bigint('nomination_tick', { mode: 'bigint' }).notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).default(1n).notNull(),
  nominatedCommandId: uuid('nominated_command_id').notNull(),
  nominatedEventId: uuid('nominated_event_id').notNull(),
  acceptedCommandId: uuid('accepted_command_id'),
  acceptedEventId: uuid('accepted_event_id'),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const candidacyTransitions = pgTable('candidacy_transitions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  candidacyId: uuid('candidacy_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  effectiveTick: bigint('effective_tick', { mode: 'bigint' }).notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const eligibilitySnapshots = pgTable('eligibility_snapshots', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  ruleSchemaVersion: integer('rule_schema_version').default(1).notNull(),
  policyDslVersion: integer('policy_dsl_version').default(1).notNull(),
  snapshotTick: bigint('snapshot_tick', { mode: 'bigint' }).notNull(),
  sourceStateRevision: bigint('source_state_revision', { mode: 'bigint' }).notNull(),
  sourceMembershipCursor: bigint('source_membership_cursor', { mode: 'bigint' }).notNull(),
  eligibleCount: integer('eligible_count').notNull(),
  ruleSnapshot: jsonb('rule_snapshot').notNull(),
  checksum: bytea('checksum').notNull(),
  generatedCommandId: uuid('generated_command_id').notNull(),
  generatedEventId: uuid('generated_event_id').notNull(),
  generatedAt: timestamptz('generated_at').defaultNow().notNull(),
});

export const eligibilitySnapshotMembers = pgTable('eligibility_snapshot_members', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  snapshotId: uuid('snapshot_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  voterEntityId: uuid('voter_entity_id').notNull(),
  votingWeight: integer('voting_weight').default(1).notNull(),
  eligibilityBasis: jsonb('eligibility_basis').notNull(),
  memberHash: bytea('member_hash').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const ballotParticipation = pgTable('ballot_participation', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  eligibilitySnapshotId: uuid('eligibility_snapshot_id').notNull(),
  voterEntityId: uuid('voter_entity_id').notNull(),
  ballotMode: text('ballot_mode').notNull(),
  currentRevision: integer('current_revision').notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'bigint' }).notNull(),
  firstCastTick: bigint('first_cast_tick', { mode: 'bigint' }).notNull(),
  lastCastTick: bigint('last_cast_tick', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const ballotReceipts = pgTable('ballot_receipts', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  participationId: uuid('participation_id').notNull(),
  revision: integer().notNull(),
  receiptHash: bytea('receipt_hash').notNull(),
  choiceHash: bytea('choice_hash').notNull(),
  castTick: bigint('cast_tick', { mode: 'bigint' }).notNull(),
  issuedAt: timestamptz('issued_at').defaultNow().notNull(),
});

export const ballotChoiceRevisions = pgTable('ballot_choice_revisions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  participationId: uuid('participation_id').notNull(),
  receiptId: uuid('receipt_id').notNull(),
  revision: integer().notNull(),
  storageMode: text('storage_mode').notNull(),
  choiceSchemaVersion: integer('choice_schema_version').default(1).notNull(),
  choiceHash: bytea('choice_hash').notNull(),
  replacesRevisionId: uuid('replaces_revision_id'),
  castCommandId: uuid('cast_command_id').notNull(),
  castEventId: uuid('cast_event_id').notNull(),
  castStateRevision: bigint('cast_state_revision', { mode: 'bigint' }).notNull(),
  castTick: bigint('cast_tick', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const ballotEffectiveRevisions = pgTable('ballot_effective_revisions', {
  participationId: uuid('participation_id').primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  choiceRevisionId: uuid('choice_revision_id').notNull(),
  effectiveRevision: integer('effective_revision').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).notNull(),
  updatedCommandId: uuid('updated_command_id').notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const publicBallotChoices = pgTable('public_ballot_choices', {
  choiceRevisionId: uuid('choice_revision_id').primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  participationId: uuid('participation_id').notNull(),
  voterEntityId: uuid('voter_entity_id').notNull(),
  choicePayload: jsonb('choice_payload').notNull(),
  choiceHash: bytea('choice_hash').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const secretBallotChoices = pgTable('secret_ballot_choices', {
  choiceRevisionId: uuid('choice_revision_id').primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  participationId: uuid('participation_id').notNull(),
  choicePayload: jsonb('choice_payload').notNull(),
  choiceHash: bytea('choice_hash').notNull(),
  linkageNonceHash: bytea('linkage_nonce_hash').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const proposalTallies = pgTable('proposal_tallies', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  eligibilitySnapshotId: uuid('eligibility_snapshot_id').notNull(),
  tallyVersion: integer('tally_version').notNull(),
  algorithmVersion: text('algorithm_version').notNull(),
  eligibleCount: integer('eligible_count').notNull(),
  participatingCount: integer('participating_count').notNull(),
  quorumRequired: integer('quorum_required').notNull(),
  approvalRequired: integer('approval_required').notNull(),
  inputChecksum: bytea('input_checksum').notNull(),
  outputChecksum: bytea('output_checksum').notNull(),
  recountOfTallyId: uuid('recount_of_tally_id'),
  talliedTick: bigint('tallied_tick', { mode: 'bigint' }).notNull(),
  talliedAt: timestamptz('tallied_at').defaultNow().notNull(),
});

export const proposalTallyCounts = pgTable('proposal_tally_counts', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  tallyId: uuid('tally_id').notNull(),
  choiceCode: text('choice_code').notNull(),
  ballotCount: integer('ballot_count').notNull(),
  weightedCount: bigint('weighted_count', { mode: 'bigint' }).notNull(),
});

export const proposalResults = pgTable('proposal_results', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  tallyId: uuid('tally_id').notNull(),
  outcome: text().notNull(),
  quorumMet: boolean('quorum_met').notNull(),
  thresholdMet: boolean('threshold_met').notNull(),
  resultSchemaVersion: integer('result_schema_version').default(1).notNull(),
  resultChecksum: bytea('result_checksum').notNull(),
  certifiedCommandId: uuid('certified_command_id').notNull(),
  certifiedEventId: uuid('certified_event_id').notNull(),
  certifiedStateRevision: bigint('certified_state_revision', { mode: 'bigint' }).notNull(),
  certifiedTick: bigint('certified_tick', { mode: 'bigint' }).notNull(),
  repairOfResultId: uuid('repair_of_result_id'),
  certifiedAt: timestamptz('certified_at').defaultNow().notNull(),
});

export const electionTallies = pgTable('election_tallies', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  electionId: uuid('election_id').notNull(),
  eligibilitySnapshotId: uuid('eligibility_snapshot_id').notNull(),
  tallyVersion: integer('tally_version').notNull(),
  algorithmVersion: text('algorithm_version').notNull(),
  eligibleCount: integer('eligible_count').notNull(),
  participatingCount: integer('participating_count').notNull(),
  inputChecksum: bytea('input_checksum').notNull(),
  outputChecksum: bytea('output_checksum').notNull(),
  recountOfTallyId: uuid('recount_of_tally_id'),
  talliedTick: bigint('tallied_tick', { mode: 'bigint' }).notNull(),
  talliedAt: timestamptz('tallied_at').defaultNow().notNull(),
});

export const electionTallyCounts = pgTable('election_tally_counts', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  tallyId: uuid('tally_id').notNull(),
  candidacyId: uuid('candidacy_id'),
  countKind: text('count_kind').notNull(),
  ballotCount: integer('ballot_count').notNull(),
  weightedCount: bigint('weighted_count', { mode: 'bigint' }).notNull(),
});

export const electionResults = pgTable('election_results', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  contestId: uuid('contest_id').notNull(),
  electionId: uuid('election_id').notNull(),
  tallyId: uuid('tally_id').notNull(),
  outcome: text().notNull(),
  winningCandidacyId: uuid('winning_candidacy_id'),
  resultSchemaVersion: integer('result_schema_version').default(1).notNull(),
  resultChecksum: bytea('result_checksum').notNull(),
  certifiedCommandId: uuid('certified_command_id').notNull(),
  certifiedEventId: uuid('certified_event_id').notNull(),
  certifiedStateRevision: bigint('certified_state_revision', { mode: 'bigint' }).notNull(),
  certifiedTick: bigint('certified_tick', { mode: 'bigint' }).notNull(),
  repairOfResultId: uuid('repair_of_result_id'),
  certifiedAt: timestamptz('certified_at').defaultNow().notNull(),
});

export const officeTerms = pgTable('office_terms', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  officeId: uuid('office_id').notNull(),
  seatId: uuid('seat_id').notNull(),
  holderEntityId: uuid('holder_entity_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceElectionResultId: uuid('source_election_result_id'),
  sourceProposalResultId: uuid('source_proposal_result_id'),
  status: text().default('scheduled').notNull(),
  startsTick: bigint('starts_tick', { mode: 'bigint' }).notNull(),
  plannedEndsTick: bigint('planned_ends_tick', { mode: 'bigint' }).notNull(),
  termNumber: integer('term_number').notNull(),
  checksum: bytea('checksum').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const officeTermTransitions = pgTable('office_term_transitions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  termId: uuid('term_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  effectiveTick: bigint('effective_tick', { mode: 'bigint' }).notNull(),
  reasonCode: text('reason_code').notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const officeSeatAuthorityIntervals = pgTable('office_seat_authority_intervals', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  officeId: uuid('office_id').notNull(),
  seatId: uuid('seat_id').notNull(),
  termId: uuid('term_id').notNull(),
  holderEntityId: uuid('holder_entity_id').notNull(),
  effectiveTicks: int8range('effective_ticks').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  updatedCommandId: uuid('updated_command_id').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const proposalEnactments = pgTable('proposal_enactments', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  proposalId: uuid('proposal_id').notNull(),
  proposalResultId: uuid('proposal_result_id').notNull(),
  enactmentAttempt: integer('enactment_attempt').notNull(),
  status: text().notNull(),
  failureCode: text('failure_code'),
  inputChecksum: bytea('input_checksum').notNull(),
  outputChecksum: bytea('output_checksum'),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  enactedTick: bigint('enacted_tick', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const proposalActionEnactments = pgTable('proposal_action_enactments', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  proposalEnactmentId: uuid('proposal_enactment_id').notNull(),
  proposalActionId: uuid('proposal_action_id').notNull(),
  effectKind: text('effect_kind').notNull(),
  effectId: uuid('effect_id').notNull(),
  effectVersion: bigint('effect_version', { mode: 'bigint' }).notNull(),
  effectChecksum: bytea('effect_checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const governanceAuthorityDecisions = pgTable('governance_authority_decisions', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  commandId: uuid('command_id').notNull(),
  actorMode: text('actor_mode').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  actorEntityId: uuid('actor_entity_id'),
  actionCode: text('action_code').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  evaluatedTick: bigint('evaluated_tick', { mode: 'bigint' }).notNull(),
  decision: text().notNull(),
  reasonCode: text('reason_code').notNull(),
  policyDslVersion: integer('policy_dsl_version').default(1).notNull(),
  inputContext: jsonb('input_context').notNull(),
  inputChecksum: bytea('input_checksum').notNull(),
  decisionChecksum: bytea('decision_checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const governanceAuthorityDecisionSources = pgTable('governance_authority_decision_sources', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  decisionId: uuid('decision_id').notNull(),
  sourceOrdinal: integer('source_ordinal').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceVersion: bigint('source_version', { mode: 'bigint' }).notNull(),
  sourceEffectiveTicks: int8range('source_effective_ticks'),
  sourceChecksum: bytea('source_checksum').notNull(),
  contribution: text().notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const governanceScheduleOccurrences = pgTable('governance_schedule_occurrences', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  scheduledActionId: uuid('scheduled_action_id').notNull(),
  occurrenceKey: text('occurrence_key').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: uuid('target_id').notNull(),
  transitionKind: text('transition_kind').notNull(),
  dueTick: bigint('due_tick', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const governanceOverrides = pgTable('governance_overrides', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  creatorOverrideId: uuid('creator_override_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  actorMode: text('actor_mode').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: uuid('target_id').notNull(),
  reason: text().notNull(),
  impactBefore: jsonb('impact_before').notNull(),
  impactAfter: jsonb('impact_after').notNull(),
  requiresSecondApproval: boolean('requires_second_approval').default(false).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  ledgerEntryId: uuid('ledger_entry_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const governanceOverrideApprovals = pgTable('governance_override_approvals', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  overrideId: uuid('override_id').notNull(),
  approverUserId: uuid('approver_user_id').notNull(),
  approvalKind: text('approval_kind').notNull(),
  approvalHash: bytea('approval_hash').notNull(),
  auditRecordId: uuid('audit_record_id').notNull(),
  approvedAt: timestamptz('approved_at').defaultNow().notNull(),
});

export const governanceRepairs = pgTable('governance_repairs', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: uuid('target_id').notNull(),
  repairKind: text('repair_kind').notNull(),
  reason: text().notNull(),
  beforeChecksum: bytea('before_checksum').notNull(),
  afterChecksum: bytea('after_checksum').notNull(),
  replacementResultId: uuid('replacement_result_id'),
  requiresSecondApproval: boolean('requires_second_approval').default(true).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  ledgerEntryId: uuid('ledger_entry_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const governanceRepairApprovals = pgTable('governance_repair_approvals', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  repairId: uuid('repair_id').notNull(),
  approverUserId: uuid('approver_user_id').notNull(),
  approvalHash: bytea('approval_hash').notNull(),
  auditRecordId: uuid('audit_record_id').notNull(),
  approvedAt: timestamptz('approved_at').defaultNow().notNull(),
});

export const recentCredentialProofs = pgTable(
  'recent_credential_proofs',
  {
    id: uuid().primaryKey().notNull(),
    proofHash: bytea('proof_hash').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id, { onDelete: 'restrict' }),
    commandId: uuid('command_id').notNull(),
    commandType: text('command_type').notNull(),
    commandRequestHash: bytea('command_request_hash').notNull(),
    method: text().notNull(),
    verifiedAt: timestamptz('verified_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    requestId: text('request_id').notNull(),
    auditRecordId: uuid('audit_record_id').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('recent_credential_proofs_hash_unique').on(table.proofHash),
    uniqueIndex('recent_credential_proofs_audit_unique').on(table.auditRecordId),
    unique('recent_credential_proofs_binding_unique').on(
      table.id,
      table.sessionId,
      table.userId,
      table.worldId,
      table.commandId,
      table.commandType,
      table.commandRequestHash,
    ),
    foreignKey({
      columns: [table.auditRecordId, table.worldId, table.userId],
      foreignColumns: [
        securityAuditRecords.id,
        securityAuditRecords.worldId,
        securityAuditRecords.actorUserId,
      ],
      name: 'recent_credential_proofs_audit_world_actor_fk',
    }).onDelete('restrict'),
    index('recent_credential_proofs_expiry_idx').on(table.expiresAt, table.id),
    check(
      'recent_credential_proofs_shape_valid',
      sql`octet_length(${table.proofHash}) = 32
        and octet_length(${table.commandRequestHash}) = 32
        and ${table.commandType} in ('ExecuteCreatorOverrideV1','RepairGovernanceResultV1')
        and ${table.method} = 'password'
        and ${table.expiresAt} > ${table.verifiedAt}
        and ${table.expiresAt} <= ${table.verifiedAt} + interval '15 minutes'
        and ${table.createdAt} >= ${table.verifiedAt}
        and char_length(${table.requestId}) between 1 and 128
        and ${table.requestId} !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const recentCredentialProofConsumptions = pgTable(
  'recent_credential_proof_consumptions',
  {
    proofId: uuid('proof_id').primaryKey().notNull(),
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id').notNull(),
    worldId: uuid('world_id').notNull(),
    commandId: uuid('command_id').notNull(),
    commandType: text('command_type').notNull(),
    commandRequestHash: bytea('command_request_hash').notNull(),
    requestId: text('request_id').notNull(),
    consumedAt: timestamptz('consumed_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('recent_credential_proof_consumptions_command_unique').on(table.commandId),
    foreignKey({
      columns: [
        table.proofId,
        table.sessionId,
        table.userId,
        table.worldId,
        table.commandId,
        table.commandType,
        table.commandRequestHash,
      ],
      foreignColumns: [
        recentCredentialProofs.id,
        recentCredentialProofs.sessionId,
        recentCredentialProofs.userId,
        recentCredentialProofs.worldId,
        recentCredentialProofs.commandId,
        recentCredentialProofs.commandType,
        recentCredentialProofs.commandRequestHash,
      ],
      name: 'recent_credential_proof_consumptions_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.commandId, table.worldId],
      foreignColumns: [commandRecords.id, commandRecords.worldId],
      name: 'recent_credential_proof_consumptions_command_world_fk',
    }).onDelete('restrict'),
    check(
      'recent_credential_proof_consumptions_shape_valid',
      sql`octet_length(${table.commandRequestHash}) = 32
        and ${table.commandType} in ('ExecuteCreatorOverrideV1','RepairGovernanceResultV1')
        and char_length(${table.requestId}) between 1 and 128
        and ${table.requestId} !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const publicProjectAuthorizations = pgTable('public_project_authorizations', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  proposalActionId: uuid('proposal_action_id').notNull(),
  proposalResultId: uuid('proposal_result_id').notNull(),
  projectEntityId: uuid('project_entity_id').notNull(),
  treasuryWalletId: uuid('treasury_wallet_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  authorizedMinor: bigint('authorized_minor', { mode: 'bigint' }).notNull(),
  startsTick: bigint('starts_tick', { mode: 'bigint' }).notNull(),
  expiresTick: bigint('expires_tick', { mode: 'bigint' }),
  purposeCode: text('purpose_code').notNull(),
  terms: jsonb().notNull(),
  checksum: bytea('checksum').notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const treasuryEncumbrances = pgTable('treasury_encumbrances', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  projectAuthorizationId: uuid('project_authorization_id').notNull(),
  treasuryWalletId: uuid('treasury_wallet_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  maximumMinor: bigint('maximum_minor', { mode: 'bigint' }).notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  createdEventId: uuid('created_event_id').notNull(),
  createdStateRevision: bigint('created_state_revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const treasuryEncumbranceFacts = pgTable('treasury_encumbrance_facts', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  encumbranceId: uuid('encumbrance_id').notNull(),
  factSequence: integer('fact_sequence').notNull(),
  factKind: text('fact_kind').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  occurredTick: bigint('occurred_tick', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});

export const treasuryEncumbranceProjections = pgTable('treasury_encumbrance_projections', {
  encumbranceId: uuid('encumbrance_id').primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  treasuryWalletId: uuid('treasury_wallet_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  authorizedMinor: bigint('authorized_minor', { mode: 'bigint' }).notNull(),
  consumedMinor: bigint('consumed_minor', { mode: 'bigint' }).default(0n).notNull(),
  releasedMinor: bigint('released_minor', { mode: 'bigint' }).default(0n).notNull(),
  activeMinor: bigint('active_minor', { mode: 'bigint' }).notNull(),
  status: text().default('active').notNull(),
  lastFactSequence: integer('last_fact_sequence').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  updatedStateRevision: bigint('updated_state_revision', { mode: 'bigint' }).notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const taxPolicyAuthorityIntervals = pgTable('tax_policy_authority_intervals', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  taxPolicyId: uuid('tax_policy_id').notNull(),
  currencyId: uuid('currency_id').notNull(),
  taxType: taxPolicyType('tax_type').notNull(),
  semanticScopeKey: text('semantic_scope_key').notNull(),
  effectiveTicks: int8range('effective_ticks').notNull(),
  createdCommandId: uuid('created_command_id').notNull(),
  updatedCommandId: uuid('updated_command_id').notNull(),
  rowVersion: bigint('row_version', { mode: 'bigint' }).default(1n).notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
  updatedAt: timestamptz('updated_at').defaultNow().notNull(),
});

export const governanceTaxPolicyLineage = pgTable('governance_tax_policy_lineage', {
  id: uuid().primaryKey().notNull(),
  worldId: uuid('world_id').notNull(),
  previousTaxPolicyId: uuid('previous_tax_policy_id').notNull(),
  newTaxPolicyId: uuid('new_tax_policy_id').notNull(),
  policyStableKey: citext('policy_stable_key').notNull(),
  previousPolicyVersion: integer('previous_policy_version').notNull(),
  newPolicyVersion: integer('new_policy_version').notNull(),
  previousPolicyChecksum: bytea('previous_policy_checksum').notNull(),
  newPolicyChecksum: bytea('new_policy_checksum').notNull(),
  proposalResultId: uuid('proposal_result_id').notNull(),
  proposalResultChecksum: bytea('proposal_result_checksum').notNull(),
  proposalActionId: uuid('proposal_action_id').notNull(),
  proposalActionChecksum: bytea('proposal_action_checksum').notNull(),
  proposalEnactmentId: uuid('proposal_enactment_id').notNull(),
  effectiveTick: bigint('effective_tick', { mode: 'bigint' }).notNull(),
  commandId: uuid('command_id').notNull(),
  eventId: uuid('event_id').notNull(),
  stateRevision: bigint('state_revision', { mode: 'bigint' }).notNull(),
  checksum: bytea('checksum').notNull(),
  createdAt: timestamptz('created_at').defaultNow().notNull(),
});
