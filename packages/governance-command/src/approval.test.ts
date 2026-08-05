import { describe, expect, it } from 'vitest';

import type { GovernanceCommandRequestV1 } from '@worldgraph/contracts';

import {
  governanceTwoPersonApprovalBindingHashV1,
  governanceTwoPersonApprovalRequestHashV1,
} from './approval.js';

const command = {
  actorMode: 'administrator',
  commandId: '018f8652-3cb6-7d52-904b-000000000001',
  expectedAggregateVersion: '0',
  expectedStateRevision: '4',
  expectedTick: '10',
  expectedWorldVersion: '1',
  idempotencyKey: 'governance-approval-test-0001',
  payload: {
    approvalId: null,
    confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
    effect: {
      effectType: 'remove_officeholder',
      removal: {
        effectiveAtTick: '10',
        expectedTermVersion: '1',
        reason: 'Resolve the declared conflict.',
        termId: '018f8652-3cb6-7d52-904b-000000000002',
      },
    },
    impact: 'End the conflicted term at the current authoritative tick.',
    reason: 'Emergency action reviewed by a distinct administrator.',
  },
  schemaVersion: 1,
  type: 'ExecuteCreatorOverrideV1',
} satisfies Extract<GovernanceCommandRequestV1, { type: 'ExecuteCreatorOverrideV1' }>;

describe('governanceTwoPersonApprovalBindingHashV1', () => {
  it('normalizes only the eventual approval id', () => {
    const withApproval: Extract<GovernanceCommandRequestV1, { type: 'ExecuteCreatorOverrideV1' }> =
      structuredClone(command);
    withApproval.payload.approvalId = '018f8652-3cb6-7d52-904b-000000000003';
    expect(governanceTwoPersonApprovalBindingHashV1(withApproval)).toBe(
      governanceTwoPersonApprovalBindingHashV1(command),
    );
  });

  it('changes for every reviewed command or effect mutation', () => {
    const original = governanceTwoPersonApprovalBindingHashV1(command);
    const mutations = [
      { ...command, expectedStateRevision: '5' },
      { ...command, expectedTick: '11' },
      { ...command, idempotencyKey: 'governance-approval-test-0002' },
      { ...command, payload: { ...command.payload, reason: `${command.payload.reason} Changed.` } },
      {
        ...command,
        payload: {
          ...command.payload,
          effect: {
            ...command.payload.effect,
            removal: { ...command.payload.effect.removal, effectiveAtTick: '11' },
          },
        },
      },
    ] as const;

    for (const value of mutations) {
      const mutated = governanceTwoPersonApprovalBindingHashV1(value);
      expect(mutated).toMatch(/^[a-f0-9]{64}$/u);
      expect(mutated).not.toBe(original);
    }
  });

  it('adds the world boundary to approval issuance idempotency', () => {
    const first = governanceTwoPersonApprovalRequestHashV1(
      '018f8652-3cb6-7d52-904b-000000000004',
      command,
    );
    const second = governanceTwoPersonApprovalRequestHashV1(
      '018f8652-3cb6-7d52-904b-000000000005',
      command,
    );

    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(first).not.toEqual(second);
  });
});
