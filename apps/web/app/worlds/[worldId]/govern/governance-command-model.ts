import type {
  AppointOfficeholderPayloadV1,
  GovernanceOfficeTermViewV1,
  GovernanceOfficeViewV1,
  GovernanceProposalViewV1,
  RemoveOfficeholderPayloadV1,
  WithdrawProposalPayloadV1,
} from '@worldgraph/contracts';

export interface GovernanceSubmitCommand {
  commandId: string;
  expectedAggregateVersion: string;
  expectedStateRevision: string;
  expectedTick: string;
  expectedWorldVersion: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  schemaVersion: 1;
  type: string;
}

export type GovernanceOperatorActorMode = 'administrator' | 'creator';

export interface GovernanceApprovalReviewCommand extends GovernanceSubmitCommand {
  actorMode: GovernanceOperatorActorMode;
}

const GOVERNANCE_OPERATOR_COMMAND_TYPES = new Set([
  'ExecuteCreatorOverrideV1',
  'RepairGovernanceResultV1',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function governanceApprovalReviewCommand(
  command: GovernanceSubmitCommand,
  actorMode: GovernanceOperatorActorMode,
): GovernanceApprovalReviewCommand {
  assertOperatorCommand(command);
  return {
    ...command,
    actorMode,
    payload: { ...command.payload, approvalId: null },
  };
}

export function attachGovernanceApproval(
  command: GovernanceSubmitCommand,
  approvalId: string,
): GovernanceSubmitCommand {
  assertOperatorCommand(command);
  if (!UUID_PATTERN.test(approvalId)) throw new Error('GOVERNANCE_APPROVAL_ID_INVALID');
  return { ...command, payload: { ...command.payload, approvalId } };
}

function assertOperatorCommand(command: GovernanceSubmitCommand): void {
  if (!GOVERNANCE_OPERATOR_COMMAND_TYPES.has(command.type)) {
    throw new Error('GOVERNANCE_OPERATOR_COMMAND_REQUIRED');
  }
}

export function officeAppointmentPayload(
  office: GovernanceOfficeViewV1,
  input: {
    holderEntityKey: string;
    reason: string;
    seatIndex: string;
    termEndsAtTick: string;
    termStartsAtTick: string;
  },
): AppointOfficeholderPayloadV1 {
  return {
    expectedOfficeVersion: office.aggregateVersion,
    holderEntityKey: input.holderEntityKey,
    officeId: office.officeId,
    reason: input.reason,
    seatIndex: Number(input.seatIndex),
    termEndsAtTick: input.termEndsAtTick,
    termStartsAtTick: input.termStartsAtTick,
  };
}

export function officeRemovalPayload(
  term: GovernanceOfficeTermViewV1,
  effectiveAtTick: string,
  reason: string,
): RemoveOfficeholderPayloadV1 {
  return {
    effectiveAtTick,
    expectedTermVersion: term.aggregateVersion,
    reason,
    termId: term.termId,
  };
}

export function proposalWithdrawalPayload(
  proposal: GovernanceProposalViewV1,
  reason: string,
): WithdrawProposalPayloadV1 {
  return {
    expectedProposalVersion: proposal.aggregateVersion,
    proposalId: proposal.proposalId,
    reason,
  };
}
