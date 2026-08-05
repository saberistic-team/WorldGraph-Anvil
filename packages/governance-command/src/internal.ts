import { createHash } from 'node:crypto';

import {
  canonicalJson,
  type GovernanceCommandRequestV1,
  type SafeGovernanceEventPayloadV1,
} from '@worldgraph/contracts';

import type {
  GovernanceCommandExecutionInput,
  GovernanceCommandPolicy,
  GovernanceRestrictedTallyExecutor,
  GovernanceSqlExecutor,
} from './types.js';

export interface WorldTransactionContext {
  active_world_version_id: string;
  anchor_artifact_hash: Buffer | null;
  current_tick: string;
  design_version: string;
  governance_row_version: string | null;
  governance_checksum: Buffer | null;
  governance_seed_plan_hash: Buffer | null;
  last_entry_hash: Buffer | null;
  lifecycle: string;
  next_event_sequence: string;
  next_ledger_sequence: string;
  recorded_at: Date;
  state_revision: string;
}

export interface GovernancePlannedEvent {
  aggregateId: string;
  aggregateType: string;
  aggregateVersion: string;
  eventId: string;
  eventType: string;
  history: {
    category: string;
    summaryArgs: Record<string, unknown>;
    targetId: string;
    targetType: string;
    titleKey: string;
    visibility: 'creator' | 'member' | 'operator' | 'public';
  };
  ledgerEntryId: string;
  ledgerKind?: 'domain_event' | 'override' | 'repair_anchor';
  payload: SafeGovernanceEventPayloadV1 | Record<string, unknown>;
  summaryCode: string;
}

export interface GovernanceHandlerOutcome {
  additionalEvents?: readonly GovernancePlannedEvent[];
  event: GovernancePlannedEvent;
  headCreated?: boolean;
  responseDetails?: Record<string, unknown>;
}

export interface GovernanceCreatorOverrideProvenance {
  action: string;
  auditRecordId: string;
  creatorOverrideId: string;
  effectHash: string;
  targetId: string;
  targetType: string;
}

export interface GovernanceHandlerContext {
  additionalEvents: GovernancePlannedEvent[];
  client: GovernanceSqlExecutor;
  command: GovernanceCommandRequestV1;
  creatorOverride?: GovernanceCreatorOverrideProvenance;
  eventId: string;
  eventLedgerEntryId: string;
  ids: { next(): string };
  input: GovernanceCommandExecutionInput;
  policy: GovernanceCommandPolicy;
  resultingStateRevision: string;
  restrictedTallyExecutor?: GovernanceRestrictedTallyExecutor;
  world: WorldTransactionContext;
}

export function sha256Buffer(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

export function sha256Hex(value: unknown): string {
  return sha256Buffer(value).toString('hex');
}

export function addDecimal(value: string, amount = 1): string {
  return (BigInt(value) + BigInt(amount)).toString();
}

export function ceilBasisPoints(count: number, basisPoints: number): number {
  return Number((BigInt(count) * BigInt(basisPoints) + 9_999n) / 10_000n);
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function hexBuffer(value: string): Buffer {
  return Buffer.from(value, 'hex');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function queryOne<TRow>(
  executor: GovernanceSqlExecutor,
  sql: string,
  values: readonly unknown[],
): Promise<TRow | null> {
  const result = await executor.query<TRow>(sql, values);
  return result.rows[0] ?? null;
}

export function actionKind(actionType: string): string {
  const kinds: Record<string, string> = {
    amend_law: 'law_amend',
    appoint_officeholder: 'office_appointment',
    approve_world_patch: 'world_patch_approval',
    authorize_public_project: 'public_project_authorization',
    create_law: 'law_create',
    repeal_law: 'law_repeal',
    update_tax: 'tax_policy_update',
  };
  return kinds[actionType] ?? 'unknown';
}

export function proposalType(actionType: string): string {
  if (actionType === 'appoint_officeholder') return 'appointment';
  if (actionType === 'approve_world_patch') return 'patch_approval';
  return 'ordinary';
}

export function sanitizeGovernanceContext(value: unknown): Record<string, unknown> {
  const forbidden = /(?:choice|selection|secret|password|token|credential|linkage|nonce)/iu;
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 5) return '[bounded]';
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') return input.slice(0, 500);
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'undefined') return '[undefined]';
    if (Array.isArray(input)) return input.slice(0, 64).map((item) => visit(item, depth + 1));
    if (!isRecord(input)) return `[${typeof input}]`;
    return Object.fromEntries(
      Object.entries(input)
        .filter(([key]) => !forbidden.test(key))
        .slice(0, 64)
        .map(([key, item]) => [key.slice(0, 120), visit(item, depth + 1)]),
    );
  };
  const result = visit(value, 0);
  return isRecord(result) ? result : {};
}
