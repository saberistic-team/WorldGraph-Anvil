import type { QueryResult, QueryResultRow } from 'pg';

import type {
  GovernanceAuditViewV1,
  GovernanceCandidacyViewV1,
  GovernanceElectionChoiceV1,
  GovernanceElectionReceiptViewV1,
  GovernanceCharterViewV1,
  GovernanceElectionResultViewV1,
  GovernanceElectionViewV1,
  GovernanceInstitutionViewV1,
  GovernanceLawViewV1,
  GovernanceOfficeTermViewV1,
  GovernanceOfficeViewV1,
  GovernanceProposalReceiptViewV1,
  GovernanceProposalChoice,
  GovernanceProposalResultViewV1,
  GovernanceProposalViewV1,
  GovernanceUiProposalTargetsV1,
  SafeGovernanceEventPayloadV1,
} from '@worldgraph/contracts';

import type { GovernanceRealtimeMessageV1 } from './api-contracts.js';

export interface GovernanceReadConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
}

export interface GovernanceReadExecutor {
  connect(): Promise<GovernanceReadConnection>;
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface GovernanceReadContext {
  evaluatedAtTick: string;
  projectionRevision: string;
}

export interface GovernanceReadPage<T> {
  evaluatedAtTick: string;
  items: T[];
  positions: string[];
  projectionRevision: string;
}

export interface GovernanceCapabilityResource {
  parentResourceId: string | null;
  resourceId: string;
  resourceKey: string | null;
  resourceState: string;
  resourceType: 'candidacy' | 'election' | 'institution' | 'office' | 'office_term' | 'proposal';
  snapshotId: string | null;
  subjectEntityId: string | null;
}

export interface GovernanceActorCapabilityContext {
  actorEntityId: string | null;
  actorEntityKey: string | null;
  ballotReplacementAllowed: boolean;
  candidateEligible: boolean;
  eligible: boolean;
  hasBallot: boolean;
  membershipRole: 'administrator' | 'creator' | 'observer' | 'player';
}

interface ActorCapabilityContextRow extends QueryResultRow {
  actor_entity_id: string | null;
  actor_entity_key: string | null;
  ballot_replacement_allowed: boolean;
  candidate_eligible: boolean;
  eligible: boolean;
  has_ballot: boolean;
  membership_role: GovernanceActorCapabilityContext['membershipRole'];
}

interface ProposalTaxTargetRow extends QueryResultRow {
  currency_code: string;
  currency_id: string;
  currency_key: string;
  current_rate_bps: number;
  expected_policy_version: string;
  policy_id: string;
  policy_key: string;
  tax_type: string;
  treasury_wallet_id: string;
  treasury_wallet_key: string;
}

interface ProposalTreasuryTargetRow extends QueryResultRow {
  currency_code: string;
  currency_id: string;
  currency_key: string;
  currency_version: string;
  spendable_minor: string;
  treasury_wallet_id: string;
  treasury_wallet_key: string;
  treasury_wallet_version: string;
}

interface ProposalProjectTargetRow extends QueryResultRow {
  display_name: string;
  project_entity_id: string;
  project_key: string;
}

interface CapabilityResourceRow extends QueryResultRow {
  parent_resource_id: string | null;
  resource_id: string;
  resource_key: string | null;
  resource_state: string;
  resource_type: GovernanceCapabilityResource['resourceType'];
  snapshot_id: string | null;
  subject_entity_id: string | null;
}

interface ContextRow extends QueryResultRow {
  evaluated_at_tick: string;
  projection_revision: string;
}

interface CharterRow extends QueryResultRow {
  aggregate_version: string;
  charter_id: string;
  charter_version: number;
  checksum: Buffer;
  citizen_eligibility_policy: GovernanceCharterViewV1['citizenEligibilityPolicy'];
  effective_from_tick: string;
  effective_until_tick: string | null;
  proposal_rules: GovernanceCharterViewV1['proposalRules'];
  stable_key: string;
  summary: string;
  title: string;
  world_id: string;
}

interface InstitutionRow extends QueryResultRow {
  display_name: string;
  id: string;
  institution_type: GovernanceInstitutionViewV1['institutionType'];
  jurisdiction_entity_key: string;
  row_version: string;
  stable_key: string;
  status: GovernanceInstitutionViewV1['status'];
  world_id: string;
}

interface LawRow extends QueryResultRow {
  effective_from_tick: string;
  effective_until_tick: string | null;
  id: string;
  law_id: string;
  law_version: number;
  stable_key: string;
  status: GovernanceLawViewV1['status'];
  summary: string;
  title: string;
  world_id: string;
}

interface OfficeRow extends QueryResultRow {
  id: string;
  institution_id: string;
  row_version: string;
  seat_count: number;
  stable_key: string;
  term_ticks: string;
  tie_policy: GovernanceOfficeViewV1['tieRule'];
  title: string;
  world_id: string;
}

interface TermRow extends QueryResultRow {
  aggregate_version: string;
  holder_entity_key: string;
  id: string;
  office_id: string;
  planned_ends_tick: string;
  seat_index: number;
  source_id: string;
  source_kind: GovernanceOfficeTermViewV1['sourceType'];
  starts_tick: string;
  status: GovernanceOfficeTermViewV1['status'];
  world_id: string;
}

interface ProposalRow extends QueryResultRow {
  action_payload: GovernanceProposalViewV1['action'];
  aggregate_version: string;
  ballot_disclosure: GovernanceProposalViewV1['ballotPolicy']['disclosure'];
  ballot_mode: GovernanceProposalViewV1['ballotPolicy']['ballotMode'];
  body: string;
  debate_closes_tick: string;
  eligible_count: number | null;
  eligibility_snapshot_id: string | null;
  id: string;
  institution_id: string;
  quorum_numerator: number;
  replacement_allowed: boolean;
  status: GovernanceProposalViewV1['status'];
  sponsorship_closes_tick: string;
  threshold_numerator: number;
  title: string;
  turnout_count: number;
  voting_closes_tick: string;
  voting_opens_tick: string;
  world_id: string;
}

interface ElectionRow extends QueryResultRow {
  aggregate_version: string;
  ballot_disclosure: GovernanceElectionViewV1['ballotPolicy']['disclosure'];
  ballot_mode: GovernanceElectionViewV1['ballotPolicy']['ballotMode'];
  certification_tick: string;
  eligible_count: number | null;
  eligibility_snapshot_id: string | null;
  id: string;
  nomination_closes_tick: string;
  nomination_opens_tick: string;
  office_id: string;
  quorum_numerator: number;
  replacement_allowed: boolean;
  status: GovernanceElectionViewV1['status'];
  term_starts_tick: string;
  tie_rule: GovernanceElectionViewV1['tieRule'];
  title: string;
  turnout_count: number;
  voting_closes_tick: string;
  voting_opens_tick: string;
  world_id: string;
}

interface CandidacyRow extends QueryResultRow {
  aggregate_version: string;
  candidate_entity_key: string;
  election_id: string;
  id: string;
  status: GovernanceCandidacyViewV1['status'];
}

interface ReceiptRow extends QueryResultRow {
  ballot_mode: 'public' | 'secret';
  cast_tick: string;
  choice_payload: unknown;
  contest_id: string;
  contest_target_id: string;
  receipt_hash: Buffer;
}

interface ReceiptDisclosureRow extends QueryResultRow {
  ballot_mode: 'public' | 'secret';
  cast_tick: string;
  effective: boolean;
  public_choice: unknown;
  receipt_hash: Buffer;
}

interface ProposalResultRow extends QueryResultRow {
  abstain_count: number;
  eligible_count: number;
  input_checksum: Buffer;
  no_count: number;
  outcome: GovernanceProposalResultViewV1['outcome'];
  proposal_id: string;
  result_checksum: Buffer;
  result_id: string;
  turnout_count: number;
  yes_count: number;
}

interface ElectionResultRow extends QueryResultRow {
  abstain_count: number;
  election_id: string;
  eligible_count: number;
  input_checksum: Buffer;
  outcome: GovernanceElectionResultViewV1['outcome'];
  result_checksum: Buffer;
  result_id: string;
  turnout_count: number;
  winner_candidate_key: string | null;
}

interface ElectionCountRow extends QueryResultRow {
  ballot_count: number;
  candidate_key: string | null;
  count_kind: 'abstain' | 'candidate';
}

interface AuditRow extends QueryResultRow {
  actor_mode: GovernanceAuditViewV1['actorMode'];
  aggregate_id: string;
  aggregate_type: string;
  audit_id: string;
  event_type: string;
  occurred_at_tick: string;
  reason: string | null;
}

interface EventRow extends QueryResultRow {
  aggregate_id: string;
  aggregate_type: string;
  aggregate_version: string;
  event_type: string;
  occurred_at: Date;
  payload: SafeGovernanceEventPayloadV1;
  resulting_state_revision: string;
  world_event_sequence: string;
  world_id: string;
}

export class PostgresGovernanceReadRepository {
  public constructor(private readonly executor: GovernanceReadExecutor) {}

  public async context(actorId: string, worldId: string): Promise<GovernanceReadContext | null> {
    return this.readContext(this.executor, actorId, worldId);
  }

  private async readContext(
    executor: Pick<GovernanceReadConnection, 'query'>,
    actorId: string,
    worldId: string,
  ): Promise<GovernanceReadContext | null> {
    const result = await executor.query<ContextRow>(
      `select head.updated_state_revision::text as projection_revision,
              clock.current_tick::text as evaluated_at_tick
         from world_memberships membership
         join world_governance_heads head on head.world_id = membership.world_id
         join world_simulation_clocks clock on clock.world_id = membership.world_id
        where membership.world_id = $1 and membership.user_id = $2
          and membership.status = 'active'`,
      [worldId, actorId],
    );
    const row = result.rows[0];
    return row
      ? {
          evaluatedAtTick: row.evaluated_at_tick,
          projectionRevision: row.projection_revision,
        }
      : null;
  }

  public async charter(actorId: string, worldId: string): Promise<GovernanceCharterViewV1 | null> {
    const snapshot = await this.snapshotRead(actorId, worldId, async (connection) => {
      const result = await connection.query<CharterRow>(
        `select charter.id::text as charter_id, charter.world_id::text,
              charter.stable_key::text, charter.row_version::text as aggregate_version,
              version.charter_version, version.checksum,
              version.effective_from_tick::text,
              version.declared_until_tick::text as effective_until_tick,
              version.canonical_policy_document -> 'citizenEligibilityPolicy'
                as citizen_eligibility_policy,
              version.canonical_policy_document -> 'proposalRules' as proposal_rules,
              version.canonical_policy_document ->> 'title' as title,
              version.canonical_policy_document ->> 'summary' as summary
         from governing_charters charter
         join governing_charter_versions version
           on version.world_id = charter.world_id and version.charter_id = charter.id
         join charter_authority_intervals authority
           on authority.world_id=version.world_id
          and authority.charter_id=version.charter_id
          and authority.charter_version_id=version.id
         join world_simulation_clocks clock
           on clock.world_id=version.world_id
          and authority.effective_ticks @> clock.current_tick
        where charter.world_id = $1
        order by version.charter_version desc, version.id desc
        limit 1`,
        [worldId],
      );
      return result.rows[0] ?? null;
    });
    if (!snapshot || !snapshot.value) return null;
    return charterView(snapshot.value, snapshot.context);
  }

  public async capabilityResources(
    actorId: string,
    worldId: string,
  ): Promise<GovernanceCapabilityResource[] | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const result = await this.executor.query<CapabilityResourceRow>(
      `/* governance:read:capability-resources */
       with institution_resources as (
         select 'institution'::text as resource_type,institution.id::text as resource_id,
                institution.stable_key::text as resource_key,
                institution.status::text as resource_state,null::text as snapshot_id,
                null::text as parent_resource_id,null::text as subject_entity_id
           from institutions institution
          where institution.world_id=$1 and institution.status='active'
          order by institution.id
          limit 200
       ), office_resources as (
         select 'office'::text as resource_type,office.id::text as resource_id,
                office.stable_key::text as resource_key,
                'active'::text as resource_state,null::text as snapshot_id,
                null::text as parent_resource_id,null::text as subject_entity_id
           from political_offices office
          where office.world_id=$1
          order by office.id
          limit 200
       ), office_term_states as (
         select 'office_term'::text as resource_type,term.id::text as resource_id,
                null::text as resource_key,
                case
                  when latest.to_status in ('removed','ended','superseded_by_repair')
                    then latest.to_status
                  when clock.current_tick < term.starts_tick then 'scheduled'
                  when clock.current_tick >= term.planned_ends_tick then 'ended'
                  else 'active'
                end::text as resource_state,
                null::text as snapshot_id,null::text as parent_resource_id,
                null::text as subject_entity_id
           from office_terms term
           join world_simulation_clocks clock on clock.world_id=term.world_id
           left join lateral (
             select transition.to_status
               from office_term_transitions transition
              where transition.world_id=term.world_id and transition.term_id=term.id
              order by transition.effective_tick desc,transition.id desc limit 1
           ) latest on true
          where term.world_id=$1
       ), office_term_resources as (
         select * from office_term_states
          where resource_state in ('active','scheduled')
          order by resource_id
          limit 200
       ), proposal_states as (
         select 'proposal'::text as resource_type,proposal.id::text as resource_id,
                null::text as resource_key,proposal.status::text as resource_state,
                snapshot.id::text as snapshot_id,null::text as parent_resource_id,
                proposal.proposer_entity_id::text as subject_entity_id
           from proposals proposal
           left join proposal_contests mapping
             on mapping.world_id=proposal.world_id and mapping.proposal_id=proposal.id
           left join eligibility_snapshots snapshot
             on snapshot.world_id=mapping.world_id and snapshot.contest_id=mapping.contest_id
          where proposal.world_id=$1
       ), proposal_preballot_resources as (
         select * from proposal_states
          where resource_state in ('draft','sponsoring','debate','scheduled')
          order by resource_id
          limit 400
       ), proposal_ballot_resources as (
         select state.*
           from proposal_states state
           join proposals proposal
             on proposal.world_id=$1 and proposal.id=state.resource_id::uuid
           join world_simulation_clocks clock on clock.world_id=proposal.world_id
          where state.resource_state='open'
            and clock.current_tick >= proposal.voting_opens_tick
            and clock.current_tick < proposal.voting_closes_tick
          order by state.resource_id
          limit 100
       ), election_states as (
         select 'election'::text as resource_type,election.id::text as resource_id,
                null::text as resource_key,election.status::text as resource_state,
                snapshots.snapshot_id,election.office_id::text as parent_resource_id,
                null::text as subject_entity_id
           from elections election
           left join lateral (
             select snapshot.id::text as snapshot_id
               from election_contests mapping
               join eligibility_snapshots snapshot
                 on snapshot.world_id=mapping.world_id
                and snapshot.contest_id=mapping.contest_id
              where mapping.world_id=election.world_id
                and mapping.election_id=election.id
              order by mapping.contest_ordinal,snapshot.id
              limit 1
           ) snapshots on true
          where election.world_id=$1
       ), election_nomination_resources as (
         select state.*
           from election_states state
           join elections election
             on election.world_id=$1 and election.id=state.resource_id::uuid
           join world_simulation_clocks clock on clock.world_id=election.world_id
          where state.resource_state='nominations_open'
            and clock.current_tick >= election.nomination_opens_tick
            and clock.current_tick < election.nomination_closes_tick
          order by state.resource_id
          limit 200
       ), election_ballot_resources as (
         select state.*
           from election_states state
           join elections election
             on election.world_id=$1 and election.id=state.resource_id::uuid
           join world_simulation_clocks clock on clock.world_id=election.world_id
          where state.resource_state='open'
            and clock.current_tick >= election.voting_opens_tick
            and clock.current_tick < election.voting_closes_tick
          order by state.resource_id
          limit 100
       ), candidacy_resources as (
         select 'candidacy'::text as resource_type,candidacy.id::text as resource_id,
                null::text as resource_key,candidacy.status::text as resource_state,
                null::text as snapshot_id,candidacy.election_id::text as parent_resource_id,
                candidacy.candidate_entity_id::text as subject_entity_id
           from candidacies candidacy
           join elections election
             on election.world_id=candidacy.world_id and election.id=candidacy.election_id
           join world_simulation_clocks clock on clock.world_id=candidacy.world_id
          where candidacy.world_id=$1 and candidacy.status='nominated'
            and election.status='nominations_open'
            and clock.current_tick >= election.nomination_opens_tick
            and clock.current_tick < election.nomination_closes_tick
            and exists (
              select 1
                from world_entity_controllers controller
               where controller.world_id=candidacy.world_id
                 and controller.entity_id=candidacy.candidate_entity_id
                 and controller.user_id=$2
                 and controller.control_scope='primary'
                 and controller.revoked_at is null
            )
          order by candidacy.id
          limit 150
       )
       select resource.resource_type,resource.resource_id,resource.resource_key,
              resource.resource_state,
              resource.snapshot_id,resource.parent_resource_id,resource.subject_entity_id
         from (
           select * from institution_resources
           union all select * from office_resources
           union all select * from office_term_resources
           union all select * from proposal_preballot_resources
           union all select * from proposal_ballot_resources
           union all select * from election_nomination_resources
           union all select * from election_ballot_resources
           union all select * from candidacy_resources
         ) resource
        order by resource.resource_type collate "C",resource.resource_id`,
      [worldId, actorId],
    );
    return result.rows.map((row) => ({
      parentResourceId: row.parent_resource_id,
      resourceId: row.resource_id,
      resourceKey: row.resource_key,
      resourceState: row.resource_state,
      resourceType: row.resource_type,
      snapshotId: row.snapshot_id,
      subjectEntityId: row.subject_entity_id,
    }));
  }

  public async actorCapabilityContext(
    actorId: string,
    worldId: string,
    targetKind: 'election' | 'proposal' | 'world',
    targetId: string,
    snapshotId: string | null,
  ): Promise<GovernanceActorCapabilityContext | null> {
    const result = await this.executor.query<ActorCapabilityContextRow>(
      `/* governance:read:actor-capability */
       select actor_entity_id::text,actor_entity_key,membership_role,eligible,
              candidate_eligible,has_ballot,ballot_replacement_allowed
         from worldgraph_governance_actor_capability_v1($1,$2,$3,$4,$5)`,
      [worldId, actorId, targetKind, targetId, snapshotId],
    );
    const row = result.rows[0];
    return row
      ? {
          actorEntityId: row.actor_entity_id,
          actorEntityKey: row.actor_entity_key,
          ballotReplacementAllowed: row.ballot_replacement_allowed,
          candidateEligible: row.candidate_eligible,
          eligible: row.eligible,
          hasBallot: row.has_ballot,
          membershipRole: row.membership_role,
        }
      : null;
  }

  public async proposalTargets(
    actorId: string,
    worldId: string,
  ): Promise<GovernanceUiProposalTargetsV1 | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const [taxPolicies, treasuries, projectEntities] = await Promise.all([
      this.executor.query<ProposalTaxTargetRow>(
        `/* governance:read:proposal-tax-targets */
         select policy.id::text as policy_id,policy.stable_key::text as policy_key,
                policy.policy_version::text as expected_policy_version,
                policy.rate_basis_points as current_rate_bps,policy.tax_type::text,
                wallet.id::text as treasury_wallet_id,
                wallet.stable_key::text as treasury_wallet_key,
                currency.id::text as currency_id,currency.stable_key::text as currency_key,
                currency.code::text as currency_code
           from tax_policy_authority_intervals authority
           join tax_policies policy
             on policy.world_id=authority.world_id and policy.id=authority.tax_policy_id
           join wallets wallet
             on wallet.world_id=policy.world_id and wallet.id=policy.treasury_wallet_id
           join currencies currency
             on currency.world_id=policy.world_id and currency.id=policy.currency_id
           join world_simulation_clocks clock
             on clock.world_id=authority.world_id
            and authority.effective_ticks @> clock.current_tick
          where authority.world_id=$1 and policy.status='active'
            and policy.rate_basis_points is not null
            and wallet.status='active' and wallet.wallet_kind='treasury'
            and currency.status='active'
          order by policy.stable_key::text collate "C",policy.policy_version,policy.id
          limit 100`,
        [worldId],
      ),
      this.executor.query<ProposalTreasuryTargetRow>(
        `/* governance:read:proposal-treasury-targets */
         select wallet.id::text as treasury_wallet_id,
                wallet.stable_key::text as treasury_wallet_key,
                wallet.row_version::text as treasury_wallet_version,
                currency.id::text as currency_id,currency.stable_key::text as currency_key,
                currency.code::text as currency_code,currency.row_version::text as currency_version,
                worldgraph_wallet_spendable_minor_v1(wallet.world_id,wallet.id)::text
                  as spendable_minor
           from wallets wallet
           join currencies currency
             on currency.world_id=wallet.world_id and currency.id=wallet.currency_id
           join wallet_balances balance
             on balance.world_id=wallet.world_id and balance.wallet_id=wallet.id
          where wallet.world_id=$1 and wallet.wallet_kind='treasury'
            and wallet.status='active' and currency.status='active'
          order by wallet.stable_key::text collate "C",wallet.id
          limit 32`,
        [worldId],
      ),
      this.executor.query<ProposalProjectTargetRow>(
        `/* governance:read:proposal-project-targets */
         select entity.id::text as project_entity_id,entity.logical_key::text as project_key,
                coalesce(nullif(entity.state->>'displayName',''),nullif(entity.state->>'name',''),
                         entity.logical_key::text) as display_name
           from world_entities entity
          where entity.world_id=$1 and entity.entity_type='district'
            and entity.retired_world_version_id is null
          order by entity.logical_key::text collate "C",entity.id
          limit 100`,
        [worldId],
      ),
    ]);
    return {
      projectEntities: projectEntities.rows.map((row) => ({
        displayName: row.display_name,
        projectEntityId: row.project_entity_id,
        projectKey: row.project_key,
      })),
      taxPolicies: taxPolicies.rows.map((row) => ({
        currentRateBps: row.current_rate_bps,
        currencyCode: row.currency_code,
        currencyId: row.currency_id,
        currencyKey: row.currency_key,
        expectedPolicyVersion: row.expected_policy_version,
        policyId: row.policy_id,
        policyKey: row.policy_key,
        taxType: row.tax_type,
        treasuryWalletId: row.treasury_wallet_id,
        treasuryWalletKey: row.treasury_wallet_key,
      })),
      treasuries: treasuries.rows.map((row) => ({
        currencyCode: row.currency_code,
        currencyId: row.currency_id,
        currencyKey: row.currency_key,
        currencyVersion: row.currency_version,
        spendableMinor: row.spendable_minor,
        treasuryWalletId: row.treasury_wallet_id,
        treasuryWalletKey: row.treasury_wallet_key,
        treasuryWalletVersion: row.treasury_wallet_version,
      })),
    };
  }

  public institutions(
    input: PageInput,
  ): Promise<GovernanceReadPage<GovernanceInstitutionViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<InstitutionRow>(
        `select institution.id::text, institution.world_id::text,
                institution.stable_key::text, institution.institution_type::text,
                institution.status::text, institution.row_version::text,
                jurisdiction.logical_key::text as jurisdiction_entity_key,
                coalesce(entity.state ->> 'displayName', entity.state ->> 'name',
                         institution.stable_key::text) as display_name
           from institutions institution
           join world_entities entity
             on entity.world_id = institution.world_id and entity.id = institution.entity_id
           join world_entities jurisdiction
             on jurisdiction.world_id = institution.world_id
            and jurisdiction.id = institution.jurisdiction_entity_id
          where institution.world_id = $1 and ($2::uuid is null or institution.id > $2::uuid)
          order by institution.id
          limit $3`,
        [input.worldId, input.after, input.limit],
      );
      return {
        items: result.rows.map(institutionView),
        positions: result.rows.map((row) => row.id),
      };
    });
  }

  public laws(input: PageInput): Promise<GovernanceReadPage<GovernanceLawViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<LawRow>(
        `select version.id::text, version.world_id::text, law.id::text as law_id,
                law.stable_key::text, version.law_version, version.title, version.summary,
                version.effective_from_tick::text,
                upper(interval.effective_ticks)::text as effective_until_tick,
                case
                  when interval.effective_ticks @> clock.current_tick then 'active'
                  when interval.effective_ticks is not null
                    and clock.current_tick < lower(interval.effective_ticks) then 'scheduled'
                  when interval.effective_ticks is not null
                    and upper(interval.effective_ticks) is not null
                    and clock.current_tick >= upper(interval.effective_ticks) then
                    case
                      when successor.version_kind = 'repeal' then 'repealed'
                      when successor.version_kind is not null then 'superseded'
                      else 'expired'
                    end
                  else coalesce(latest.to_status, version.initial_status)
                end::text as status
           from law_versions version
           join laws law on law.world_id = version.world_id and law.id = version.law_id
           join world_simulation_clocks clock on clock.world_id = version.world_id
           left join law_authority_intervals interval
             on interval.world_id = version.world_id and interval.law_version_id = version.id
           left join lateral (
             select transition.to_status
               from law_effectivity_transitions transition
              where transition.world_id = version.world_id
                and transition.law_version_id = version.id
             order by transition.effective_tick desc, transition.id desc limit 1
           ) latest on true
           left join lateral (
             select next_version.version_kind
               from law_versions next_version
              where next_version.world_id = version.world_id
                and next_version.supersedes_version_id = version.id
              order by next_version.law_version, next_version.id limit 1
           ) successor on true
          where version.world_id = $1 and ($2::uuid is null or version.id > $2::uuid)
          order by version.id
          limit $3`,
        [input.worldId, input.after, input.limit],
      );
      return { items: result.rows.map(lawView), positions: result.rows.map((row) => row.id) };
    });
  }

  public offices(input: PageInput): Promise<GovernanceReadPage<GovernanceOfficeViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<OfficeRow>(
        `select office.id::text, office.world_id::text, office.institution_id::text,
                office.stable_key::text, office.title, office.seat_count,
                office.term_ticks::text, office.tie_policy::text, office.row_version::text
           from political_offices office
          where office.world_id = $1 and ($2::uuid is null or office.id > $2::uuid)
          order by office.id
          limit $3`,
        [input.worldId, input.after, input.limit],
      );
      return { items: result.rows.map(officeView), positions: result.rows.map((row) => row.id) };
    });
  }

  public terms(input: PageInput): Promise<GovernanceReadPage<GovernanceOfficeTermViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<TermRow>(
        `select term.id::text, term.world_id::text, term.office_id::text,
                holder.logical_key::text as holder_entity_key,
                (seat.seat_ordinal - 1)::integer as seat_index,
                term.starts_tick::text, term.planned_ends_tick::text,
                head.current_version::text as aggregate_version,
                case
                  when latest.to_status in ('removed','ended','superseded_by_repair')
                    then latest.to_status
                  when clock.current_tick < term.starts_tick then 'scheduled'
                  when clock.current_tick >= term.planned_ends_tick then 'ended'
                  else 'active'
                end::text as status,
                term.source_kind::text,
                coalesce(term.source_election_result_id, term.source_proposal_result_id,
                         term.created_command_id)::text as source_id
           from office_terms term
           join political_office_seats seat
             on seat.world_id = term.world_id and seat.id = term.seat_id
           join world_entities holder
             on holder.world_id = term.world_id and holder.id = term.holder_entity_id
           join aggregate_stream_heads head
             on head.world_id = term.world_id
            and head.aggregate_type = 'office_term'
            and head.aggregate_id = term.id::text
           join world_simulation_clocks clock on clock.world_id = term.world_id
           left join lateral (
             select transition.to_status
               from office_term_transitions transition
              where transition.world_id = term.world_id and transition.term_id = term.id
              order by transition.effective_tick desc, transition.id desc limit 1
           ) latest on true
          where term.world_id = $1 and ($2::uuid is null or term.id > $2::uuid)
          order by term.id
          limit $3`,
        [input.worldId, input.after, input.limit],
      );
      return { items: result.rows.map(termView), positions: result.rows.map((row) => row.id) };
    });
  }

  public proposals(input: PageInput): Promise<GovernanceReadPage<GovernanceProposalViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<ProposalRow>(
        `select proposal.id::text, proposal.world_id::text, proposal.institution_id::text,
                proposal.title, proposal.body, proposal.status::text,
                proposal.sponsorship_closes_tick::text,
                proposal.debate_closes_tick::text,
                proposal.voting_opens_tick::text, proposal.voting_closes_tick::text,
                proposal.quorum_numerator, proposal.threshold_numerator,
                proposal.ballot_mode::text, proposal.ballot_disclosure::text,
                proposal.allow_ballot_replacement as replacement_allowed,
                proposal.aggregate_version::text,
                action.action_payload,
                snapshot.eligible_count, snapshot.id::text as eligibility_snapshot_id,
                coalesce(turnout.turnout_count, 0)::integer as turnout_count
           from proposals proposal
           join lateral (
             select proposal_action.action_payload
               from proposal_actions proposal_action
              where proposal_action.world_id = proposal.world_id
                and proposal_action.proposal_id = proposal.id
              order by proposal_action.action_ordinal, proposal_action.id limit 1
           ) action on true
           left join proposal_contests mapping
             on mapping.world_id = proposal.world_id and mapping.proposal_id = proposal.id
           left join eligibility_snapshots snapshot
             on snapshot.world_id = mapping.world_id and snapshot.contest_id = mapping.contest_id
           left join lateral (
             select count(*)::integer as turnout_count
               from ballot_participation participation
              where participation.world_id = mapping.world_id
                and participation.contest_id = mapping.contest_id
           ) turnout on true
          where proposal.world_id = $1 and ($2::uuid is null or proposal.id > $2::uuid)
          order by proposal.id
          limit $3`,
        [input.worldId, input.after, input.limit],
      );
      return { items: result.rows.map(proposalView), positions: result.rows.map((row) => row.id) };
    });
  }

  public elections(input: PageInput): Promise<GovernanceReadPage<GovernanceElectionViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<ElectionRow>(
        `select election.id::text, election.world_id::text, election.office_id::text,
                office.title, election.status::text,
                election.nomination_opens_tick::text,election.nomination_closes_tick::text,
                election.voting_opens_tick::text, election.voting_closes_tick::text,
                election.certification_tick::text,election.term_starts_tick::text,
                election.quorum_numerator, election.tie_rule::text,
                election.ballot_mode::text, election.ballot_disclosure::text,
                election.allow_ballot_replacement as replacement_allowed,
                election.aggregate_version::text,
                snapshots.eligible_count, snapshots.eligibility_snapshot_id,
                coalesce(turnout.turnout_count,0)::integer as turnout_count
           from elections election
           join political_offices office
             on office.world_id = election.world_id and office.id = election.office_id
           left join lateral (
             select max(snapshot.eligible_count)::integer as eligible_count,
                    (array_agg(snapshot.id order by contest.contest_ordinal))[1]::text
                      as eligibility_snapshot_id
               from election_contests contest
               join eligibility_snapshots snapshot
                 on snapshot.world_id = contest.world_id and snapshot.contest_id = contest.contest_id
              where contest.world_id = election.world_id and contest.election_id = election.id
           ) snapshots on true
           left join lateral (
             select count(*)::integer as turnout_count
               from election_contests contest
               join ballot_participation participation
                 on participation.world_id = contest.world_id
                and participation.contest_id = contest.contest_id
              where contest.world_id = election.world_id and contest.election_id = election.id
           ) turnout on true
          where election.world_id = $1 and ($2::uuid is null or election.id > $2::uuid)
          order by election.id
          limit $3`,
        [input.worldId, input.after, input.limit],
      );
      return { items: result.rows.map(electionView), positions: result.rows.map((row) => row.id) };
    });
  }

  public candidacies(
    input: PageInput & { electionId: string },
  ): Promise<GovernanceReadPage<GovernanceCandidacyViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<CandidacyRow>(
        `select candidacy.id::text, candidacy.election_id::text,
                candidacy.aggregate_version::text,
                candidate.logical_key::text as candidate_entity_key,
                candidacy.status::text
           from candidacies candidacy
           join world_entities candidate
             on candidate.world_id = candidacy.world_id
            and candidate.id = candidacy.candidate_entity_id
          where candidacy.world_id = $1 and candidacy.election_id = $2
            and ($3::uuid is null or candidacy.id > $3::uuid)
          order by candidacy.id
          limit $4`,
        [input.worldId, input.electionId, input.after, input.limit],
      );
      return { items: result.rows.map(candidacyView), positions: result.rows.map((row) => row.id) };
    });
  }

  public async proposalReceipt(
    actorId: string,
    worldId: string,
    proposalId: string,
  ): Promise<GovernanceProposalReceiptViewV1 | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const row = await this.receipt(actorId, worldId, 'proposal', proposalId);
    if (!row) return null;
    if (row.ballot_mode === 'secret') {
      return {
        ballotMode: 'secret',
        castAtTick: row.cast_tick,
        proposalId: row.contest_target_id,
        receiptHash: hex(row.receipt_hash),
      };
    }
    return {
      ballotMode: 'public',
      castAtTick: row.cast_tick,
      choice: proposalReceiptChoice(row.choice_payload),
      proposalId: row.contest_target_id,
      receiptHash: hex(row.receipt_hash),
    };
  }

  public async electionReceipt(
    actorId: string,
    worldId: string,
    electionId: string,
  ): Promise<GovernanceElectionReceiptViewV1 | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const row = await this.receipt(actorId, worldId, 'election', electionId);
    if (!row) return null;
    if (row.ballot_mode === 'secret') {
      return {
        ballotMode: 'secret',
        castAtTick: row.cast_tick,
        electionId: row.contest_target_id,
        receiptHash: hex(row.receipt_hash),
      };
    }
    return {
      ballotMode: 'public',
      castAtTick: row.cast_tick,
      choice: row.choice_payload as GovernanceElectionChoiceV1,
      electionId: row.contest_target_id,
      receiptHash: hex(row.receipt_hash),
    };
  }

  public async proposalResult(
    actorId: string,
    worldId: string,
    proposalId: string,
  ): Promise<GovernanceProposalResultViewV1 | null> {
    const snapshot = await this.snapshotRead(actorId, worldId, async (connection) => {
      const result = await connection.query<ProposalResultRow>(
        `select result_id::text,proposal_id::text,outcome,result_checksum,input_checksum,
                eligible_count,turnout_count,yes_count,no_count,abstain_count
           from worldgraph_governance_proposal_result_v1($1,$2,$3)`,
        [worldId, actorId, proposalId],
      );
      const row = result.rows[0];
      return row ? proposalResultView(row) : null;
    });
    return snapshot?.value ?? null;
  }

  public async electionResult(
    actorId: string,
    worldId: string,
    electionId: string,
  ): Promise<GovernanceElectionResultViewV1 | null> {
    const snapshot = await this.snapshotRead(actorId, worldId, async (connection) => {
      const result = await connection.query<ElectionResultRow>(
        `select result_id::text,election_id::text,outcome,result_checksum,input_checksum,
                eligible_count,turnout_count,winner_candidate_key,abstain_count
           from worldgraph_governance_election_result_v1($1,$2,$3)`,
        [worldId, actorId, electionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const countResult = await connection.query<ElectionCountRow>(
        `select count_kind,ballot_count,candidate_key
           from worldgraph_governance_election_result_counts_v1($1,$2,$3)`,
        [worldId, actorId, row.result_id],
      );
      return electionResultView(row, countResult.rows);
    });
    return snapshot?.value ?? null;
  }

  public audit(input: PageInput): Promise<GovernanceReadPage<GovernanceAuditViewV1> | null> {
    return this.page(input, async (connection) => {
      const result = await connection.query<AuditRow>(
        `select audit_id, actor_mode, aggregate_id, aggregate_type, event_type,
                occurred_at_tick, reason
           from (
             select override.id::text as audit_id, override.actor_mode::text,
                    override.target_id::text as aggregate_id,
                    override.target_kind::text as aggregate_type,
                    'governance.override'::text as event_type,
                    command.expected_tick::text as occurred_at_tick,
                    override.reason
               from governance_overrides override
               join command_records command
                 on command.world_id = override.world_id and command.id = override.command_id
              where override.world_id = $1
             union all
             select repair.id::text,
                    authority.actor_mode::text,
                    repair.target_id::text, repair.target_kind::text,
                    'governance.repair'::text,
                    command.expected_tick::text, repair.reason
               from governance_repairs repair
               join command_records command
                 on command.world_id = repair.world_id and command.id = repair.command_id
               join lateral (
                 select decision.actor_mode
                   from governance_authority_decisions decision
                  where decision.world_id=repair.world_id
                    and decision.command_id=repair.command_id
                    and decision.action_code='governance.result.repair'
                  order by decision.id
                  limit 1
               ) authority on true
              where repair.world_id = $1
             union all
             select decision.id::text, decision.actor_mode::text,
                    decision.command_id::text, 'authority_decision'::text,
                    'governance.authority_decision'::text,
                    decision.evaluated_tick::text, decision.reason_code::text
               from governance_authority_decisions decision
              where decision.world_id = $1
           ) audit
          where ($2::uuid is null or audit.audit_id::uuid > $2::uuid)
          order by audit.audit_id::uuid
          limit $3`,
        [input.worldId, input.after, input.limit],
      );
      return {
        items: result.rows.map(auditView),
        positions: result.rows.map((row) => row.audit_id),
      };
    });
  }

  public async events(
    actorId: string,
    worldId: string,
    after: string,
    limit: number,
  ): Promise<GovernanceRealtimeMessageV1[] | null> {
    const context = await this.context(actorId, worldId);
    if (!context) return null;
    const result = await this.executor.query<EventRow>(
      `select event.world_id::text, event.world_event_sequence::text,
              event.aggregate_type, event.aggregate_id, event.aggregate_version::text,
              event.event_type, event.payload, event.occurred_at,
              event.resulting_state_revision::text
         from domain_events event
        where event.world_id = $1 and event.world_event_sequence > $2::bigint
          and event.event_type = any($3::text[])
        order by event.world_event_sequence
        limit $4`,
      [worldId, after, SAFE_EVENT_TYPES, limit],
    );
    return result.rows.map(eventView);
  }

  private async receipt(
    actorId: string,
    worldId: string,
    kind: 'election' | 'proposal',
    targetId: string,
  ): Promise<ReceiptRow | null> {
    const targetTable = kind === 'proposal' ? 'proposal_contests' : 'election_contests';
    const targetColumn = kind === 'proposal' ? 'proposal_id' : 'election_id';
    const owned = await this.executor.query<ReceiptRow>(
      `/* governance:read:owned-receipt-token */
       select participation.ballot_mode::text,receipt.cast_tick::text,
              receipt.receipt_hash,participation.contest_id::text,
              mapping.${targetColumn}::text as contest_target_id,
              null::jsonb as choice_payload
         from ${targetTable} mapping
         join ballot_participation participation
           on participation.world_id = mapping.world_id
          and participation.contest_id = mapping.contest_id
         join world_entity_controllers controller
           on controller.world_id = participation.world_id
          and controller.entity_id = participation.voter_entity_id
          and controller.user_id = $3 and controller.revoked_at is null
         join ballot_receipts receipt
           on receipt.world_id = participation.world_id
          and receipt.participation_id = participation.id
        where mapping.world_id = $1 and mapping.${targetColumn} = $2
        order by receipt.cast_tick desc,receipt.id desc
        limit 1`,
      [worldId, targetId, actorId],
    );
    const token = owned.rows[0];
    if (!token) return null;
    const disclosed = await this.executor.query<ReceiptDisclosureRow>(
      `/* governance:read:receipt-disclosure-boundary */
       select ballot_mode,cast_tick::text,effective,public_choice,receipt_hash
         from worldgraph_governance_ballot_receipt_v1($1,$2,$3)`,
      [worldId, token.contest_id, token.receipt_hash],
    );
    const disclosure = disclosed.rows[0];
    if (!disclosure || !disclosure.effective || disclosure.ballot_mode !== token.ballot_mode) {
      return null;
    }
    return {
      ...token,
      ballot_mode: disclosure.ballot_mode,
      cast_tick: disclosure.cast_tick,
      choice_payload: disclosure.public_choice,
      receipt_hash: disclosure.receipt_hash,
    };
  }

  private async page<T>(
    input: PageInput,
    read: (connection: GovernanceReadConnection) => Promise<{ items: T[]; positions: string[] }>,
  ): Promise<GovernanceReadPage<T> | null> {
    const snapshot = await this.snapshotRead(input.actorId, input.worldId, read);
    if (!snapshot) return null;
    return {
      ...snapshot.value,
      evaluatedAtTick: snapshot.context.evaluatedAtTick,
      projectionRevision: snapshot.context.projectionRevision,
    };
  }

  private async snapshotRead<T>(
    actorId: string,
    worldId: string,
    read: (connection: GovernanceReadConnection) => Promise<T>,
  ): Promise<{ context: GovernanceReadContext; value: T } | null> {
    const connection = await this.executor.connect();
    let transactionOpen = false;
    try {
      await connection.query('begin isolation level repeatable read read only');
      transactionOpen = true;
      const context = await this.readContext(connection, actorId, worldId);
      if (!context) {
        await connection.query('commit');
        transactionOpen = false;
        return null;
      }
      const value = await read(connection);
      await connection.query('commit');
      transactionOpen = false;
      return { context, value };
    } catch (error) {
      if (transactionOpen) {
        await connection.query('rollback').catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}

function proposalReceiptChoice(value: unknown): GovernanceProposalChoice {
  if (
    !value ||
    typeof value !== 'object' ||
    !Object.hasOwn(value, 'choice') ||
    !['yes', 'no', 'abstain'].includes(String((value as { choice?: unknown }).choice))
  ) {
    throw new Error('GOVERNANCE_PUBLIC_PROPOSAL_RECEIPT_INVALID');
  }
  return (value as { choice: GovernanceProposalChoice }).choice;
}

interface PageInput {
  actorId: string;
  after: string | null;
  limit: number;
  worldId: string;
}

const SAFE_EVENT_TYPES = [
  'WorldGovernanceInitializedV1',
  'GovernanceSeedPlanAdoptedV1',
  'GovernanceCandidacyChangedV1',
  'ProposalBallotRecordedPublicV1',
  'ProposalBallotRecordedSecretV1',
  'ElectionBallotRecordedPublicV1',
  'ElectionBallotRecordedSecretV1',
  'GovernanceLifecycleChangedV1',
  'GovernanceResultFinalizedV1',
  'GovernanceLawVersionActivatedV1',
  'GovernanceOfficeTermChangedV1',
  'GovernanceOverrideExecutedV1',
  'GovernanceRepairAppendedV1',
] as const;

function charterView(row: CharterRow, context: GovernanceReadContext): GovernanceCharterViewV1 {
  return {
    aggregateVersion: row.aggregate_version,
    charterId: row.charter_id,
    checksum: hex(row.checksum),
    citizenEligibilityPolicy: row.citizen_eligibility_policy,
    evaluatedAtTick: context.evaluatedAtTick,
    effectiveFromTick: row.effective_from_tick,
    effectiveUntilTick: row.effective_until_tick,
    projectionRevision: context.projectionRevision,
    proposalRules: row.proposal_rules,
    stableKey: row.stable_key,
    summary: row.summary,
    title: row.title,
    version: String(row.charter_version),
    worldId: row.world_id,
  };
}

function institutionView(row: InstitutionRow): GovernanceInstitutionViewV1 {
  return {
    aggregateVersion: row.row_version,
    displayName: row.display_name,
    institutionId: row.id,
    institutionType: row.institution_type,
    jurisdictionEntityKey: row.jurisdiction_entity_key,
    stableKey: row.stable_key,
    status: row.status,
    worldId: row.world_id,
  };
}

function lawView(row: LawRow): GovernanceLawViewV1 {
  return {
    aggregateVersion: String(row.law_version),
    effectiveFromTick: row.effective_from_tick,
    effectiveUntilTick: row.effective_until_tick,
    lawId: row.law_id,
    lawVersion: String(row.law_version),
    stableKey: row.stable_key,
    status: row.status,
    summary: row.summary,
    title: row.title,
    worldId: row.world_id,
  };
}

function officeView(row: OfficeRow): GovernanceOfficeViewV1 {
  return {
    aggregateVersion: row.row_version,
    displayName: row.title,
    institutionId: row.institution_id,
    officeId: row.id,
    seats: row.seat_count,
    stableKey: row.stable_key,
    termDurationTicks: row.term_ticks,
    tieRule: row.tie_policy,
    worldId: row.world_id,
  };
}

function termView(row: TermRow): GovernanceOfficeTermViewV1 {
  return {
    aggregateVersion: row.aggregate_version,
    endsAtTick: row.planned_ends_tick,
    holderEntityKey: row.holder_entity_key,
    officeId: row.office_id,
    seatIndex: row.seat_index,
    sourceId: row.source_id,
    sourceType: row.source_kind,
    startsAtTick: row.starts_tick,
    status: row.status,
    termId: row.id,
    worldId: row.world_id,
  };
}

function proposalView(row: ProposalRow): GovernanceProposalViewV1 {
  return {
    action: row.action_payload,
    aggregateVersion: row.aggregate_version,
    approvalThresholdBps: row.threshold_numerator,
    ballotPolicy:
      row.ballot_mode === 'secret'
        ? {
            ballotMode: 'secret',
            disclosure: 'aggregate_only',
            replacementAllowed: row.replacement_allowed,
          }
        : {
            ballotMode: 'public',
            disclosure: row.ballot_disclosure,
            replacementAllowed: row.replacement_allowed,
          },
    body: row.body,
    debateEndsAtTick: row.debate_closes_tick,
    eligibleCount: row.eligible_count,
    eligibilitySnapshotId: row.eligibility_snapshot_id,
    institutionId: row.institution_id,
    proposalId: row.id,
    quorumBps: row.quorum_numerator,
    sponsorshipEndsAtTick: row.sponsorship_closes_tick,
    status: row.status,
    title: row.title,
    turnoutCount: row.turnout_count,
    votingClosesAtTick: row.voting_closes_tick,
    votingOpensAtTick: row.voting_opens_tick,
    worldId: row.world_id,
  };
}

function electionView(row: ElectionRow): GovernanceElectionViewV1 {
  return {
    aggregateVersion: row.aggregate_version,
    ballotPolicy:
      row.ballot_mode === 'secret'
        ? {
            ballotMode: 'secret',
            disclosure: 'aggregate_only',
            replacementAllowed: row.replacement_allowed,
          }
        : {
            ballotMode: 'public',
            disclosure: row.ballot_disclosure,
            replacementAllowed: row.replacement_allowed,
          },
    certificationAtTick: row.certification_tick,
    electionId: row.id,
    eligibleCount: row.eligible_count,
    eligibilitySnapshotId: row.eligibility_snapshot_id,
    nominationClosesAtTick: row.nomination_closes_tick,
    nominationOpensAtTick: row.nomination_opens_tick,
    officeId: row.office_id,
    quorumBps: row.quorum_numerator,
    status: row.status,
    termStartsAtTick: row.term_starts_tick,
    tieRule: row.tie_rule,
    title: row.title,
    turnoutCount: row.turnout_count,
    votingClosesAtTick: row.voting_closes_tick,
    votingOpensAtTick: row.voting_opens_tick,
    worldId: row.world_id,
  };
}

function candidacyView(row: CandidacyRow): GovernanceCandidacyViewV1 {
  return {
    aggregateVersion: row.aggregate_version,
    candidacyId: row.id,
    candidateEntityKey: row.candidate_entity_key,
    electionId: row.election_id,
    status: row.status,
  };
}

function proposalResultView(row: ProposalResultRow): GovernanceProposalResultViewV1 {
  return {
    abstainCount: row.abstain_count,
    certified: true,
    eligibleCount: row.eligible_count,
    inputChecksum: hex(row.input_checksum),
    noCount: row.no_count,
    outcome: row.outcome,
    proposalId: row.proposal_id,
    resultChecksum: hex(row.result_checksum),
    resultId: row.result_id,
    turnoutCount: row.turnout_count,
    yesCount: row.yes_count,
  };
}

function electionResultView(
  row: ElectionResultRow,
  counts: ElectionCountRow[],
): GovernanceElectionResultViewV1 {
  const candidateTotals = counts
    .filter(
      (count): count is ElectionCountRow & { candidate_key: string } =>
        count.count_kind === 'candidate' && count.candidate_key !== null,
    )
    .map((count) => ({ candidateKey: count.candidate_key, voteCount: count.ballot_count }));
  const maximum = candidateTotals.reduce((value, count) => Math.max(value, count.voteCount), -1);
  const tiedCandidateKeys =
    row.outcome === 'vacant_tie'
      ? candidateTotals
          .filter((count) => count.voteCount === maximum)
          .map((count) => count.candidateKey)
      : [];
  return {
    abstainCount: row.abstain_count,
    candidateTotals,
    certified: true,
    electionId: row.election_id,
    eligibleCount: row.eligible_count,
    inputChecksum: hex(row.input_checksum),
    outcome: row.outcome,
    resultChecksum: hex(row.result_checksum),
    resultId: row.result_id,
    tiedCandidateKeys,
    turnoutCount: row.turnout_count,
    winnerCandidateKey: row.winner_candidate_key,
  };
}

function auditView(row: AuditRow): GovernanceAuditViewV1 {
  return {
    actorMode: row.actor_mode,
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    auditId: row.audit_id,
    eventType: row.event_type,
    occurredAtTick: row.occurred_at_tick,
    reason: row.reason,
  };
}

function eventView(row: EventRow): GovernanceRealtimeMessageV1 {
  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    aggregateVersion: row.aggregate_version,
    eventCursor: row.world_event_sequence,
    eventType: row.event_type,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
    resultingStateRevision: row.resulting_state_revision,
    worldId: row.world_id,
  };
}

function hex(value: Buffer): string {
  return value.toString('hex');
}
