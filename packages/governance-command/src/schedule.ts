import { createHash } from 'node:crypto';

import { canonicalJson } from '@worldgraph/contracts';

import type { InternalGovernanceCommandType } from './types.js';

export type GovernanceScheduleTargetKind =
  'election' | 'law' | 'office_term' | 'proposal' | 'tax_policy';
export type GovernanceScheduleTransitionKind =
  'activate' | 'certify' | 'close_tally' | 'complete' | 'open';

export interface GovernanceScheduleOccurrenceIdentity {
  dueTick: string;
  targetId: string;
  targetKind: GovernanceScheduleTargetKind;
  transitionKind: GovernanceScheduleTransitionKind;
  worldId: string;
}

export function governanceScheduleOccurrenceKey(
  identity: GovernanceScheduleOccurrenceIdentity,
): string {
  return [
    'governance',
    identity.targetKind,
    identity.targetId,
    identity.transitionKind,
    identity.dueTick,
  ].join(':');
}

export function governanceScheduleIdempotencyKey(
  commandType: InternalGovernanceCommandType,
  identity: GovernanceScheduleOccurrenceIdentity,
): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        commandType,
        domain: 'worldgraph.governance-schedule-idempotency.v1',
        occurrenceKey: governanceScheduleOccurrenceKey(identity),
        worldId: identity.worldId,
      }),
      'utf8',
    )
    .digest('hex');
  return `governance-schedule-v1.${digest}`;
}

export function governanceScheduleCommandType(
  targetKind: 'election' | 'proposal',
  transitionKind: 'certify' | 'close_tally' | 'open',
): InternalGovernanceCommandType {
  if (targetKind === 'proposal') {
    if (transitionKind === 'open') return 'OpenProposalVotingV1';
    if (transitionKind === 'close_tally') return 'CloseAndTallyProposalV1';
    return 'CertifyAndEnactProposalV1';
  }
  if (transitionKind === 'open') return 'OpenElectionV1';
  if (transitionKind === 'close_tally') return 'CloseAndTallyElectionV1';
  return 'CertifyElectionV1';
}
