import { describe, expect, it } from 'vitest';

import {
  CERTIFY_AND_ENACT_PROPOSAL_DESCRIPTOR_V1,
  CERTIFY_ELECTION_DESCRIPTOR_V1,
  CLOSE_AND_TALLY_ELECTION_DESCRIPTOR_V1,
  CLOSE_AND_TALLY_PROPOSAL_DESCRIPTOR_V1,
  OPEN_ELECTION_DESCRIPTOR_V1,
  OPEN_PROPOSAL_VOTING_DESCRIPTOR_V1,
  runSimulationProcessV1,
} from './registry.js';

const context = {
  currentProjectionChecksum: 'a'.repeat(64),
  processSchemaVersion: 1 as const,
  scheduleSequence: '8',
  stableProcessKey: 'schedule:8',
  state: {},
  tick: '42',
  worldSeed: 'harbor-city-seed',
  worldTimeUnixMilliseconds: '947721600000',
};
const targetId = '018f8652-3cb6-7d52-904b-cce7901d7e26';

describe('governance simulation process registry', () => {
  it('registers target-only system-dispatch descriptors in registry 3', () => {
    for (const descriptor of [
      OPEN_PROPOSAL_VOTING_DESCRIPTOR_V1,
      CLOSE_AND_TALLY_PROPOSAL_DESCRIPTOR_V1,
      CERTIFY_AND_ENACT_PROPOSAL_DESCRIPTOR_V1,
      OPEN_ELECTION_DESCRIPTOR_V1,
      CLOSE_AND_TALLY_ELECTION_DESCRIPTOR_V1,
      CERTIFY_ELECTION_DESCRIPTOR_V1,
    ]) {
      expect(descriptor).toMatchObject({
        authorityPolicy: 'system_scheduler',
        maxEvents: 0,
        maxSchedules: 0,
        processVersion: '1.0.0',
        registryVersion: 3,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
  });

  it.each([
    ['OpenProposalVotingV1', { proposalId: targetId }],
    ['CloseAndTallyProposalV1', { proposalId: targetId }],
    ['CertifyAndEnactProposalV1', { proposalId: targetId }],
    ['OpenElectionV1', { electionId: targetId }],
    ['CloseAndTallyElectionV1', { electionId: targetId }],
    ['CertifyElectionV1', { electionId: targetId }],
  ] as const)('commits a payload-free %s dispatch trigger', (actionType, payload) => {
    expect(
      runSimulationProcessV1({
        actionSchemaVersion: 1,
        actionType,
        context,
        payload,
        processVersion: '1.0.0',
      }),
    ).toEqual({ events: [], processSchemaVersion: 1, schedules: [] });
  });

  it('rejects ballot choices and mutable result data in scheduler payloads', () => {
    expect(() =>
      runSimulationProcessV1({
        actionSchemaVersion: 1,
        actionType: 'CloseAndTallyProposalV1',
        context,
        payload: { choice: 'yes', proposalId: targetId, resultChecksum: 'b'.repeat(64) },
        processVersion: '1.0.0',
      }),
    ).toThrowError(expect.objectContaining({ code: 'SIMULATION_HANDLER_FAILED' }));
  });
});
