import { createHash } from 'node:crypto';

import { canonicalJson, type GovernanceCommandRequestV1 } from '@worldgraph/contracts';

export type GovernanceTwoPersonCommand = Extract<
  GovernanceCommandRequestV1,
  { type: 'ExecuteCreatorOverrideV1' | 'RepairGovernanceResultV1' }
>;

/**
 * Binds a second-person approval to the complete reviewed command. The eventual
 * executor adds the returned approval id, so that one field is normalized while
 * every authority, concurrency, timing, reason, impact, and effect field remains
 * frozen.
 */
export function governanceTwoPersonApprovalBindingHashV1(
  command: GovernanceTwoPersonCommand,
): string {
  const material = {
    ...command,
    payload: { ...command.payload, approvalId: null },
  };
  return createHash('sha256')
    .update(
      canonicalJson({
        command: material,
        domain: 'worldgraph.governance-two-person-approval.v1',
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * Gives approval issuance its own idempotency domain and includes the world
 * boundary that is enforced separately when the approval is consumed.
 */
export function governanceTwoPersonApprovalRequestHashV1(
  worldId: string,
  command: GovernanceTwoPersonCommand,
): Buffer {
  return createHash('sha256')
    .update(
      canonicalJson({
        bindingHash: governanceTwoPersonApprovalBindingHashV1(command),
        domain: 'worldgraph.governance-two-person-approval-request.v1',
        worldId,
      }),
      'utf8',
    )
    .digest();
}
