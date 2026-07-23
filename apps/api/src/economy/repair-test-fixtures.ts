import type {
  EconomyRepairApprovalTransport,
  EconomyRepairPlanViewTransport,
} from './api-contracts.js';

export const repairTestId = (value: number): string =>
  `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;

export const repairActorId = repairTestId(31);
export const repairWorldId = repairTestId(26);
export const repairOtherWorldId = repairTestId(27);
export const repairPlanId = repairTestId(22);
export const repairApprovalId = repairTestId(30);
export const repairPlanHash = 'd'.repeat(64);

export const repairPlanView: EconomyRepairPlanViewTransport = {
  approvalStatus: { creator: false, platformAdmin: false },
  delta: {
    financialDelta: null,
    repairKind: 'reverse_asset_transfer',
    titleDelta: {
      assetId: repairTestId(16),
      compensationTransferId: repairTestId(17),
      fromOwnerEntityId: repairTestId(18),
      ownershipVersionAfter: '3',
      ownershipVersionBefore: '2',
      reversalOfTransferId: repairTestId(20),
      toOwnerEntityId: repairTestId(19),
    },
  },
  domain: 'worldgraph.economy-repair-plan.v1',
  executed: false,
  expiresAt: '2026-07-23T12:00:00.000Z',
  incidentReason: 'Duplicate transfer escaped idempotency enforcement.',
  pitrNotUsedReason: 'The recovery objective cannot tolerate a world rollback.',
  planHash: repairPlanHash,
  preparedAt: '2026-07-22T12:00:00.000Z',
  preparedByUserId: repairTestId(21),
  reasonCode: 'DUPLICATE_EFFECT',
  repairKind: 'reverse_asset_transfer',
  repairPlanId,
  repairPlanSchemaVersion: 1,
  reservedCommandId: repairTestId(23),
  sourceCommandId: repairTestId(24),
  sourceEconomyChecksum: 'a'.repeat(64),
  sourceEconomyHeadVersion: '9',
  sourceEventSequence: '81',
  sourceReconciliationRunId: repairTestId(25),
  sourceStateRevision: '47',
  sourceWorldVersion: '3',
  worldId: repairWorldId,
};

export function repairApproval(
  authorityKind: 'creator' | 'platform_admin',
  approvalId = repairApprovalId,
): EconomyRepairApprovalTransport {
  const common = {
    approvalId,
    approvedAt: '2026-07-22T12:00:30.000Z',
    approverUserId: repairActorId,
    planHash: repairPlanHash,
    repairPlanId,
    worldId: repairWorldId,
  } as const;
  return authorityKind === 'creator'
    ? {
        ...common,
        authorityKind,
        creatorOverrideId: repairTestId(32),
      }
    : { ...common, authorityKind, creatorOverrideId: null };
}
