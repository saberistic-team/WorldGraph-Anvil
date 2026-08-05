import { describe, expect, it, vi } from 'vitest';

import type { GovernanceUiProposalTargetsV1 } from '@worldgraph/contracts';

import type { AuthenticatedActor } from '../identity/service.js';
import { GovernanceCapabilityService } from './capabilities.js';
import type {
  GovernanceAuthorityPreparation,
  GovernanceAuthorityPreparationInput,
} from './command-gateway.js';
import type {
  GovernanceActorCapabilityContext,
  GovernanceCapabilityResource,
} from './repository.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e20';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const actorEntityId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const otherEntityId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const institutionId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const officeId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const termId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const proposalId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const electionId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const candidacyId = '018f8652-3cb6-7d52-904b-cce7901d7e29';
const snapshotId = '018f8652-3cb6-7d52-904b-cce7901d7e2a';

const proposalTargets: GovernanceUiProposalTargetsV1 = {
  projectEntities: [],
  taxPolicies: [],
  treasuries: [],
};

describe('GovernanceCapabilityService', () => {
  it.each([
    {
      authorityState: 'observer',
      heldOffice: false,
      membershipRole: 'observer',
      platformRole: 'user',
      profile: 'observer',
    },
    {
      authorityState: 'player',
      heldOffice: false,
      membershipRole: 'player',
      platformRole: 'user',
      profile: 'player',
    },
    {
      authorityState: 'officeholder',
      heldOffice: true,
      membershipRole: 'player',
      platformRole: 'user',
      profile: 'officeholder',
    },
    {
      authorityState: 'creator',
      heldOffice: false,
      membershipRole: 'creator',
      platformRole: 'user',
      profile: 'creator',
    },
    {
      authorityState: 'platform_administrator',
      heldOffice: false,
      membershipRole: 'administrator',
      platformRole: 'platform_admin',
      profile: 'platform administrator',
    },
  ] as const)(
    'projects stable authority and operator controls for $profile',
    async ({ authorityState, heldOffice, membershipRole, platformRole }) => {
      const prepareAuthority = vi.fn(async (input: GovernanceAuthorityPreparationInput) => {
        const operator =
          input.actionCode === 'governance.override.execute' ||
          input.actionCode === 'governance.result.repair';
        const allowed = operator
          ? membershipRole === 'creator' || platformRole === 'platform_admin'
          : membershipRole !== 'observer';
        return preparation(input, allowed, heldOffice);
      });
      const service = new GovernanceCapabilityService(
        repository(membershipRole, baseResources(), () => actorContext(membershipRole)),
        { prepareAuthority },
      );

      const view = await service.capabilities(actor(platformRole), worldId);

      expect(view.actor.authorityState).toBe(authorityState);
      expect(view.contractVersion).toBe(1);
      expect(view.proposalTargets).toEqual(proposalTargets);
      expect(capability(view, 'proposal.create', institutionId)?.allowed).toBe(
        membershipRole !== 'observer',
      );
      expect(capability(view, 'operator.override', worldId)?.allowed).toBe(
        membershipRole === 'creator' || platformRole === 'platform_admin',
      );
      expect(capability(view, 'operator.repair', worldId)?.allowed).toBe(
        membershipRole === 'creator' || platformRole === 'platform_admin',
      );
      const operatorInputs = prepareAuthority.mock.calls
        .map(([input]) => input)
        .filter((input) => input.overrideRequested);
      expect(operatorInputs).toHaveLength(2);
      expect(operatorInputs.every((input) => input.actorMode === 'administrator')).toBe(
        platformRole === 'platform_admin',
      );
      expect(operatorInputs.every((input) => input.actorMode === 'creator')).toBe(
        platformRole !== 'platform_admin',
      );
    },
  );

  it('fails closed for proposer, candidate, office eligibility, frozen voter, and ballot replacement scope', async () => {
    const ownDraftId = '018f8652-3cb6-7d52-904b-cce7901d7e30';
    const otherDraftId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
    const ineligibleElectionId = '018f8652-3cb6-7d52-904b-cce7901d7e32';
    const ineligibleBallotId = '018f8652-3cb6-7d52-904b-cce7901d7e33';
    const finalBallotId = '018f8652-3cb6-7d52-904b-cce7901d7e34';
    const replaceableBallotId = '018f8652-3cb6-7d52-904b-cce7901d7e35';
    const otherCandidacyId = '018f8652-3cb6-7d52-904b-cce7901d7e36';
    const resources: GovernanceCapabilityResource[] = [
      resource('institution', institutionId, 'active'),
      { ...resource('proposal', ownDraftId, 'draft'), subjectEntityId: actorEntityId },
      { ...resource('proposal', otherDraftId, 'draft'), subjectEntityId: otherEntityId },
      {
        ...resource('election', ineligibleElectionId, 'nominations_open'),
        parentResourceId: officeId,
      },
      { ...resource('proposal', ineligibleBallotId, 'open'), snapshotId },
      { ...resource('proposal', finalBallotId, 'open'), snapshotId },
      { ...resource('proposal', replaceableBallotId, 'open'), snapshotId },
      {
        ...resource('candidacy', otherCandidacyId, 'nominated'),
        parentResourceId: ineligibleElectionId,
        subjectEntityId: otherEntityId,
      },
    ];
    const scoped = (targetKind: string, targetId: string) => {
      if (targetKind === 'world') return actorContext('player');
      if (targetId === ineligibleElectionId)
        return { ...actorContext('player'), candidateEligible: false };
      if (targetId === ineligibleBallotId) return { ...actorContext('player'), eligible: false };
      if (targetId === finalBallotId)
        return {
          ...actorContext('player'),
          ballotReplacementAllowed: false,
          eligible: true,
          hasBallot: true,
        };
      if (targetId === replaceableBallotId)
        return {
          ...actorContext('player'),
          ballotReplacementAllowed: true,
          eligible: true,
          hasBallot: true,
        };
      return actorContext('player');
    };
    const service = new GovernanceCapabilityService(repository('player', resources, scoped), {
      prepareAuthority: async (input) => preparation(input, true, false),
    });

    const view = await service.capabilities(actor('user'), worldId);

    expect(capability(view, 'proposal.withdraw', ownDraftId)).toMatchObject({ allowed: true });
    expect(capability(view, 'proposal.withdraw', otherDraftId)).toMatchObject({
      allowed: false,
      reasonCode: 'PROPOSER_REQUIRED',
    });
    expect(capability(view, 'candidate.nominate', ineligibleElectionId)).toMatchObject({
      allowed: false,
      reasonCode: 'CANDIDATE_INELIGIBLE',
    });
    expect(capability(view, 'candidate.accept', otherCandidacyId)).toMatchObject({
      allowed: false,
      reasonCode: 'CANDIDATE_SELF_REQUIRED',
    });
    expect(capability(view, 'proposal.ballot.cast', ineligibleBallotId)).toMatchObject({
      allowed: false,
      reasonCode: 'BALLOT_INELIGIBLE',
    });
    expect(capability(view, 'proposal.ballot.cast', finalBallotId)).toMatchObject({
      allowed: false,
      reasonCode: 'BALLOT_REPLACEMENT_NOT_ALLOWED',
    });
    expect(capability(view, 'proposal.ballot.cast', replaceableBallotId)).toMatchObject({
      allowed: true,
    });
    expect(
      view.ballotEligibility.find((entry) => entry.targetId === replaceableBallotId),
    ).toMatchObject({ ballotState: 'cast_replaceable', eligible: true });
    expect(view.ballotEligibility.find((entry) => entry.targetId === finalBallotId)).toMatchObject({
      ballotState: 'cast_final',
      eligible: true,
    });
  });

  it('retries when the projection changes and returns only a stable revision and tick', async () => {
    const stableRepository = repository(
      'player',
      [resource('institution', institutionId, 'active')],
      () => actorContext('player'),
    );
    const contexts = [
      { evaluatedAtTick: '42', projectionRevision: '40' },
      { evaluatedAtTick: '42', projectionRevision: '41' },
      { evaluatedAtTick: '42', projectionRevision: '41' },
      { evaluatedAtTick: '42', projectionRevision: '41' },
    ];
    const context = vi.fn(async () => contexts.shift() ?? contexts.at(-1)!);
    const service = new GovernanceCapabilityService(
      { ...stableRepository, context },
      { prepareAuthority: async (input) => preparation(input, true, false) },
    );

    const view = await service.capabilities(actor('user'), worldId);

    expect(view).toMatchObject({ evaluatedAtTick: '42', projectionRevision: '41' });
    expect(context).toHaveBeenCalledTimes(4);
  });

  it('fails closed after bounded retries when no coherent capability snapshot is available', async () => {
    const stableRepository = repository(
      'player',
      [resource('institution', institutionId, 'active')],
      () => actorContext('player'),
    );
    const contexts = [
      { evaluatedAtTick: '42', projectionRevision: '40' },
      { evaluatedAtTick: '42', projectionRevision: '41' },
      { evaluatedAtTick: '42', projectionRevision: '41' },
      { evaluatedAtTick: '42', projectionRevision: '42' },
      { evaluatedAtTick: '42', projectionRevision: '42' },
      { evaluatedAtTick: '42', projectionRevision: '43' },
    ];
    const context = vi.fn(async () => contexts.shift()!);
    const service = new GovernanceCapabilityService(
      { ...stableRepository, context },
      { prepareAuthority: async (input) => preparation(input, true, false) },
    );

    await expect(service.capabilities(actor('user'), worldId)).rejects.toMatchObject({
      code: 'GOVERNANCE_CAPABILITY_SNAPSHOT_UNSTABLE',
      statusCode: 503,
    });
    expect(context).toHaveBeenCalledTimes(6);
  });

  it('batches large independently bounded capability classes without dropping decisions', async () => {
    const resources = Array.from({ length: 70 }, (_, index) =>
      resource(
        'institution',
        `018f8652-3cb6-7d52-904b-${(100 + index).toString(16).padStart(12, '0')}`,
        'active',
      ),
    );
    let active = 0;
    let maximumActive = 0;
    const prepareAuthority = vi.fn(async (input: GovernanceAuthorityPreparationInput) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return preparation(input, true, false);
    });
    const service = new GovernanceCapabilityService(
      repository('player', resources, () => actorContext('player')),
      { prepareAuthority },
    );

    const view = await service.capabilities(actor('user'), worldId);

    expect(
      view.decisions.filter((decision) => decision.capability === 'proposal.create'),
    ).toHaveLength(70);
    expect(maximumActive).toBeLessThanOrEqual(32);
  });
});

function repository(
  membershipRole: GovernanceActorCapabilityContext['membershipRole'],
  resources: GovernanceCapabilityResource[],
  scoped: (targetKind: string, targetId: string) => GovernanceActorCapabilityContext,
) {
  return {
    actorCapabilityContext: async (
      _actorId: string,
      _worldId: string,
      targetKind: 'election' | 'proposal' | 'world',
      targetId: string,
    ) => scoped(targetKind, targetId),
    capabilityResources: async () => resources,
    context: async () => ({ evaluatedAtTick: '42', projectionRevision: '41' }),
    proposalTargets: async () => proposalTargets,
  };
}

function actor(platformRole: 'platform_admin' | 'user'): AuthenticatedActor {
  return { user: { id: actorId, platformRole } } as AuthenticatedActor;
}

function actorContext(
  membershipRole: GovernanceActorCapabilityContext['membershipRole'],
): GovernanceActorCapabilityContext {
  return {
    actorEntityId,
    actorEntityKey: 'character:alex',
    ballotReplacementAllowed: false,
    candidateEligible: true,
    eligible: true,
    hasBallot: false,
    membershipRole,
  };
}

function baseResources(): GovernanceCapabilityResource[] {
  return [
    resource('institution', institutionId, 'active'),
    resource('office', officeId, 'active'),
    resource('office_term', termId, 'active'),
    { ...resource('proposal', proposalId, 'open'), snapshotId, subjectEntityId: actorEntityId },
    {
      ...resource('election', electionId, 'open'),
      parentResourceId: officeId,
      snapshotId,
    },
    {
      ...resource('candidacy', candidacyId, 'nominated'),
      parentResourceId: electionId,
      subjectEntityId: actorEntityId,
    },
  ];
}

function resource(
  resourceType: GovernanceCapabilityResource['resourceType'],
  resourceId: string,
  resourceState: string,
): GovernanceCapabilityResource {
  return {
    parentResourceId: null,
    resourceId,
    resourceKey: resourceType === 'institution' ? 'institution:civic-council' : null,
    resourceState,
    resourceType,
    snapshotId: null,
    subjectEntityId: null,
  };
}

function preparation(
  input: GovernanceAuthorityPreparationInput,
  allowed: boolean,
  heldOffice: boolean,
): GovernanceAuthorityPreparation {
  return {
    actor: { actorEntityId, actorId, actorType: 'user' },
    authorization: {
      actionCode: input.actionCode,
      allowed,
      context: { heldOfficeKeys: heldOffice ? ['office:harbor-council'] : [], tick: '42' },
      reasonCode: allowed ? 'GOVERNANCE_POLICY_ALLOWED' : 'GOVERNANCE_POLICY_DENIED',
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      ruleId: allowed ? 'governance.policy.allowed' : 'governance.policy.denied',
    },
    hiddenByAuthority: false,
  };
}

function capability(
  view: Awaited<ReturnType<GovernanceCapabilityService['capabilities']>>,
  code: (typeof view.decisions)[number]['capability'],
  resourceId: string,
) {
  return view.decisions.find(
    (decision) => decision.capability === code && decision.resourceId === resourceId,
  );
}
