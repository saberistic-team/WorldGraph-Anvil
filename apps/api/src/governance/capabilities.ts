import type {
  AuthorityAction,
  GovernanceUiActorAuthorityStateV1,
  GovernanceUiCapabilitiesViewV1,
  GovernanceUiCapabilityCodeV1,
  GovernanceUiCapabilityDecisionV1,
} from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type {
  GovernanceAuthorityPreparationInput,
  GovernanceCommandGateway,
} from './command-gateway.js';
import type {
  GovernanceActorCapabilityContext,
  GovernanceCapabilityResource,
  PostgresGovernanceReadRepository,
} from './repository.js';

interface CapabilitySpec {
  actionCode: AuthorityAction;
  allowActiveLaw: boolean;
  capability: GovernanceUiCapabilityCodeV1;
  policyActionCode: string | null;
  policyResourceType?: string;
  resource: GovernanceCapabilityResource;
}

const MAX_CAPABILITY_SNAPSHOT_ATTEMPTS = 3;
const CAPABILITY_EVALUATION_BATCH_SIZE = 32;

export class GovernanceCapabilityService {
  public constructor(
    private readonly repository: Pick<
      PostgresGovernanceReadRepository,
      'actorCapabilityContext' | 'capabilityResources' | 'context' | 'proposalTargets'
    >,
    private readonly gateway: Pick<GovernanceCommandGateway, 'prepareAuthority'>,
  ) {}

  public async capabilities(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<GovernanceUiCapabilitiesViewV1> {
    for (let attempt = 0; attempt < MAX_CAPABILITY_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const context = await this.repository.context(actor.user.id, worldId);
      if (!context) notFound();
      const [resources, actorContext, proposalTargets] = await Promise.all([
        this.repository.capabilityResources(actor.user.id, worldId),
        this.repository.actorCapabilityContext(actor.user.id, worldId, 'world', worldId, null),
        this.repository.proposalTargets(actor.user.id, worldId),
      ]);
      if (!resources || !actorContext || !proposalTargets) notFound();

      const specs = resources.flatMap(capabilitySpecs);
      const operatorResource: GovernanceCapabilityResource = {
        parentResourceId: null,
        resourceId: worldId,
        resourceKey: null,
        resourceState: 'active',
        resourceType: 'institution',
        snapshotId: null,
        subjectEntityId: null,
      };
      const profile = await this.gateway.prepareAuthority(
        authorityInput(actor, worldId, {
          actionCode: 'governance.proposal.create',
          allowActiveLaw: false,
          capability: 'proposal.create',
          policyActionCode: 'governance.propose',
          policyResourceType: 'proposal',
          resource: operatorResource,
        }),
      );
      if (!profile || profile.hiddenByAuthority) notFound();

      const scopedContextEntries = await mapInBatches(
        scopedContextTargets(resources),
        async (resource) =>
          [
            resourceContextKey(resource.resourceType, resource.resourceId),
            await this.repository.actorCapabilityContext(
              actor.user.id,
              worldId,
              resource.resourceType,
              resource.resourceId,
              resource.snapshotId,
            ),
          ] as const,
      );
      const scopedContexts = new Map(scopedContextEntries);
      if ([...scopedContexts.values()].some((value) => value === null)) notFound();

      const preparations = await mapInBatches(specs, async (spec) => ({
        preparation: await this.gateway.prepareAuthority(authorityInput(actor, worldId, spec)),
        spec,
      }));
      const operatorPreparations = await Promise.all(
        [
          {
            actionCode: 'governance.override.execute' as const,
            capability: 'operator.override' as const,
            resourceType: 'governance_override',
          },
          {
            actionCode: 'governance.result.repair' as const,
            capability: 'operator.repair' as const,
            resourceType: 'governance_result',
          },
        ].map(async (operator) => ({
          capability: operator.capability,
          preparation: await this.gateway.prepareAuthority({
            actionCode: operator.actionCode,
            actorId: actor.user.id,
            actorMode: actor.user.platformRole === 'platform_admin' ? 'administrator' : 'creator',
            allowActiveLaw: false,
            overrideRequested: true,
            platformRole: actor.user.platformRole,
            policyActionCode: null,
            resourceId: worldId,
            resourceKey: null,
            resourceType: operator.resourceType,
            worldId,
          }),
        })),
      );

      for (const item of [...preparations, ...operatorPreparations]) {
        if (!item.preparation || item.preparation.hiddenByAuthority) notFound();
      }
      const decisions: GovernanceUiCapabilityDecisionV1[] = [
        ...preparations.map(({ preparation, spec }) =>
          scopedDecision(
            spec,
            preparation!,
            actorContext,
            scopedContextFor(spec.resource, scopedContexts),
          ),
        ),
        ...operatorPreparations.map(({ capability, preparation }) =>
          decision(capability, 'world', worldId, preparation!),
        ),
      ].sort(compareDecisions);

      const ballotResources = resources.filter(
        (
          resource,
        ): resource is GovernanceCapabilityResource & {
          resourceType: 'election' | 'proposal';
          snapshotId: string;
        } =>
          (resource.resourceType === 'election' || resource.resourceType === 'proposal') &&
          resource.resourceState === 'open' &&
          resource.snapshotId !== null,
      );
      const ballotEligibility = ballotResources.map((resource) => {
        const eligibility = scopedContexts.get(
          resourceContextKey(resource.resourceType, resource.resourceId),
        );
        if (!eligibility) notFound();
        return {
          ballotState: eligibility.hasBallot
            ? eligibility.ballotReplacementAllowed
              ? ('cast_replaceable' as const)
              : ('cast_final' as const)
            : ('not_cast' as const),
          eligible: eligibility.eligible,
          snapshotId: resource.snapshotId,
          targetId: resource.resourceId,
          targetType: resource.resourceType,
        };
      });
      ballotEligibility.sort((left, right) =>
        `${left.targetType}:${left.targetId}`.localeCompare(
          `${right.targetType}:${right.targetId}`,
        ),
      );

      const allPreparations = [
        profile,
        ...preparations.map((item) => item.preparation!),
        ...operatorPreparations.map((item) => item.preparation!),
      ];
      const preparationTick = evaluatedTick(allPreparations);
      const endContext = await this.repository.context(actor.user.id, worldId);
      if (!endContext) notFound();
      if (
        endContext.projectionRevision === context.projectionRevision &&
        endContext.evaluatedAtTick === context.evaluatedAtTick &&
        preparationTick === context.evaluatedAtTick
      ) {
        return {
          actor: {
            actorEntityId: actorContext.actorEntityId,
            actorEntityKey: actorContext.actorEntityKey,
            authorityState: authorityState(actor, actorContext.membershipRole, allPreparations),
            membershipRole: actorContext.membershipRole,
            platformRole: actor.user.platformRole,
          },
          ballotEligibility,
          contractVersion: 1,
          decisions,
          evaluatedAtTick: preparationTick,
          proposalTargets,
          projectionRevision: context.projectionRevision,
          worldId,
        };
      }
    }
    throw new ApplicationError(
      'GOVERNANCE_CAPABILITY_SNAPSHOT_UNSTABLE',
      'Governance changed while capabilities were evaluated. Retry the request.',
      503,
    );
  }
}

async function mapInBatches<T, U>(items: readonly T[], map: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let offset = 0; offset < items.length; offset += CAPABILITY_EVALUATION_BATCH_SIZE) {
    results.push(
      ...(await Promise.all(
        items.slice(offset, offset + CAPABILITY_EVALUATION_BATCH_SIZE).map(map),
      )),
    );
  }
  return results;
}

function scopedContextTargets(
  resources: readonly GovernanceCapabilityResource[],
): Array<GovernanceCapabilityResource & { resourceType: 'election' | 'proposal' }> {
  const targets = new Map<
    string,
    GovernanceCapabilityResource & { resourceType: 'election' | 'proposal' }
  >();
  for (const resource of resources) {
    if (
      resource.resourceType === 'election' ||
      (resource.resourceType === 'proposal' && resource.resourceState === 'open')
    ) {
      targets.set(
        resourceContextKey(resource.resourceType, resource.resourceId),
        resource as GovernanceCapabilityResource & { resourceType: 'election' | 'proposal' },
      );
    } else if (resource.resourceType === 'candidacy' && resource.parentResourceId) {
      const election: GovernanceCapabilityResource & { resourceType: 'election' } = {
        parentResourceId: null,
        resourceId: resource.parentResourceId,
        resourceKey: null,
        resourceState: 'nominations_open',
        resourceType: 'election',
        snapshotId: null,
        subjectEntityId: null,
      };
      const key = resourceContextKey('election', election.resourceId);
      if (!targets.has(key)) targets.set(key, election);
    }
  }
  return [...targets.values()];
}

function capabilitySpecs(resource: GovernanceCapabilityResource): CapabilitySpec[] {
  switch (resource.resourceType) {
    case 'institution':
      return [
        {
          actionCode: 'governance.proposal.create',
          allowActiveLaw: false,
          capability: 'proposal.create',
          policyActionCode: 'governance.propose',
          policyResourceType: 'proposal',
          resource,
        },
      ];
    case 'office':
      return [
        {
          actionCode: 'governance.office.appoint',
          allowActiveLaw: false,
          capability: 'office.appoint',
          policyActionCode: 'governance.appoint',
          policyResourceType: 'office',
          resource,
        },
      ];
    case 'office_term':
      return resource.resourceState === 'active' || resource.resourceState === 'scheduled'
        ? [
            {
              actionCode: 'governance.office.remove',
              allowActiveLaw: false,
              capability: 'office.remove',
              policyActionCode: 'governance.appoint',
              policyResourceType: 'office',
              resource,
            },
          ]
        : [];
    case 'candidacy':
      return resource.resourceState === 'nominated' && resource.parentResourceId
        ? [civic(resource, 'governance.candidate.accept', 'candidate.accept')]
        : [];
    case 'proposal': {
      const specs: CapabilitySpec[] = [];
      if (resource.resourceState === 'draft' || resource.resourceState === 'sponsoring') {
        specs.push(civic(resource, 'governance.proposal.sponsor', 'proposal.sponsor'));
      }
      if (['draft', 'sponsoring', 'debate', 'scheduled'].includes(resource.resourceState)) {
        specs.push(civic(resource, 'governance.proposal.withdraw', 'proposal.withdraw'));
      }
      if (resource.resourceState === 'open' && resource.snapshotId) {
        specs.push(civic(resource, 'governance.ballot.cast', 'proposal.ballot.cast'));
      }
      return specs;
    }
    case 'election':
      if (resource.resourceState === 'nominations_open') {
        return [civic(resource, 'governance.candidate.nominate', 'candidate.nominate')];
      }
      return resource.resourceState === 'open' && resource.snapshotId
        ? [civic(resource, 'governance.ballot.cast', 'election.ballot.cast')]
        : [];
  }
}

function civic(
  resource: GovernanceCapabilityResource,
  actionCode: AuthorityAction,
  capability: GovernanceUiCapabilityCodeV1,
): CapabilitySpec {
  return {
    actionCode,
    allowActiveLaw: true,
    capability,
    policyActionCode: null,
    resource,
  };
}

function authorityInput(
  actor: AuthenticatedActor,
  worldId: string,
  spec: CapabilitySpec,
): GovernanceAuthorityPreparationInput {
  const candidacy = spec.resource.resourceType === 'candidacy';
  return {
    actionCode: spec.actionCode,
    actorId: actor.user.id,
    actorMode: 'in_world',
    allowActiveLaw: spec.allowActiveLaw,
    overrideRequested: false,
    platformRole: actor.user.platformRole,
    policyActionCode: spec.policyActionCode,
    ...(spec.policyResourceType ? { policyResourceType: spec.policyResourceType } : {}),
    resourceId: candidacy ? spec.resource.parentResourceId! : spec.resource.resourceId,
    // Proposal keys are user input and cannot be pre-authorized as an institution key.
    resourceKey: null,
    resourceType: candidacy ? 'election' : spec.resource.resourceType,
    worldId,
  };
}

function decision(
  capability: GovernanceUiCapabilityCodeV1,
  resourceType: GovernanceUiCapabilityDecisionV1['resourceType'],
  resourceId: string,
  preparation: NonNullable<Awaited<ReturnType<GovernanceCommandGateway['prepareAuthority']>>>,
): GovernanceUiCapabilityDecisionV1 {
  return {
    allowed: preparation.authorization.allowed,
    capability,
    reasonCode: preparation.authorization.reasonCode,
    resourceId,
    resourceType,
    ruleId: preparation.authorization.ruleId,
  };
}

function scopedDecision(
  spec: CapabilitySpec,
  preparation: NonNullable<Awaited<ReturnType<GovernanceCommandGateway['prepareAuthority']>>>,
  actorContext: GovernanceActorCapabilityContext,
  resourceContext: GovernanceActorCapabilityContext | null,
): GovernanceUiCapabilityDecisionV1 {
  const outputType = spec.resource.resourceType;
  const base = decision(spec.capability, outputType, spec.resource.resourceId, preparation);
  if (!base.allowed) return base;
  if (
    spec.capability === 'proposal.withdraw' &&
    spec.resource.subjectEntityId !== actorContext.actorEntityId
  ) {
    return denied(base, 'PROPOSER_REQUIRED', 'governance.proposal.proposer_required');
  }
  if (
    spec.capability === 'candidate.accept' &&
    spec.resource.subjectEntityId !== actorContext.actorEntityId
  ) {
    return denied(base, 'CANDIDATE_SELF_REQUIRED', 'governance.candidate.self_required');
  }
  if (
    (spec.capability === 'candidate.nominate' || spec.capability === 'candidate.accept') &&
    !resourceContext?.candidateEligible
  ) {
    return denied(base, 'CANDIDATE_INELIGIBLE', 'governance.candidate.office_eligibility');
  }
  if (spec.capability === 'proposal.ballot.cast' || spec.capability === 'election.ballot.cast') {
    if (!resourceContext?.eligible) {
      return denied(base, 'BALLOT_INELIGIBLE', 'governance.ballot.frozen_snapshot_membership');
    }
    if (resourceContext.hasBallot && !resourceContext.ballotReplacementAllowed) {
      return denied(
        base,
        'BALLOT_REPLACEMENT_NOT_ALLOWED',
        'governance.ballot.effective_ballot_final',
      );
    }
  }
  return base;
}

function denied(
  decisionValue: GovernanceUiCapabilityDecisionV1,
  reasonCode: string,
  ruleId: string,
): GovernanceUiCapabilityDecisionV1 {
  return { ...decisionValue, allowed: false, reasonCode, ruleId };
}

function scopedContextFor(
  resource: GovernanceCapabilityResource,
  contexts: ReadonlyMap<string, GovernanceActorCapabilityContext | null>,
): GovernanceActorCapabilityContext | null {
  if (resource.resourceType === 'proposal' || resource.resourceType === 'election') {
    return contexts.get(resourceContextKey(resource.resourceType, resource.resourceId)) ?? null;
  }
  if (resource.resourceType === 'candidacy' && resource.parentResourceId) {
    return contexts.get(resourceContextKey('election', resource.parentResourceId)) ?? null;
  }
  return null;
}

function resourceContextKey(type: 'election' | 'proposal', id: string): string {
  return `${type}:${id}`;
}

function authorityState(
  actor: AuthenticatedActor,
  membershipRole: 'administrator' | 'creator' | 'observer' | 'player',
  preparations: ReadonlyArray<
    NonNullable<Awaited<ReturnType<GovernanceCommandGateway['prepareAuthority']>>>
  >,
): GovernanceUiActorAuthorityStateV1 {
  if (actor.user.platformRole === 'platform_admin') return 'platform_administrator';
  if (membershipRole === 'creator') return 'creator';
  if (membershipRole === 'administrator') return 'world_administrator';
  if (membershipRole === 'observer') return 'observer';
  return preparations.some((preparation) => {
    const keys = preparation.authorization.context['heldOfficeKeys'];
    return Array.isArray(keys) && keys.length > 0;
  })
    ? 'officeholder'
    : 'player';
}

function evaluatedTick(
  preparations: ReadonlyArray<
    NonNullable<Awaited<ReturnType<GovernanceCommandGateway['prepareAuthority']>>>
  >,
): string | null {
  let evaluatedAtTick: string | null = null;
  for (const preparation of preparations) {
    const tick = preparation.authorization.context['tick'];
    if (typeof tick !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(tick)) {
      throw new ApplicationError(
        'GOVERNANCE_CAPABILITY_INVALID',
        'Governance capability evidence is incomplete.',
        503,
      );
    }
    if (evaluatedAtTick !== null && evaluatedAtTick !== tick) return null;
    evaluatedAtTick = tick;
  }
  if (evaluatedAtTick !== null) return evaluatedAtTick;
  throw new ApplicationError(
    'GOVERNANCE_CAPABILITY_INVALID',
    'Governance capability evidence is incomplete.',
    503,
  );
}

function compareDecisions(
  left: GovernanceUiCapabilityDecisionV1,
  right: GovernanceUiCapabilityDecisionV1,
): number {
  return `${left.capability}:${left.resourceType}:${left.resourceId}`.localeCompare(
    `${right.capability}:${right.resourceType}:${right.resourceId}`,
  );
}

function notFound(): never {
  throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
}
