import { createHash } from 'node:crypto';

import {
  GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION,
  GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION,
  canonicalJson,
  type GovernanceEligibilitySnapshotReferenceV1,
} from '@worldgraph/contracts';
import {
  INTERNAL_GOVERNANCE_COMMAND_TYPES,
  PUBLIC_GOVERNANCE_COMMAND_TYPES,
  governanceScheduleCommandType,
  governanceScheduleOccurrenceKey,
  type GovernanceScheduleOccurrenceIdentity,
  type InternalGovernanceCommandType,
} from '@worldgraph/governance-command';

export const GOVERNANCE_SCHEDULER_ACTOR_ID = 'worldgraph:governance-scheduler' as const;

export const GOVERNANCE_SCHEDULE_ACTION_TYPES = [
  'OpenProposalVotingV1',
  'CloseAndTallyProposalV1',
  'CertifyAndEnactProposalV1',
  'OpenElectionV1',
  'CloseAndTallyElectionV1',
  'CertifyElectionV1',
] as const satisfies readonly InternalGovernanceCommandType[];

export const GOVERNANCE_PROPOSAL_OPERATIONAL_STATES = [
  'draft',
  'sponsoring',
  'debate',
  'scheduled',
  'open',
  'closing',
  'tallied',
  'certified',
  'enacted',
  'rejected',
  'withdrawn',
  'passed_but_enactment_failed',
] as const;

export const GOVERNANCE_ELECTION_OPERATIONAL_STATES = [
  'nominations_scheduled',
  'nominations_open',
  'voting_scheduled',
  'open',
  'closing',
  'tallied',
  'certified',
  'cancelled',
] as const;

type GovernanceProposalOperationalState = (typeof GOVERNANCE_PROPOSAL_OPERATIONAL_STATES)[number];
type GovernanceElectionOperationalState = (typeof GOVERNANCE_ELECTION_OPERATIONAL_STATES)[number];

interface GovernanceOperationalStateCounts {
  eligibleCount: number;
  targetCount: number;
  turnoutCount: number;
}

export type GovernanceOperationalStateSnapshot = GovernanceOperationalStateCounts &
  (
    | { state: GovernanceProposalOperationalState; targetKind: 'proposal' }
    | { state: GovernanceElectionOperationalState; targetKind: 'election' }
  );

export interface GovernanceOperationalSnapshot {
  maxProjectionLagRevisions: number;
  pendingOutboxCount: number;
  states: readonly GovernanceOperationalStateSnapshot[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const NONNEGATIVE_INT64 = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_INT64 = /^[1-9][0-9]{0,18}$/u;

interface GovernanceScheduleQueryResult<TRow> {
  rows: TRow[];
}

export interface GovernanceScheduleQueryExecutor {
  query<TRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<GovernanceScheduleQueryResult<TRow>>;
}

export interface GovernanceCertificationSourceReader {
  loadElectionResultChecksum(worldId: string, electionId: string): Promise<string | null>;
  loadProposalResultChecksum(worldId: string, proposalId: string): Promise<string | null>;
}

interface GovernanceScheduleRow {
  action_schema_version: number;
  action_type: InternalGovernanceCommandType;
  aggregate_version: string;
  completed_event_id: string;
  contest_id: string;
  current_tick: string;
  due_tick: string;
  eligible_count: number | null;
  expected_state_revision: string;
  expected_world_version: string;
  open_window_expired: boolean;
  payload: unknown;
  policy_checksum: string | null;
  process_version: string;
  schedule_sequence: string;
  scheduled_action_id: string;
  snapshot_checksum: string | null;
  snapshot_id: string | null;
  source_state_revision: string | null;
  target_id: string;
  target_kind: 'election' | 'proposal';
  world_id: string;
}

interface GovernanceOperationalRow {
  eligible_count: string;
  max_projection_lag_revisions: string;
  pending_outbox_count: string;
  state: string;
  target_count: string;
  target_kind: string;
  turnout_count: string;
}

interface GovernanceScheduleCandidateCommon {
  aggregateVersion: string;
  completedEventId: string;
  contestId: string;
  currentTick: string;
  dueTick: string;
  expectedStateRevision: string;
  expectedWorldVersion: string;
  occurrenceKey: string;
  scheduleSequence: string;
  scheduledActionId: string;
  targetId: string;
  targetKind: 'election' | 'proposal';
  worldId: string;
}

export type GovernanceScheduledEffectCandidate =
  | (GovernanceScheduleCandidateCommon & {
      actionType: 'OpenProposalVotingV1' | 'OpenElectionV1';
      eligibilitySnapshot: GovernanceEligibilitySnapshotReferenceV1;
    })
  | (GovernanceScheduleCandidateCommon & {
      actionType: 'CloseAndTallyProposalV1' | 'CloseAndTallyElectionV1';
      algorithmVersion:
        | typeof GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION
        | typeof GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION;
      eligibilitySnapshotId: string;
    })
  | (GovernanceScheduleCandidateCommon & {
      actionType: 'CertifyAndEnactProposalV1' | 'CertifyElectionV1';
      expectedResultChecksum: string;
    });

export interface GovernanceScheduleRepository {
  findPendingEffect(
    scheduledActionId: string,
    actionTypes?: readonly GovernanceScheduledEffectCandidate['actionType'][],
  ): Promise<GovernanceScheduledEffectCandidate | null>;
  findPendingEffects(
    limit: number,
    actionTypes?: readonly GovernanceScheduledEffectCandidate['actionType'][],
  ): Promise<GovernanceScheduledEffectCandidate[]>;
  readOperationalSnapshot(): Promise<GovernanceOperationalSnapshot>;
}

/**
 * Discovers completed simulation schedules and derives command preconditions
 * exclusively from current authoritative projections. The eligibility lateral
 * returns only a count and canonical checksums: member identities never leave
 * PostgreSQL during worker discovery.
 */
export class PostgresGovernanceScheduleRepository implements GovernanceScheduleRepository {
  public constructor(
    private readonly pool: GovernanceScheduleQueryExecutor,
    private readonly certificationSources: GovernanceCertificationSourceReader,
    private readonly worldIdScope?: string,
  ) {
    if (worldIdScope !== undefined && !UUID.test(worldIdScope)) {
      throw new Error('GOVERNANCE_SCHEDULE_WORLD_SCOPE_INVALID');
    }
  }

  public async findPendingEffect(
    scheduledActionId: string,
    actionTypes: readonly GovernanceScheduledEffectCandidate['actionType'][] = GOVERNANCE_SCHEDULE_ACTION_TYPES,
  ): Promise<GovernanceScheduledEffectCandidate | null> {
    if (!UUID.test(scheduledActionId)) {
      throw new Error('GOVERNANCE_SCHEDULE_ACTION_ID_INVALID');
    }
    return (await this.findPendingEffects(1, actionTypes, scheduledActionId))[0] ?? null;
  }

  public async findPendingEffects(
    limit: number,
    actionTypes: readonly GovernanceScheduledEffectCandidate['actionType'][] = GOVERNANCE_SCHEDULE_ACTION_TYPES,
    scheduledActionId?: string,
  ): Promise<GovernanceScheduledEffectCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
      throw new Error('GOVERNANCE_SCHEDULE_DISCOVERY_LIMIT_INVALID');
    }
    if (
      actionTypes.some((actionType) => !GOVERNANCE_SCHEDULE_ACTION_TYPES.includes(actionType)) ||
      new Set(actionTypes).size !== actionTypes.length
    ) {
      throw new Error('GOVERNANCE_SCHEDULE_DISCOVERY_ACTIONS_INVALID');
    }
    if (actionTypes.length === 0) return [];
    if (scheduledActionId !== undefined && !UUID.test(scheduledActionId)) {
      throw new Error('GOVERNANCE_SCHEDULE_ACTION_ID_INVALID');
    }
    const result = await this.pool.query<GovernanceScheduleRow>(
      `/* governance:scheduler:discover-completed */
       with candidates as (
         select action.world_id,
                action.id as scheduled_action_id,
                action.schedule_sequence::text,
                action.due_tick::text,
                action.action_type,
                action.action_schema_version,
                action.process_version,
                action.payload,
                action.completed_event_id,
                clock.current_tick::text,
                runtime.state_revision::text as expected_state_revision,
                version.version_number::text as expected_world_version,
                case when action.action_type in (
                  'OpenProposalVotingV1','CloseAndTallyProposalV1',
                  'CertifyAndEnactProposalV1'
                ) then 'proposal' else 'election' end as target_kind,
                case when action.action_type in (
                  'OpenProposalVotingV1','CloseAndTallyProposalV1',
                  'CertifyAndEnactProposalV1'
                ) then action.payload ->> 'proposalId'
                else action.payload ->> 'electionId' end as target_id
           from scheduled_actions action
           join worlds world on world.id=action.world_id
           join world_runtime_heads runtime on runtime.world_id=action.world_id
           join world_versions version
             on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
           join world_simulation_clocks clock on clock.world_id=action.world_id
          where world.lifecycle='active' and world.archived_at is null
            and action.status='completed' and action.completed_event_id is not null
            and action.action_type=any($1::text[])
            and action.action_schema_version=1 and action.process_version='1.0.0'
            and clock.current_tick >= action.due_tick
            and ($2::uuid is null or action.world_id=$2::uuid)
            and ($4::uuid is null or action.id=$4::uuid)
            and not exists (
              select 1 from governance_schedule_occurrences occurrence
               where occurrence.scheduled_action_id=action.id
            )
            and not exists (
              select 1 from command_records command
               where command.world_id=action.world_id
                 and command.actor_type='system'
                 and command.actor_id='worldgraph:governance-scheduler'
                 and command.command_type=action.action_type
                 and command.causation_id=action.completed_event_id
                 and command.status='accepted'
            )
          order by action.due_tick,action.priority,action.schedule_sequence,action.id
       )
       select candidate.*,
              coalesce(proposal.aggregate_version,election.aggregate_version)::text
                as aggregate_version,
              coalesce(proposal_contest.contest_id,election_contest.contest_id)::text
                as contest_id,
              case candidate.action_type
                when 'OpenProposalVotingV1' then
                  candidate.current_tick::bigint >= proposal.voting_closes_tick
                when 'OpenElectionV1' then
                  candidate.current_tick::bigint >= election.voting_closes_tick
                else false
              end as open_window_expired,
              snapshot.id::text as snapshot_id,
              snapshot.source_state_revision::text,
              eligibility.eligible_count,
              eligibility.policy_checksum,
              eligibility.snapshot_checksum
         from candidates candidate
         left join proposals proposal
           on candidate.target_kind='proposal' and proposal.world_id=candidate.world_id
          and proposal.id=candidate.target_id::uuid
         left join proposal_contests proposal_contest
           on proposal_contest.world_id=proposal.world_id
          and proposal_contest.proposal_id=proposal.id
         left join elections election
           on candidate.target_kind='election' and election.world_id=candidate.world_id
          and election.id=candidate.target_id::uuid
         left join lateral (
           select contest.contest_id
             from election_contests contest
            where contest.world_id=election.world_id and contest.election_id=election.id
            order by contest.contest_ordinal,contest.contest_id
            limit 1
         ) election_contest on true
         left join institutions proposal_institution
           on candidate.target_kind='proposal'
          and proposal_institution.world_id=proposal.world_id
          and proposal_institution.id=proposal.institution_id
         left join governing_charter_versions proposal_configured_charter
           on proposal_configured_charter.world_id=proposal_institution.world_id
          and proposal_configured_charter.id=proposal_institution.charter_version_id
         left join charter_authority_intervals proposal_charter_authority
           on proposal_charter_authority.world_id=proposal_configured_charter.world_id
          and proposal_charter_authority.charter_id=proposal_configured_charter.charter_id
          and proposal_charter_authority.effective_ticks @> candidate.current_tick::bigint
         left join governing_charter_versions proposal_charter
           on proposal_charter.world_id=proposal_charter_authority.world_id
          and proposal_charter.id=proposal_charter_authority.charter_version_id
         left join political_offices election_office
           on candidate.target_kind='election'
          and election_office.world_id=election.world_id
          and election_office.id=election.office_id
         left join governing_charter_versions election_charter
           on election_charter.world_id=election_office.world_id
          and election_charter.id=election_office.charter_version_id
         left join lateral (
           select case candidate.target_kind
                    when 'proposal' then
                      proposal_charter.canonical_policy_document -> 'citizenEligibilityPolicy'
                    else election_office.eligibility_policy
                  end as policy,
                  case candidate.target_kind
                    when 'proposal' then proposal_charter.policy_dsl_version
                    else election_charter.policy_dsl_version
                  end as policy_dsl_version,
                  case candidate.target_kind
                    when 'proposal' then proposal_charter.id::text
                    else election_office.id::text
                  end as policy_source_id,
                  case candidate.target_kind
                    when 'proposal' then 'charter_citizen_eligibility'
                    else 'office_eligibility'
                  end as policy_source_kind,
                  case candidate.target_kind
                    when 'proposal' then proposal_charter.charter_version::text
                    else election_office.row_version::text
                  end as policy_source_version
         ) eligibility_policy on true
         left join eligibility_snapshots snapshot
           on snapshot.world_id=candidate.world_id
          and snapshot.contest_id=coalesce(
            proposal_contest.contest_id,election_contest.contest_id
         )
         left join lateral (
           with open_window as (
             select true as present
              where candidate.current_tick::bigint < case candidate.action_type
                      when 'OpenProposalVotingV1' then proposal.voting_closes_tick
                      else election.voting_closes_tick
                    end
           ), policy_material as (
             select encode(extensions.digest(convert_to(
                      public.worldgraph_canonical_jsonb(jsonb_build_object(
                        'action','governance.vote',
                        'aggregateId',candidate.target_id,
                        'aggregateType',candidate.target_kind,
                        'policy',eligibility_policy.policy,
                        'policyDslVersion',eligibility_policy.policy_dsl_version,
                        'policySourceId',eligibility_policy.policy_source_id,
                        'policySourceKind',eligibility_policy.policy_source_kind,
                        'policySourceVersion',eligibility_policy.policy_source_version,
                        'resourceKey',null,
                        'resourceType',candidate.target_kind,
                        'snapshotTick',candidate.current_tick
                      )),'UTF8'),'sha256'),'hex') as policy_checksum
               from open_window
           ), member_contexts as (
             select controller.entity_id as voter_id,
                    entity.logical_key::text as voter_key,
                    array[membership.role::text]::text[] as membership_roles,
                    membership.row_version as membership_version,
                    coalesce(held_offices.held_office_keys,array[]::text[])
                      as held_office_keys,
                    coalesce(organizations.organization_keys,array[]::text[])
                      as organization_keys,
                    policy_material.policy_checksum
               from world_memberships membership
               join world_entity_controllers controller
                 on controller.world_id=membership.world_id
                and controller.user_id=membership.user_id
                and controller.control_scope='primary' and controller.revoked_at is null
               join world_entities entity
                 on entity.world_id=controller.world_id and entity.id=controller.entity_id
                and entity.entity_type='player_character'
                and entity.retired_world_version_id is null
               cross join policy_material
               left join lateral (
                 select coalesce(
                          array_agg(active_office.office_key
                            order by active_office.office_key collate "C"),
                          array[]::text[]
                        ) as held_office_keys
                   from (
                     select distinct office.stable_key::text as office_key
                       from office_seat_authority_intervals authority
                       join political_offices office
                         on office.world_id=authority.world_id
                        and office.id=authority.office_id
                      where authority.world_id=candidate.world_id
                        and authority.holder_entity_id=controller.entity_id
                        and authority.effective_ticks @> candidate.current_tick::bigint
                   ) active_office
               ) held_offices on true
               left join lateral (
                 select coalesce(
                          array_agg(member.organization_key
                            order by member.organization_key collate "C"),
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
                      where relationship.world_id=candidate.world_id
                        and relationship.source_entity_id=controller.entity_id
                        and relationship.relationship_type='member_of'
                        and relationship.retired_world_version_id is null
                   ) member
               ) organizations on true
              where membership.world_id=candidate.world_id
                and membership.status='active'
                and public.worldgraph_governance_policy_matches_v1(
                  eligibility_policy.policy,
                  'in_world',
                  array[membership.role::text]::text[],
                  coalesce(held_offices.held_office_keys,array[]::text[]),
                  coalesce(organizations.organization_keys,array[]::text[]),
                  'governance.vote',
                  candidate.target_kind,
                  null::text,
                  candidate.current_tick::bigint
                )
           ), member_facts as (
             select jsonb_build_object(
                      'basis',jsonb_build_object(
                        'actorMode','in_world',
                        'heldOfficeKeys',to_jsonb(member_context.held_office_keys),
                        'membershipRoles',to_jsonb(member_context.membership_roles),
                        'membershipVersion',member_context.membership_version,
                        'organizationKeys',to_jsonb(member_context.organization_keys),
                        'policyChecksum',member_context.policy_checksum,
                        'rule','governance_policy_v1'
                      ),
                      'voterEntityId',member_context.voter_id::text,
                      'voterEntityKey',member_context.voter_key,
                      'weight',1
                    ) as fact,
                    member_context.voter_key,
                    member_context.voter_id
               from member_contexts member_context
           ), material as (
             select (select count(*)::integer from member_facts) as eligible_count,
                    coalesce((
                      select jsonb_agg(fact order by voter_key collate "C",voter_id)
                        from member_facts
                    ),'[]'::jsonb) as members,
                    policy_material.policy_checksum
               from policy_material
           )
           select material.eligible_count,material.policy_checksum,
                  encode(extensions.digest(convert_to(
                    public.worldgraph_canonical_jsonb(jsonb_build_object(
                      'contestId',coalesce(
                        proposal_contest.contest_id,election_contest.contest_id
                      )::text,
                      'members',material.members,
                      'policyChecksum',material.policy_checksum,
                      'snapshotTick',candidate.current_tick,
                      'sourceStateRevision',candidate.expected_state_revision
                    )),'UTF8'),'sha256'),'hex') as snapshot_checksum
             from material
           where candidate.action_type in ('OpenProposalVotingV1','OpenElectionV1')
              and eligibility_policy.policy is not null
              and eligibility_policy.policy_dsl_version=1
              and eligibility_policy.policy_source_id is not null
              and eligibility_policy.policy_source_version is not null
         ) eligibility on true
        where coalesce(proposal_contest.contest_id,election_contest.contest_id) is not null
          and case candidate.action_type
            when 'OpenProposalVotingV1' then
              proposal.status in ('sponsoring','scheduled','debate')
              and proposal.voting_opens_tick=candidate.due_tick::bigint
              and snapshot.id is null
            when 'CloseAndTallyProposalV1' then
              proposal.status='open'
              and proposal.voting_closes_tick=candidate.due_tick::bigint
              and snapshot.id is not null
            when 'CertifyAndEnactProposalV1' then proposal.status='tallied'
            when 'OpenElectionV1' then
              election.status in ('nominations_scheduled','nominations_open','voting_scheduled')
              and election.voting_opens_tick=candidate.due_tick::bigint
              and snapshot.id is null
            when 'CloseAndTallyElectionV1' then
              election.status='open'
              and election.voting_closes_tick=candidate.due_tick::bigint
              and snapshot.id is not null
            when 'CertifyElectionV1' then
              election.status='tallied'
              and election.certification_tick <= candidate.current_tick::bigint
            else false
          end
        order by candidate.due_tick::bigint,candidate.schedule_sequence::bigint,
                 candidate.scheduled_action_id
        limit $3`,
      [actionTypes, this.worldIdScope ?? null, limit, scheduledActionId ?? null],
    );

    const mapped: GovernanceScheduledEffectCandidate[] = [];
    for (const row of result.rows) {
      const candidate = await this.mapCandidate(row);
      if (candidate) mapped.push(candidate);
    }
    return mapped;
  }

  /**
   * Reads one fixed-cardinality operational view. PostgreSQL returns exactly one
   * row for every allowlisted proposal/election state, including zero-valued
   * states; no world, contest, snapshot, or voter identity leaves the query.
   */
  public async readOperationalSnapshot(): Promise<GovernanceOperationalSnapshot> {
    const governanceCommandTypes = [
      ...PUBLIC_GOVERNANCE_COMMAND_TYPES,
      ...INTERNAL_GOVERNANCE_COMMAND_TYPES,
    ];
    const result = await this.pool.query<GovernanceOperationalRow>(
      `/* governance:scheduler:operational-snapshot */
       with scoped_worlds as (
         select world.id
           from worlds world
          where world.lifecycle='active' and world.archived_at is null
            and ($1::uuid is null or world.id=$1::uuid)
       ),
       target_states as (
         select 'proposal'::text as target_kind,allowed.state
           from unnest($2::text[]) as allowed(state)
         union all
         select 'election'::text as target_kind,allowed.state
           from unnest($3::text[]) as allowed(state)
       ),
       proposal_state as (
         select proposal.status::text as state,
                count(*)::text as target_count,
                coalesce(sum(coalesce(snapshot.eligible_count,0)),0)::text
                  as eligible_count,
                coalesce(sum(coalesce(turnout.turnout_count,0)),0)::text
                  as turnout_count
           from proposals proposal
           join scoped_worlds world on world.id=proposal.world_id
           left join proposal_contests contest
             on contest.world_id=proposal.world_id and contest.proposal_id=proposal.id
           left join eligibility_snapshots snapshot
             on snapshot.world_id=contest.world_id and snapshot.contest_id=contest.contest_id
           left join lateral (
             select count(*)::bigint as turnout_count
               from ballot_participation participation
              where participation.world_id=contest.world_id
                and participation.contest_id=contest.contest_id
           ) turnout on true
          group by proposal.status
       ),
       election_state as (
         select election.status::text as state,
                count(*)::text as target_count,
                coalesce(sum(coalesce(snapshot.eligible_count,0)),0)::text
                  as eligible_count,
                coalesce(sum(coalesce(turnout.turnout_count,0)),0)::text
                  as turnout_count
           from elections election
           join scoped_worlds world on world.id=election.world_id
           left join election_contests contest
             on contest.world_id=election.world_id and contest.election_id=election.id
           left join eligibility_snapshots snapshot
             on snapshot.world_id=contest.world_id and snapshot.contest_id=contest.contest_id
           left join lateral (
             select count(*)::bigint as turnout_count
               from ballot_participation participation
              where participation.world_id=contest.world_id
                and participation.contest_id=contest.contest_id
           ) turnout on true
          group by election.status
       ),
       state_counts as (
         select allowed.target_kind,allowed.state,
                coalesce(proposal.target_count,election.target_count,'0') as target_count,
                coalesce(proposal.eligible_count,election.eligible_count,'0')
                  as eligible_count,
                coalesce(proposal.turnout_count,election.turnout_count,'0')
                  as turnout_count
           from target_states allowed
           left join proposal_state proposal
             on allowed.target_kind='proposal' and proposal.state=allowed.state
           left join election_state election
             on allowed.target_kind='election' and election.state=allowed.state
       ),
       latest_governance_revision as (
         select world.id as world_id,
                max(command.resulting_state_revision) as state_revision
           from scoped_worlds world
           left join command_records command
             on command.world_id=world.id and command.status='accepted'
            and command.command_type=any($4::text[])
          group by world.id
       ),
       projection_lag as (
         select coalesce(max(greatest(
                  coalesce(latest.state_revision,0)
                    - coalesce(governance.updated_state_revision,0),0
                )),0)::text as max_projection_lag_revisions
           from latest_governance_revision latest
           left join world_governance_heads governance
             on governance.world_id=latest.world_id
       ),
       pending_outbox as (
         select count(*)::text as pending_outbox_count
           from outbox_messages message
           join domain_events event
             on event.world_id=message.world_id and event.id=message.event_id
           join command_records command
             on command.world_id=event.world_id and command.id=event.command_id
           join scoped_worlds world on world.id=message.world_id
          where message.status='pending' and command.command_type=any($4::text[])
       )
       select state.target_kind,state.state,state.target_count,state.eligible_count,
              state.turnout_count,lag.max_projection_lag_revisions,
              outbox.pending_outbox_count
         from state_counts state
         cross join projection_lag lag
         cross join pending_outbox outbox
        order by state.target_kind,state.state`,
      [
        this.worldIdScope ?? null,
        GOVERNANCE_PROPOSAL_OPERATIONAL_STATES,
        GOVERNANCE_ELECTION_OPERATIONAL_STATES,
        governanceCommandTypes,
      ],
    );
    return mapOperationalSnapshot(result.rows);
  }

  private async mapCandidate(
    row: GovernanceScheduleRow,
  ): Promise<GovernanceScheduledEffectCandidate | null> {
    assertCommonRow(row);
    const targetId = targetIdFromPayload(row.action_type, row.payload);
    if (targetId !== row.target_id) throw new Error('GOVERNANCE_SCHEDULE_TARGET_MISMATCH');
    const identity = occurrenceIdentity(row);
    const common: GovernanceScheduleCandidateCommon = {
      aggregateVersion: row.aggregate_version,
      completedEventId: row.completed_event_id,
      contestId: row.contest_id,
      currentTick: row.current_tick,
      dueTick: row.due_tick,
      expectedStateRevision: row.expected_state_revision,
      expectedWorldVersion: row.expected_world_version,
      occurrenceKey: governanceScheduleOccurrenceKey(identity),
      scheduleSequence: row.schedule_sequence,
      scheduledActionId: row.scheduled_action_id,
      targetId,
      targetKind: row.target_kind,
      worldId: row.world_id,
    };
    switch (row.action_type) {
      case 'OpenProposalVotingV1':
      case 'OpenElectionV1': {
        if (row.open_window_expired) {
          return {
            ...common,
            actionType: row.action_type,
            eligibilitySnapshot: delayedOpenSnapshotReference(row),
          };
        }
        if (
          row.eligible_count === null ||
          !Number.isSafeInteger(row.eligible_count) ||
          row.eligible_count < 0 ||
          !row.policy_checksum ||
          !HASH.test(row.policy_checksum) ||
          !row.snapshot_checksum ||
          !HASH.test(row.snapshot_checksum)
        ) {
          throw new Error('GOVERNANCE_ELIGIBILITY_SOURCE_INVALID');
        }
        return {
          ...common,
          actionType: row.action_type,
          eligibilitySnapshot: {
            eligibleCount: row.eligible_count,
            policyChecksum: row.policy_checksum,
            snapshotChecksum: row.snapshot_checksum,
            snapshotId: governanceScheduleDeterministicUuid(
              row.scheduled_action_id,
              'eligibility-snapshot',
            ),
            sourceStateRevision: row.expected_state_revision,
          },
        };
      }
      case 'CloseAndTallyProposalV1':
      case 'CloseAndTallyElectionV1':
        if (
          !row.snapshot_id ||
          !UUID.test(row.snapshot_id) ||
          row.source_state_revision === null ||
          !POSITIVE_INT64.test(row.source_state_revision)
        ) {
          throw new Error('GOVERNANCE_TALLY_SNAPSHOT_INVALID');
        }
        return {
          ...common,
          actionType: row.action_type,
          algorithmVersion:
            row.action_type === 'CloseAndTallyProposalV1'
              ? GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION
              : GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION,
          eligibilitySnapshotId: row.snapshot_id,
        };
      case 'CertifyAndEnactProposalV1': {
        const checksum = await this.certificationSources.loadProposalResultChecksum(
          row.world_id,
          targetId,
        );
        return checksum && HASH.test(checksum)
          ? { ...common, actionType: row.action_type, expectedResultChecksum: checksum }
          : null;
      }
      case 'CertifyElectionV1': {
        const checksum = await this.certificationSources.loadElectionResultChecksum(
          row.world_id,
          targetId,
        );
        return checksum && HASH.test(checksum)
          ? { ...common, actionType: row.action_type, expectedResultChecksum: checksum }
          : null;
      }
    }
    throw new Error('GOVERNANCE_SCHEDULE_ACTION_UNREACHABLE');
  }
}

function mapOperationalSnapshot(
  rows: readonly GovernanceOperationalRow[],
): GovernanceOperationalSnapshot {
  const expectedRowCount =
    GOVERNANCE_PROPOSAL_OPERATIONAL_STATES.length + GOVERNANCE_ELECTION_OPERATIONAL_STATES.length;
  if (rows.length !== expectedRowCount) {
    throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
  }
  const seen = new Set<string>();
  const states: GovernanceOperationalStateSnapshot[] = [];
  let maxProjectionLagRevisions: number | undefined;
  let pendingOutboxCount: number | undefined;
  for (const row of rows) {
    const key = `${row.target_kind}:${row.state}`;
    if (seen.has(key)) throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
    seen.add(key);
    const counts = {
      eligibleCount: safeOperationalCount(row.eligible_count),
      targetCount: safeOperationalCount(row.target_count),
      turnoutCount: safeOperationalCount(row.turnout_count),
    };
    if (
      row.target_kind === 'proposal' &&
      GOVERNANCE_PROPOSAL_OPERATIONAL_STATES.some((state) => state === row.state)
    ) {
      states.push({
        ...counts,
        state: row.state as GovernanceProposalOperationalState,
        targetKind: row.target_kind,
      });
    } else if (
      row.target_kind === 'election' &&
      GOVERNANCE_ELECTION_OPERATIONAL_STATES.some((state) => state === row.state)
    ) {
      states.push({
        ...counts,
        state: row.state as GovernanceElectionOperationalState,
        targetKind: row.target_kind,
      });
    } else {
      throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
    }
    const rowProjectionLag = safeOperationalObservation(row.max_projection_lag_revisions);
    const rowPendingOutbox = safeOperationalCount(row.pending_outbox_count);
    if (
      (maxProjectionLagRevisions !== undefined && maxProjectionLagRevisions !== rowProjectionLag) ||
      (pendingOutboxCount !== undefined && pendingOutboxCount !== rowPendingOutbox)
    ) {
      throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
    }
    maxProjectionLagRevisions = rowProjectionLag;
    pendingOutboxCount = rowPendingOutbox;
  }
  if (maxProjectionLagRevisions === undefined || pendingOutboxCount === undefined) {
    throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
  }
  return { maxProjectionLagRevisions, pendingOutboxCount, states };
}

function safeOperationalCount(value: string): number {
  if (!NONNEGATIVE_INT64.test(value)) {
    throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
  }
  return parsed;
}

function safeOperationalObservation(value: string): number {
  if (!NONNEGATIVE_INT64.test(value)) {
    throw new Error('GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID');
  }
  const parsed = BigInt(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
}

export function governanceScheduleDeterministicUuid(
  scheduledActionId: string,
  purpose: string,
): string {
  if (!UUID.test(scheduledActionId) || !/^[a-z][a-z0-9-]{2,63}$/u.test(purpose)) {
    throw new Error('GOVERNANCE_SCHEDULE_IDENTITY_INVALID');
  }
  const bytes = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'worldgraph.governance-schedule-uuid.v1',
        purpose,
        scheduledActionId: scheduledActionId.toLowerCase(),
      }),
      'utf8',
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function delayedOpenSnapshotReference(
  row: GovernanceScheduleRow,
): GovernanceEligibilitySnapshotReferenceV1 {
  const checksum = (purpose: 'policy-not-evaluated' | 'snapshot-not-created'): string =>
    createHash('sha256')
      .update(
        canonicalJson({
          actionType: row.action_type,
          domain: 'worldgraph.governance-delayed-open.v1',
          dueTick: row.due_tick,
          purpose,
          scheduledActionId: row.scheduled_action_id.toLowerCase(),
          targetId: row.target_id.toLowerCase(),
          worldId: row.world_id.toLowerCase(),
        }),
        'utf8',
      )
      .digest('hex');
  return {
    eligibleCount: 0,
    policyChecksum: checksum('policy-not-evaluated'),
    snapshotChecksum: checksum('snapshot-not-created'),
    snapshotId: governanceScheduleDeterministicUuid(
      row.scheduled_action_id,
      'eligibility-snapshot',
    ),
    sourceStateRevision: row.expected_state_revision,
  };
}

function occurrenceIdentity(row: GovernanceScheduleRow): GovernanceScheduleOccurrenceIdentity {
  const transitionKind = row.action_type.includes('Open')
    ? 'open'
    : row.action_type.includes('CloseAndTally')
      ? 'close_tally'
      : 'certify';
  if (governanceScheduleCommandType(row.target_kind, transitionKind) !== row.action_type) {
    throw new Error('GOVERNANCE_SCHEDULE_ACTION_IDENTITY_INVALID');
  }
  return {
    dueTick: row.due_tick,
    targetId: row.target_id,
    targetKind: row.target_kind,
    transitionKind,
    worldId: row.world_id,
  };
}

function targetIdFromPayload(actionType: InternalGovernanceCommandType, payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GOVERNANCE_SCHEDULE_PAYLOAD_INVALID');
  }
  const record = payload as Record<string, unknown>;
  const key = actionType.includes('Proposal') ? 'proposalId' : 'electionId';
  const targetId = record[key];
  if (Object.keys(record).length !== 1 || typeof targetId !== 'string' || !UUID.test(targetId)) {
    throw new Error('GOVERNANCE_SCHEDULE_PAYLOAD_INVALID');
  }
  return targetId;
}

function assertCommonRow(row: GovernanceScheduleRow): void {
  if (
    !GOVERNANCE_SCHEDULE_ACTION_TYPES.includes(row.action_type) ||
    !UUID.test(row.world_id) ||
    !UUID.test(row.scheduled_action_id) ||
    !UUID.test(row.completed_event_id) ||
    !UUID.test(row.target_id) ||
    !UUID.test(row.contest_id) ||
    !NONNEGATIVE_INT64.test(row.current_tick) ||
    !NONNEGATIVE_INT64.test(row.due_tick) ||
    !POSITIVE_INT64.test(row.schedule_sequence) ||
    !POSITIVE_INT64.test(row.expected_state_revision) ||
    !POSITIVE_INT64.test(row.expected_world_version) ||
    !POSITIVE_INT64.test(row.aggregate_version) ||
    row.action_schema_version !== 1 ||
    row.process_version !== '1.0.0' ||
    typeof row.open_window_expired !== 'boolean' ||
    BigInt(row.current_tick) < BigInt(row.due_tick)
  ) {
    throw new Error('GOVERNANCE_SCHEDULE_ROW_INVALID');
  }
}
