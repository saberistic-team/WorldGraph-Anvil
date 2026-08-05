import {
  ElectionBallotRecordedPublicEventV1Schema,
  GovernanceSeedProposalRulesV1Schema,
  ProposalBallotRecordedPublicEventV1Schema,
  createValidator,
  type GovernanceCommandRequestV1,
  type GovernanceElectionChoiceV1,
  type GovernanceOverrideEffectV1,
  type GovernanceProposalActionV1,
  type GovernanceProposalChoice,
  type GovernanceSeedPlanV1,
  type SafeGovernanceEventPayloadV1,
} from '@worldgraph/contracts';
import {
  GovernanceDomainError,
  assertGovernanceSeedPlanV1,
  calculateOfficeTermV1,
  governanceSeedPlanHashV1,
  tallyElectionPluralityV1,
  tallyProposalYesNoV1,
} from '@worldgraph/governance';

import { governanceTwoPersonApprovalBindingHashV1 } from './approval.js';
import { GovernanceCommandError, mapPostgresGovernanceRejection } from './errors.js';
import {
  actionKind,
  addDecimal,
  ceilBasisPoints,
  proposalType,
  queryOne,
  safeJson,
  sha256Buffer,
  sha256Hex,
  type GovernanceHandlerContext,
  type GovernanceHandlerOutcome,
  type GovernancePlannedEvent,
} from './internal.js';

type HandlerContext<TType extends GovernanceCommandRequestV1['type']> = Omit<
  GovernanceHandlerContext,
  'command'
> & {
  readonly command: Extract<GovernanceCommandRequestV1, { type: TType }>;
};

interface ProposalRow {
  aggregate_version: string;
  allow_ballot_replacement: boolean;
  ballot_disclosure: 'aggregate_only' | 'choice_totals' | 'voter_and_choice';
  ballot_mode: 'public' | 'secret';
  contest_id: string | null;
  contest_version: string | null;
  debate_closes_tick: string;
  minimum_sponsors: number;
  proposal_id: string;
  proposer_entity_id: string;
  quorum_numerator: number;
  sponsorship_closes_tick: string;
  status: string;
  threshold_numerator: number;
  title: string;
  voting_closes_tick: string;
  voting_opens_tick: string;
}

interface ElectionRow {
  aggregate_version: string;
  allow_ballot_replacement: boolean;
  ballot_disclosure: 'aggregate_only' | 'choice_totals' | 'voter_and_choice';
  ballot_mode: 'public' | 'secret';
  certification_tick: string;
  contest_id: string | null;
  contest_version: string | null;
  election_id: string;
  election_kind: 'regular' | 'special';
  election_rule_snapshot: unknown;
  institution_id: string;
  nomination_closes_tick: string;
  nomination_opens_tick: string;
  office_id: string;
  seat_id: string;
  quorum_numerator: number;
  status: string;
  term_starts_tick: string;
  tie_rule: 'stable_key' | 'vacancy';
  voting_closes_tick: string;
  voting_opens_tick: string;
}

interface SuccessorElectionPlan {
  certificationTick: string;
  nominationClosesTick: string;
  nominationOpensTick: string;
  status: 'nominations_open' | 'nominations_scheduled';
  termStartsTick: string;
  votingClosesTick: string;
  votingOpensTick: string;
}

interface CastResultRow {
  ballot_mode: 'public' | 'secret';
  choice_totals: unknown;
  effective_revision: number;
  participation_id: string;
  participation_version: string;
  receipt_hash: Buffer;
}

interface SnapshotMemberRow {
  held_office_keys: string[];
  membership_role: string;
  membership_version: number;
  organization_keys: string[];
  voter_entity_id: string;
  voter_entity_key: string;
}

interface EligibilityPolicySourceRow {
  eligibility_policy: Record<string, unknown>;
  policy_source_id: string;
  policy_source_kind: 'charter_citizen_eligibility' | 'office_eligibility';
  policy_source_version: string;
}

interface ProposalTallyRow {
  algorithm_version: string;
  input_checksum: Buffer;
  output_checksum: Buffer;
  proposal_id: string;
  tally_id: string;
}

interface ElectionTallyRow {
  algorithm_version: string;
  election_id: string;
  input_checksum: Buffer;
  output_checksum: Buffer;
  tally_id: string;
}

interface ProposalActionRow {
  action_id: string;
  action_kind: string;
  action_ordinal: number;
  action_payload: GovernanceProposalActionV1;
}

type GovernanceProposalRulesV1 = GovernanceSeedPlanV1['charter']['proposalRules'];

interface ActiveInstitutionProposalPolicyRow {
  charter_version: string;
  jurisdiction_entity_id: string;
  jurisdiction_entity_key: string;
  proposal_rules: unknown;
}

interface DerivedProposalPolicy {
  debateEndsAtTick: string;
  rules: GovernanceProposalRulesV1;
  sponsorshipEndsAtTick: string;
  votingClosesAtTick: string;
  votingOpensAtTick: string;
}

const governanceProposalRulesValidator = createValidator<GovernanceProposalRulesV1>(
  GovernanceSeedProposalRulesV1Schema,
);
type ProposalPublicBallotEventV1 = Extract<
  SafeGovernanceEventPayloadV1,
  { eventType: 'ProposalBallotRecordedPublicV1' }
>;
type ElectionPublicBallotEventV1 = Extract<
  SafeGovernanceEventPayloadV1,
  { eventType: 'ElectionBallotRecordedPublicV1' }
>;
const proposalPublicBallotEventValidator = createValidator<ProposalPublicBallotEventV1>(
  ProposalBallotRecordedPublicEventV1Schema,
);
const electionPublicBallotEventValidator = createValidator<ElectionPublicBallotEventV1>(
  ElectionBallotRecordedPublicEventV1Schema,
);
const POSTGRES_INT64_MAX = 9_223_372_036_854_775_807n;

export async function dispatchGovernanceHandler(
  context: GovernanceHandlerContext,
): Promise<GovernanceHandlerOutcome> {
  try {
    switch (context.command.type) {
      case 'InitializeWorldGovernanceV1':
        return await initializeWorldGovernance(
          context as HandlerContext<'InitializeWorldGovernanceV1'>,
        );
      case 'AdoptGovernanceSeedPlanV1':
        return await adoptGovernanceSeedPlan(
          context as HandlerContext<'AdoptGovernanceSeedPlanV1'>,
        );
      case 'CreateProposalV1':
        return await createProposal(context as HandlerContext<'CreateProposalV1'>);
      case 'SponsorProposalV1':
        return await sponsorProposal(context as HandlerContext<'SponsorProposalV1'>);
      case 'WithdrawProposalV1':
        return await withdrawProposal(context as HandlerContext<'WithdrawProposalV1'>);
      case 'OpenProposalVotingV1':
        return await openProposal(context as HandlerContext<'OpenProposalVotingV1'>);
      case 'CastProposalBallotV1':
        return await castProposalBallot(context as HandlerContext<'CastProposalBallotV1'>);
      case 'CloseAndTallyProposalV1':
        return await closeAndTallyProposal(context as HandlerContext<'CloseAndTallyProposalV1'>);
      case 'CertifyAndEnactProposalV1':
        return await certifyAndEnactProposal(
          context as HandlerContext<'CertifyAndEnactProposalV1'>,
        );
      case 'NominateCandidateV1':
        return await nominateCandidate(context as HandlerContext<'NominateCandidateV1'>);
      case 'AcceptNominationV1':
        return await acceptNomination(context as HandlerContext<'AcceptNominationV1'>);
      case 'OpenElectionV1':
        return await openElection(context as HandlerContext<'OpenElectionV1'>);
      case 'CastElectionBallotV1':
        return await castElectionBallot(context as HandlerContext<'CastElectionBallotV1'>);
      case 'CloseAndTallyElectionV1':
        return await closeAndTallyElection(context as HandlerContext<'CloseAndTallyElectionV1'>);
      case 'CertifyElectionV1':
        return await certifyElection(context as HandlerContext<'CertifyElectionV1'>);
      case 'AppointOfficeholderV1':
        return await appointOfficeholder(context as HandlerContext<'AppointOfficeholderV1'>);
      case 'RemoveOfficeholderV1':
        return await removeOfficeholder(context as HandlerContext<'RemoveOfficeholderV1'>);
      case 'ExecuteCreatorOverrideV1':
        return await executeCreatorOverride(context as HandlerContext<'ExecuteCreatorOverrideV1'>);
      case 'RepairGovernanceResultV1':
        return await repairGovernanceResult(context as HandlerContext<'RepairGovernanceResultV1'>);
    }
    throw new GovernanceCommandError(
      'COMMAND_TYPE_DISABLED',
      'Governance command type is disabled.',
    );
  } catch (error) {
    if (error instanceof GovernanceCommandError) throw error;
    if (error instanceof GovernanceDomainError) {
      throw new GovernanceCommandError(
        error.code.startsWith('TALLY_') ? 'VALIDATION_FAILED' : 'GOVERNANCE_POLICY_DENIED',
        error.message,
      );
    }
    const mapped = mapPostgresGovernanceRejection(error as { code?: string; constraint?: string });
    if (mapped) throw mapped;
    throw error;
  }
}

async function initializeWorldGovernance(
  context: HandlerContext<'InitializeWorldGovernanceV1'>,
): Promise<GovernanceHandlerOutcome> {
  const { payload } = context.command;
  const existing = await queryOne<{ present: boolean }>(
    context.client,
    `/* governance:initialize:head-check */
     select true as present from world_governance_heads where world_id=$1 for update`,
    [context.input.worldId],
  );
  if (existing) {
    throw new GovernanceCommandError(
      'GOVERNANCE_ALREADY_INITIALIZED',
      'Governance has already been initialized for this world.',
    );
  }
  if (payload.compiledWorldVersionId !== context.world.active_world_version_id) {
    throw new GovernanceCommandError(
      'SEED_PLAN_INCOMPATIBLE',
      'The governance seed belongs to a different active world version.',
    );
  }
  const seed = await queryOne<{ canonical_plan: GovernanceSeedPlanV1; plan_hash: Buffer }>(
    context.client,
    `/* governance:initialize:load-seed */
     select canonical_plan,plan_hash
       from compiled_governance_seed_plans
      where world_id=$1 and world_version_id=$2`,
    [context.input.worldId, payload.compiledWorldVersionId],
  );
  if (!seed) {
    throw new GovernanceCommandError(
      'SEED_PLAN_INCOMPATIBLE',
      'The compiled world has no compatible governance seed plan.',
    );
  }
  if (seed.plan_hash.toString('hex') !== payload.seedPlanHash) {
    throw new GovernanceCommandError('SEED_PLAN_HASH_MISMATCH', 'The seed plan hash is stale.');
  }
  const plan = assertGovernanceSeedPlanV1(seed.canonical_plan);
  if (governanceSeedPlanHashV1(plan) !== payload.seedPlanHash) {
    throw new GovernanceCommandError('SEED_PLAN_HASH_MISMATCH', 'The seed plan is not canonical.');
  }
  const materialized = await materializeSeedPlan(context, plan, payload.seedPlanHash);
  return {
    event: plannedEvent(context, {
      aggregateId: context.input.worldId,
      aggregateType: 'world_governance',
      aggregateVersion: '1',
      eventType: 'WorldGovernanceInitializedV1',
      payload: {
        eventType: 'WorldGovernanceInitializedV1',
        seedPlanHash: payload.seedPlanHash,
        sourceWorldVersionId: payload.compiledWorldVersionId,
      },
      summaryCode: 'WORLD_GOVERNANCE_INITIALIZED',
    }),
    headCreated: true,
    responseDetails: materialized,
  };
}

async function adoptGovernanceSeedPlan(
  context: HandlerContext<'AdoptGovernanceSeedPlanV1'>,
): Promise<GovernanceHandlerOutcome> {
  const { payload } = context.command;
  const existing = await queryOne<{ present: boolean }>(
    context.client,
    `/* governance:adopt:head-check */
     select true as present from world_governance_heads where world_id=$1 for update`,
    [context.input.worldId],
  );
  if (existing) {
    throw new GovernanceCommandError(
      'GOVERNANCE_ALREADY_INITIALIZED',
      'Governance has already been initialized for this world.',
    );
  }
  if (payload.compiledWorldVersionId !== context.world.active_world_version_id) {
    throw new GovernanceCommandError(
      'SEED_PLAN_INCOMPATIBLE',
      'The adopted governance seed targets a different world version.',
    );
  }
  const plan = assertGovernanceSeedPlanV1(payload.seedPlan);
  if (governanceSeedPlanHashV1(plan) !== payload.seedPlanHash) {
    throw new GovernanceCommandError(
      'SEED_PLAN_HASH_MISMATCH',
      'The adopted seed plan hash does not match its canonical content.',
    );
  }
  if (context.world.anchor_artifact_hash?.toString('hex') !== payload.sourceArtifactHash) {
    throw new GovernanceCommandError(
      'SEED_PLAN_INCOMPATIBLE',
      'The adopted seed does not reference the active world anchor.',
    );
  }
  await context.client.query(
    `/* governance:adopt:insert-seed */
     insert into compiled_governance_seed_plans(
       id,world_id,world_version_id,source_kind,source_compiler_version,
       source_artifact_hash,governance_seed_plan_schema_version,canonical_plan,
       plan_hash,adopted_command_id,adopted_event_id
     ) values ($1,$2,$3,'adopted_legacy',$4,$5,1,$6,$7,$8,$9)`,
    [
      context.ids.next(),
      context.input.worldId,
      payload.compiledWorldVersionId,
      '1.2.0',
      Buffer.from(payload.sourceArtifactHash, 'hex'),
      safeJson(plan),
      Buffer.from(payload.seedPlanHash, 'hex'),
      context.command.commandId,
      context.eventId,
    ],
  );
  const materialized = await materializeSeedPlan(context, plan, payload.seedPlanHash);
  return {
    event: plannedEvent(context, {
      aggregateId: context.input.worldId,
      aggregateType: 'world_governance',
      aggregateVersion: '1',
      eventType: 'GovernanceSeedPlanAdoptedV1',
      payload: {
        adoptionReasonHash: sha256Hex(payload.adoptionReason),
        eventType: 'GovernanceSeedPlanAdoptedV1',
        seedPlanHash: payload.seedPlanHash,
      },
      summaryCode: 'GOVERNANCE_SEED_PLAN_ADOPTED',
    }),
    headCreated: true,
    responseDetails: materialized,
  };
}

async function materializeSeedPlan(
  context: GovernanceHandlerContext,
  plan: GovernanceSeedPlanV1,
  planHash: string,
): Promise<Record<string, unknown>> {
  const worldId = context.input.worldId;
  const commandId = context.command.commandId;
  const eventId = context.eventId;
  const revision = context.resultingStateRevision;
  const sourceVersionId = context.world.active_world_version_id;
  const charterJurisdiction = await resolveEntityId(
    context,
    plan.institutions[0]!.jurisdictionEntityKey,
  );
  const charterId = context.ids.next();
  const charterVersionId = context.ids.next();
  const charterDocument = {
    citizenEligibilityPolicy: plan.charter.citizenEligibilityPolicy,
    proposalRules: plan.charter.proposalRules,
    summary: plan.charter.summary,
    title: plan.charter.title,
  };
  const charterChecksum = sha256Buffer({
    charterDocument,
    charterId,
    charterVersion: 1,
    effectiveFromTick: plan.charter.effectiveFromTick,
  });
  const charterAuthorityIntervalId = context.ids.next();
  await context.client.query(
    `/* governance:seed:charter */
     insert into governing_charters(
       id,world_id,stable_key,jurisdiction_entity_id,row_version,
       created_command_id,created_event_id,created_state_revision
     ) values ($1,$2,$3,$4,1,$5,$6,$7::bigint)`,
    [charterId, worldId, plan.charter.stableKey, charterJurisdiction, commandId, eventId, revision],
  );
  await context.client.query(
    `/* governance:seed:charter-version */
     insert into governing_charter_versions(
       id,world_id,charter_id,charter_version,source_world_version_id,seed_plan_hash,
       policy_dsl_version,canonical_policy_document,checksum,effective_from_tick,
       declared_until_tick,provenance,created_command_id,created_event_id,created_state_revision
     ) values ($1,$2,$3,1,$4,$5,1,$6,$7,$8::bigint,$9::bigint,$10,$11,$12,$13::bigint)`,
    [
      charterVersionId,
      worldId,
      charterId,
      sourceVersionId,
      Buffer.from(planHash, 'hex'),
      safeJson(charterDocument),
      charterChecksum,
      plan.charter.effectiveFromTick,
      plan.charter.effectiveUntilTick,
      safeJson({ source: 'governance_seed_plan_v1' }),
      commandId,
      eventId,
      revision,
    ],
  );
  await context.client.query(
    `/* governance:seed:charter-authority */
     insert into charter_authority_intervals(
       id,world_id,charter_id,charter_version_id,effective_ticks,
       created_command_id,updated_command_id,row_version
     ) values ($1,$2,$3,$4,int8range($5::bigint,$6::bigint,'[)'),$7,$7,1)`,
    [
      charterAuthorityIntervalId,
      worldId,
      charterId,
      charterVersionId,
      plan.charter.effectiveFromTick,
      plan.charter.effectiveUntilTick,
      commandId,
    ],
  );

  const institutionIds = new Map<string, string>();
  for (const institution of plan.institutions) {
    const institutionId = context.ids.next();
    institutionIds.set(institution.stableKey, institutionId);
    const entityId = await resolveEntityId(context, institution.worldEntityKey);
    const jurisdictionId = await resolveEntityId(context, institution.jurisdictionEntityKey);
    await context.client.query(
      `/* governance:seed:institution */
       insert into institutions(
         id,world_id,entity_id,charter_version_id,jurisdiction_entity_id,stable_key,
         institution_type,status,row_version,created_command_id,created_event_id,
         created_state_revision
       ) values ($1,$2,$3,$4,$5,$6,$7,'active',1,$8,$9,$10::bigint)`,
      [
        institutionId,
        worldId,
        entityId,
        charterVersionId,
        jurisdictionId,
        institution.stableKey,
        institution.institutionType,
        commandId,
        eventId,
        revision,
      ],
    );
    for (const [ordinal, power] of institution.powers.entries()) {
      const powerKey = `${institution.stableKey.replaceAll(':', '.')}.power.${ordinal + 1}`;
      await context.client.query(
        `/* governance:seed:institution-power */
         insert into institution_powers(
           id,world_id,institution_id,charter_version_id,power_key,action_code,
           resource_type,scope_policy,policy_dsl_version,checksum,
           created_command_id,created_event_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11)`,
        [
          context.ids.next(),
          worldId,
          institutionId,
          charterVersionId,
          powerKey,
          power.action,
          power.resourceType,
          safeJson(power.policy),
          sha256Buffer({ power, powerKey }),
          commandId,
          eventId,
        ],
      );
    }
  }

  for (const law of plan.initialLaws) {
    const lawId = context.ids.next();
    const lawVersionId = context.ids.next();
    const jurisdictionId = await resolveEntityId(context, law.jurisdictionEntityKey);
    const checksum = sha256Buffer({ law, version: 1 });
    const transitionId = context.ids.next();
    const transitionChecksum = sha256Buffer({
      lawId,
      status: 'initial',
      tick: law.effectiveFromTick,
    });
    const authorityIntervalId = context.ids.next();
    await context.client.query(
      `/* governance:seed:law */
       insert into laws(
         id,world_id,jurisdiction_entity_id,stable_key,title,
         created_command_id,created_event_id,created_state_revision
       ) values ($1,$2,$3,$4,$5,$6,$7,$8::bigint)`,
      [lawId, worldId, jurisdictionId, law.stableKey, law.title, commandId, eventId, revision],
    );
    await context.client.query(
      `/* governance:seed:law-version */
       insert into law_versions(
         id,world_id,law_id,law_version,version_kind,initial_status,title,summary,
         policy_ast,action_effects,policy_dsl_version,supersedes_version_id,
         source_proposal_result_id,source_action_ordinal,effective_from_tick,checksum,
         created_command_id,created_event_id,created_state_revision
       ) values ($1,$2,$3,1,'create',case when $4::bigint <= $5::bigint then 'active' else 'scheduled' end,
         $6,$7,$8,'{}'::jsonb,1,null,null,null,$4::bigint,$9,$10,$11,$12::bigint)`,
      [
        lawVersionId,
        worldId,
        lawId,
        law.effectiveFromTick,
        context.world.current_tick,
        law.title,
        law.summary,
        safeJson(law.policy),
        checksum,
        commandId,
        eventId,
        revision,
      ],
    );
    await context.client.query(
      `/* governance:seed:law-transition */
       insert into law_effectivity_transitions(
         id,world_id,law_id,law_version_id,from_status,to_status,effective_tick,
         command_id,event_id,state_revision,checksum
       ) values ($1,$2,$3,$4,null,case when $5::bigint <= $6::bigint then 'active' else 'scheduled' end,
         $5::bigint,$7,$8,$9::bigint,$10)`,
      [
        transitionId,
        worldId,
        lawId,
        lawVersionId,
        law.effectiveFromTick,
        context.world.current_tick,
        commandId,
        eventId,
        revision,
        transitionChecksum,
      ],
    );
    await context.client.query(
      `/* governance:seed:law-authority */
       insert into law_authority_intervals(
         id,world_id,law_id,law_version_id,effective_ticks,created_command_id,
         updated_command_id,row_version
       ) values ($1,$2,$3,$4,int8range($5::bigint,$6::bigint,'[)'),$7,$7,1)`,
      [
        authorityIntervalId,
        worldId,
        lawId,
        lawVersionId,
        law.effectiveFromTick,
        law.effectiveUntilTick,
        commandId,
      ],
    );
  }

  let officeCount = 0;
  let electionCount = 0;
  for (const office of plan.offices) {
    const institutionId = institutionIds.get(office.institutionKey);
    if (!institutionId) {
      throw new GovernanceCommandError(
        'SEED_PLAN_INCOMPATIBLE',
        'An office references an institution outside the governance seed.',
      );
    }
    const officeId = context.ids.next();
    await context.client.query(
      `/* governance:seed:office */
       insert into political_offices(
         id,world_id,institution_id,charter_version_id,stable_key,title,
         selection_method,seat_count,term_ticks,eligibility_policy,tie_policy,
         vacancy_policy,row_version,created_command_id,created_event_id,created_state_revision
       ) values ($1,$2,$3,$4,$5,$6,'election',$7,$8::bigint,$9,$10,
         'special_election',1,$11,$12,$13::bigint)`,
      [
        officeId,
        worldId,
        institutionId,
        charterVersionId,
        office.stableKey,
        office.displayName,
        office.seats,
        office.termDurationTicks,
        safeJson(office.eligibilityPolicy),
        office.tieRule,
        commandId,
        eventId,
        revision,
      ],
    );
    const seatIds: string[] = [];
    for (let seatIndex = 0; seatIndex < office.seats; seatIndex += 1) {
      const seatId = context.ids.next();
      seatIds.push(seatId);
      await context.client.query(
        `/* governance:seed:seat */
         insert into political_office_seats(
           id,world_id,office_id,seat_ordinal,stable_key,status,
           created_command_id,created_event_id
         ) values ($1,$2,$3,$4,$5,'active',$6,$7)`,
        [
          seatId,
          worldId,
          officeId,
          seatIndex + 1,
          `${office.stableKey}.seat.${seatIndex + 1}`,
          commandId,
          eventId,
        ],
      );
    }
    for (const [ordinal, power] of office.powers.entries()) {
      const powerKey = `${office.stableKey.replaceAll(':', '.')}.power.${ordinal + 1}`;
      const powerId = context.ids.next();
      const powerChecksum = sha256Buffer({ power, powerKey });
      await context.client.query(
        `/* governance:seed:office-power */
         insert into office_powers(
           id,world_id,office_id,charter_version_id,power_key,action_code,
           resource_type,scope_policy,policy_dsl_version,checksum,
           created_command_id,created_event_id
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11)`,
        [
          powerId,
          worldId,
          officeId,
          charterVersionId,
          powerKey,
          power.action,
          power.resourceType,
          safeJson(power.policy),
          powerChecksum,
          commandId,
          eventId,
        ],
      );
      for (const [
        delegationOrdinal,
        organizationKey,
      ] of power.delegatedOrganizationEntityKeys.entries()) {
        const organizationEntityId = await resolveEntityId(context, organizationKey);
        const delegationKey = `${powerKey}.delegation.${delegationOrdinal + 1}`;
        const delegationChecksum = sha256Buffer({
          charterVersionId,
          delegationKey,
          granteeOrganizationEntityId: organizationEntityId,
          officePowerChecksum: powerChecksum.toString('hex'),
          officePowerId: powerId,
          worldId,
        });
        await context.client.query(
          `/* governance:seed:office-power-delegation */
           insert into office_power_delegations(
             id,world_id,office_power_id,charter_version_id,
             grantee_organization_entity_id,delegation_key,checksum,
             created_command_id,created_event_id
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            context.ids.next(),
            worldId,
            powerId,
            charterVersionId,
            organizationEntityId,
            delegationKey,
            delegationChecksum,
            commandId,
            eventId,
          ],
        );
      }
    }
    const nominationOpen = context.world.current_tick;
    const cadence = BigInt(office.electionCadenceTicks);
    const nominationClose = (BigInt(nominationOpen) + maxBigInt(1n, cadence / 4n)).toString();
    const votingOpen = nominationClose;
    const votingClose = (BigInt(votingOpen) + maxBigInt(1n, cadence / 4n)).toString();
    const certificationTick = (
      BigInt(votingClose) + BigInt(office.transitionDelayTicks)
    ).toString();
    const termStart = certificationTick;
    for (const [seatIndex, seatId] of seatIds.entries()) {
      const electionId = context.ids.next();
      const contestId = context.ids.next();
      await context.client.query(
        `/* governance:seed:election */
         insert into elections(
           id,world_id,institution_id,office_id,seat_id,election_kind,status,
           nomination_opens_tick,nomination_closes_tick,voting_opens_tick,
           voting_closes_tick,certification_tick,term_starts_tick,
           quorum_numerator,quorum_denominator,tie_rule,ballot_mode,ballot_disclosure,
           allow_ballot_replacement,election_rule_snapshot,aggregate_version,
           created_command_id,created_event_id,created_state_revision
         ) values ($1,$2,$3,$4,$5,'regular','nominations_open',$6::bigint,$7::bigint,
           $8::bigint,$9::bigint,$10::bigint,$11::bigint,$12,10000,$13,$14,$15,$16,$17,1,$18,$19,$20::bigint)`,
        [
          electionId,
          worldId,
          institutionId,
          officeId,
          seatId,
          nominationOpen,
          nominationClose,
          votingOpen,
          votingClose,
          certificationTick,
          termStart,
          plan.charter.proposalRules.quorumBps,
          office.tieRule,
          office.ballotPolicy.ballotMode,
          office.ballotPolicy.disclosure,
          office.ballotPolicy.replacementAllowed,
          safeJson({
            ballotPolicy: office.ballotPolicy,
            electionCadenceTicks: office.electionCadenceTicks,
            eligibilityPolicy: office.eligibilityPolicy,
            officeKey: office.stableKey,
            seatIndex,
            transitionDelayTicks: office.transitionDelayTicks,
          }),
          commandId,
          eventId,
          revision,
        ],
      );
      await context.client.query(
        `/* governance:seed:election-stream */
         select worldgraph_seed_governance_aggregate_stream_v1($1,$2,'election',$3)`,
        [worldId, commandId, electionId],
      );
      await context.client.query(
        `/* governance:seed:election-contest */
         insert into governance_contests(
           id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
           opens_tick,closes_tick,allow_replacement,aggregate_version,
           created_command_id,created_event_id,created_state_revision
         ) values ($1,$2,'election',$3,$4,'scheduled',$5::bigint,$6::bigint,$7,1,$8,$9,$10::bigint)`,
        [
          contestId,
          worldId,
          office.ballotPolicy.ballotMode,
          office.ballotPolicy.disclosure,
          votingOpen,
          votingClose,
          office.ballotPolicy.replacementAllowed,
          commandId,
          eventId,
          revision,
        ],
      );
      await context.client.query(
        `/* governance:seed:election-contest-link */
         insert into election_contests(
           contest_id,world_id,election_id,office_id,seat_id,contest_ordinal,seats_to_fill
         ) values ($1,$2,$3,$4,$5,$6,1)`,
        [contestId, worldId, electionId, officeId, seatId, 1],
      );
      await createScheduledAction(
        context,
        'OpenElectionV1',
        electionId,
        nominationClose,
        'election',
      );
      await createScheduledAction(
        context,
        'CloseAndTallyElectionV1',
        electionId,
        votingClose,
        'election',
      );
      await createScheduledAction(
        context,
        'CertifyElectionV1',
        electionId,
        certificationTick,
        'election',
      );
      electionCount += 1;
    }
    officeCount += 1;
  }

  await context.client.query(
    `/* governance:seed:head */
     insert into world_governance_heads(
       world_id,source_world_version_id,seed_plan_hash,governance_schema_version,
       projection_schema_version,checksum,row_version,updated_state_revision,
       initialized_command_id,initialized_event_id,created_at,updated_at
     ) values ($1,$2,$3,1,1,$4,1,$5::bigint,$6,$7,$8,$8)`,
    [
      worldId,
      sourceVersionId,
      Buffer.from(planHash, 'hex'),
      sha256Buffer({ domain: 'worldgraph.governance-projection.v1', planHash, revision }),
      revision,
      commandId,
      eventId,
      context.world.recorded_at,
    ],
  );
  return {
    charterId,
    electionCount,
    institutionCount: plan.institutions.length,
    lawCount: plan.initialLaws.length,
    officeCount,
  };
}

async function loadActiveInstitutionProposalPolicy(
  context: HandlerContext<'CreateProposalV1'>,
  institutionId: string,
): Promise<ActiveInstitutionProposalPolicyRow> {
  const institution = await queryOne<ActiveInstitutionProposalPolicyRow>(
    context.client,
    `/* governance:proposal:active-charter-policy */
     select charter.charter_version::text,
       institution.jurisdiction_entity_id::text,
       jurisdiction.logical_key::text as jurisdiction_entity_key,
       charter.canonical_policy_document -> 'proposalRules' as proposal_rules
      from institutions institution
      join world_entities jurisdiction
        on jurisdiction.world_id=institution.world_id
       and jurisdiction.id=institution.jurisdiction_entity_id
       and jurisdiction.retired_world_version_id is null
      join governing_charter_versions charter
        on charter.world_id=institution.world_id
       and charter.id=institution.charter_version_id
      join charter_authority_intervals authority
        on authority.world_id=charter.world_id
       and authority.charter_id=charter.charter_id
       and authority.charter_version_id=charter.id
       and authority.effective_ticks @> $3::bigint
     where institution.world_id=$1 and institution.id=$2 and institution.status='active'`,
    [context.input.worldId, institutionId, context.world.current_tick],
  );
  if (!institution || !governanceProposalRulesValidator.is(institution.proposal_rules)) {
    throw new GovernanceCommandError(
      'GOVERNANCE_POLICY_DENIED',
      'The institution has no valid active charter proposal policy.',
    );
  }
  return institution;
}

function deriveProposalPolicy(
  context: HandlerContext<'CreateProposalV1'>,
  institution: ActiveInstitutionProposalPolicyRow,
): DerivedProposalPolicy {
  const rules = institution.proposal_rules as GovernanceProposalRulesV1;
  const sponsorshipEndsAtTick = BigInt(context.world.current_tick) + BigInt(rules.sponsorshipTicks);
  const debateEndsAtTick = sponsorshipEndsAtTick + BigInt(rules.debateTicks);
  const votingOpensAtTick = debateEndsAtTick;
  const votingClosesAtTick = votingOpensAtTick + BigInt(rules.votingTicks);
  if (votingClosesAtTick > POSTGRES_INT64_MAX) {
    throw new GovernanceCommandError(
      'GOVERNANCE_POLICY_DENIED',
      'The active charter proposal windows exceed the supported world-tick range.',
    );
  }
  return {
    debateEndsAtTick: debateEndsAtTick.toString(),
    rules,
    sponsorshipEndsAtTick: sponsorshipEndsAtTick.toString(),
    votingClosesAtTick: votingClosesAtTick.toString(),
    votingOpensAtTick: votingOpensAtTick.toString(),
  };
}

function assertProposalMatchesActiveCharter(
  context: HandlerContext<'CreateProposalV1'>,
  institution: ActiveInstitutionProposalPolicyRow,
  policy: DerivedProposalPolicy,
): void {
  const { payload } = context.command;
  if (
    payload.targetCharterVersion !== institution.charter_version ||
    (payload.action.actionType === 'create_law' &&
      payload.action.targetCharterVersion !== institution.charter_version)
  ) {
    throw new GovernanceCommandError(
      'AGGREGATE_VERSION_CONFLICT',
      'The active charter version changed before proposal creation.',
    );
  }
  if (payload.jurisdictionEntityKey !== institution.jurisdiction_entity_key) {
    throw new GovernanceCommandError(
      'GOVERNANCE_POLICY_DENIED',
      'The proposal jurisdiction does not match its institution.',
    );
  }
  const ballot = policy.rules.ballotPolicy;
  if (
    payload.approvalThresholdBps !== policy.rules.approvalThresholdBps ||
    payload.minimumSponsors !== policy.rules.minimumSponsors ||
    payload.quorumBps !== policy.rules.quorumBps ||
    payload.ballotPolicy.ballotMode !== ballot.ballotMode ||
    payload.ballotPolicy.disclosure !== ballot.disclosure ||
    payload.ballotPolicy.replacementAllowed !== ballot.replacementAllowed ||
    payload.sponsorshipEndsAtTick !== policy.sponsorshipEndsAtTick ||
    payload.debateEndsAtTick !== policy.debateEndsAtTick ||
    payload.votingOpensAtTick !== policy.votingOpensAtTick ||
    payload.votingClosesAtTick !== policy.votingClosesAtTick
  ) {
    throw new GovernanceCommandError(
      'GOVERNANCE_POLICY_DENIED',
      'Proposal rules and windows must exactly match the active charter.',
    );
  }
}

async function createProposal(
  context: HandlerContext<'CreateProposalV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  requirePolicy(context.policy.allowNewContests, 'GOVERNANCE_CONTESTS_PAUSED');
  const { payload } = context.command;
  requireAuthorityBinding(context, {
    actionCode: 'governance.proposal.create',
    policyActionCode: 'governance.propose',
    policyResourceType: 'proposal',
    resourceId: payload.institutionId,
    resourceType: 'institution',
  });
  if (context.command.expectedAggregateVersion !== '0') {
    throw new GovernanceCommandError(
      'AGGREGATE_VERSION_CONFLICT',
      'A new proposal starts at version zero.',
    );
  }
  const institution = await loadActiveInstitutionProposalPolicy(context, payload.institutionId);
  const proposalPolicy = deriveProposalPolicy(context, institution);
  assertProposalMatchesActiveCharter(context, institution, proposalPolicy);
  const proposerId = requireActorEntity(context);
  const proposalId = context.ids.next();
  const actionId = context.ids.next();
  const contestId = context.ids.next();
  const startingStatus = proposalPolicy.rules.minimumSponsors === 0 ? 'debate' : 'sponsoring';
  const proposalTransitionId = context.ids.next();
  const proposalTransitionChecksum = sha256Buffer({
    proposalId,
    startingStatus,
    version: 1,
  });
  await context.client.query(
    `/* governance:proposal:create */
     insert into proposals(
       id,world_id,institution_id,jurisdiction_entity_id,proposer_entity_id,
       proposal_type,proposal_schema_version,title,body,status,
       sponsorship_closes_tick,debate_closes_tick,voting_opens_tick,voting_closes_tick,
       minimum_sponsors,quorum_numerator,quorum_denominator,threshold_numerator,
       threshold_denominator,ballot_mode,ballot_disclosure,allow_ballot_replacement,
       target_versions,aggregate_version,created_command_id,created_event_id,
       created_state_revision
     ) values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10::bigint,$11::bigint,$12::bigint,
       $13::bigint,$14,$15,10000,$16,10000,$17,$18,$19,$20,1,$21,$22,$23::bigint)`,
    [
      proposalId,
      context.input.worldId,
      payload.institutionId,
      institution.jurisdiction_entity_id,
      proposerId,
      proposalType(payload.action.actionType),
      payload.title,
      payload.body,
      startingStatus,
      proposalPolicy.sponsorshipEndsAtTick,
      proposalPolicy.debateEndsAtTick,
      proposalPolicy.votingOpensAtTick,
      proposalPolicy.votingClosesAtTick,
      proposalPolicy.rules.minimumSponsors,
      proposalPolicy.rules.quorumBps,
      proposalPolicy.rules.approvalThresholdBps,
      proposalPolicy.rules.ballotPolicy.ballotMode,
      proposalPolicy.rules.ballotPolicy.disclosure,
      proposalPolicy.rules.ballotPolicy.replacementAllowed,
      safeJson({ targetCharterVersion: institution.charter_version }),
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
    ],
  );
  await context.client.query(
    `/* governance:proposal:create-action */
     insert into proposal_actions(
       id,world_id,proposal_id,action_ordinal,action_kind,action_schema_version,
       target_kind,target_id,expected_target_version,action_payload,provenance,
       checksum,created_command_id,created_event_id
     ) values ($1,$2,$3,0,$4,1,$5,$6,$7::bigint,$8,$9,$10,$11,$12)`,
    [
      actionId,
      context.input.worldId,
      proposalId,
      actionKind(payload.action.actionType),
      actionTargetKind(payload.action),
      actionTargetId(payload.action),
      actionExpectedVersion(payload.action),
      safeJson(payload.action),
      safeJson({ proposalKey: payload.proposalKey }),
      sha256Buffer(payload.action),
      context.command.commandId,
      context.eventId,
    ],
  );
  await context.client.query(
    `/* governance:proposal:create-transition */
     insert into proposal_transitions(
       id,world_id,proposal_id,from_status,to_status,effective_tick,aggregate_version,
       reason_code,command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,null,$4,$5::bigint,1,'PROPOSAL_CREATED',$6,$7,$8::bigint,$9)`,
    [
      proposalTransitionId,
      context.input.worldId,
      proposalId,
      startingStatus,
      context.world.current_tick,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
      proposalTransitionChecksum,
    ],
  );
  await context.client.query(
    `/* governance:proposal:precreate-contest */
     insert into governance_contests(
       id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
       opens_tick,closes_tick,allow_replacement,aggregate_version,
       created_command_id,created_event_id,created_state_revision
     ) values ($1,$2,'proposal',$3,$4,'scheduled',$5::bigint,$6::bigint,$7,1,$8,$9,$10::bigint)`,
    [
      contestId,
      context.input.worldId,
      proposalPolicy.rules.ballotPolicy.ballotMode,
      proposalPolicy.rules.ballotPolicy.disclosure,
      proposalPolicy.votingOpensAtTick,
      proposalPolicy.votingClosesAtTick,
      proposalPolicy.rules.ballotPolicy.replacementAllowed,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
    ],
  );
  await context.client.query(
    `/* governance:proposal:precreate-contest-link */
     insert into proposal_contests(contest_id,world_id,proposal_id,question)
     values ($1,$2,$3,$4)`,
    [contestId, context.input.worldId, proposalId, payload.title],
  );
  await createScheduledAction(
    context,
    'OpenProposalVotingV1',
    proposalId,
    proposalPolicy.votingOpensAtTick,
    'proposal',
  );
  await createScheduledAction(
    context,
    'CloseAndTallyProposalV1',
    proposalId,
    proposalPolicy.votingClosesAtTick,
    'proposal',
  );
  await createScheduledAction(
    context,
    'CertifyAndEnactProposalV1',
    proposalId,
    proposalPolicy.votingClosesAtTick,
    'proposal',
  );
  return {
    ...lifecycleOutcome(context, 'proposal', proposalId, '1', startingStatus, 'PROPOSAL_CREATED'),
    responseDetails: { contestId, proposalId },
  };
}

async function sponsorProposal(
  context: HandlerContext<'SponsorProposalV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  const proposal = await loadProposal(context, payload.proposalId);
  expectVersion(proposal.aggregate_version, payload.expectedProposalVersion);
  if (
    !['draft', 'sponsoring'].includes(proposal.status) ||
    BigInt(context.world.current_tick) >= BigInt(proposal.sponsorship_closes_tick)
  ) {
    throw new GovernanceCommandError(
      'PROPOSAL_STATE_INVALID',
      'The proposal is not accepting sponsors.',
    );
  }
  const sponsorId = requireActorEntity(context);
  const nextVersion = addDecimal(proposal.aggregate_version);
  const sponsorRecordId = context.ids.next();
  await context.client.query(
    `/* governance:proposal:sponsor */
     insert into proposal_sponsors(
       id,world_id,proposal_id,sponsor_entity_id,sponsored_tick,command_id,event_id,state_revision
     ) values ($1,$2,$3,$4,$5::bigint,$6,$7,$8::bigint)`,
    [
      sponsorRecordId,
      context.input.worldId,
      payload.proposalId,
      sponsorId,
      context.world.current_tick,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
    ],
  );
  const sponsored = await context.client.query(
    `/* governance:proposal:sponsor-increment */
     update proposals set aggregate_version=$4::bigint,
       status=case when (select count(*) from proposal_sponsors where proposal_id=$2) >= minimum_sponsors
         then 'debate' else 'sponsoring' end,updated_at=$5
       where world_id=$1 and id=$2 and aggregate_version=$3::bigint`,
    [
      context.input.worldId,
      payload.proposalId,
      proposal.aggregate_version,
      nextVersion,
      context.world.recorded_at,
    ],
  );
  assertSingle(sponsored, 'AGGREGATE_VERSION_CONFLICT');
  const updated = await loadProposal(context, payload.proposalId);
  await insertProposalTransition(
    context,
    payload.proposalId,
    proposal.status,
    updated.status,
    nextVersion,
    'PROPOSAL_SPONSORED',
  );
  return lifecycleOutcome(
    context,
    'proposal',
    payload.proposalId,
    nextVersion,
    updated.status,
    'PROPOSAL_SPONSORED',
  );
}

async function withdrawProposal(
  context: HandlerContext<'WithdrawProposalV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  const proposal = await loadProposal(context, payload.proposalId);
  expectVersion(proposal.aggregate_version, payload.expectedProposalVersion);
  if (proposal.proposer_entity_id !== requireActorEntity(context)) {
    throw new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Only the proposal owner may withdraw it.',
    );
  }
  if (!['draft', 'sponsoring', 'debate', 'scheduled'].includes(proposal.status)) {
    throw new GovernanceCommandError(
      'PROPOSAL_STATE_INVALID',
      'The proposal can no longer be withdrawn.',
    );
  }
  const nextVersion = addDecimal(proposal.aggregate_version);
  const updated = await context.client.query(
    `/* governance:proposal:withdraw */
     update proposals set status='withdrawn',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and aggregate_version=$5::bigint
      returning id`,
    [
      context.input.worldId,
      payload.proposalId,
      nextVersion,
      context.world.recorded_at,
      proposal.aggregate_version,
    ],
  );
  assertSingle(updated, 'AGGREGATE_VERSION_CONFLICT');
  await insertProposalTransition(
    context,
    payload.proposalId,
    proposal.status,
    'withdrawn',
    nextVersion,
    'PROPOSAL_WITHDRAWN',
  );
  return lifecycleOutcome(
    context,
    'proposal',
    payload.proposalId,
    nextVersion,
    'withdrawn',
    'PROPOSAL_WITHDRAWN',
  );
}

async function openProposal(
  context: HandlerContext<'OpenProposalVotingV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  requirePolicy(context.policy.allowVoting, 'GOVERNANCE_VOTING_PAUSED');
  const { payload } = context.command;
  validateSchedulerPayload(context, payload.occurrenceKey);
  const proposal = await loadProposal(context, payload.proposalId);
  expectVersion(proposal.aggregate_version, payload.expectedProposalVersion);
  if (
    !proposal.contest_id ||
    !['sponsoring', 'scheduled', 'debate'].includes(proposal.status) ||
    BigInt(context.world.current_tick) < BigInt(proposal.voting_opens_tick)
  ) {
    throw new GovernanceCommandError('PROPOSAL_STATE_INVALID', 'Proposal voting is not due.');
  }
  if (BigInt(context.world.current_tick) >= BigInt(proposal.voting_closes_tick)) {
    const nextVersion = addDecimal(proposal.aggregate_version);
    const terminal = await context.client.query(
      `/* governance:proposal:delayed-open-terminal */
       update proposals set status='rejected',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
      [
        context.input.worldId,
        payload.proposalId,
        nextVersion,
        context.world.recorded_at,
        proposal.aggregate_version,
      ],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Proposal changed.');
    }
    const contestTerminal = await context.client.query(
      `/* governance:proposal:delayed-open-contest-terminal */
       update governance_contests set status='cancelled',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and status='scheduled'`,
      [context.input.worldId, proposal.contest_id, nextVersion, context.world.recorded_at],
    );
    if ((contestTerminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Proposal changed.');
    }
    await insertProposalTransition(
      context,
      payload.proposalId,
      proposal.status,
      'rejected',
      nextVersion,
      'PROPOSAL_VOTING_WINDOW_MISSED',
    );
    return {
      ...lifecycleOutcome(
        context,
        'proposal',
        payload.proposalId,
        nextVersion,
        'rejected',
        'PROPOSAL_REJECTED_VOTING_WINDOW_MISSED',
      ),
      responseDetails: {
        rejectionReason: 'voting_window_missed',
        votingClosesTick: proposal.voting_closes_tick,
      },
    };
  }
  const sponsors = await queryOne<{ count: number }>(
    context.client,
    `/* governance:proposal:sponsor-count */
     select count(*)::integer as count from proposal_sponsors where world_id=$1 and proposal_id=$2`,
    [context.input.worldId, payload.proposalId],
  );
  if ((sponsors?.count ?? 0) < proposal.minimum_sponsors) {
    const nextVersion = addDecimal(proposal.aggregate_version);
    const terminal = await context.client.query(
      `/* governance:proposal:sponsorship-terminal */
       update proposals set status='rejected',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
      [
        context.input.worldId,
        payload.proposalId,
        nextVersion,
        context.world.recorded_at,
        proposal.aggregate_version,
      ],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Proposal changed.');
    }
    const contestTerminal = await context.client.query(
      `/* governance:proposal:sponsorship-contest-terminal */
       update governance_contests set status='cancelled',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and status='scheduled'`,
      [context.input.worldId, proposal.contest_id, nextVersion, context.world.recorded_at],
    );
    if ((contestTerminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Proposal changed.');
    }
    await insertProposalTransition(
      context,
      payload.proposalId,
      proposal.status,
      'rejected',
      nextVersion,
      'PROPOSAL_SPONSORSHIP_FAILED',
    );
    return lifecycleOutcome(
      context,
      'proposal',
      payload.proposalId,
      nextVersion,
      'rejected',
      'PROPOSAL_REJECTED_NO_SPONSORS',
    );
  }
  const contestId = proposal.contest_id;
  await createEligibilitySnapshot(context, contestId, payload.eligibilitySnapshot, {
    aggregateId: payload.proposalId,
    aggregateType: 'proposal',
  });
  const nextVersion = addDecimal(proposal.aggregate_version);
  const updated = await context.client.query(
    `/* governance:proposal:open */
     update proposals set status='open',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
    [
      context.input.worldId,
      payload.proposalId,
      nextVersion,
      context.world.recorded_at,
      proposal.aggregate_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1)
    throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Proposal changed.');
  const contestUpdated = await context.client.query(
    `/* governance:proposal:open-contest */
     update governance_contests set status='open',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and status='scheduled'`,
    [context.input.worldId, contestId, nextVersion, context.world.recorded_at],
  );
  if ((contestUpdated.rowCount ?? 0) !== 1)
    throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Proposal contest changed.');
  await insertProposalTransition(
    context,
    payload.proposalId,
    proposal.status,
    'open',
    nextVersion,
    'PROPOSAL_VOTING_OPENED',
  );
  return lifecycleOutcome(
    context,
    'proposal',
    payload.proposalId,
    nextVersion,
    'open',
    'PROPOSAL_VOTING_OPENED',
  );
}

async function castProposalBallot(
  context: HandlerContext<'CastProposalBallotV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  requirePolicy(context.policy.allowVoting, 'GOVERNANCE_VOTING_PAUSED');
  const { payload } = context.command;
  const proposal = await loadProposal(context, payload.proposalId);
  expectVersion(proposal.aggregate_version, payload.expectedProposalVersion);
  if (!proposal.contest_id || proposal.status !== 'open') {
    throw new GovernanceCommandError('BALLOT_WINDOW_CLOSED', 'Proposal voting is closed.');
  }
  const voterEntityId = requireActorEntity(context);
  const cast = await castBallot(context, {
    choice: { choice: payload.choice },
    contestId: proposal.contest_id,
    eligibilitySnapshotId: payload.eligibilitySnapshotId,
    expectedContestVersion: proposal.contest_version ?? proposal.aggregate_version,
    replaceExisting: payload.replaceExisting,
    voterEntityId,
  });
  const turnoutCount = await turnout(context, proposal.contest_id);
  const voterKey =
    cast.ballot_mode === 'public' && proposal.ballot_disclosure === 'voter_and_choice'
      ? await resolveEntityKey(context, voterEntityId)
      : null;
  const eventPayload = proposalBallotEventPayload(
    proposal,
    cast,
    payload.choice,
    voterKey,
    turnoutCount,
  );
  return {
    event: plannedEvent(context, {
      aggregateId: cast.participation_id,
      aggregateType: 'ballot_participation',
      aggregateVersion: cast.participation_version,
      eventType: eventPayload.eventType,
      payload: eventPayload,
      summaryCode: 'PROPOSAL_BALLOT_RECORDED',
      targetId: payload.proposalId,
      targetType: 'proposal',
    }),
    headCreated: cast.effective_revision === 1,
    responseDetails: {
      ballotMode: cast.ballot_mode,
      effectiveRevision: cast.effective_revision,
      receiptHash: cast.receipt_hash.toString('hex'),
    },
  };
}

async function closeAndTallyProposal(
  context: HandlerContext<'CloseAndTallyProposalV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  validateSchedulerPayload(context, payload.occurrenceKey);
  const proposal = await loadProposal(context, payload.proposalId);
  expectVersion(proposal.aggregate_version, payload.expectedProposalVersion);
  if (
    !proposal.contest_id ||
    proposal.status !== 'open' ||
    BigInt(context.world.current_tick) < BigInt(proposal.voting_closes_tick)
  ) {
    throw new GovernanceCommandError('TALLY_NOT_DUE', 'Proposal tally is not due.');
  }
  if (!context.restrictedTallyExecutor) {
    throw new GovernanceCommandError(
      'SECRET_TALLY_ROLE_UNAVAILABLE',
      'The restricted governance tally role is unavailable.',
    );
  }
  const snapshot = await loadSnapshot(context, payload.eligibilitySnapshotId, proposal.contest_id);
  const ballots = await context.restrictedTallyExecutor.loadProposalBallots({
    contestId: proposal.contest_id,
    eligibilitySnapshotId: payload.eligibilitySnapshotId,
    worldId: context.input.worldId,
  });
  const tally = tallyProposalYesNoV1({
    approvalThresholdBps: proposal.threshold_numerator,
    ballots,
    eligibleCount: snapshot.eligible_count,
    quorumBps: proposal.quorum_numerator,
  });
  if (tally.algorithmVersion !== payload.algorithmVersion) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'The proposal tally algorithm is incompatible.',
    );
  }
  const tallyId = context.ids.next();
  const yesCountId = context.ids.next();
  const noCountId = context.ids.next();
  const abstainCountId = context.ids.next();
  const persisted = await context.client.query<{ tally_id: string }>(
    `/* governance:proposal:tally */
     select worldgraph_persist_proposal_tally_v1(
       $1,$2,$3,$4,$5,$6::bigint,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       $17::bigint,$18,$19,$20,$21
     )::text as tally_id`,
    [
      tallyId,
      context.input.worldId,
      proposal.contest_id,
      payload.proposalId,
      payload.eligibilitySnapshotId,
      proposal.contest_version ?? proposal.aggregate_version,
      tally.algorithmVersion,
      tally.eligibleCount,
      tally.turnoutCount,
      ceilBasisPoints(tally.eligibleCount, tally.quorumBps),
      ceilBasisPoints(tally.yesCount + tally.noCount, tally.approvalThresholdBps),
      tally.yesCount,
      tally.noCount,
      tally.abstainCount,
      Buffer.from(tally.inputChecksum, 'hex'),
      Buffer.from(tally.resultChecksum, 'hex'),
      context.world.current_tick,
      context.command.commandId,
      yesCountId,
      noCountId,
      abstainCountId,
    ],
  );
  if (persisted.rows[0]?.tally_id !== tallyId) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'Proposal tally persistence failed.',
    );
  }
  const nextVersion = addDecimal(proposal.aggregate_version);
  const closedProposal = await context.client.query(
    `/* governance:proposal:close */
     update proposals set status='tallied',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
    [
      context.input.worldId,
      payload.proposalId,
      nextVersion,
      context.world.recorded_at,
      proposal.aggregate_version,
    ],
  );
  assertSingle(closedProposal, 'AGGREGATE_VERSION_CONFLICT');
  const closedContest = await context.client.query(
    `/* governance:proposal:close-contest */
     update governance_contests set status='tallied',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and status='open'`,
    [context.input.worldId, proposal.contest_id, nextVersion, context.world.recorded_at],
  );
  assertSingle(closedContest, 'AGGREGATE_VERSION_CONFLICT');
  await insertProposalTransition(
    context,
    payload.proposalId,
    'open',
    'tallied',
    nextVersion,
    'PROPOSAL_TALLIED',
  );
  return {
    ...lifecycleOutcome(
      context,
      'proposal',
      payload.proposalId,
      nextVersion,
      'tallied',
      'PROPOSAL_TALLIED',
    ),
    responseDetails: {
      inputChecksum: tally.inputChecksum,
      resultChecksum: tally.resultChecksum,
      tallyId,
    },
  };
}

async function certifyAndEnactProposal(
  context: HandlerContext<'CertifyAndEnactProposalV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  validateSchedulerPayload(context, context.input.scheduler?.occurrenceKey ?? '');
  const proposal = await loadProposal(context, payload.proposalId);
  expectVersion(proposal.aggregate_version, payload.expectedProposalVersion);
  if (!proposal.contest_id || proposal.status !== 'tallied') {
    throw new GovernanceCommandError(
      'PROPOSAL_STATE_INVALID',
      'The proposal is not ready for certification.',
    );
  }
  const tally = await queryOne<
    ProposalTallyRow & {
      outcome: 'passed' | 'rejected_quorum' | 'rejected_threshold';
      quorum_met: boolean;
      threshold_met: boolean;
    }
  >(
    context.client,
    `/* governance:proposal:certify-load */
     select tally_id::text,proposal_id::text,algorithm_version,input_checksum,
       output_checksum,outcome,quorum_met,threshold_met
       from worldgraph_proposal_tally_for_certification_v1($1,$2,$3,$4)`,
    [
      context.input.worldId,
      payload.proposalId,
      Buffer.from(payload.expectedResultChecksum, 'hex'),
      context.command.commandId,
    ],
  );
  if (!tally || tally.output_checksum.toString('hex') !== payload.expectedResultChecksum) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'The proposal tally checksum changed.',
    );
  }
  await context.client.query(
    `/* governance:proposal:result */
     insert into proposal_results(
       id,world_id,contest_id,proposal_id,tally_id,outcome,quorum_met,threshold_met,
       result_schema_version,result_checksum,certified_command_id,certified_event_id,
       certified_state_revision,certified_tick
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12::bigint,$13::bigint)`,
    [
      payload.resultId,
      context.input.worldId,
      proposal.contest_id,
      payload.proposalId,
      tally.tally_id,
      tally.outcome,
      tally.quorum_met,
      tally.threshold_met,
      tally.output_checksum,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
      context.world.current_tick,
    ],
  );
  let status: string = tally.outcome === 'passed' ? 'enacted' : 'rejected';
  let enactmentFailure: string | null = null;
  if (tally.outcome === 'passed') {
    requirePolicy(context.policy.allowEnactment, 'GOVERNANCE_ENACTMENT_PAUSED');
    const additionalEventCount = context.additionalEvents.length;
    await context.client.query('savepoint governance_enactment');
    try {
      await enactProposalActions(
        context,
        payload.proposalId,
        payload.resultId,
        tally.output_checksum,
      );
      await context.client.query('release savepoint governance_enactment');
    } catch (error) {
      const mapped =
        error instanceof GovernanceCommandError
          ? error
          : mapPostgresGovernanceRejection(error as { code?: string; constraint?: string });
      if (!mapped || !mapped.safeFailure) throw error;
      await context.client.query('rollback to savepoint governance_enactment');
      await context.client.query('release savepoint governance_enactment');
      context.additionalEvents.splice(additionalEventCount);
      enactmentFailure = mapped.code;
      status = 'passed_but_enactment_failed';
      await context.client.query(
        `/* governance:proposal:enactment-failed */
         insert into proposal_enactments(
           id,world_id,proposal_id,proposal_result_id,enactment_attempt,status,
           failure_code,input_checksum,output_checksum,command_id,event_id,
           state_revision,enacted_tick
         ) values ($1,$2,$3,$4,1,'failed',$5,$6,null,$7,$8,$9::bigint,$10::bigint)`,
        [
          context.ids.next(),
          context.input.worldId,
          payload.proposalId,
          payload.resultId,
          normalizeFailureCode(mapped.code),
          tally.output_checksum,
          context.command.commandId,
          context.eventId,
          context.resultingStateRevision,
          context.world.current_tick,
        ],
      );
    }
  }
  const nextVersion = addDecimal(proposal.aggregate_version);
  const certifiedProposal = await context.client.query(
    `/* governance:proposal:certify */
     update proposals set status=$3,aggregate_version=$4::bigint,updated_at=$5
      where world_id=$1 and id=$2 and aggregate_version=$6::bigint`,
    [
      context.input.worldId,
      payload.proposalId,
      status,
      nextVersion,
      context.world.recorded_at,
      proposal.aggregate_version,
    ],
  );
  assertSingle(certifiedProposal, 'AGGREGATE_VERSION_CONFLICT');
  const certifiedContest = await context.client.query(
    `/* governance:proposal:certify-contest */
      update governance_contests set status='certified',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and status='tallied'`,
    [context.input.worldId, proposal.contest_id, nextVersion, context.world.recorded_at],
  );
  assertSingle(certifiedContest, 'AGGREGATE_VERSION_CONFLICT');
  await insertProposalTransition(
    context,
    payload.proposalId,
    'tallied',
    status,
    nextVersion,
    status === 'enacted'
      ? 'PROPOSAL_ENACTED'
      : status === 'rejected'
        ? 'PROPOSAL_REJECTED'
        : 'PROPOSAL_ENACTMENT_FAILED',
  );
  return {
    event: plannedEvent(context, {
      aggregateId: payload.proposalId,
      aggregateType: 'proposal',
      aggregateVersion: nextVersion,
      eventType: 'GovernanceResultFinalizedV1',
      payload: {
        aggregateId: payload.proposalId,
        aggregateType: 'proposal',
        eventType: 'GovernanceResultFinalizedV1',
        inputChecksum: tally.input_checksum.toString('hex'),
        resultChecksum: tally.output_checksum.toString('hex'),
        resultId: payload.resultId,
      },
      summaryCode: enactmentFailure
        ? 'PROPOSAL_PASSED_ENACTMENT_FAILED'
        : 'PROPOSAL_RESULT_FINALIZED',
    }),
    responseDetails: {
      enactmentFailure,
      outcome: tally.outcome,
      resultChecksum: tally.output_checksum.toString('hex'),
      resultId: payload.resultId,
      status,
    },
  };
}

async function nominateCandidate(
  context: HandlerContext<'NominateCandidateV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  const election = await loadElection(context, payload.electionId);
  expectVersion(election.aggregate_version, payload.expectedElectionVersion);
  if (
    election.office_id !== payload.officeId ||
    !['nominations_scheduled', 'nominations_open'].includes(election.status) ||
    BigInt(context.world.current_tick) < BigInt(election.nomination_opens_tick) ||
    BigInt(context.world.current_tick) >= BigInt(election.nomination_closes_tick) ||
    !election.contest_id
  ) {
    throw new GovernanceCommandError(
      'ELECTION_STATE_INVALID',
      'The election is not accepting nominations.',
    );
  }
  const candidateId = await resolveEntityId(context, payload.candidateEntityKey);
  await assertCandidateOfficeEligibility(context, election.office_id, candidateId);
  const candidacyId = context.ids.next();
  const candidacyTransitionId = context.ids.next();
  const candidacyTransitionChecksum = sha256Buffer({
    candidacyId,
    status: 'nominated',
    tick: context.world.current_tick,
  });
  await context.client.query(
    `/* governance:election:nominate */
     insert into candidacies(
       id,world_id,election_id,contest_id,candidate_entity_id,status,nomination_tick,
       aggregate_version,nominated_command_id,nominated_event_id
     ) values ($1,$2,$3,$4,$5,'nominated',$6::bigint,1,$7,$8)`,
    [
      candidacyId,
      context.input.worldId,
      payload.electionId,
      election.contest_id,
      candidateId,
      context.world.current_tick,
      context.command.commandId,
      context.eventId,
    ],
  );
  await context.client.query(
    `/* governance:election:nominate-transition */
     insert into candidacy_transitions(
       id,world_id,candidacy_id,from_status,to_status,effective_tick,
       aggregate_version,command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,null,'nominated',$4::bigint,1,$5,$6,$7::bigint,$8)`,
    [
      candidacyTransitionId,
      context.input.worldId,
      candidacyId,
      context.world.current_tick,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
      candidacyTransitionChecksum,
    ],
  );
  return {
    event: plannedEvent(context, {
      aggregateId: candidacyId,
      aggregateType: 'candidacy',
      aggregateVersion: '1',
      eventType: 'GovernanceCandidacyChangedV1',
      payload: {
        candidacyId,
        electionId: payload.electionId,
        eventType: 'GovernanceCandidacyChangedV1',
        status: 'nominated',
      },
      summaryCode: 'CANDIDATE_NOMINATED',
      targetId: payload.electionId,
      targetType: 'election',
    }),
    headCreated: true,
    responseDetails: { candidacyId },
  };
}

async function acceptNomination(
  context: HandlerContext<'AcceptNominationV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  const election = await loadElection(context, payload.electionId);
  expectVersion(election.aggregate_version, payload.expectedElectionVersion);
  if (
    !['nominations_scheduled', 'nominations_open'].includes(election.status) ||
    BigInt(context.world.current_tick) >= BigInt(election.nomination_closes_tick)
  ) {
    throw new GovernanceCommandError('ELECTION_STATE_INVALID', 'The nomination window is closed.');
  }
  const candidacy = await queryOne<{
    aggregate_version: string;
    candidate_entity_id: string;
    status: string;
  }>(
    context.client,
    `/* governance:election:load-candidacy */
     select aggregate_version::text,candidate_entity_id::text,status
       from candidacies where world_id=$1 and id=$2 and election_id=$3 for update`,
    [context.input.worldId, payload.candidacyId, payload.electionId],
  );
  if (!candidacy || candidacy.status !== 'nominated') {
    throw new GovernanceCommandError(
      'CANDIDACY_STATE_INVALID',
      'The candidacy is not awaiting acceptance.',
    );
  }
  expectVersion(candidacy.aggregate_version, payload.expectedCandidacyVersion);
  if (candidacy.candidate_entity_id !== requireActorEntity(context)) {
    throw new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Only the nominated entity may accept.',
    );
  }
  await assertCandidateOfficeEligibility(
    context,
    election.office_id,
    candidacy.candidate_entity_id,
  );
  const nextVersion = addDecimal(candidacy.aggregate_version);
  const updated = await context.client.query(
    `/* governance:election:accept-nomination */
     update candidacies set status='accepted',aggregate_version=$3::bigint,
       accepted_command_id=$4,accepted_event_id=$5,updated_at=$6
      where world_id=$1 and id=$2 and aggregate_version=$7::bigint and status='nominated'`,
    [
      context.input.worldId,
      payload.candidacyId,
      nextVersion,
      context.command.commandId,
      context.eventId,
      context.world.recorded_at,
      candidacy.aggregate_version,
    ],
  );
  assertSingle(updated, 'CANDIDACY_STATE_INVALID');
  await insertCandidacyTransition(
    context,
    payload.candidacyId,
    'nominated',
    'accepted',
    nextVersion,
  );
  return {
    event: plannedEvent(context, {
      aggregateId: payload.candidacyId,
      aggregateType: 'candidacy',
      aggregateVersion: nextVersion,
      eventType: 'GovernanceCandidacyChangedV1',
      payload: {
        candidacyId: payload.candidacyId,
        electionId: payload.electionId,
        eventType: 'GovernanceCandidacyChangedV1',
        status: 'accepted',
      },
      summaryCode: 'CANDIDACY_ACCEPTED',
      targetId: payload.electionId,
      targetType: 'election',
    }),
  };
}

function deriveSuccessorElectionPlan(
  context: GovernanceHandlerContext,
  election: ElectionRow,
): SuccessorElectionPlan {
  const snapshot = election.election_rule_snapshot;
  const cadenceValue =
    snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)['electionCadenceTicks']
      : undefined;
  if (typeof cadenceValue !== 'string' || !/^[1-9][0-9]*$/u.test(cadenceValue)) {
    throw new GovernanceCommandError(
      'ELECTION_STATE_INVALID',
      'The election rule snapshot has no valid recurring cadence.',
    );
  }
  const cadence = BigInt(cadenceValue);
  if (cadence > POSTGRES_INT64_MAX) {
    throw new GovernanceCommandError(
      'ELECTION_STATE_INVALID',
      'The election cadence exceeds the supported world-tick range.',
    );
  }
  const shift = (tick: string): string => {
    const shifted = BigInt(tick) + cadence;
    if (shifted > POSTGRES_INT64_MAX) {
      throw new GovernanceCommandError(
        'ELECTION_STATE_INVALID',
        'The successor election exceeds the supported world-tick range.',
      );
    }
    return shifted.toString();
  };
  const nominationOpensTick = shift(election.nomination_opens_tick);
  return {
    certificationTick: shift(election.certification_tick),
    nominationClosesTick: shift(election.nomination_closes_tick),
    nominationOpensTick,
    status:
      BigInt(nominationOpensTick) <= BigInt(context.world.current_tick)
        ? 'nominations_open'
        : 'nominations_scheduled',
    termStartsTick: shift(election.term_starts_tick),
    votingClosesTick: shift(election.voting_closes_tick),
    votingOpensTick: shift(election.voting_opens_tick),
  };
}

async function createSuccessorElection(
  context: GovernanceHandlerContext,
  election: ElectionRow,
): Promise<{ contestId: string; electionId: string }> {
  const plan = deriveSuccessorElectionPlan(context, election);
  const electionId = context.ids.next();
  const contestId = context.ids.next();
  await context.client.query(
    `/* governance:election:successor */
     insert into elections(
       id,world_id,institution_id,office_id,seat_id,election_kind,status,
       nomination_opens_tick,nomination_closes_tick,voting_opens_tick,
       voting_closes_tick,certification_tick,term_starts_tick,
       quorum_numerator,quorum_denominator,tie_rule,ballot_mode,ballot_disclosure,
       allow_ballot_replacement,election_rule_snapshot,aggregate_version,
       created_command_id,created_event_id,created_state_revision
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint,$10::bigint,
       $11::bigint,$12::bigint,$13::bigint,$14,10000,$15,$16,$17,$18,$19,1,
       $20,$21,$22::bigint)`,
    [
      electionId,
      context.input.worldId,
      election.institution_id,
      election.office_id,
      election.seat_id,
      election.election_kind,
      plan.status,
      plan.nominationOpensTick,
      plan.nominationClosesTick,
      plan.votingOpensTick,
      plan.votingClosesTick,
      plan.certificationTick,
      plan.termStartsTick,
      election.quorum_numerator,
      election.tie_rule,
      election.ballot_mode,
      election.ballot_disclosure,
      election.allow_ballot_replacement,
      safeJson(election.election_rule_snapshot),
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
    ],
  );
  await context.client.query(
    `/* governance:election:successor-stream */
     select worldgraph_seed_governance_aggregate_stream_v1($1,$2,'election',$3)`,
    [context.input.worldId, context.command.commandId, electionId],
  );
  await context.client.query(
    `/* governance:election:successor-contest */
     insert into governance_contests(
       id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
       opens_tick,closes_tick,allow_replacement,aggregate_version,
       created_command_id,created_event_id,created_state_revision
     ) values ($1,$2,'election',$3,$4,'scheduled',$5::bigint,$6::bigint,$7,1,
       $8,$9,$10::bigint)`,
    [
      contestId,
      context.input.worldId,
      election.ballot_mode,
      election.ballot_disclosure,
      plan.votingOpensTick,
      plan.votingClosesTick,
      election.allow_ballot_replacement,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
    ],
  );
  await context.client.query(
    `/* governance:election:successor-contest-link */
     insert into election_contests(
       contest_id,world_id,election_id,office_id,seat_id,contest_ordinal,seats_to_fill
     ) values ($1,$2,$3,$4,$5,1,1)`,
    [contestId, context.input.worldId, electionId, election.office_id, election.seat_id],
  );
  await createScheduledAction(
    context,
    'OpenElectionV1',
    electionId,
    plan.votingOpensTick,
    'election',
  );
  await createScheduledAction(
    context,
    'CloseAndTallyElectionV1',
    electionId,
    plan.votingClosesTick,
    'election',
  );
  await createScheduledAction(
    context,
    'CertifyElectionV1',
    electionId,
    plan.certificationTick,
    'election',
  );
  return { contestId, electionId };
}

async function openElection(
  context: HandlerContext<'OpenElectionV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  requirePolicy(context.policy.allowVoting, 'GOVERNANCE_VOTING_PAUSED');
  const { payload } = context.command;
  validateSchedulerPayload(context, payload.occurrenceKey);
  const election = await loadElection(context, payload.electionId);
  expectVersion(election.aggregate_version, payload.expectedElectionVersion);
  if (
    !['nominations_scheduled', 'nominations_open', 'voting_scheduled'].includes(election.status) ||
    BigInt(context.world.current_tick) < BigInt(election.voting_opens_tick) ||
    !election.contest_id
  ) {
    throw new GovernanceCommandError('ELECTION_STATE_INVALID', 'Election voting is not due.');
  }
  if (BigInt(context.world.current_tick) >= BigInt(election.voting_closes_tick)) {
    const nextVersion = addDecimal(election.aggregate_version);
    const terminal = await context.client.query(
      `/* governance:election:delayed-open-terminal */
       update elections set status='cancelled',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
      [
        context.input.worldId,
        payload.electionId,
        nextVersion,
        context.world.recorded_at,
        election.aggregate_version,
      ],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Election changed.');
    }
    const contestTerminal = await context.client.query(
      `/* governance:election:delayed-open-contest-terminal */
       update governance_contests set status='cancelled',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and status='scheduled'`,
      [context.input.worldId, election.contest_id, nextVersion, context.world.recorded_at],
    );
    if ((contestTerminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Election changed.');
    }
    const successor = await createSuccessorElection(context, election);
    return {
      ...lifecycleOutcome(
        context,
        'election',
        payload.electionId,
        nextVersion,
        'cancelled',
        'ELECTION_CANCELLED_VOTING_WINDOW_MISSED',
      ),
      responseDetails: {
        cancellationReason: 'voting_window_missed',
        successorContestId: successor.contestId,
        successorElectionId: successor.electionId,
        votingClosesTick: election.voting_closes_tick,
      },
    };
  }
  const accepted = await queryOne<{ count: number }>(
    context.client,
    `/* governance:election:candidate-count */
     select count(*)::integer as count from candidacies
      where world_id=$1 and election_id=$2 and status='accepted'`,
    [context.input.worldId, payload.electionId],
  );
  if ((accepted?.count ?? 0) < 1) {
    const nextVersion = addDecimal(election.aggregate_version);
    const terminal = await context.client.query(
      `/* governance:election:no-candidates-terminal */
       update elections set status='cancelled',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
      [
        context.input.worldId,
        payload.electionId,
        nextVersion,
        context.world.recorded_at,
        election.aggregate_version,
      ],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Election changed.');
    }
    const contestTerminal = await context.client.query(
      `/* governance:election:no-candidates-contest-terminal */
       update governance_contests set status='cancelled',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and status='scheduled'`,
      [context.input.worldId, election.contest_id, nextVersion, context.world.recorded_at],
    );
    if ((contestTerminal.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Election changed.');
    }
    const successor = await createSuccessorElection(context, election);
    return {
      ...lifecycleOutcome(
        context,
        'election',
        payload.electionId,
        nextVersion,
        'cancelled',
        'ELECTION_CANCELLED_NO_CANDIDATES',
      ),
      responseDetails: {
        successorContestId: successor.contestId,
        successorElectionId: successor.electionId,
      },
    };
  }
  await createEligibilitySnapshot(context, election.contest_id, payload.eligibilitySnapshot, {
    aggregateId: payload.electionId,
    aggregateType: 'election',
  });
  const nextVersion = addDecimal(election.aggregate_version);
  const updated = await context.client.query(
    `/* governance:election:open */
     update elections set status='open',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
    [
      context.input.worldId,
      payload.electionId,
      nextVersion,
      context.world.recorded_at,
      election.aggregate_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1)
    throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Election changed.');
  const contestUpdated = await context.client.query(
    `/* governance:election:open-contest */
     update governance_contests set status='open',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and status='scheduled'`,
    [context.input.worldId, election.contest_id, nextVersion, context.world.recorded_at],
  );
  if ((contestUpdated.rowCount ?? 0) !== 1)
    throw new GovernanceCommandError('AGGREGATE_VERSION_CONFLICT', 'Election contest changed.');
  return lifecycleOutcome(
    context,
    'election',
    payload.electionId,
    nextVersion,
    'open',
    'ELECTION_VOTING_OPENED',
  );
}

async function castElectionBallot(
  context: HandlerContext<'CastElectionBallotV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  requirePolicy(context.policy.allowVoting, 'GOVERNANCE_VOTING_PAUSED');
  const { payload } = context.command;
  const election = await loadElection(context, payload.electionId);
  expectVersion(election.aggregate_version, payload.expectedElectionVersion);
  if (!election.contest_id || election.status !== 'open') {
    throw new GovernanceCommandError('BALLOT_WINDOW_CLOSED', 'Election voting is closed.');
  }
  if (payload.choice.choiceType === 'candidate') {
    const candidate = await queryOne<{ present: boolean }>(
      context.client,
      `/* governance:election:validate-choice */
       select true as present from candidacies candidacy
       join world_entities entity on entity.world_id=candidacy.world_id
         and entity.id=candidacy.candidate_entity_id
       where candidacy.world_id=$1 and candidacy.election_id=$2
         and candidacy.contest_id=$3 and candidacy.status='accepted'
         and entity.logical_key=$4`,
      [context.input.worldId, payload.electionId, election.contest_id, payload.choice.candidateKey],
    );
    if (!candidate)
      throw new GovernanceCommandError('VALIDATION_FAILED', 'Candidate is not on this ballot.');
  }
  const voterEntityId = requireActorEntity(context);
  const cast = await castBallot(context, {
    choice: payload.choice,
    contestId: election.contest_id,
    eligibilitySnapshotId: payload.eligibilitySnapshotId,
    expectedContestVersion: election.contest_version ?? election.aggregate_version,
    replaceExisting: payload.replaceExisting,
    voterEntityId,
  });
  const turnoutCount = await turnout(context, election.contest_id);
  const voterKey =
    cast.ballot_mode === 'public' && election.ballot_disclosure === 'voter_and_choice'
      ? await resolveEntityKey(context, voterEntityId)
      : null;
  const eventPayload = electionBallotEventPayload(
    election,
    cast,
    payload.choice,
    voterKey,
    turnoutCount,
  );
  return {
    event: plannedEvent(context, {
      aggregateId: cast.participation_id,
      aggregateType: 'ballot_participation',
      aggregateVersion: cast.participation_version,
      eventType: eventPayload.eventType,
      payload: eventPayload,
      summaryCode: 'ELECTION_BALLOT_RECORDED',
      targetId: payload.electionId,
      targetType: 'election',
    }),
    headCreated: cast.effective_revision === 1,
    responseDetails: {
      ballotMode: cast.ballot_mode,
      effectiveRevision: cast.effective_revision,
      receiptHash: cast.receipt_hash.toString('hex'),
    },
  };
}

async function closeAndTallyElection(
  context: HandlerContext<'CloseAndTallyElectionV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  validateSchedulerPayload(context, payload.occurrenceKey);
  const election = await loadElection(context, payload.electionId);
  expectVersion(election.aggregate_version, payload.expectedElectionVersion);
  if (
    !election.contest_id ||
    election.status !== 'open' ||
    BigInt(context.world.current_tick) < BigInt(election.voting_closes_tick)
  ) {
    throw new GovernanceCommandError('TALLY_NOT_DUE', 'Election tally is not due.');
  }
  if (!context.restrictedTallyExecutor) {
    throw new GovernanceCommandError(
      'SECRET_TALLY_ROLE_UNAVAILABLE',
      'The restricted governance tally role is unavailable.',
    );
  }
  const snapshot = await loadSnapshot(context, payload.eligibilitySnapshotId, election.contest_id);
  const candidates = await context.client.query<{ candidacy_id: string; candidate_key: string }>(
    `/* governance:election:tally-candidates */
     select candidacy.id::text as candidacy_id,entity.logical_key::text as candidate_key
       from candidacies candidacy
       join world_entities entity on entity.world_id=candidacy.world_id
         and entity.id=candidacy.candidate_entity_id
      where candidacy.world_id=$1 and candidacy.election_id=$2
        and candidacy.contest_id=$3 and candidacy.status='accepted'
      order by entity.logical_key::text collate "C",candidacy.id`,
    [context.input.worldId, payload.electionId, election.contest_id],
  );
  const ballots = await context.restrictedTallyExecutor.loadElectionBallots({
    candidateKeys: candidates.rows.map((row) => row.candidate_key),
    contestId: election.contest_id,
    eligibilitySnapshotId: payload.eligibilitySnapshotId,
    worldId: context.input.worldId,
  });
  const tally = tallyElectionPluralityV1({
    ballots,
    candidateKeys: candidates.rows.map((row) => row.candidate_key),
    eligibleCount: snapshot.eligible_count,
    quorumBps: election.quorum_numerator,
    tieRule: election.tie_rule,
  });
  if (tally.algorithmVersion !== payload.algorithmVersion) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'The election tally algorithm is incompatible.',
    );
  }
  const tallyId = context.ids.next();
  const candidacyByKey = new Map(
    candidates.rows.map((row) => [row.candidate_key, row.candidacy_id]),
  );
  const candidateCounts = tally.candidateTotals.map((total) => ({
    ballotCount: total.voteCount,
    candidacyId: candidacyByKey.get(total.candidateKey),
    countId: context.ids.next(),
  }));
  if (candidateCounts.some((count) => count.candidacyId === undefined)) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'Election candidates changed during tally.',
    );
  }
  const abstainCountId = context.ids.next();
  const persisted = await context.client.query<{ tally_id: string }>(
    `/* governance:election:tally */
     select worldgraph_persist_election_tally_v1(
       $1,$2,$3,$4,$5,$6::bigint,$7,$8,$9,$10,$11,$12,$13::bigint,$14,$15,$16
     )::text as tally_id`,
    [
      tallyId,
      context.input.worldId,
      election.contest_id,
      payload.electionId,
      payload.eligibilitySnapshotId,
      election.contest_version ?? election.aggregate_version,
      tally.algorithmVersion,
      tally.eligibleCount,
      tally.turnoutCount,
      tally.abstainCount,
      Buffer.from(tally.inputChecksum, 'hex'),
      Buffer.from(tally.resultChecksum, 'hex'),
      context.world.current_tick,
      context.command.commandId,
      safeJson(candidateCounts),
      abstainCountId,
    ],
  );
  if (persisted.rows[0]?.tally_id !== tallyId) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'Election tally persistence failed.',
    );
  }
  const nextVersion = addDecimal(election.aggregate_version);
  const closedElection = await context.client.query(
    `/* governance:election:close */
     update elections set status='tallied',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
    [
      context.input.worldId,
      payload.electionId,
      nextVersion,
      context.world.recorded_at,
      election.aggregate_version,
    ],
  );
  assertSingle(closedElection, 'AGGREGATE_VERSION_CONFLICT');
  const closedContest = await context.client.query(
    `/* governance:election:close-contest */
     update governance_contests set status='tallied',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and status='open'`,
    [context.input.worldId, election.contest_id, nextVersion, context.world.recorded_at],
  );
  assertSingle(closedContest, 'AGGREGATE_VERSION_CONFLICT');
  return {
    ...lifecycleOutcome(
      context,
      'election',
      payload.electionId,
      nextVersion,
      'tallied',
      'ELECTION_TALLIED',
    ),
    responseDetails: {
      inputChecksum: tally.inputChecksum,
      resultChecksum: tally.resultChecksum,
      tallyId,
    },
  };
}

async function certifyElection(
  context: HandlerContext<'CertifyElectionV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  validateSchedulerPayload(context, context.input.scheduler?.occurrenceKey ?? '');
  const election = await loadElection(context, payload.electionId);
  expectVersion(election.aggregate_version, payload.expectedElectionVersion);
  if (
    !election.contest_id ||
    election.status !== 'tallied' ||
    BigInt(context.world.current_tick) < BigInt(election.certification_tick)
  ) {
    throw new GovernanceCommandError(
      'ELECTION_STATE_INVALID',
      'Election is not ready for certification.',
    );
  }
  const tallyRows = await context.client.query<
    ElectionTallyRow & {
      abstain_count: number;
      ballot_count: number;
      candidacy_id: string;
      candidate_key: string;
      eligible_count: number;
      participating_count: number;
    }
  >(
    `/* governance:election:certify-load */
     select tally_id::text,election_id::text,algorithm_version,input_checksum,
       output_checksum,eligible_count,participating_count,abstain_count,
       candidacy_id::text,candidate_key,ballot_count
       from worldgraph_election_tally_for_certification_v1($1,$2,$3,$4)`,
    [
      context.input.worldId,
      payload.electionId,
      Buffer.from(payload.expectedResultChecksum, 'hex'),
      context.command.commandId,
    ],
  );
  const tally = tallyRows.rows[0];
  if (!tally || tally.output_checksum.toString('hex') !== payload.expectedResultChecksum) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'The election tally checksum changed.',
    );
  }
  const quorumMet =
    BigInt(tally.participating_count) * 10_000n >=
    BigInt(tally.eligible_count) * BigInt(election.quorum_numerator);
  const nonAbstain = tally.participating_count - tally.abstain_count;
  const top = tallyRows.rows[0];
  const tied = top ? tallyRows.rows.filter((row) => row.ballot_count === top.ballot_count) : [];
  const outcome = !quorumMet
    ? 'vacant_no_quorum'
    : nonAbstain === 0 || !top
      ? 'vacant_no_votes'
      : tied.length > 1 && election.tie_rule === 'vacancy'
        ? 'vacant_tie'
        : 'elected';
  const winner = outcome === 'elected' ? top! : null;
  await context.client.query(
    `/* governance:election:result */
     insert into election_results(
       id,world_id,contest_id,election_id,tally_id,outcome,winning_candidacy_id,
       result_schema_version,result_checksum,certified_command_id,certified_event_id,
       certified_state_revision,certified_tick
     ) values ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11::bigint,$12::bigint)`,
    [
      payload.resultId,
      context.input.worldId,
      election.contest_id,
      payload.electionId,
      tally.tally_id,
      outcome,
      winner?.candidacy_id ?? null,
      tally.output_checksum,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
      context.world.current_tick,
    ],
  );
  let termId: string | null = null;
  if (winner) {
    const office = await queryOne<{
      office_key: string;
      seat_id: string;
      seat_ordinal: number;
      term_ticks: string;
      winner_entity_id: string;
    }>(
      context.client,
      `/* governance:election:term-source */
       select office.stable_key::text as office_key,office.term_ticks::text,
         contest.seat_id::text,seat.seat_ordinal,
         candidacy.candidate_entity_id::text as winner_entity_id
        from elections election
        join political_offices office on office.world_id=election.world_id and office.id=election.office_id
        join election_contests contest on contest.world_id=election.world_id and contest.contest_id=$3
        join political_office_seats seat on seat.world_id=contest.world_id and seat.id=contest.seat_id
        join candidacies candidacy on candidacy.world_id=election.world_id and candidacy.id=$4
       where election.world_id=$1 and election.id=$2`,
      [context.input.worldId, payload.electionId, election.contest_id, winner.candidacy_id],
    );
    if (!office) throw new GovernanceCommandError('TERM_CONFLICT', 'Election seat disappeared.');
    const term = calculateOfficeTermV1({
      certifiedAtTick: election.term_starts_tick,
      officeKey: office.office_key,
      seatIndex: office.seat_ordinal - 1,
      termDurationTicks: office.term_ticks,
      transitionDelayTicks: '0',
    });
    if (term.startsAtTick !== election.term_starts_tick) {
      throw new GovernanceCommandError('TERM_CONFLICT', 'Election term schedule changed.');
    }
    await endPriorSeatTermAt(
      context,
      election.office_id,
      office.seat_id,
      office.seat_ordinal - 1,
      election.term_starts_tick,
    );
    termId = context.ids.next();
    const termEvent = addOfficeTermChangedEvent(context, {
      aggregateVersion: '1',
      officeId: election.office_id,
      seatIndex: office.seat_ordinal - 1,
      status: 'active',
      termId,
    });
    await insertOfficeTerm(context, {
      createdEventId: termEvent.eventId,
      endsTick: term.endsAtTick,
      holderEntityId: office.winner_entity_id,
      officeId: election.office_id,
      seatId: office.seat_id,
      sourceElectionResultId: payload.resultId,
      sourceKind: 'election',
      sourceProposalResultId: null,
      startsTick: term.startsAtTick,
      termChecksum: term.termChecksum,
      termId,
    });
  }
  const nextVersion = addDecimal(election.aggregate_version);
  const certifiedElection = await context.client.query(
    `/* governance:election:certify */
     update elections set status='certified',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and aggregate_version=$5::bigint`,
    [
      context.input.worldId,
      payload.electionId,
      nextVersion,
      context.world.recorded_at,
      election.aggregate_version,
    ],
  );
  assertSingle(certifiedElection, 'AGGREGATE_VERSION_CONFLICT');
  const certifiedContest = await context.client.query(
    `/* governance:election:certify-contest */
     update governance_contests set status='certified',aggregate_version=$3::bigint,updated_at=$4
      where world_id=$1 and id=$2 and status='tallied'`,
    [context.input.worldId, election.contest_id, nextVersion, context.world.recorded_at],
  );
  assertSingle(certifiedContest, 'AGGREGATE_VERSION_CONFLICT');
  const successor = await createSuccessorElection(context, election);
  return {
    event: plannedEvent(context, {
      aggregateId: payload.electionId,
      aggregateType: 'election',
      aggregateVersion: nextVersion,
      eventType: 'GovernanceResultFinalizedV1',
      payload: {
        aggregateId: payload.electionId,
        aggregateType: 'election',
        eventType: 'GovernanceResultFinalizedV1',
        inputChecksum: tally.input_checksum.toString('hex'),
        resultChecksum: tally.output_checksum.toString('hex'),
        resultId: payload.resultId,
      },
      summaryCode: 'ELECTION_RESULT_FINALIZED',
    }),
    responseDetails: {
      outcome,
      resultId: payload.resultId,
      successorContestId: successor.contestId,
      successorElectionId: successor.electionId,
      termId,
    },
  };
}

async function appointOfficeholder(
  context: HandlerContext<'AppointOfficeholderV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  requireAuthorityBinding(context, {
    actionCode: 'governance.office.appoint',
    policyActionCode: 'governance.appoint',
    policyResourceType: 'office',
    resourceId: payload.officeId,
    resourceType: 'office',
  });
  const office = await loadOfficeSeat(context, payload.officeId, payload.seatIndex);
  expectVersion(office.office_version, payload.expectedOfficeVersion);
  const holderId = await resolveEntityId(context, payload.holderEntityKey);
  const termId = context.ids.next();
  await insertOfficeTerm(context, {
    createdEventId: context.eventId,
    endsTick: payload.termEndsAtTick,
    holderEntityId: holderId,
    officeId: payload.officeId,
    seatId: office.seat_id,
    sourceElectionResultId: null,
    sourceKind: 'appointment',
    sourceProposalResultId: null,
    startsTick: payload.termStartsAtTick,
    termChecksum: sha256Hex({
      endsAtTick: payload.termEndsAtTick,
      holderEntityKey: payload.holderEntityKey,
      officeId: payload.officeId,
      seatIndex: payload.seatIndex,
      startsAtTick: payload.termStartsAtTick,
    }),
    termId,
  });
  await context.client.query(
    `/* governance:office:increment */
     update political_offices set row_version=row_version+1,updated_at=$3
      where world_id=$1 and id=$2 and row_version=$4::bigint`,
    [context.input.worldId, payload.officeId, context.world.recorded_at, office.office_version],
  );
  return officeTermOutcome(context, payload.officeId, payload.seatIndex, termId, 'active', '1');
}

async function removeOfficeholder(
  context: HandlerContext<'RemoveOfficeholderV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  requireAuthorityBinding(context, {
    actionCode: 'governance.office.remove',
    policyActionCode: 'governance.appoint',
    policyResourceType: 'office',
    resourceId: payload.termId,
    resourceType: 'office_term',
  });
  const removal = await applyOfficeTermRemoval(context, payload);
  return officeTermOutcome(
    context,
    removal.officeId,
    removal.seatIndex,
    payload.termId,
    'removed',
    removal.nextVersion,
  );
}

async function applyOfficeTermRemoval(
  context: GovernanceHandlerContext,
  removal: {
    effectiveAtTick: string;
    expectedTermVersion: string;
    termId: string;
  },
): Promise<{ nextVersion: string; officeId: string; seatIndex: number }> {
  const term = await queryOne<{
    office_id: string;
    seat_index: number;
    status: string;
    term_version: string;
  }>(
    context.client,
    `/* governance:office:load-term */
     select term.office_id::text,(seat.seat_ordinal-1)::integer as seat_index,
       coalesce(latest.to_status,term.status) as status,
       head.current_version::text as term_version
      from office_terms term
      join political_office_seats seat on seat.world_id=term.world_id and seat.id=term.seat_id
      join aggregate_stream_heads head on head.world_id=term.world_id
        and head.aggregate_type='office_term' and head.aggregate_id=term.id::text
      left join lateral (
        select transition.to_status
          from office_term_transitions transition
         where transition.world_id=term.world_id and transition.term_id=term.id
         order by transition.created_at desc,transition.id desc limit 1
      ) latest on true
     where term.world_id=$1 and term.id=$2 for update of term`,
    [context.input.worldId, removal.termId],
  );
  if (!term || !['scheduled', 'active'].includes(term.status)) {
    throw new GovernanceCommandError('TERM_CONFLICT', 'The office term is already terminal.');
  }
  expectVersion(term.term_version, removal.expectedTermVersion);
  if (removal.effectiveAtTick !== context.world.current_tick) {
    throw new GovernanceCommandError(
      'VALIDATION_FAILED',
      'A term removal must take effect at the command tick.',
    );
  }
  const nextVersion = addDecimal(term.term_version);
  const transitionId = context.ids.next();
  const transitionChecksum = sha256Buffer({
    termId: removal.termId,
    status: 'removed',
    tick: removal.effectiveAtTick,
  });
  const effectEvent =
    context.command.type === 'ExecuteCreatorOverrideV1'
      ? addOfficeTermChangedEvent(context, {
          aggregateVersion: nextVersion,
          officeId: term.office_id,
          seatIndex: term.seat_index,
          status: 'removed',
          termId: removal.termId,
        })
      : null;
  const closed = await context.client.query(
    `/* governance:office:remove */
     update office_seat_authority_intervals
        set effective_ticks=int8range(lower(effective_ticks),$3::bigint,'[)'),
            updated_command_id=$4,row_version=row_version+1,updated_at=$5
      where world_id=$1 and term_id=$2
        and (upper_inf(effective_ticks) or upper(effective_ticks) > $3::bigint)`,
    [
      context.input.worldId,
      removal.termId,
      removal.effectiveAtTick,
      context.command.commandId,
      context.world.recorded_at,
    ],
  );
  if ((closed.rowCount ?? 0) !== 1) {
    throw new GovernanceCommandError('TERM_CONFLICT', 'Office authority changed during removal.');
  }
  await context.client.query(
    `/* governance:office:remove-transition */
     insert into office_term_transitions(
       id,world_id,term_id,from_status,to_status,effective_tick,reason_code,
       command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,$4,'removed',$5::bigint,'OFFICEHOLDER_REMOVED',$6,$7,$8::bigint,$9)`,
    [
      transitionId,
      context.input.worldId,
      removal.termId,
      term.status,
      removal.effectiveAtTick,
      context.command.commandId,
      effectEvent?.eventId ?? context.eventId,
      context.resultingStateRevision,
      transitionChecksum,
    ],
  );
  return { nextVersion, officeId: term.office_id, seatIndex: term.seat_index };
}

async function endPriorSeatTermAt(
  context: GovernanceHandlerContext,
  officeId: string,
  seatId: string,
  seatIndex: number,
  transitionTick: string,
): Promise<void> {
  const prior = await queryOne<{
    status: string;
    term_id: string;
    term_version: string;
  }>(
    context.client,
    `/* governance:office:end-prior-term-load */
     select term.id::text as term_id,coalesce(latest.to_status,term.status) as status,
       head.current_version::text as term_version
       from office_seat_authority_intervals authority
       join office_terms term
         on term.world_id=authority.world_id and term.id=authority.term_id
       join aggregate_stream_heads head
         on head.world_id=term.world_id and head.aggregate_type='office_term'
        and head.aggregate_id=term.id::text
       left join lateral (
         select transition.to_status
           from office_term_transitions transition
          where transition.world_id=term.world_id and transition.term_id=term.id
          order by transition.created_at desc,transition.id desc limit 1
       ) latest on true
      where authority.world_id=$1 and authority.seat_id=$2
        and lower(authority.effective_ticks) < $3::bigint
        and (upper_inf(authority.effective_ticks)
          or upper(authority.effective_ticks) > $3::bigint)
        and coalesce(latest.to_status,term.status) in ('scheduled','active')
      for update of authority`,
    [context.input.worldId, seatId, transitionTick],
  );
  if (!prior) return;
  const transitionId = context.ids.next();
  const transitionChecksum = sha256Buffer({
    status: 'ended',
    termId: prior.term_id,
    tick: transitionTick,
  });
  const closed = await context.client.query(
    `/* governance:office:end-prior-term */
     update office_seat_authority_intervals
        set effective_ticks=int8range(lower(effective_ticks),$3::bigint,'[)'),
            updated_command_id=$4,row_version=row_version+1,updated_at=$5
      where world_id=$1 and seat_id=$2 and term_id=$6
        and lower(effective_ticks) < $3::bigint
        and (upper_inf(effective_ticks) or upper(effective_ticks) > $3::bigint)`,
    [
      context.input.worldId,
      seatId,
      transitionTick,
      context.command.commandId,
      context.world.recorded_at,
      prior.term_id,
    ],
  );
  if ((closed.rowCount ?? 0) !== 1) {
    throw new GovernanceCommandError('TERM_CONFLICT', 'Prior office authority changed.');
  }
  const effectEvent = addOfficeTermChangedEvent(context, {
    aggregateVersion: addDecimal(prior.term_version),
    officeId,
    seatIndex,
    status: 'ended',
    termId: prior.term_id,
  });
  await context.client.query(
    `/* governance:office:end-prior-term-transition */
     insert into office_term_transitions(
       id,world_id,term_id,from_status,to_status,effective_tick,reason_code,
       command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,$4,'ended',$5::bigint,'OFFICE_TERM_SUPERSEDED',
       $6,$7,$8::bigint,$9)`,
    [
      transitionId,
      context.input.worldId,
      prior.term_id,
      prior.status,
      transitionTick,
      context.command.commandId,
      effectEvent.eventId,
      context.resultingStateRevision,
      transitionChecksum,
    ],
  );
}

async function executeCreatorOverride(
  context: HandlerContext<'ExecuteCreatorOverrideV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  requirePolicy(context.policy.allowOverrides, 'GOVERNANCE_OVERRIDES_PAUSED');
  const { payload } = context.command;
  if (
    !context.creatorOverride ||
    !['platform_admin', 'user'].includes(context.input.actor.actorType)
  ) {
    throw new GovernanceCommandError('AUTHORIZATION_DENIED', 'Override provenance is missing.');
  }
  const provenance = await queryOne<{
    actor_user_id: string;
    target_id: string;
    target_type: string;
  }>(
    context.client,
    `/* governance:override:provenance */
     select actor_user_id::text,target_id::text,target_type
       from creator_override_records
      where id=$1 and world_id=$2 and command_id=$3 and actor_user_id=$4
        and action=$5 and target_type=$6 and target_id=$7`,
    [
      context.creatorOverride.creatorOverrideId,
      context.input.worldId,
      context.command.commandId,
      context.input.actor.actorId,
      context.creatorOverride.action,
      context.creatorOverride.targetType,
      context.creatorOverride.targetId,
    ],
  );
  if (!provenance)
    throw new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Creator override provenance is invalid.',
    );
  const secondApproval = await loadSecondApproval(
    context,
    payload.approvalId,
    context.input.actor.actorId,
    'override',
  );
  if (context.policy.requireTwoPersonOverride && !secondApproval) {
    throw new GovernanceCommandError(
      'TWO_PERSON_APPROVAL_REQUIRED',
      'A distinct second approver is required.',
    );
  }
  const overrideId = context.ids.next();
  const effectSummary = await applyOverrideEffect(context, payload.effect);
  const checksum = sha256Buffer({ effectSummary, impact: payload.impact, reason: payload.reason });
  const targetKind = provenance.target_type;
  const targetId = provenance.target_id;
  await context.client.query(
    `/* governance:override:append */
     insert into governance_overrides(
       id,world_id,creator_override_id,actor_user_id,actor_mode,target_kind,target_id,
       reason,impact_before,impact_after,requires_second_approval,command_id,event_id,
       ledger_entry_id,state_revision,checksum
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::bigint,$16)`,
    [
      overrideId,
      context.input.worldId,
      context.creatorOverride.creatorOverrideId,
      context.input.actor.actorId,
      context.command.actorMode,
      targetKind,
      targetId,
      payload.reason,
      safeJson({ sealed: true }),
      safeJson(effectSummary),
      context.policy.requireTwoPersonOverride,
      context.command.commandId,
      context.eventId,
      context.eventLedgerEntryId,
      context.resultingStateRevision,
      checksum,
    ],
  );
  if (secondApproval) {
    await context.client.query(
      `/* governance:override:approval */
       insert into governance_override_approvals(
         id,world_id,override_id,approver_user_id,approval_kind,approval_hash,audit_record_id
       ) values ($1,$2,$3,$4,'second_party',$5,$6)`,
      [
        context.ids.next(),
        context.input.worldId,
        overrideId,
        secondApproval.actor_user_id,
        sha256Buffer({ approvalId: payload.approvalId, overrideId }),
        payload.approvalId,
      ],
    );
  }
  return {
    event: plannedEvent(context, {
      aggregateId: overrideId,
      aggregateType: 'governance_override',
      aggregateVersion: '1',
      eventType: 'GovernanceOverrideExecutedV1',
      ledgerKind: 'override',
      payload: {
        actorMode: context.command.actorMode,
        eventType: 'GovernanceOverrideExecutedV1',
        impactHash: sha256Hex(payload.impact),
        overrideId,
        reasonCode: 'explicit_governance_override',
      },
      summaryCode: 'GOVERNANCE_OVERRIDE_EXECUTED',
      targetId,
      targetType: targetKind,
      visibility: 'operator',
    }),
    headCreated: true,
    responseDetails: { overrideId },
  };
}

async function repairGovernanceResult(
  context: HandlerContext<'RepairGovernanceResultV1'>,
): Promise<GovernanceHandlerOutcome> {
  requireGovernance(context);
  const { payload } = context.command;
  if (!['platform_admin', 'user'].includes(context.input.actor.actorType)) {
    throw new GovernanceCommandError('AUTHORIZATION_DENIED', 'Repair actor provenance is missing.');
  }
  if (payload.repairKind !== 'certification_compensation') {
    return recountGovernanceResult(context);
  }
  const source = await queryOne<{
    aggregate_version: string;
    outcome: string;
    proposal_id: string;
    proposal_status: string;
    result_checksum: Buffer;
  }>(
    context.client,
    `/* governance:repair:source */
     select result.result_checksum,result.outcome,result.proposal_id::text,
            proposal.status as proposal_status,
            proposal.aggregate_version::text
       from proposal_results result
       join proposals proposal
         on proposal.world_id=result.world_id and proposal.id=result.proposal_id
      where result.world_id=$1 and result.id=$2
      for update of proposal`,
    [context.input.worldId, payload.sourceResultId],
  );
  if (
    !source ||
    source.result_checksum.toString('hex') !== payload.expectedCurrentResultChecksum ||
    source.outcome !== 'passed' ||
    source.proposal_status !== 'passed_but_enactment_failed'
  ) {
    throw new GovernanceCommandError(
      'GOVERNANCE_REPAIR_CONFLICT',
      'The source result checksum changed.',
    );
  }
  const actionMaterial = await context.client.query<{
    action_checksum: Buffer;
    action_id: string;
    action_ordinal: number;
    action_payload: GovernanceProposalActionV1;
  }>(
    `/* governance:repair:immutable-actions */
     select id::text as action_id,action_ordinal,action_payload,
            checksum as action_checksum
       from proposal_actions
      where world_id=$1 and proposal_id=$2
      order by action_ordinal`,
    [context.input.worldId, source.proposal_id],
  );
  if (actionMaterial.rows.length < 1) {
    throw new GovernanceCommandError(
      'GOVERNANCE_REPAIR_CONFLICT',
      'The proposal has no immutable actions.',
    );
  }
  const compensationPlanChecksum = sha256Hex({
    actions: actionMaterial.rows.map((action) => ({
      actionChecksum: action.action_checksum.toString('hex'),
      actionId: action.action_id,
      actionOrdinal: action.action_ordinal,
      actionPayload: action.action_payload,
    })),
    algorithmVersion: 'governance_certification_compensation_v1',
    proposalId: source.proposal_id,
    sourceResultChecksum: payload.expectedCurrentResultChecksum,
    sourceResultId: payload.sourceResultId,
  });
  if (payload.replacementResultChecksum !== compensationPlanChecksum) {
    throw new GovernanceCommandError(
      'GOVERNANCE_REPAIR_CONFLICT',
      'The supplied repair checksum does not match the immutable compensation plan.',
    );
  }
  const secondApproval = await loadSecondApproval(
    context,
    payload.approvalId,
    context.input.actor.actorId,
    'repair',
  );
  if (context.policy.requireTwoPersonRepair && !secondApproval) {
    throw new GovernanceCommandError(
      'TWO_PERSON_APPROVAL_REQUIRED',
      'A distinct second approver is required.',
    );
  }
  const attempt = await queryOne<{ enactment_attempt: number }>(
    context.client,
    `/* governance:repair:next-attempt */
     select coalesce(max(enactment_attempt),0)::integer+1 as enactment_attempt
       from proposal_enactments
      where world_id=$1 and proposal_result_id=$2`,
    [context.input.worldId, payload.sourceResultId],
  );
  if (!attempt || attempt.enactment_attempt > 100) {
    throw new GovernanceCommandError(
      'GOVERNANCE_REPAIR_CONFLICT',
      'Enactment retry limit reached.',
    );
  }
  const repairId = context.ids.next();
  let failureCode: string | null = null;
  let proposalVersion: string | null = null;
  let repairChecksum = Buffer.from(compensationPlanChecksum, 'hex') as ReturnType<
    typeof sha256Buffer
  >;
  const additionalEventCount = context.additionalEvents.length;
  await context.client.query('savepoint governance_repair_enactment');
  try {
    await enactProposalActions(
      context,
      source.proposal_id,
      payload.sourceResultId,
      source.result_checksum,
      attempt.enactment_attempt,
    );
    proposalVersion = addDecimal(source.aggregate_version);
    const updated = await context.client.query(
      `/* governance:repair:proposal-enacted */
       update proposals set status='enacted',aggregate_version=$3::bigint,updated_at=$4
        where world_id=$1 and id=$2 and aggregate_version=$5::bigint
          and status='passed_but_enactment_failed'`,
      [
        context.input.worldId,
        source.proposal_id,
        proposalVersion,
        context.world.recorded_at,
        source.aggregate_version,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError(
        'AGGREGATE_VERSION_CONFLICT',
        'Proposal changed during repair.',
      );
    }
    await insertProposalTransition(
      context,
      source.proposal_id,
      'passed_but_enactment_failed',
      'enacted',
      proposalVersion,
      'PROPOSAL_ENACTMENT_REPAIRED',
    );
    await context.client.query('release savepoint governance_repair_enactment');
  } catch (error) {
    const mapped =
      error instanceof GovernanceCommandError
        ? error
        : mapPostgresGovernanceRejection(error as { code?: string; constraint?: string });
    if (!mapped || !mapped.safeFailure) throw error;
    await context.client.query('rollback to savepoint governance_repair_enactment');
    await context.client.query('release savepoint governance_repair_enactment');
    context.additionalEvents.splice(additionalEventCount);
    failureCode = normalizeFailureCode(mapped.code);
    repairChecksum = sha256Buffer({
      compensationPlanChecksum,
      failureCode,
      status: 'failed',
    });
    await context.client.query(
      `/* governance:repair:enactment-failed */
       insert into proposal_enactments(
         id,world_id,proposal_id,proposal_result_id,enactment_attempt,status,
         failure_code,input_checksum,output_checksum,command_id,event_id,
         state_revision,enacted_tick
       ) values ($1,$2,$3,$4,$5::integer,'failed',$6,$7,null,$8,$9,$10::bigint,$11::bigint)`,
      [
        context.ids.next(),
        context.input.worldId,
        source.proposal_id,
        payload.sourceResultId,
        attempt.enactment_attempt,
        failureCode,
        source.result_checksum,
        context.command.commandId,
        context.eventId,
        context.resultingStateRevision,
        context.world.current_tick,
      ],
    );
  }
  await context.client.query(
    `/* governance:repair:append */
     insert into governance_repairs(
       id,world_id,target_kind,target_id,repair_kind,reason,before_checksum,
       after_checksum,replacement_result_id,requires_second_approval,command_id,
       event_id,ledger_entry_id,actor_user_id,state_revision
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,null,$9,$10,$11,$12,$13,$14::bigint)`,
    [
      repairId,
      context.input.worldId,
      'proposal_result',
      payload.sourceResultId,
      'replace_result',
      payload.reason,
      source.result_checksum,
      repairChecksum,
      context.policy.requireTwoPersonRepair,
      context.command.commandId,
      context.eventId,
      context.eventLedgerEntryId,
      context.input.actor.actorId,
      context.resultingStateRevision,
    ],
  );
  if (secondApproval) {
    await context.client.query(
      `/* governance:repair:approval */
       insert into governance_repair_approvals(
         id,world_id,repair_id,approver_user_id,approval_hash,audit_record_id
       ) values ($1,$2,$3,$4,$5,$6)`,
      [
        context.ids.next(),
        context.input.worldId,
        repairId,
        secondApproval.actor_user_id,
        sha256Buffer({ approvalId: payload.approvalId, repairId }),
        payload.approvalId,
      ],
    );
  }
  return {
    event: plannedEvent(context, {
      aggregateId: proposalVersion ? source.proposal_id : repairId,
      aggregateType: proposalVersion ? 'proposal' : 'governance_repair',
      aggregateVersion: proposalVersion ?? '1',
      eventType: 'GovernanceRepairAppendedV1',
      ledgerKind: 'repair_anchor',
      payload: {
        eventType: 'GovernanceRepairAppendedV1',
        repairId,
        repairKind: payload.repairKind,
        replacementResultChecksum: repairChecksum.toString('hex'),
        sourceResultId: payload.sourceResultId,
      },
      summaryCode: 'GOVERNANCE_REPAIR_APPENDED',
      targetId: payload.sourceResultId,
      targetType: 'proposal_result',
      visibility: 'operator',
    }),
    headCreated: proposalVersion === null,
    responseDetails: {
      compensationPlanChecksum,
      enactmentAttempt: attempt.enactment_attempt,
      failureCode,
      repairId,
      status: proposalVersion ? 'enacted' : 'enactment_failed',
    },
  };
}

interface GovernanceRecountRow {
  input_checksum: Buffer;
  outcome: string;
  result_checksum: Buffer;
  result_id: string;
  tally_id: string;
}

async function recountGovernanceResult(
  context: HandlerContext<'RepairGovernanceResultV1'>,
): Promise<GovernanceHandlerOutcome> {
  const { payload } = context.command;
  const secondApproval = await loadSecondApproval(
    context,
    payload.approvalId,
    context.input.actor.actorId,
    'repair',
  );
  if (context.policy.requireTwoPersonRepair && !secondApproval) {
    throw new GovernanceCommandError(
      'TWO_PERSON_APPROVAL_REQUIRED',
      'A distinct second approver is required.',
    );
  }

  const replacementResultId = context.ids.next();
  const replacementTallyId = context.ids.next();
  let targetKind: 'election_result' | 'proposal_result';
  let recounted: GovernanceRecountRow | null;
  if (payload.repairKind === 'proposal_recount') {
    targetKind = 'proposal_result';
    recounted = await queryOne<GovernanceRecountRow>(
      context.client,
      `/* governance:repair:proposal-recount */
       select result_id::text,tally_id::text,input_checksum,result_checksum,outcome
         from worldgraph_recount_proposal_result_v1(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint,$13::bigint
         )`,
      [
        context.input.worldId,
        payload.sourceResultId,
        replacementResultId,
        replacementTallyId,
        context.ids.next(),
        context.ids.next(),
        context.ids.next(),
        Buffer.from(payload.expectedCurrentResultChecksum, 'hex'),
        Buffer.from(payload.replacementResultChecksum, 'hex'),
        context.command.commandId,
        context.eventId,
        context.resultingStateRevision,
        context.world.current_tick,
      ],
    );
  } else {
    targetKind = 'election_result';
    const candidates = await context.client.query<{ candidacy_id: string }>(
      `/* governance:repair:election-recount-candidates */
       select candidacy.id::text as candidacy_id
         from election_results source
         join candidacies candidacy
           on candidacy.world_id=source.world_id
          and candidacy.election_id=source.election_id
          and candidacy.contest_id=source.contest_id
         join world_entities entity
           on entity.world_id=candidacy.world_id
          and entity.id=candidacy.candidate_entity_id
        where source.world_id=$1 and source.id=$2 and candidacy.status='accepted'
        order by entity.logical_key::text collate "C",candidacy.id`,
      [context.input.worldId, payload.sourceResultId],
    );
    if (candidates.rows.length < 1 || candidates.rows.length > 128) {
      throw new GovernanceCommandError(
        'GOVERNANCE_REPAIR_CONFLICT',
        'The election candidate evidence is unavailable.',
      );
    }
    const candidateCountIds = candidates.rows.map((candidate) => ({
      candidacyId: candidate.candidacy_id,
      countId: context.ids.next(),
    }));
    recounted = await queryOne<GovernanceRecountRow>(
      context.client,
      `/* governance:repair:election-recount */
       select result_id::text,tally_id::text,input_checksum,result_checksum,outcome
         from worldgraph_recount_election_result_v1(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12::bigint
         )`,
      [
        context.input.worldId,
        payload.sourceResultId,
        replacementResultId,
        replacementTallyId,
        safeJson(candidateCountIds),
        context.ids.next(),
        Buffer.from(payload.expectedCurrentResultChecksum, 'hex'),
        Buffer.from(payload.replacementResultChecksum, 'hex'),
        context.command.commandId,
        context.eventId,
        context.resultingStateRevision,
        context.world.current_tick,
      ],
    );
  }
  if (
    !recounted ||
    recounted.result_id !== replacementResultId ||
    recounted.tally_id !== replacementTallyId ||
    recounted.result_checksum.toString('hex') !== payload.replacementResultChecksum
  ) {
    throw new GovernanceCommandError(
      'GOVERNANCE_REPAIR_CONFLICT',
      'The deterministic recount did not match the supplied checksum.',
    );
  }

  const repairId = context.ids.next();
  await context.client.query(
    `/* governance:repair:append-recount */
     insert into governance_repairs(
       id,world_id,target_kind,target_id,repair_kind,reason,before_checksum,
       after_checksum,replacement_result_id,requires_second_approval,command_id,
       event_id,ledger_entry_id,actor_user_id,state_revision
     ) values ($1,$2,$3,$4,'recount',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::bigint)`,
    [
      repairId,
      context.input.worldId,
      targetKind,
      payload.sourceResultId,
      payload.reason,
      Buffer.from(payload.expectedCurrentResultChecksum, 'hex'),
      recounted.result_checksum,
      replacementResultId,
      context.policy.requireTwoPersonRepair,
      context.command.commandId,
      context.eventId,
      context.eventLedgerEntryId,
      context.input.actor.actorId,
      context.resultingStateRevision,
    ],
  );
  if (secondApproval) {
    await context.client.query(
      `/* governance:repair:recount-approval */
       insert into governance_repair_approvals(
         id,world_id,repair_id,approver_user_id,approval_hash,audit_record_id
       ) values ($1,$2,$3,$4,$5,$6)`,
      [
        context.ids.next(),
        context.input.worldId,
        repairId,
        secondApproval.actor_user_id,
        sha256Buffer({ approvalId: payload.approvalId, repairId }),
        payload.approvalId,
      ],
    );
  }
  return {
    event: plannedEvent(context, {
      aggregateId: repairId,
      aggregateType: 'governance_repair',
      aggregateVersion: '1',
      eventType: 'GovernanceRepairAppendedV1',
      ledgerKind: 'repair_anchor',
      payload: {
        eventType: 'GovernanceRepairAppendedV1',
        repairId,
        repairKind: payload.repairKind,
        replacementResultChecksum: recounted.result_checksum.toString('hex'),
        sourceResultId: payload.sourceResultId,
      },
      summaryCode: 'GOVERNANCE_RECOUNT_APPENDED',
      targetId: payload.sourceResultId,
      targetType: targetKind,
      visibility: 'operator',
    }),
    headCreated: true,
    responseDetails: {
      inputChecksum: recounted.input_checksum.toString('hex'),
      outcome: recounted.outcome,
      repairId,
      replacementResultId,
      replacementTallyId,
      resultChecksum: recounted.result_checksum.toString('hex'),
      status: 'recounted',
    },
  };
}

async function loadProposal(
  context: GovernanceHandlerContext,
  proposalId: string,
): Promise<ProposalRow> {
  const proposal = await queryOne<ProposalRow>(
    context.client,
    `/* governance:proposal:load */
     select proposal.id::text as proposal_id,proposal.aggregate_version::text,
       proposal.status,proposal.title,proposal.minimum_sponsors,
       proposal.proposer_entity_id::text,
       proposal.sponsorship_closes_tick::text,proposal.debate_closes_tick::text,
       proposal.voting_opens_tick::text,proposal.voting_closes_tick::text,
       proposal.quorum_numerator,proposal.threshold_numerator,
       proposal.ballot_mode,proposal.ballot_disclosure,proposal.allow_ballot_replacement,
       contest.contest_id::text,contest_head.aggregate_version::text as contest_version
      from proposals proposal
      left join proposal_contests contest
        on contest.world_id=proposal.world_id and contest.proposal_id=proposal.id
      left join governance_contests contest_head
        on contest_head.world_id=contest.world_id and contest_head.id=contest.contest_id
     where proposal.world_id=$1 and proposal.id=$2 for update of proposal`,
    [context.input.worldId, proposalId],
  );
  if (!proposal)
    throw new GovernanceCommandError('PROPOSAL_STATE_INVALID', 'Proposal was not found.');
  return proposal;
}

async function loadElection(
  context: GovernanceHandlerContext,
  electionId: string,
): Promise<ElectionRow> {
  const election = await queryOne<ElectionRow>(
    context.client,
    `/* governance:election:load */
     select election.id::text as election_id,election.institution_id::text,
       election.office_id::text,election.seat_id::text,election.election_kind,
       election.aggregate_version::text,election.status,
       election.nomination_opens_tick::text,election.nomination_closes_tick::text,
       election.voting_opens_tick::text,election.voting_closes_tick::text,
       election.certification_tick::text,election.term_starts_tick::text,
       election.quorum_numerator,election.tie_rule,election.ballot_mode,
       election.ballot_disclosure,election.allow_ballot_replacement,
       election.election_rule_snapshot,
       contest.contest_id::text,contest_head.aggregate_version::text as contest_version
      from elections election
      left join election_contests contest
        on contest.world_id=election.world_id and contest.election_id=election.id
      left join governance_contests contest_head
        on contest_head.world_id=election.world_id and contest_head.id=contest.contest_id
     where election.world_id=$1 and election.id=$2 for update of election`,
    [context.input.worldId, electionId],
  );
  if (!election)
    throw new GovernanceCommandError('ELECTION_STATE_INVALID', 'Election was not found.');
  return election;
}

async function assertCandidateOfficeEligibility(
  context: GovernanceHandlerContext,
  officeId: string,
  candidateEntityId: string,
): Promise<void> {
  const eligible = await queryOne<{ eligible: boolean }>(
    context.client,
    `/* governance:election:candidate-eligibility */
     select public.worldgraph_governance_policy_matches_v1(
              office.eligibility_policy,'in_world',array[membership.role::text],
              coalesce(held_offices.office_keys,array[]::text[]),
              coalesce(organizations.organization_keys,array[]::text[]),
              'governance.nominate','office',office.stable_key::text,$4::bigint
            ) as eligible
       from political_offices office
       join world_entity_controllers controller
         on controller.world_id=office.world_id and controller.entity_id=$3
        and controller.control_scope='primary' and controller.revoked_at is null
       join world_memberships membership
         on membership.world_id=controller.world_id and membership.user_id=controller.user_id
        and membership.status='active'
       join world_entities entity
         on entity.world_id=controller.world_id and entity.id=controller.entity_id
        and entity.entity_type='player_character' and entity.retired_world_version_id is null
       left join lateral (
         select coalesce(
           array_agg(held.office_key order by held.office_key collate "C"),
           array[]::text[]
         ) as office_keys
           from (
             select distinct held_office.stable_key::text as office_key
               from office_seat_authority_intervals authority
               join political_offices held_office
                 on held_office.world_id=authority.world_id
                and held_office.id=authority.office_id
              where authority.world_id=controller.world_id
                and authority.holder_entity_id=controller.entity_id
                and authority.effective_ticks @> $4::bigint
           ) held
       ) held_offices on true
       left join lateral (
         select coalesce(
           array_agg(member.organization_key order by member.organization_key collate "C"),
           array[]::text[]
         ) as organization_keys
           from (
             select distinct organization.logical_key::text as organization_key
               from world_relationships relationship
               join world_entities organization
                 on organization.world_id=relationship.world_id
                and organization.id=relationship.target_entity_id
                and organization.entity_type='organization'
                and organization.retired_world_version_id is null
              where relationship.world_id=controller.world_id
                and relationship.source_entity_id=controller.entity_id
                and relationship.relationship_type='member_of'
                and relationship.retired_world_version_id is null
           ) member
       ) organizations on true
      where office.world_id=$1 and office.id=$2
      limit 1`,
    [context.input.worldId, officeId, candidateEntityId, context.world.current_tick],
  );
  if (!eligible?.eligible) {
    throw new GovernanceCommandError(
      'GOVERNANCE_POLICY_DENIED',
      'The candidate does not satisfy the office eligibility policy.',
    );
  }
}

async function createEligibilitySnapshot(
  context: GovernanceHandlerContext,
  contestId: string,
  expected: {
    eligibleCount: number;
    policyChecksum: string;
    snapshotChecksum: string;
    snapshotId: string;
    sourceStateRevision: string;
  },
  owner: { aggregateId: string; aggregateType: 'election' | 'proposal' },
): Promise<void> {
  if (expected.sourceStateRevision !== context.world.state_revision) {
    throw new GovernanceCommandError(
      'REVISION_CONFLICT',
      'Eligibility snapshot revision is stale.',
    );
  }
  const source = await loadEligibilityPolicySource(context, owner);
  const policyDocument = {
    action: 'governance.vote',
    aggregateId: owner.aggregateId,
    aggregateType: owner.aggregateType,
    policy: source.eligibility_policy,
    policyDslVersion: 1,
    policySourceId: source.policy_source_id,
    policySourceKind: source.policy_source_kind,
    policySourceVersion: source.policy_source_version,
    resourceKey: null,
    resourceType: owner.aggregateType,
    snapshotTick: context.world.current_tick,
  };
  const policyChecksum = sha256Hex(policyDocument);
  const members = await context.client.query<SnapshotMemberRow>(
    `/* governance:eligibility:policy-members */
     select controller.entity_id::text as voter_entity_id,
       entity.logical_key::text as voter_entity_key,membership.role::text as membership_role,
       membership.row_version as membership_version,
       coalesce(held_offices.office_keys,array[]::text[]) as held_office_keys,
       coalesce(organizations.organization_keys,array[]::text[]) as organization_keys
      from world_memberships membership
      join world_entity_controllers controller
        on controller.world_id=membership.world_id
       and controller.user_id=membership.user_id
       and controller.control_scope='primary' and controller.revoked_at is null
      join world_entities entity
        on entity.world_id=controller.world_id and entity.id=controller.entity_id
       and entity.entity_type='player_character' and entity.retired_world_version_id is null
      left join lateral (
        select coalesce(
          array_agg(held.office_key order by held.office_key collate "C"),
          array[]::text[]
        ) as office_keys
          from (
            select distinct office.stable_key::text as office_key
              from office_seat_authority_intervals authority
              join political_offices office
                on office.world_id=authority.world_id and office.id=authority.office_id
             where authority.world_id=membership.world_id
               and authority.holder_entity_id=controller.entity_id
               and authority.effective_ticks @> $3::bigint
          ) held
      ) held_offices on true
      left join lateral (
        select coalesce(
          array_agg(member.organization_key order by member.organization_key collate "C"),
          array[]::text[]
        ) as organization_keys
          from (
            select distinct organization.logical_key::text as organization_key
              from world_relationships relationship
              join world_entities organization
                on organization.world_id=relationship.world_id
               and organization.id=relationship.target_entity_id
               and organization.entity_type='organization'
               and organization.retired_world_version_id is null
             where relationship.world_id=membership.world_id
               and relationship.source_entity_id=controller.entity_id
               and relationship.relationship_type='member_of'
               and relationship.retired_world_version_id is null
          ) member
      ) organizations on true
     where membership.world_id=$1 and membership.status='active'
       and public.worldgraph_governance_policy_matches_v1(
         $2::jsonb,'in_world',array[membership.role::text],
         coalesce(held_offices.office_keys,array[]::text[]),
         coalesce(organizations.organization_keys,array[]::text[]),'governance.vote',
         $4,null::text,$3::bigint
       )
     order by entity.logical_key::text collate "C",controller.entity_id`,
    [
      context.input.worldId,
      safeJson(source.eligibility_policy),
      context.world.current_tick,
      owner.aggregateType,
    ],
  );
  const memberFacts = members.rows.map((member) => ({
    basis: {
      actorMode: 'in_world',
      heldOfficeKeys: member.held_office_keys,
      membershipRoles: [member.membership_role],
      membershipVersion: member.membership_version,
      organizationKeys: member.organization_keys,
      policyChecksum,
      rule: 'governance_policy_v1',
    },
    voterEntityId: member.voter_entity_id,
    voterEntityKey: member.voter_entity_key,
    weight: 1,
  }));
  const snapshotChecksum = sha256Hex({
    contestId,
    members: memberFacts,
    policyChecksum,
    snapshotTick: context.world.current_tick,
    sourceStateRevision: context.world.state_revision,
  });
  if (
    members.rows.length !== expected.eligibleCount ||
    policyChecksum !== expected.policyChecksum ||
    snapshotChecksum !== expected.snapshotChecksum
  ) {
    throw new GovernanceCommandError(
      'TALLY_CHECKSUM_MISMATCH',
      'The supplied eligibility snapshot does not match the governing eligibility policy.',
    );
  }
  const membershipCursor = members.rows.reduce(
    (maximum, member) => Math.max(maximum, member.membership_version),
    0,
  );
  await context.client.query(
    `/* governance:eligibility:snapshot */
     insert into eligibility_snapshots(
       id,world_id,contest_id,rule_schema_version,policy_dsl_version,snapshot_tick,
       source_state_revision,source_membership_cursor,eligible_count,rule_snapshot,
       checksum,generated_command_id,generated_event_id
     ) values ($1,$2,$3,1,1,$4::bigint,$5::bigint,$6::bigint,$7,$8,$9,$10,$11)`,
    [
      expected.snapshotId,
      context.input.worldId,
      contestId,
      context.world.current_tick,
      context.world.state_revision,
      membershipCursor,
      members.rows.length,
      safeJson({ owner, ...policyDocument, policyChecksum }),
      Buffer.from(snapshotChecksum, 'hex'),
      context.command.commandId,
      context.eventId,
    ],
  );
  for (const [index, member] of members.rows.entries()) {
    const basis = memberFacts[index]!.basis;
    await context.client.query(
      `/* governance:eligibility:member */
       insert into eligibility_snapshot_members(
         id,world_id,snapshot_id,contest_id,voter_entity_id,voting_weight,
         eligibility_basis,member_hash
       ) values ($1,$2,$3,$4,$5,1,$6,$7)`,
      [
        context.ids.next(),
        context.input.worldId,
        expected.snapshotId,
        contestId,
        member.voter_entity_id,
        safeJson(basis),
        sha256Buffer({ basis, contestId, voterEntityId: member.voter_entity_id, weight: 1 }),
      ],
    );
  }
}

async function loadEligibilityPolicySource(
  context: GovernanceHandlerContext,
  owner: { aggregateId: string; aggregateType: 'election' | 'proposal' },
): Promise<EligibilityPolicySourceRow> {
  const source =
    owner.aggregateType === 'proposal'
      ? await queryOne<EligibilityPolicySourceRow>(
          context.client,
          `/* governance:eligibility:proposal-policy */
       select charter_version.canonical_policy_document->'citizenEligibilityPolicy'
                as eligibility_policy,
              charter_version.id::text as policy_source_id,
              'charter_citizen_eligibility'::text as policy_source_kind,
              charter_version.charter_version::text as policy_source_version
         from proposals proposal
         join institutions institution
           on institution.world_id=proposal.world_id and institution.id=proposal.institution_id
         join governing_charter_versions configured_version
           on configured_version.world_id=institution.world_id
          and configured_version.id=institution.charter_version_id
         join charter_authority_intervals authority
           on authority.world_id=configured_version.world_id
          and authority.charter_id=configured_version.charter_id
          and authority.effective_ticks @> $3::bigint
         join governing_charter_versions charter_version
           on charter_version.world_id=authority.world_id
          and charter_version.id=authority.charter_version_id
        where proposal.world_id=$1 and proposal.id=$2`,
          [context.input.worldId, owner.aggregateId, context.world.current_tick],
        )
      : await queryOne<EligibilityPolicySourceRow>(
          context.client,
          `/* governance:eligibility:election-policy */
       select office.eligibility_policy,
              office.id::text as policy_source_id,
              'office_eligibility'::text as policy_source_kind,
              office.row_version::text as policy_source_version
         from elections election
         join political_offices office
           on office.world_id=election.world_id and office.id=election.office_id
        where election.world_id=$1 and election.id=$2`,
          [context.input.worldId, owner.aggregateId],
        );
  if (!source?.eligibility_policy) {
    throw new GovernanceCommandError(
      'GOVERNANCE_POLICY_DENIED',
      'The governing eligibility policy is unavailable.',
    );
  }
  return source;
}

async function castBallot(
  context: GovernanceHandlerContext,
  input: {
    choice: Record<string, unknown>;
    contestId: string;
    eligibilitySnapshotId: string;
    expectedContestVersion: string;
    replaceExisting: boolean;
    voterEntityId: string;
  },
): Promise<CastResultRow> {
  if (context.world.current_tick !== context.command.expectedTick) {
    throw new GovernanceCommandError('EXPECTED_TICK_MISMATCH', 'Ballot tick changed.');
  }
  const existing = await queryOne<{ participation_id: string }>(
    context.client,
    `/* governance:ballot:participation */
     select id::text as participation_id from ballot_participation
      where world_id=$1 and contest_id=$2 and voter_entity_id=$3`,
    [context.input.worldId, input.contestId, input.voterEntityId],
  );
  if (existing && !input.replaceExisting) {
    throw new GovernanceCommandError('BALLOT_ALREADY_CAST', 'A ballot has already been cast.');
  }
  if (!existing && input.replaceExisting) {
    throw new GovernanceCommandError(
      'BALLOT_REPLACEMENT_NOT_ALLOWED',
      'There is no existing ballot to replace.',
    );
  }
  const participationId = existing?.participation_id ?? context.ids.next();
  const choiceRevisionId = context.ids.next();
  const receiptId = context.ids.next();
  const receiptHash = sha256Buffer({
    commandId: context.command.commandId,
    contestId: input.contestId,
    domain: 'worldgraph.governance-ballot-receipt.v1',
    receiptId,
  });
  const contest = await queryOne<{ ballot_mode: string }>(
    context.client,
    `/* governance:ballot:mode */
     select ballot_mode from governance_contests where world_id=$1 and id=$2`,
    [context.input.worldId, input.contestId],
  );
  const linkageNonce =
    contest?.ballot_mode === 'secret'
      ? sha256Buffer({
          commandId: context.command.commandId,
          domain: 'worldgraph.governance-secret-linkage-nonce.v1',
          participationId,
        })
      : null;
  // Privacy boundary: this fixed SECURITY DEFINER function is the only SQL
  // statement in the package that receives an individual ballot choice.
  const result = await context.client.query<CastResultRow>(
    `/* governance:ballot:cast-choice-boundary */
     select participation_id::text,receipt_hash,ballot_mode,effective_revision,
       participation_version::text,choice_totals
      from worldgraph_cast_governance_ballot_v1(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12,$13::bigint,$14,$15,$16::bigint
     )`,
    [
      context.input.worldId,
      input.contestId,
      input.eligibilitySnapshotId,
      input.voterEntityId,
      participationId,
      choiceRevisionId,
      receiptId,
      receiptHash,
      linkageNonce,
      safeJson(input.choice),
      input.expectedContestVersion,
      input.replaceExisting,
      context.world.current_tick,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
    ],
  );
  const cast = result.rows[0];
  if (!cast) throw new GovernanceCommandError('BALLOT_INELIGIBLE', 'The ballot was not recorded.');
  return cast;
}

async function turnout(context: GovernanceHandlerContext, contestId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    context.client,
    `/* governance:ballot:turnout */
     select count(*)::integer as count from ballot_participation
      where world_id=$1 and contest_id=$2`,
    [context.input.worldId, contestId],
  );
  return row?.count ?? 0;
}

function proposalBallotEventPayload(
  proposal: ProposalRow,
  cast: CastResultRow,
  choice: GovernanceProposalChoice,
  voterEntityKey: string | null,
  turnoutCount: number,
): Record<string, unknown> & { eventType: string } {
  const common = {
    aggregateVersion: cast.participation_version,
    proposalId: proposal.proposal_id,
  };
  if (cast.ballot_mode === 'secret') {
    return {
      ...common,
      ballotMode: 'secret',
      disclosure: 'aggregate_only',
      eventType: 'ProposalBallotRecordedSecretV1',
      receiptHash: cast.receipt_hash.toString('hex'),
    };
  }
  if (proposal.ballot_disclosure === 'voter_and_choice') {
    if (voterEntityKey === null) {
      throw new Error('Public proposal ballot voter disclosure is missing its voter key.');
    }
    return {
      ...common,
      ballotMode: 'public',
      choice,
      disclosure: 'voter_and_choice',
      eventType: 'ProposalBallotRecordedPublicV1',
      receiptHash: cast.receipt_hash.toString('hex'),
      turnoutCount,
      voterEntityKey,
    };
  }
  if (proposal.ballot_disclosure === 'choice_totals') {
    const totals = cast.choice_totals;
    if (!hasExactKeys(totals, ['abstainCount', 'noCount', 'yesCount'])) {
      throw new Error('Proposal ballot choice totals violated the database result contract.');
    }
    const event = {
      ...common,
      abstainCount: totals.abstainCount,
      ballotMode: 'public' as const,
      disclosure: 'choice_totals' as const,
      eventType: 'ProposalBallotRecordedPublicV1' as const,
      noCount: totals.noCount,
      turnoutCount,
      yesCount: totals.yesCount,
    };
    if (!proposalPublicBallotEventValidator.is(event)) {
      throw new Error('Proposal ballot choice totals violated the public event contract.');
    }
    return event;
  }
  return {
    ...common,
    ballotMode: 'public',
    disclosure: 'aggregate_only',
    eventType: 'ProposalBallotRecordedPublicV1',
    turnoutCount,
  };
}

function electionBallotEventPayload(
  election: ElectionRow,
  cast: CastResultRow,
  choice: GovernanceElectionChoiceV1,
  voterEntityKey: string | null,
  turnoutCount: number,
): Record<string, unknown> & { eventType: string } {
  const common = {
    aggregateVersion: cast.participation_version,
    electionId: election.election_id,
  };
  if (cast.ballot_mode === 'secret') {
    return {
      ...common,
      ballotMode: 'secret',
      disclosure: 'aggregate_only',
      eventType: 'ElectionBallotRecordedSecretV1',
      receiptHash: cast.receipt_hash.toString('hex'),
    };
  }
  if (election.ballot_disclosure === 'voter_and_choice') {
    if (voterEntityKey === null) {
      throw new Error('Public election ballot voter disclosure is missing its voter key.');
    }
    return {
      ...common,
      ballotMode: 'public',
      choice,
      disclosure: 'voter_and_choice',
      eventType: 'ElectionBallotRecordedPublicV1',
      receiptHash: cast.receipt_hash.toString('hex'),
      turnoutCount,
      voterEntityKey,
    };
  }
  if (election.ballot_disclosure === 'choice_totals') {
    const totals = cast.choice_totals;
    if (!hasExactKeys(totals, ['abstainCount', 'candidateTotals'])) {
      throw new Error('Election ballot choice totals violated the database result contract.');
    }
    const event = {
      ...common,
      abstainCount: totals.abstainCount,
      ballotMode: 'public' as const,
      candidateTotals: totals.candidateTotals,
      disclosure: 'choice_totals' as const,
      eventType: 'ElectionBallotRecordedPublicV1' as const,
      turnoutCount,
    };
    if (!electionPublicBallotEventValidator.is(event)) {
      throw new Error('Election ballot choice totals violated the public event contract.');
    }
    return event;
  }
  return {
    ...common,
    ballotMode: 'public',
    disclosure: 'aggregate_only',
    eventType: 'ElectionBallotRecordedPublicV1',
    turnoutCount,
  };
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

async function loadSnapshot(
  context: GovernanceHandlerContext,
  snapshotId: string,
  contestId: string,
): Promise<{ eligible_count: number }> {
  const snapshot = await queryOne<{ eligible_count: number }>(
    context.client,
    `/* governance:eligibility:load */
     select eligible_count from eligibility_snapshots
      where world_id=$1 and id=$2 and contest_id=$3`,
    [context.input.worldId, snapshotId, contestId],
  );
  if (!snapshot)
    throw new GovernanceCommandError('BALLOT_INELIGIBLE', 'Eligibility snapshot is invalid.');
  return snapshot;
}

async function insertProposalTransition(
  context: GovernanceHandlerContext,
  proposalId: string,
  fromStatus: string,
  toStatus: string,
  version: string,
  reasonCode: string,
): Promise<void> {
  await context.client.query(
    `/* governance:proposal:transition */
     insert into proposal_transitions(
       id,world_id,proposal_id,from_status,to_status,effective_tick,aggregate_version,
       reason_code,command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8,$9,$10,$11::bigint,$12)`,
    [
      context.ids.next(),
      context.input.worldId,
      proposalId,
      fromStatus,
      toStatus,
      context.world.current_tick,
      version,
      reasonCode,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
      sha256Buffer({ fromStatus, proposalId, reasonCode, toStatus, version }),
    ],
  );
}

async function insertCandidacyTransition(
  context: GovernanceHandlerContext,
  candidacyId: string,
  fromStatus: string,
  toStatus: string,
  version: string,
): Promise<void> {
  await context.client.query(
    `/* governance:election:candidacy-transition */
     insert into candidacy_transitions(
       id,world_id,candidacy_id,from_status,to_status,effective_tick,
       aggregate_version,command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8,$9,$10::bigint,$11)`,
    [
      context.ids.next(),
      context.input.worldId,
      candidacyId,
      fromStatus,
      toStatus,
      context.world.current_tick,
      version,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
      sha256Buffer({ candidacyId, fromStatus, toStatus, version }),
    ],
  );
}

async function createScheduledAction(
  context: GovernanceHandlerContext,
  actionType:
    | 'CertifyAndEnactProposalV1'
    | 'CertifyElectionV1'
    | 'CloseAndTallyElectionV1'
    | 'CloseAndTallyProposalV1'
    | 'OpenElectionV1'
    | 'OpenProposalVotingV1',
  targetId: string,
  dueTick: string,
  targetKind: 'election' | 'proposal',
): Promise<string> {
  const scheduleId = context.ids.next();
  const scheduleEventId = context.ids.next();
  const scheduleLedgerEntryId = context.ids.next();
  const payload = targetKind === 'proposal' ? { proposalId: targetId } : { electionId: targetId };
  const payloadHash = sha256Buffer(payload);
  const sequence = await queryOne<{ sequence: string }>(
    context.client,
    `/* governance:schedule:allocate */
     select worldgraph_allocate_schedule_sequence($1)::text as sequence`,
    [context.input.worldId],
  );
  if (!sequence)
    throw new GovernanceCommandError(
      'INTERNAL_COMMAND_FAILED',
      'Schedule allocation failed.',
      false,
    );
  await context.client.query(
    `/* governance:schedule:create */
     insert into scheduled_actions(
       id,world_id,schedule_sequence,due_tick,priority,action_type,
       action_schema_version,payload,payload_hash,process_version,
       created_by_actor_type,created_by_actor_id,created_command_id,created_state_revision,
       created_at,updated_at
     ) values ($1,$2,$3::bigint,$4::bigint,0,$5,1,$6,$7,'1.0.0',
       $8,$9,$10,$11::bigint,$12,$12)`,
    [
      scheduleId,
      context.input.worldId,
      sequence.sequence,
      dueTick,
      actionType,
      safeJson(payload),
      payloadHash,
      context.input.actor.actorType,
      context.input.actor.actorId,
      context.command.commandId,
      context.resultingStateRevision,
      context.world.recorded_at,
    ],
  );
  context.additionalEvents.push({
    aggregateId: scheduleId,
    aggregateType: 'scheduled_action',
    aggregateVersion: '1',
    eventId: scheduleEventId,
    eventType: 'ScheduledActionCreatedV1',
    history: {
      category: 'governance',
      summaryArgs: { actionType, dueTick, targetKind },
      targetId: scheduleId,
      targetType: 'scheduled_action',
      titleKey: 'history.governance.scheduled_action_created',
      visibility: 'member',
    },
    ledgerEntryId: scheduleLedgerEntryId,
    payload: {
      actionSchemaVersion: 1,
      actionType,
      dueTick,
      payload,
      payloadHash: payloadHash.toString('hex'),
      priority: 0,
      processVersion: '1.0.0',
      scheduleId,
      scheduleSequence: sequence.sequence,
    },
    summaryCode: 'SCHEDULED_ACTION_CREATED',
  });
  return scheduleId;
}

async function enactProposalActions(
  context: GovernanceHandlerContext,
  proposalId: string,
  proposalResultId: string,
  inputChecksum: Buffer,
  enactmentAttempt = 1,
): Promise<Buffer> {
  const actions = await context.client.query<ProposalActionRow>(
    `/* governance:enactment:load-actions */
     select id::text as action_id,action_ordinal,action_kind,action_payload
       from proposal_actions
      where world_id=$1 and proposal_id=$2
      order by action_ordinal`,
    [context.input.worldId, proposalId],
  );
  if (actions.rows.length < 1) {
    throw new GovernanceCommandError('ENACTMENT_FAILED', 'Proposal contains no enactable action.');
  }
  const enactmentId = context.ids.next();
  const effects: Array<{
    actionId: string;
    checksum: Buffer;
    effectId: string;
    kind: string;
    version: string;
  }> = [];
  for (const action of actions.rows) {
    effects.push(
      await enactAction(context, action.action_payload, {
        actionId: action.action_id,
        actionOrdinal: action.action_ordinal,
        enactmentId,
        proposalId,
        proposalResultId,
      }),
    );
  }
  const outputChecksum = sha256Buffer({
    effects: effects.map((effect) => ({
      checksum: effect.checksum.toString('hex'),
      effectId: effect.effectId,
      kind: effect.kind,
      version: effect.version,
    })),
    enactmentKey:
      context.command.type === 'CertifyAndEnactProposalV1'
        ? context.command.payload.enactmentKey
        : context.command.commandId,
    proposalId,
    proposalResultId,
  });
  await context.client.query(
    `/* governance:enactment:success */
     insert into proposal_enactments(
       id,world_id,proposal_id,proposal_result_id,enactment_attempt,status,
       failure_code,input_checksum,output_checksum,command_id,event_id,
       state_revision,enacted_tick
     ) values ($1,$2,$3,$4,$5::integer,'succeeded',null,$6,$7,$8,$9,$10::bigint,$11::bigint)`,
    [
      enactmentId,
      context.input.worldId,
      proposalId,
      proposalResultId,
      enactmentAttempt,
      inputChecksum,
      outputChecksum,
      context.command.commandId,
      context.eventId,
      context.resultingStateRevision,
      context.world.current_tick,
    ],
  );
  for (const effect of effects) {
    await context.client.query(
      `/* governance:enactment:link-effect */
       insert into proposal_action_enactments(
         id,world_id,proposal_enactment_id,proposal_action_id,effect_kind,
         effect_id,effect_version,effect_checksum
       ) values ($1,$2,$3,$4,$5,$6,$7::bigint,$8)`,
      [
        context.ids.next(),
        context.input.worldId,
        enactmentId,
        effect.actionId,
        effect.kind,
        effect.effectId,
        effect.version,
        effect.checksum,
      ],
    );
  }
  return outputChecksum;
}

async function enactAction(
  context: GovernanceHandlerContext,
  action: GovernanceProposalActionV1,
  source: {
    actionId: string;
    actionOrdinal: number;
    enactmentId: string;
    proposalId: string;
    proposalResultId: string;
  },
): Promise<{
  actionId: string;
  checksum: Buffer;
  effectId: string;
  kind: string;
  version: string;
}> {
  switch (action.actionType) {
    case 'create_law': {
      if (!effectTickCanApply(context, action.effectiveFromTick)) {
        throw new GovernanceCommandError(
          'ENACTMENT_FAILED',
          'New laws must take effect at the certification tick.',
        );
      }
      const existing = await queryOne<{ present: boolean }>(
        context.client,
        `/* governance:enactment:law-create-check */
         select true as present from laws where world_id=$1 and stable_key=$2`,
        [context.input.worldId, action.lawKey],
      );
      if (existing)
        throw new GovernanceCommandError('LAW_VERSION_CONFLICT', 'Law key already exists.');
      const jurisdiction = await queryOne<{ jurisdiction_entity_id: string }>(
        context.client,
        `/* governance:enactment:proposal-jurisdiction */
         select jurisdiction_entity_id::text from proposals where world_id=$1 and id=$2`,
        [context.input.worldId, source.proposalId],
      );
      if (!jurisdiction)
        throw new GovernanceCommandError('ENACTMENT_FAILED', 'Proposal jurisdiction is missing.');
      const lawId = context.ids.next();
      const versionId = context.ids.next();
      const checksum = sha256Buffer({ action, lawId, lawVersion: 1 });
      const transitionId = context.ids.next();
      const transitionChecksum = sha256Buffer({
        lawId,
        status:
          BigInt(action.effectiveFromTick) <= BigInt(context.world.current_tick)
            ? 'active'
            : 'scheduled',
        tick: action.effectiveFromTick,
        version: 1,
      });
      const authorityIntervalId = context.ids.next();
      const effectEvent = addLawVersionActivatedEvent(context, {
        effectiveFromTick: action.effectiveFromTick,
        lawId,
        lawVersion: '1',
        lawVersionId: versionId,
        sourceProposalId: source.proposalId,
      });
      await context.client.query(
        `/* governance:enactment:law-create */
         insert into laws(
           id,world_id,jurisdiction_entity_id,stable_key,title,created_command_id,
           created_event_id,created_state_revision
         ) values ($1,$2,$3,$4,$5,$6,$7,$8::bigint)`,
        [
          lawId,
          context.input.worldId,
          jurisdiction.jurisdiction_entity_id,
          action.lawKey,
          action.title,
          context.command.commandId,
          effectEvent.eventId,
          context.resultingStateRevision,
        ],
      );
      await context.client.query(
        `/* governance:enactment:law-create-version */
         insert into law_versions(
           id,world_id,law_id,law_version,version_kind,initial_status,title,summary,
           policy_ast,action_effects,policy_dsl_version,supersedes_version_id,
           source_proposal_result_id,source_action_ordinal,effective_from_tick,
           checksum,created_command_id,created_event_id,created_state_revision
         ) values ($1,$2,$3,1,'create',case when $4::bigint <= $5::bigint then 'active' else 'scheduled' end,
           $6,$7,$8,'{}'::jsonb,1,null,$9,$10,$4::bigint,$11,$12,$13,$14::bigint)`,
        [
          versionId,
          context.input.worldId,
          lawId,
          action.effectiveFromTick,
          context.world.current_tick,
          action.title,
          action.summary,
          safeJson(action.policy),
          source.proposalResultId,
          source.actionOrdinal,
          checksum,
          context.command.commandId,
          effectEvent.eventId,
          context.resultingStateRevision,
        ],
      );
      await context.client.query(
        `/* governance:enactment:law-create-transition */
         insert into law_effectivity_transitions(
           id,world_id,law_id,law_version_id,from_status,to_status,effective_tick,
           command_id,event_id,state_revision,checksum
         ) values ($1,$2,$3,$4,null,
           case when $5::bigint <= $6::bigint then 'active' else 'scheduled' end,
           $5::bigint,$7,$8,$9::bigint,$10)`,
        [
          transitionId,
          context.input.worldId,
          lawId,
          versionId,
          action.effectiveFromTick,
          context.world.current_tick,
          context.command.commandId,
          effectEvent.eventId,
          context.resultingStateRevision,
          transitionChecksum,
        ],
      );
      await context.client.query(
        `/* governance:enactment:law-create-authority */
         insert into law_authority_intervals(
           id,world_id,law_id,law_version_id,effective_ticks,created_command_id,
           updated_command_id,row_version
         ) values ($1,$2,$3,$4,int8range($5::bigint,$6::bigint,'[)'),$7,$7,1)`,
        [
          authorityIntervalId,
          context.input.worldId,
          lawId,
          versionId,
          action.effectiveFromTick,
          action.effectiveUntilTick,
          context.command.commandId,
        ],
      );
      return {
        actionId: source.actionId,
        checksum,
        effectId: versionId,
        kind: 'law_version',
        version: '1',
      };
    }
    case 'amend_law':
    case 'repeal_law': {
      const previous = await queryOne<{
        current_version: number;
        jurisdiction_entity_id: string;
        policy_ast: Record<string, unknown>;
        previous_version_id: string;
        stable_key: string;
        summary: string;
        title: string;
      }>(
        context.client,
        // Laws and versions are immutable. The command executor's world lock plus the mutable
        // authority-row update below provide serialization without requiring UPDATE privilege.
        `/* governance:enactment:law-load */
         select law.jurisdiction_entity_id::text,law.stable_key::text,
           version.id::text as previous_version_id,version.law_version as current_version,
           version.title,version.summary,version.policy_ast
          from laws law
          join law_versions version on version.world_id=law.world_id and version.law_id=law.id
         where law.world_id=$1 and law.id=$2
         order by version.law_version desc limit 1`,
        [context.input.worldId, action.lawId],
      );
      if (!previous || previous.current_version !== Number(action.expectedLawVersion)) {
        throw new GovernanceCommandError(
          'LAW_VERSION_CONFLICT',
          'Law version changed before enactment.',
        );
      }
      const version = previous.current_version + 1;
      const versionId = context.ids.next();
      const effectiveTick =
        action.actionType === 'amend_law' ? action.effectiveFromTick : action.effectiveAtTick;
      if (!effectTickCanApply(context, effectiveTick)) {
        throw new GovernanceCommandError(
          'ENACTMENT_FAILED',
          'Law changes must take effect at the certification tick.',
        );
      }
      const checksum = sha256Buffer({ action, lawId: action.lawId, lawVersion: version });
      const title = action.actionType === 'amend_law' ? action.title : previous.title;
      const summary = action.actionType === 'amend_law' ? action.summary : action.reason;
      const policy = action.actionType === 'amend_law' ? action.policy : previous.policy_ast;
      const versionKind = action.actionType === 'amend_law' ? 'amend' : 'repeal';
      const nextStatus = action.actionType === 'amend_law' ? 'active' : 'repealed';
      const transitionId = context.ids.next();
      const transitionChecksum = sha256Buffer({
        lawId: action.lawId,
        status: nextStatus,
        tick: effectiveTick,
        version,
      });
      const effectEvent = addLawVersionActivatedEvent(context, {
        effectiveFromTick: effectiveTick,
        lawId: action.lawId,
        lawVersion: String(version),
        lawVersionId: versionId,
        sourceProposalId: source.proposalId,
      });
      const closedAuthority = await context.client.query(
        `/* governance:enactment:law-close-authority */
         update law_authority_intervals set
           effective_ticks=int8range(lower(effective_ticks),$3::bigint,'[)'),
           updated_command_id=$4,row_version=row_version+1,updated_at=$5
          where world_id=$1 and law_id=$2 and effective_ticks @> $3::bigint`,
        [
          context.input.worldId,
          action.lawId,
          effectiveTick,
          context.command.commandId,
          context.world.recorded_at,
        ],
      );
      if ((closedAuthority.rowCount ?? 0) !== 1) {
        throw new GovernanceCommandError(
          'LAW_VERSION_CONFLICT',
          'Law authority changed during enactment.',
        );
      }
      await context.client.query(
        `/* governance:enactment:law-revision */
         insert into law_versions(
           id,world_id,law_id,law_version,version_kind,initial_status,title,summary,
           policy_ast,action_effects,policy_dsl_version,supersedes_version_id,
           source_proposal_result_id,source_action_ordinal,effective_from_tick,
           checksum,created_command_id,created_event_id,created_state_revision
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14::bigint,
           $15,$16,$17,$18::bigint)`,
        [
          versionId,
          context.input.worldId,
          action.lawId,
          version,
          versionKind,
          nextStatus,
          title,
          summary,
          safeJson(policy),
          safeJson({ actionType: action.actionType }),
          previous.previous_version_id,
          source.proposalResultId,
          source.actionOrdinal,
          effectiveTick,
          checksum,
          context.command.commandId,
          effectEvent.eventId,
          context.resultingStateRevision,
        ],
      );
      await context.client.query(
        `/* governance:enactment:law-transition */
         insert into law_effectivity_transitions(
           id,world_id,law_id,law_version_id,from_status,to_status,effective_tick,
           command_id,event_id,state_revision,checksum
         ) values ($1,$2,$3,$4,'active',$5,$6::bigint,$7,$8,$9::bigint,$10)`,
        [
          transitionId,
          context.input.worldId,
          action.lawId,
          versionId,
          nextStatus,
          effectiveTick,
          context.command.commandId,
          effectEvent.eventId,
          context.resultingStateRevision,
          transitionChecksum,
        ],
      );
      if (action.actionType === 'amend_law') {
        await context.client.query(
          `/* governance:enactment:law-amend-authority */
           insert into law_authority_intervals(
             id,world_id,law_id,law_version_id,effective_ticks,created_command_id,
             updated_command_id,row_version
           ) values ($1,$2,$3,$4,int8range($5::bigint,$6::bigint,'[)'),$7,$7,1)`,
          [
            context.ids.next(),
            context.input.worldId,
            action.lawId,
            versionId,
            effectiveTick,
            action.effectiveUntilTick,
            context.command.commandId,
          ],
        );
      }
      return {
        actionId: source.actionId,
        checksum,
        effectId: versionId,
        kind: 'law_version',
        version: String(version),
      };
    }
    case 'update_tax': {
      if (!effectTickCanApply(context, action.effectiveFromTick)) {
        throw new GovernanceCommandError(
          'ENACTMENT_FAILED',
          'Tax policy authority must begin at the certification tick.',
        );
      }
      if (
        action.newRateBps < context.policy.minimumTaxRateBps ||
        action.newRateBps > context.policy.maximumTaxRateBps
      ) {
        throw new GovernanceCommandError(
          'GOVERNANCE_POLICY_DENIED',
          'Tax rate is outside policy limits.',
        );
      }
      const previous = await queryOne<{
        applicability: Record<string, unknown>;
        authority_entity_id: string;
        collection_mode: string;
        currency_id: string;
        fixed_amount_minor: string;
        policy_version: number;
        primitive_content_hash: Buffer;
        primitive_key: string;
        primitive_ref: string;
        primitive_version: string;
        primitive_version_id: string;
        source_plan_hash: Buffer;
        source_world_version_id: string;
        stable_key: string;
        tax_type: string;
        treasury_wallet_id: string;
      }>(
        context.client,
        // Tax policies are immutable and the application role intentionally cannot lock them
        // FOR UPDATE. The governed insertion boundary serializes on the mutable authority row.
        `/* governance:enactment:tax-load */
         select stable_key::text,policy_version,authority_entity_id::text,
           treasury_wallet_id::text,currency_id::text,tax_type::text,
           collection_mode::text,fixed_amount_minor::text,applicability,
           primitive_ref,primitive_key,primitive_version,primitive_version_id::text,
           primitive_content_hash,source_world_version_id::text,source_plan_hash
          from tax_policies where world_id=$1 and id=$2`,
        [context.input.worldId, action.taxPolicyId],
      );
      if (!previous || previous.policy_version !== Number(action.expectedTaxPolicyVersion)) {
        throw new GovernanceCommandError('LAW_VERSION_CONFLICT', 'Tax policy version changed.');
      }
      const newId = context.ids.next();
      const version = previous.policy_version + 1;
      const checksum = sha256Buffer({ action, policyId: newId, policyVersion: version });
      const lineageId = context.ids.next();
      const inserted = await context.client.query<{ policy_id: string }>(
        `/* governance:enactment:tax-update */
         select worldgraph_insert_governed_tax_policy_v1(
           $1,$2,$3,$4,$5,$6::integer,$7,$8,$9,
           $10::tax_policy_type,$11::tax_collection_mode,$12::integer,$13::bigint,
           $14::jsonb,$15::bigint,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
           $26,$27,$28::bigint,$29
         )::text as policy_id`,
        [
          lineageId,
          context.input.worldId,
          action.taxPolicyId,
          newId,
          previous.stable_key,
          version,
          previous.authority_entity_id,
          previous.treasury_wallet_id,
          previous.currency_id,
          previous.tax_type,
          previous.collection_mode,
          action.newRateBps,
          previous.fixed_amount_minor,
          safeJson(previous.applicability),
          action.effectiveFromTick,
          previous.primitive_ref,
          previous.primitive_key,
          previous.primitive_version,
          previous.primitive_version_id,
          previous.primitive_content_hash,
          previous.source_world_version_id,
          previous.source_plan_hash,
          source.proposalResultId,
          source.actionId,
          source.enactmentId,
          context.command.commandId,
          context.eventId,
          context.resultingStateRevision,
          checksum,
        ],
      );
      if (inserted.rows[0]?.policy_id !== newId) {
        throw new GovernanceCommandError('ENACTMENT_FAILED', 'Governed tax policy update failed.');
      }
      return {
        actionId: source.actionId,
        checksum,
        effectId: newId,
        kind: 'tax_policy',
        version: String(version),
      };
    }
    case 'authorize_public_project': {
      if (!effectTickCanApply(context, action.effectiveAtTick)) {
        throw new GovernanceCommandError(
          'ENACTMENT_FAILED',
          'Public project authority must begin at the certification tick.',
        );
      }
      const treasury = await queryOne<{
        currency_status: string;
        spendable_minor: string;
        wallet_kind: string;
        wallet_status: string;
      }>(
        context.client,
        `/* governance:enactment:public-project-treasury */
         select wallet.wallet_kind::text,wallet.status::text as wallet_status,
                currency.status::text as currency_status,
                public.worldgraph_wallet_spendable_minor_v1(
                  wallet.world_id,wallet.id
                )::text as spendable_minor
           from wallets wallet
           join currencies currency
             on currency.world_id=wallet.world_id and currency.id=wallet.currency_id
           join wallet_balances balance
             on balance.world_id=wallet.world_id and balance.wallet_id=wallet.id
            and balance.currency_id=wallet.currency_id
          where wallet.world_id=$1 and wallet.id=$2 and wallet.currency_id=$3
          for update of wallet,currency,balance`,
        [context.input.worldId, action.treasuryWalletId, action.currencyId],
      );
      if (
        !treasury ||
        treasury.wallet_kind !== 'treasury' ||
        treasury.wallet_status !== 'active' ||
        treasury.currency_status !== 'active' ||
        BigInt(treasury.spendable_minor) < BigInt(action.amountMinor)
      ) {
        throw new GovernanceCommandError(
          'ENACTMENT_FAILED',
          'The active treasury cannot fund this project in the requested currency.',
        );
      }
      const projectEntityId = await resolveEntityId(context, action.projectKey);
      const authorizationId = context.ids.next();
      const encumbranceId = context.ids.next();
      const checksum = sha256Buffer({ action, authorizationId });
      const encumbranceFactId = context.ids.next();
      const encumbranceFactChecksum = sha256Buffer({
        amount: action.amountMinor,
        encumbranceId,
        sequence: 1,
      });
      const purposeCode = `budget.${sha256Hex({ budgetKey: action.budgetKey }).slice(0, 64)}`;
      await context.client.query(
        `/* governance:enactment:public-project */
         insert into public_project_authorizations(
           id,world_id,proposal_action_id,proposal_result_id,project_entity_id,
           treasury_wallet_id,currency_id,authorized_minor,starts_tick,expires_tick,
           purpose_code,terms,checksum,command_id,event_id,state_revision
         ) values ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint,null,$10,$11,$12,$13,$14,$15::bigint)`,
        [
          authorizationId,
          context.input.worldId,
          source.actionId,
          source.proposalResultId,
          projectEntityId,
          action.treasuryWalletId,
          action.currencyId,
          action.amountMinor,
          action.effectiveAtTick,
          purposeCode,
          safeJson({ budgetKey: action.budgetKey, description: action.description }),
          checksum,
          context.command.commandId,
          context.eventId,
          context.resultingStateRevision,
        ],
      );
      await context.client.query(
        `/* governance:enactment:public-project-encumbrance */
         insert into treasury_encumbrances(
           id,world_id,project_authorization_id,treasury_wallet_id,currency_id,
           maximum_minor,created_command_id,created_event_id,created_state_revision
         ) values ($1,$2,$3,$4,$5,$6::bigint,$7,$8,$9::bigint)`,
        [
          encumbranceId,
          context.input.worldId,
          authorizationId,
          action.treasuryWalletId,
          action.currencyId,
          action.amountMinor,
          context.command.commandId,
          context.eventId,
          context.resultingStateRevision,
        ],
      );
      await context.client.query(
        `/* governance:enactment:public-project-fact */
         insert into treasury_encumbrance_facts(
           id,world_id,encumbrance_id,fact_sequence,fact_kind,amount_minor,command_id,
           event_id,state_revision,occurred_tick,checksum
         ) values ($1,$2,$3,1,'authorize',$4::bigint,$5,$6,$7::bigint,$8::bigint,$9)`,
        [
          encumbranceFactId,
          context.input.worldId,
          encumbranceId,
          action.amountMinor,
          context.command.commandId,
          context.eventId,
          context.resultingStateRevision,
          context.world.current_tick,
          encumbranceFactChecksum,
        ],
      );
      await context.client.query(
        `/* governance:enactment:public-project-projection */
         insert into treasury_encumbrance_projections(
           encumbrance_id,world_id,treasury_wallet_id,currency_id,authorized_minor,
           consumed_minor,released_minor,active_minor,status,last_fact_sequence,
           row_version,updated_state_revision
         ) values ($1,$2,$3,$4,$5::bigint,0,0,$5::bigint,'active',1,1,$6::bigint)`,
        [
          encumbranceId,
          context.input.worldId,
          action.treasuryWalletId,
          action.currencyId,
          action.amountMinor,
          context.resultingStateRevision,
        ],
      );
      return {
        actionId: source.actionId,
        checksum,
        effectId: authorizationId,
        kind: 'public_project',
        version: '1',
      };
    }
    case 'appoint_officeholder': {
      const office = await loadOfficeSeat(context, action.officeId, action.seatIndex);
      expectVersion(office.office_version, action.expectedOfficeVersion);
      const holderId = await resolveEntityId(context, action.holderEntityKey);
      const checksumHex = sha256Hex({ action, proposalResultId: source.proposalResultId });
      const termId = context.ids.next();
      const effectEvent = addOfficeTermChangedEvent(context, {
        aggregateVersion: '1',
        officeId: action.officeId,
        seatIndex: action.seatIndex,
        status: 'active',
        termId,
      });
      await insertOfficeTerm(context, {
        createdEventId: effectEvent.eventId,
        endsTick: action.termEndsAtTick,
        holderEntityId: holderId,
        officeId: action.officeId,
        seatId: office.seat_id,
        sourceElectionResultId: null,
        sourceKind: 'appointment',
        sourceProposalResultId: source.proposalResultId,
        startsTick: action.termStartsAtTick,
        termChecksum: checksumHex,
        termId,
      });
      const incremented = await context.client.query(
        `/* governance:enactment:office-increment */
         update political_offices set row_version=row_version+1,updated_at=$3
          where world_id=$1 and id=$2 and row_version=$4::bigint`,
        [context.input.worldId, action.officeId, context.world.recorded_at, office.office_version],
      );
      if ((incremented.rowCount ?? 0) !== 1) {
        throw new GovernanceCommandError(
          'AGGREGATE_VERSION_CONFLICT',
          'Office changed during appointment.',
        );
      }
      return {
        actionId: source.actionId,
        checksum: Buffer.from(checksumHex, 'hex'),
        effectId: termId,
        kind: 'office_term',
        version: '1',
      };
    }
    case 'approve_world_patch': {
      if (action.expectedWorldVersion !== context.command.expectedWorldVersion) {
        throw new GovernanceCommandError('WORLD_VERSION_CONFLICT', 'World patch target changed.');
      }
      return {
        actionId: source.actionId,
        checksum: Buffer.from(action.patchHash, 'hex'),
        effectId: action.patchId,
        kind: 'world_patch_approval',
        version: '1',
      };
    }
  }
  throw new GovernanceCommandError('ENACTMENT_FAILED', 'Proposal action is not enactable.');
}

async function applyOverrideLawAction(
  context: GovernanceHandlerContext,
  action: Extract<
    GovernanceProposalActionV1,
    { actionType: 'amend_law' | 'create_law' | 'repeal_law' }
  >,
): Promise<Record<string, unknown>> {
  const effectiveTick =
    action.actionType === 'repeal_law' ? action.effectiveAtTick : action.effectiveFromTick;
  if (effectiveTick !== context.world.current_tick) {
    throw new GovernanceCommandError(
      'ENACTMENT_FAILED',
      'Override law changes must take effect at the command tick.',
    );
  }
  if (action.actionType === 'create_law') {
    const existing = await queryOne<{ present: boolean }>(
      context.client,
      `/* governance:override:law-create-check */
       select true as present from laws where world_id=$1 and stable_key=$2`,
      [context.input.worldId, action.lawKey],
    );
    if (existing)
      throw new GovernanceCommandError('LAW_VERSION_CONFLICT', 'Law key already exists.');
    const jurisdictions = await context.client.query<{ jurisdiction_entity_id: string }>(
      `/* governance:override:law-jurisdiction */
       select charter.jurisdiction_entity_id::text
         from governing_charter_versions version
         join governing_charters charter
           on charter.world_id=version.world_id and charter.id=version.charter_id
         join charter_authority_intervals authority
           on authority.world_id=version.world_id
          and authority.charter_version_id=version.id
          and authority.effective_ticks @> $3::bigint
        where version.world_id=$1 and version.charter_version=$2::integer
        order by charter.stable_key::text collate "C"`,
      [context.input.worldId, action.targetCharterVersion, context.world.current_tick],
    );
    if (jurisdictions.rows.length !== 1) {
      throw new GovernanceCommandError(
        'GOVERNANCE_POLICY_DENIED',
        'The override does not resolve one active charter jurisdiction.',
      );
    }
    const lawId = context.ids.next();
    const versionId = context.ids.next();
    const checksum = sha256Buffer({ action, lawId, lawVersion: 1, override: true });
    const transitionId = context.ids.next();
    const transitionChecksum = sha256Buffer({
      lawId,
      status: 'active',
      tick: effectiveTick,
      version: 1,
    });
    const authorityIntervalId = context.ids.next();
    const effectEvent = addLawVersionActivatedEvent(context, {
      effectiveFromTick: effectiveTick,
      lawId,
      lawVersion: '1',
      lawVersionId: versionId,
      sourceProposalId: null,
    });
    await context.client.query(
      `/* governance:override:law-create */
       insert into laws(
         id,world_id,jurisdiction_entity_id,stable_key,title,created_command_id,
         created_event_id,created_state_revision
       ) values ($1,$2,$3,$4,$5,$6,$7,$8::bigint)`,
      [
        lawId,
        context.input.worldId,
        jurisdictions.rows[0]!.jurisdiction_entity_id,
        action.lawKey,
        action.title,
        context.command.commandId,
        effectEvent.eventId,
        context.resultingStateRevision,
      ],
    );
    await context.client.query(
      `/* governance:override:law-create-version */
       insert into law_versions(
         id,world_id,law_id,law_version,version_kind,initial_status,title,summary,
         policy_ast,action_effects,policy_dsl_version,supersedes_version_id,
         source_proposal_result_id,source_action_ordinal,effective_from_tick,
         checksum,created_command_id,created_event_id,created_state_revision
       ) values ($1,$2,$3,1,'create','active',$4,$5,$6,$7,1,null,null,null,
         $8::bigint,$9,$10,$11,$12::bigint)`,
      [
        versionId,
        context.input.worldId,
        lawId,
        action.title,
        action.summary,
        safeJson(action.policy),
        safeJson({ actionType: action.actionType, override: true }),
        effectiveTick,
        checksum,
        context.command.commandId,
        effectEvent.eventId,
        context.resultingStateRevision,
      ],
    );
    await context.client.query(
      `/* governance:override:law-create-transition */
       insert into law_effectivity_transitions(
         id,world_id,law_id,law_version_id,from_status,to_status,effective_tick,
         command_id,event_id,state_revision,checksum
       ) values ($1,$2,$3,$4,null,'active',$5::bigint,$6,$7,$8::bigint,$9)`,
      [
        transitionId,
        context.input.worldId,
        lawId,
        versionId,
        effectiveTick,
        context.command.commandId,
        effectEvent.eventId,
        context.resultingStateRevision,
        transitionChecksum,
      ],
    );
    await context.client.query(
      `/* governance:override:law-create-authority */
       insert into law_authority_intervals(
         id,world_id,law_id,law_version_id,effective_ticks,created_command_id,
         updated_command_id,row_version
       ) values ($1,$2,$3,$4,int8range($5::bigint,$6::bigint,'[)'),$7,$7,1)`,
      [
        authorityIntervalId,
        context.input.worldId,
        lawId,
        versionId,
        effectiveTick,
        action.effectiveUntilTick,
        context.command.commandId,
      ],
    );
    return {
      actionHash: sha256Hex(action),
      actionType: action.actionType,
      effectId: versionId,
      effectVersion: '1',
      execution: 'applied',
      lawId,
      status: 'active',
    };
  }

  const previous = await queryOne<{
    current_version: number;
    policy_ast: Record<string, unknown>;
    previous_version_id: string;
    summary: string;
    title: string;
  }>(
    context.client,
    // Override serialization is likewise owned by the mutable authority interval below.
    `/* governance:override:law-load */
     select version.id::text as previous_version_id,
            version.law_version as current_version,version.title,version.summary,
            version.policy_ast
       from laws law
       join law_versions version
         on version.world_id=law.world_id and version.law_id=law.id
      where law.world_id=$1 and law.id=$2
      order by version.law_version desc limit 1`,
    [context.input.worldId, action.lawId],
  );
  if (!previous || previous.current_version !== Number(action.expectedLawVersion)) {
    throw new GovernanceCommandError(
      'LAW_VERSION_CONFLICT',
      'Law version changed before override.',
    );
  }
  const version = previous.current_version + 1;
  const versionId = context.ids.next();
  const checksum = sha256Buffer({
    action,
    lawId: action.lawId,
    lawVersion: version,
    override: true,
  });
  const isRepeal = action.actionType === 'repeal_law';
  const title = isRepeal ? previous.title : action.title;
  const summary = isRepeal ? action.reason : action.summary;
  const policy = isRepeal ? previous.policy_ast : action.policy;
  const versionKind = isRepeal ? 'repeal' : 'amend';
  const nextStatus = isRepeal ? 'repealed' : 'active';
  const transitionId = context.ids.next();
  const transitionChecksum = sha256Buffer({
    lawId: action.lawId,
    status: nextStatus,
    tick: effectiveTick,
    version,
  });
  const effectEvent = addLawVersionActivatedEvent(context, {
    effectiveFromTick: effectiveTick,
    lawId: action.lawId,
    lawVersion: String(version),
    lawVersionId: versionId,
    sourceProposalId: null,
  });
  const closedAuthority = await context.client.query(
    `/* governance:override:law-close-authority */
     update law_authority_intervals set
       effective_ticks=int8range(lower(effective_ticks),$3::bigint,'[)'),
       updated_command_id=$4,row_version=row_version+1,updated_at=$5
      where world_id=$1 and law_id=$2 and effective_ticks @> $3::bigint`,
    [
      context.input.worldId,
      action.lawId,
      effectiveTick,
      context.command.commandId,
      context.world.recorded_at,
    ],
  );
  if ((closedAuthority.rowCount ?? 0) !== 1) {
    throw new GovernanceCommandError(
      'LAW_VERSION_CONFLICT',
      'Law authority changed during override.',
    );
  }
  await context.client.query(
    `/* governance:override:law-revision */
     insert into law_versions(
       id,world_id,law_id,law_version,version_kind,initial_status,title,summary,
       policy_ast,action_effects,policy_dsl_version,supersedes_version_id,
       source_proposal_result_id,source_action_ordinal,effective_from_tick,
       checksum,created_command_id,created_event_id,created_state_revision
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,null,null,$12::bigint,
       $13,$14,$15,$16::bigint)`,
    [
      versionId,
      context.input.worldId,
      action.lawId,
      version,
      versionKind,
      nextStatus,
      title,
      summary,
      safeJson(policy),
      safeJson({ actionType: action.actionType, override: true }),
      previous.previous_version_id,
      effectiveTick,
      checksum,
      context.command.commandId,
      effectEvent.eventId,
      context.resultingStateRevision,
    ],
  );
  await context.client.query(
    `/* governance:override:law-transition */
     insert into law_effectivity_transitions(
       id,world_id,law_id,law_version_id,from_status,to_status,effective_tick,
       command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,$4,'active',$5,$6::bigint,$7,$8,$9::bigint,$10)`,
    [
      transitionId,
      context.input.worldId,
      action.lawId,
      versionId,
      nextStatus,
      effectiveTick,
      context.command.commandId,
      effectEvent.eventId,
      context.resultingStateRevision,
      transitionChecksum,
    ],
  );
  if (!isRepeal) {
    await context.client.query(
      `/* governance:override:law-amend-authority */
       insert into law_authority_intervals(
         id,world_id,law_id,law_version_id,effective_ticks,created_command_id,
         updated_command_id,row_version
       ) values ($1,$2,$3,$4,int8range($5::bigint,$6::bigint,'[)'),$7,$7,1)`,
      [
        context.ids.next(),
        context.input.worldId,
        action.lawId,
        versionId,
        effectiveTick,
        action.effectiveUntilTick,
        context.command.commandId,
      ],
    );
  }
  return {
    actionHash: sha256Hex(action),
    actionType: action.actionType,
    effectId: versionId,
    effectVersion: String(version),
    execution: 'applied',
    lawId: action.lawId,
    status: isRepeal ? 'repealed' : 'active',
  };
}

async function applyOverrideEffect(
  context: GovernanceHandlerContext,
  effect: GovernanceOverrideEffectV1,
): Promise<Record<string, unknown>> {
  if (effect.effectType === 'execute_proposal_action') {
    return applyOverrideLawAction(context, effect.proposalAction);
  }
  if (effect.effectType === 'appoint_officeholder') {
    const appointment = effect.appointment as {
      expectedOfficeVersion: string;
      holderEntityKey: string;
      officeId: string;
      seatIndex: number;
      termEndsAtTick: string;
      termStartsAtTick: string;
    };
    const office = await loadOfficeSeat(context, appointment.officeId, appointment.seatIndex);
    expectVersion(office.office_version, appointment.expectedOfficeVersion);
    const holderId = await resolveEntityId(context, appointment.holderEntityKey);
    const termId = context.ids.next();
    const effectEvent = addOfficeTermChangedEvent(context, {
      aggregateVersion: '1',
      officeId: appointment.officeId,
      seatIndex: appointment.seatIndex,
      status: 'active',
      termId,
    });
    await insertOfficeTerm(context, {
      createdEventId: effectEvent.eventId,
      endsTick: appointment.termEndsAtTick,
      holderEntityId: holderId,
      officeId: appointment.officeId,
      seatId: office.seat_id,
      sourceElectionResultId: null,
      sourceKind: 'appointment',
      sourceProposalResultId: null,
      startsTick: appointment.termStartsAtTick,
      termChecksum: sha256Hex(appointment),
      termId,
    });
    const incremented = await context.client.query(
      `/* governance:override:office-increment */
       update political_offices set row_version=row_version+1,updated_at=$3
        where world_id=$1 and id=$2 and row_version=$4::bigint`,
      [
        context.input.worldId,
        appointment.officeId,
        context.world.recorded_at,
        office.office_version,
      ],
    );
    if ((incremented.rowCount ?? 0) !== 1) {
      throw new GovernanceCommandError(
        'AGGREGATE_VERSION_CONFLICT',
        'Office changed during override.',
      );
    }
    return {
      effectType: effect.effectType,
      execution: 'applied',
      officeVersion: addDecimal(office.office_version),
      termId,
    };
  }
  const removal = await applyOfficeTermRemoval(context, effect.removal);
  return {
    effectType: effect.effectType,
    execution: 'applied',
    officeId: removal.officeId,
    seatIndex: removal.seatIndex,
    termId: effect.removal.termId,
    termVersion: removal.nextVersion,
  };
}

async function insertOfficeTerm(
  context: GovernanceHandlerContext,
  input: {
    createdEventId: string;
    endsTick: string;
    holderEntityId: string;
    officeId: string;
    seatId: string;
    sourceElectionResultId: string | null;
    sourceKind: 'appointment' | 'election' | 'initial';
    sourceProposalResultId: string | null;
    startsTick: string;
    termChecksum: string;
    termId: string;
  },
): Promise<string> {
  if (BigInt(input.endsTick) <= BigInt(input.startsTick)) {
    throw new GovernanceCommandError(
      'VALIDATION_FAILED',
      'Office term must be a non-empty interval.',
    );
  }
  if (input.sourceKind === 'appointment' && input.startsTick !== context.world.current_tick) {
    throw new GovernanceCommandError(
      'ENACTMENT_FAILED',
      'Office appointment authority must begin at the command or certification tick.',
    );
  }
  const count = await queryOne<{ term_number: number }>(
    context.client,
    `/* governance:office:term-number */
     select coalesce(max(term_number),0)::integer+1 as term_number
       from office_terms where world_id=$1 and seat_id=$2`,
    [context.input.worldId, input.seatId],
  );
  const status = 'active';
  const transitionId = context.ids.next();
  const transitionChecksum = sha256Buffer({
    status,
    termId: input.termId,
    tick: input.startsTick,
  });
  const authorityIntervalId = context.ids.next();
  await context.client.query(
    `/* governance:office:insert-term */
     insert into office_terms(
       id,world_id,office_id,seat_id,holder_entity_id,source_kind,
       source_election_result_id,source_proposal_result_id,status,starts_tick,
       planned_ends_tick,term_number,checksum,created_command_id,created_event_id,
       created_state_revision
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$11::bigint,$12,$13,$14,$15,$16::bigint)`,
    [
      input.termId,
      context.input.worldId,
      input.officeId,
      input.seatId,
      input.holderEntityId,
      input.sourceKind,
      input.sourceElectionResultId,
      input.sourceProposalResultId,
      status,
      input.startsTick,
      input.endsTick,
      count?.term_number ?? 1,
      Buffer.from(input.termChecksum, 'hex'),
      context.command.commandId,
      input.createdEventId,
      context.resultingStateRevision,
    ],
  );
  await context.client.query(
    `/* governance:office:insert-term-transition */
     insert into office_term_transitions(
       id,world_id,term_id,from_status,to_status,effective_tick,reason_code,
       command_id,event_id,state_revision,checksum
     ) values ($1,$2,$3,null,$4,$5::bigint,'OFFICE_TERM_CREATED',$6,$7,$8::bigint,$9)`,
    [
      transitionId,
      context.input.worldId,
      input.termId,
      status,
      input.startsTick,
      context.command.commandId,
      input.createdEventId,
      context.resultingStateRevision,
      transitionChecksum,
    ],
  );
  await context.client.query(
    `/* governance:office:insert-term-authority */
     insert into office_seat_authority_intervals(
       id,world_id,office_id,seat_id,term_id,holder_entity_id,effective_ticks,
       created_command_id,updated_command_id,row_version
     ) values ($1,$2,$3,$4,$5,$6,int8range($7::bigint,$8::bigint,'[)'),$9,$9,1)`,
    [
      authorityIntervalId,
      context.input.worldId,
      input.officeId,
      input.seatId,
      input.termId,
      input.holderEntityId,
      input.startsTick,
      input.endsTick,
      context.command.commandId,
    ],
  );
  return input.termId;
}

async function loadOfficeSeat(
  context: GovernanceHandlerContext,
  officeId: string,
  seatIndex: number,
): Promise<{ office_version: string; seat_id: string }> {
  const office = await queryOne<{ office_version: string; seat_id: string }>(
    context.client,
    `/* governance:office:load-seat */
     select office.row_version::text as office_version,seat.id::text as seat_id
       from political_offices office
       join political_office_seats seat on seat.world_id=office.world_id
         and seat.office_id=office.id and seat.seat_ordinal=$3
      where office.world_id=$1 and office.id=$2 and seat.status='active'
      for update of office`,
    [context.input.worldId, officeId, seatIndex + 1],
  );
  if (!office) throw new GovernanceCommandError('TERM_CONFLICT', 'Office seat was not found.');
  return office;
}

async function loadSecondApproval(
  context: GovernanceHandlerContext,
  approvalId: string | null,
  firstActorId: string,
  approvalKind: 'override' | 'repair',
): Promise<{ actor_user_id: string } | null> {
  if (!approvalId) return null;
  if (
    context.command.type !== 'ExecuteCreatorOverrideV1' &&
    context.command.type !== 'RepairGovernanceResultV1'
  ) {
    return null;
  }
  const bindingHash = governanceTwoPersonApprovalBindingHashV1(context.command);
  return queryOne<{ actor_user_id: string }>(
    context.client,
    `/* governance:two-person:approval */
     select audit.actor_user_id::text from security_audit_records audit
      cross join lateral (
        select case
          when jsonb_typeof(audit.redacted_metadata->'approvalExpiresAt')='string'
           and audit.redacted_metadata->>'approvalExpiresAt'
                 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          then (audit.redacted_metadata->>'approvalExpiresAt')::timestamptz
          else null
        end as expires_at,
        case
          when jsonb_typeof(audit.redacted_metadata->'approvalIssuedAt')='string'
           and audit.redacted_metadata->>'approvalIssuedAt'
                 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          then (audit.redacted_metadata->>'approvalIssuedAt')::timestamptz
          else null
        end as issued_at
      ) approval
      where audit.id=$1 and audit.world_id=$2 and audit.actor_user_id is not null
        and audit.actor_user_id::text<>$3 and audit.outcome='allowed'
        and audit.category='governance_approval'
        and audit.action=$4 and audit.reason_code=$5
        and audit.target_type='command' and audit.target_id=$6
        and audit.redacted_metadata->>'bindingHash'=$7
        and audit.occurred_at between transaction_timestamp()-interval '15 minutes'
                                  and transaction_timestamp()
        and approval.issued_at between audit.occurred_at-interval '1 minute'
                                   and audit.occurred_at+interval '1 minute'
        and approval.expires_at > transaction_timestamp()
        and approval.expires_at > approval.issued_at
        and approval.expires_at <= approval.issued_at+interval '15 minutes'
        and exists (
          select 1
            from sessions approval_session
            join users approval_user on approval_user.id=approval_session.user_id
           where approval_session.id::text=audit.redacted_metadata->>'sessionId'
             and approval_session.user_id=audit.actor_user_id
             and approval_session.revoked_at is null
             and approval_session.auth_version=approval_user.auth_version
             and approval_user.status='active'
             and approval_session.idle_expires_at >= approval.expires_at
             and approval_session.absolute_expires_at >= approval.expires_at
             and (
               approval_user.platform_role='platform_admin'
               or exists (
                 select 1 from world_memberships approval_membership
                  where approval_membership.world_id=audit.world_id
                    and approval_membership.user_id=approval_user.id
                    and approval_membership.status='active'
                    and approval_membership.role in ('creator','administrator')
               )
             )
        )
        and not exists (
          select 1 from governance_override_approvals used
           where used.audit_record_id=audit.id
        )
        and not exists (
          select 1 from governance_repair_approvals used
           where used.audit_record_id=audit.id
        )`,
    [
      approvalId,
      context.input.worldId,
      firstActorId,
      approvalKind === 'override' ? 'governance.approve_override' : 'governance.approve_repair',
      approvalKind === 'override'
        ? 'GOVERNANCE_OVERRIDE_SECOND_APPROVAL'
        : 'GOVERNANCE_REPAIR_SECOND_APPROVAL',
      context.command.commandId,
      bindingHash,
    ],
  );
}

async function resolveEntityId(
  context: GovernanceHandlerContext,
  logicalKey: string,
): Promise<string> {
  const entity = await queryOne<{ id: string }>(
    context.client,
    `/* governance:entity:resolve-id */
     select id::text from world_entities
      where world_id=$1 and logical_key=$2 and retired_world_version_id is null`,
    [context.input.worldId, logicalKey],
  );
  if (!entity) {
    throw new GovernanceCommandError(
      'SEED_PLAN_INCOMPATIBLE',
      'A referenced world entity is unavailable.',
    );
  }
  return entity.id;
}

async function resolveEntityKey(
  context: GovernanceHandlerContext,
  entityId: string,
): Promise<string> {
  const entity = await queryOne<{ logical_key: string }>(
    context.client,
    `/* governance:entity:resolve-key */
     select logical_key::text from world_entities where world_id=$1 and id=$2`,
    [context.input.worldId, entityId],
  );
  if (!entity)
    throw new GovernanceCommandError('BALLOT_INELIGIBLE', 'Voter entity is unavailable.');
  return entity.logical_key;
}

function addLawVersionActivatedEvent(
  context: GovernanceHandlerContext,
  input: {
    effectiveFromTick: string;
    lawId: string;
    lawVersion: string;
    lawVersionId: string;
    sourceProposalId: string | null;
  },
): GovernancePlannedEvent {
  const event: GovernancePlannedEvent = {
    aggregateId: input.lawVersionId,
    aggregateType: 'law_version',
    aggregateVersion: '1',
    eventId: context.ids.next(),
    eventType: 'GovernanceLawVersionActivatedV1',
    history: {
      category: 'governance',
      summaryArgs: {
        effectiveFromTick: input.effectiveFromTick,
        lawVersion: input.lawVersion,
      },
      targetId: input.lawId,
      targetType: 'law',
      titleKey: 'history.governance.law_activated',
      visibility: 'public',
    },
    ledgerEntryId: context.ids.next(),
    payload: {
      effectiveFromTick: input.effectiveFromTick,
      eventType: 'GovernanceLawVersionActivatedV1',
      lawId: input.lawId,
      lawVersion: input.lawVersion,
      sourceProposalId: input.sourceProposalId,
    },
    summaryCode: 'GOVERNANCE_LAW_VERSION_ACTIVATED',
  };
  context.additionalEvents.push(event);
  return event;
}

function addOfficeTermChangedEvent(
  context: GovernanceHandlerContext,
  input: {
    aggregateVersion: string;
    officeId: string;
    seatIndex: number;
    status: 'active' | 'ended' | 'removed' | 'scheduled' | 'superseded_by_repair';
    termId: string;
  },
): GovernancePlannedEvent {
  const event: GovernancePlannedEvent = {
    aggregateId: input.termId,
    aggregateType: 'office_term',
    aggregateVersion: input.aggregateVersion,
    eventId: context.ids.next(),
    eventType: 'GovernanceOfficeTermChangedV1',
    history: {
      category: 'governance',
      summaryArgs: { seatIndex: input.seatIndex, status: input.status },
      targetId: input.termId,
      targetType: 'office_term',
      titleKey: 'history.governance.term_changed',
      visibility: 'public',
    },
    ledgerEntryId: context.ids.next(),
    payload: {
      eventType: 'GovernanceOfficeTermChangedV1',
      officeId: input.officeId,
      seatIndex: input.seatIndex,
      status: input.status,
      termId: input.termId,
    },
    summaryCode: 'GOVERNANCE_OFFICE_TERM_CHANGED',
  };
  context.additionalEvents.push(event);
  return event;
}

function plannedEvent(
  context: GovernanceHandlerContext,
  input: {
    aggregateId: string;
    aggregateType: string;
    aggregateVersion: string;
    eventType: string;
    ledgerKind?: 'domain_event' | 'override' | 'repair_anchor';
    payload: Record<string, unknown>;
    summaryCode: string;
    targetId?: string;
    targetType?: string;
    visibility?: 'creator' | 'member' | 'operator' | 'public';
  },
): GovernancePlannedEvent {
  return {
    aggregateId: input.aggregateId,
    aggregateType: input.aggregateType,
    aggregateVersion: input.aggregateVersion,
    eventId: context.eventId,
    eventType: input.eventType,
    history: {
      category: 'governance',
      summaryArgs: {
        aggregateType: input.aggregateType,
        eventType: input.eventType,
      },
      targetId: input.targetId ?? input.aggregateId,
      targetType: input.targetType ?? input.aggregateType,
      titleKey: `history.governance.${input.summaryCode.toLowerCase()}`,
      visibility: input.visibility ?? 'public',
    },
    ledgerEntryId: context.eventLedgerEntryId,
    ...(input.ledgerKind ? { ledgerKind: input.ledgerKind } : {}),
    payload: input.payload,
    summaryCode: input.summaryCode,
  };
}

function lifecycleOutcome(
  context: GovernanceHandlerContext,
  aggregateType: 'election' | 'proposal',
  aggregateId: string,
  aggregateVersion: string,
  status: string,
  summaryCode: string,
): GovernanceHandlerOutcome {
  return {
    event: plannedEvent(context, {
      aggregateId,
      aggregateType,
      aggregateVersion,
      eventType: 'GovernanceLifecycleChangedV1',
      payload: {
        aggregateId,
        aggregateType,
        aggregateVersion,
        eventType: 'GovernanceLifecycleChangedV1',
        occurredTick: context.world.current_tick,
        status,
      },
      summaryCode,
    }),
  };
}

function officeTermOutcome(
  context: GovernanceHandlerContext,
  officeId: string,
  seatIndex: number,
  termId: string,
  status: 'active' | 'removed' | 'scheduled',
  aggregateVersion: string,
): GovernanceHandlerOutcome {
  return {
    event: plannedEvent(context, {
      aggregateId: termId,
      aggregateType: 'office_term',
      aggregateVersion,
      eventType: 'GovernanceOfficeTermChangedV1',
      payload: {
        eventType: 'GovernanceOfficeTermChangedV1',
        officeId,
        seatIndex,
        status,
        termId,
      },
      summaryCode: status === 'removed' ? 'OFFICEHOLDER_REMOVED' : 'OFFICEHOLDER_APPOINTED',
      targetId: officeId,
      targetType: 'office',
    }),
    headCreated: aggregateVersion === '1',
    responseDetails: { termId },
  };
}

function requireGovernance(context: GovernanceHandlerContext): void {
  if (context.world.governance_row_version === null) {
    throw new GovernanceCommandError(
      'GOVERNANCE_NOT_INITIALIZED',
      'World governance is not initialized.',
    );
  }
}

function requireActorEntity(context: GovernanceHandlerContext): string {
  const entityId = context.input.actor.actorEntityId;
  if (!entityId)
    throw new GovernanceCommandError('AUTHORIZATION_DENIED', 'An in-world actor is required.');
  return entityId;
}

function requireAuthorityBinding(
  context: GovernanceHandlerContext,
  expected: {
    actionCode: string;
    policyActionCode: string;
    policyResourceType: string;
    resourceId: string;
    resourceType: string;
  },
): void {
  const { authorization } = context.input;
  if (
    authorization.actionCode !== expected.actionCode ||
    authorization.context.policyActionCode !== expected.policyActionCode ||
    authorization.context.policyResourceType !== expected.policyResourceType ||
    authorization.resourceType !== expected.resourceType ||
    authorization.resourceId !== expected.resourceId
  ) {
    throw new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Governance authority evidence does not match the command target.',
    );
  }
}

function requirePolicy(
  allowed: boolean,
  code:
    | 'GOVERNANCE_CONTESTS_PAUSED'
    | 'GOVERNANCE_ENACTMENT_PAUSED'
    | 'GOVERNANCE_OVERRIDES_PAUSED'
    | 'GOVERNANCE_VOTING_PAUSED',
): void {
  if (!allowed) throw new GovernanceCommandError(code, 'This governance capability is paused.');
}

function expectVersion(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new GovernanceCommandError(
      'AGGREGATE_VERSION_CONFLICT',
      'Governance aggregate version changed.',
    );
  }
}

function validateSchedulerPayload(context: GovernanceHandlerContext, occurrenceKey: string): void {
  if (!context.input.scheduler || context.input.scheduler.occurrenceKey !== occurrenceKey) {
    throw new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Scheduled command provenance is invalid.',
    );
  }
  if (
    BigInt(context.input.scheduler.dueTick) > BigInt(context.world.current_tick) ||
    context.command.expectedTick !== context.world.current_tick
  ) {
    throw new GovernanceCommandError(
      'TALLY_NOT_DUE',
      'Scheduled governance transition is not due.',
    );
  }
}

function assertSingle(
  result: { rowCount: number | null },
  code: 'AGGREGATE_VERSION_CONFLICT' | 'CANDIDACY_STATE_INVALID',
): void {
  if ((result.rowCount ?? 0) !== 1)
    throw new GovernanceCommandError(code, 'Governance aggregate changed.');
}

function actionTargetKind(action: GovernanceProposalActionV1): string | null {
  switch (action.actionType) {
    case 'amend_law':
    case 'repeal_law':
      return 'law';
    case 'update_tax':
      return 'tax_policy';
    case 'appoint_officeholder':
      return 'office';
    case 'approve_world_patch':
      return 'world_patch';
    default:
      return null;
  }
}

function actionTargetId(action: GovernanceProposalActionV1): string | null {
  switch (action.actionType) {
    case 'amend_law':
    case 'repeal_law':
      return action.lawId;
    case 'update_tax':
      return action.taxPolicyId;
    case 'appoint_officeholder':
      return action.officeId;
    case 'approve_world_patch':
      return action.patchId;
    default:
      return null;
  }
}

function actionExpectedVersion(action: GovernanceProposalActionV1): string | null {
  switch (action.actionType) {
    case 'amend_law':
    case 'repeal_law':
      return action.expectedLawVersion;
    case 'update_tax':
      return action.expectedTaxPolicyVersion;
    case 'appoint_officeholder':
      return action.expectedOfficeVersion;
    case 'approve_world_patch':
      return action.expectedWorldVersion;
    default:
      return null;
  }
}

function normalizeFailureCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
  return /^[A-Z][A-Z0-9_]*$/u.test(normalized) ? normalized : 'ENACTMENT_FAILED';
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function effectTickCanApply(context: GovernanceHandlerContext, effectTick: string): boolean {
  return context.command.type === 'RepairGovernanceResultV1'
    ? BigInt(effectTick) <= BigInt(context.world.current_tick)
    : effectTick === context.world.current_tick;
}
