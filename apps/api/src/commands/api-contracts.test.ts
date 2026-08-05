import { createValidator } from '@worldgraph/contracts';
import { describe, expect, it } from 'vitest';

import {
  GovernanceApprovalRequestTransportSchema,
  RecentCredentialRequestTransportSchema,
} from './api-contracts.js';

const command = {
  commandId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
  expectedAggregateVersion: '0',
  expectedStateRevision: '4',
  expectedTick: '10',
  expectedWorldVersion: '1',
  idempotencyKey: 'repair-governance-result-0001',
  payload: {
    approvalId: null,
    confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
    expectedCurrentResultChecksum: 'a'.repeat(64),
    reason: 'Recompute the frozen ballots and append linked evidence.',
    repairKind: 'proposal_recount',
    replacementResultChecksum: 'b'.repeat(64),
    sourceResultId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
  },
  schemaVersion: 1,
  type: 'RepairGovernanceResultV1',
} as const;

describe('recent-credential API contract', () => {
  it('accepts only a complete typed privileged command and never a caller-authored hash', () => {
    const validator = createValidator(RecentCredentialRequestTransportSchema);
    const request = {
      command,
      password: 'correct horse battery',
      worldId: '018f8652-3cb6-7d52-904b-cce7901d7e23',
    };

    expect(validator.is(request)).toBe(true);
    expect(
      validator.is({
        ...request,
        command: { ...command, type: 'CreateProposalV1' },
      }),
    ).toBe(false);
    expect(
      validator.is({
        ...request,
        command: { ...command, commandRequestHash: 'a'.repeat(64) },
      }),
    ).toBe(false);
    expect(
      validator.is({
        ...request,
        command: { ...command, payload: { ...command.payload, unexpected: true } },
      }),
    ).toBe(false);
  });
});

describe('governance second-approval API contract', () => {
  it('binds approval review to the same complete privileged-command union', () => {
    const validator = createValidator(GovernanceApprovalRequestTransportSchema);
    const request = {
      command: { ...command, actorMode: 'creator' },
      password: 'correct horse battery',
      worldId: '018f8652-3cb6-7d52-904b-cce7901d7e23',
    };

    expect(validator.is(request)).toBe(true);
    expect(validator.is({ ...request, command: { ...command, expectedTick: '-1' } })).toBe(false);
    expect(
      validator.is({
        ...request,
        command: { ...command, payload: { ...command.payload, approvalId: 'not-a-uuid' } },
      }),
    ).toBe(false);
    expect(validator.is({ ...request, command })).toBe(false);
  });
});
