import { createHash } from 'node:crypto';

import type { Pool, QueryResultRow } from 'pg';

import {
  canonicalJson,
  type AuthorityAction,
  type GovernanceActorMode,
  type GovernancePolicyExpressionV1,
  type IdGenerator,
  type PublicGovernanceCommandRequestV1,
  type WorldRole,
} from '@worldgraph/contracts';
import { evaluateGovernancePolicyV1 } from '@worldgraph/governance';
import {
  PostgresGovernanceCommandExecutor,
  RecentCredentialProofError,
  type GovernanceAuthorizationEvidence,
  type GovernanceAuthoritySourceEvidence,
  type GovernanceCommandActor,
  type GovernanceCommandExecutionResult,
  type GovernanceCommandPolicy,
  type PublicGovernanceCommandExecutionInput,
  type GovernanceSqlClient,
  type GovernanceSqlPool,
  type GovernanceRecentCredentialProof,
} from '@worldgraph/governance-command';

import { ApplicationError } from '../application/errors.js';
import { evaluateAuthority } from '../authority/evaluator.js';

interface AuthorityContextRow extends QueryResultRow {
  active_world_version_id: string;
  actor_entity_ids: string[];
  current_tick: string;
  membership_role: WorldRole | null;
  membership_row_version: string | null;
  membership_status: 'active' | 'removed' | null;
  world_id: string;
}

interface OrganizationMembershipRow extends QueryResultRow {
  active_world_version_id: string;
  attributes: Record<string, unknown>;
  created_world_version_id: string;
  organization_entity_id: string;
  organization_key: string;
  relationship_id: string;
  relationship_key: string;
  relationship_row_version: string;
  relationship_schema_version: number;
  source_entity_id: string;
  world_id: string;
}

interface HeldOfficeRow extends QueryResultRow {
  effective_from_tick: string;
  effective_until_tick: string | null;
  office_key: string;
  term_checksum: Buffer;
  term_id: string;
  term_number: string;
}

interface PolicyRow extends QueryResultRow {
  authority_kind: 'delegated_organization' | 'direct_office' | null;
  delegation_checksum: Buffer | null;
  delegation_id: string | null;
  effective_from_tick: string;
  effective_until_tick: string | null;
  office_term_checksum: Buffer | null;
  office_term_id: string | null;
  office_term_number: string | null;
  organization_membership_id: string | null;
  policy: GovernancePolicyExpressionV1;
  source_checksum: Buffer;
  source_id: string;
  source_kind: 'institution_power' | 'law' | 'office_power';
  source_version: string;
}

export interface GovernanceAuthorityPreparationInput {
  actionCode: AuthorityAction;
  actorId: string;
  actorMode: GovernanceActorMode;
  allowActiveLaw: boolean;
  overrideRequested: boolean;
  platformRole: 'platform_admin' | 'user';
  policyActionCode: string | null;
  policyResourceType?: string;
  resourceId: string;
  resourceKey: string | null;
  resourceType: string;
  worldId: string;
}

export interface GovernanceAuthorityPreparation {
  actor: GovernanceCommandActor;
  authorization: GovernanceAuthorizationEvidence;
  hiddenByAuthority: boolean;
}

export interface GovernanceCommandGateway {
  executePublic(
    input: PublicGovernanceCommandExecutionInput,
  ): Promise<GovernanceCommandExecutionResult>;
  prepareAuthority(
    input: GovernanceAuthorityPreparationInput,
  ): Promise<GovernanceAuthorityPreparation | null>;
}

export interface PostgresGovernanceCommandGatewayOptions {
  ids: IdGenerator;
  maximumSerializationAttempts?: number;
  policy?: Partial<GovernanceCommandPolicy>;
  secretHashKey?: string;
}

export class PostgresGovernanceCommandGateway implements GovernanceCommandGateway {
  private readonly executor: PostgresGovernanceCommandExecutor;

  public constructor(
    private readonly pool: Pool,
    options: PostgresGovernanceCommandGatewayOptions,
  ) {
    this.executor = new PostgresGovernanceCommandExecutor(governanceSqlPool(pool), options);
  }

  public async executePublic(
    input: PublicGovernanceCommandExecutionInput,
  ): Promise<GovernanceCommandExecutionResult> {
    try {
      return await this.executor.executePublic(input);
    } catch (error) {
      if (error instanceof RecentCredentialProofError) {
        throw new ApplicationError(
          'RECENT_CREDENTIAL_INVALID',
          'The recent-credential proof is invalid or expired.',
          403,
        );
      }
      throw error;
    }
  }

  public async prepareAuthority(
    input: GovernanceAuthorityPreparationInput,
  ): Promise<GovernanceAuthorityPreparation | null> {
    const contextResult = await this.pool.query<AuthorityContextRow>(
      `/* governance:api:authority-context */
       select world.id::text as world_id,clock.current_tick::text,
              world.active_world_version_id::text,
              membership.role::text as membership_role,
              membership.status::text as membership_status,
              membership.row_version::text as membership_row_version,
              array(
                select controller.entity_id::text
                  from world_entity_controllers controller
                 join world_entities entity on entity.world_id=controller.world_id
                    and entity.id=controller.entity_id
                 where controller.world_id=world.id and controller.user_id=$2
                   and controller.control_scope='primary'
                   and controller.revoked_at is null
                   and entity.entity_type='player_character'
                   and entity.retired_world_version_id is null
                 order by entity.logical_key::text collate "C",controller.entity_id
                 limit 2
              ) as actor_entity_ids
         from worlds world
         join world_simulation_clocks clock on clock.world_id=world.id
         left join world_memberships membership on membership.world_id=world.id
          and membership.user_id=$2
        where world.id=$1 and world.archived_at is null
          and world.lifecycle='active' and world.active_world_version_id is not null`,
      [input.worldId, input.actorId],
    );
    const context = contextResult.rows[0];
    if (!context) return null;

    const actorEntityId =
      context.actor_entity_ids.length === 1 ? context.actor_entity_ids[0]! : null;
    const actor: GovernanceCommandActor =
      input.actorMode === 'administrator' && input.platformRole === 'platform_admin'
        ? { actorEntityId: null, actorId: input.actorId, actorType: 'platform_admin' }
        : {
            actorEntityId: input.actorMode === 'in_world' ? actorEntityId : null,
            actorId: input.actorId,
            actorType: 'user',
          };
    const coarse = evaluateAuthority(
      {
        ...(context.membership_role ? { membershipRole: context.membership_role } : {}),
        ...(context.membership_status ? { membershipStatus: context.membership_status } : {}),
        platformRole: input.platformRole,
        userId: input.actorId,
      },
      input.actionCode,
      { worldId: input.worldId },
      { overrideRequested: input.overrideRequested },
    );
    const membershipSource = membershipAuthoritySource(input, context);
    const baseContext = {
      activeWorldVersionId: context.active_world_version_id,
      actorMode: input.actorMode,
      controlledEntityCount: context.actor_entity_ids.length,
      membershipRole: context.membership_role,
      policyActionCode: input.policyActionCode,
      policyResourceType: input.policyResourceType ?? input.resourceType,
      resourceKey: input.resourceKey,
      tick: context.current_tick,
    };
    if (!coarse.allowed) {
      return {
        actor,
        authorization: {
          actionCode: input.actionCode,
          allowed: false,
          context: baseContext,
          reasonCode: coarse.reasonCode,
          resourceId: input.resourceId,
          resourceType: input.resourceType,
          ruleId: coarse.ruleId,
          ...(membershipSource ? { sources: [membershipSource] } : {}),
        },
        hiddenByAuthority: coarse.reasonCode === 'WORLD_NOT_VISIBLE',
      };
    }
    if (input.actorMode === 'in_world' && actorEntityId === null) {
      return {
        actor,
        authorization: {
          actionCode: input.actionCode,
          allowed: false,
          context: baseContext,
          reasonCode:
            context.actor_entity_ids.length > 1
              ? 'ACTOR_ENTITY_AMBIGUOUS'
              : 'ACTOR_ENTITY_REQUIRED',
          resourceId: input.resourceId,
          resourceType: input.resourceType,
          ruleId: 'governance.actor_entity.fail_closed',
          ...(membershipSource ? { sources: [membershipSource] } : {}),
        },
        hiddenByAuthority: false,
      };
    }

    const needsCompiledPolicy =
      input.actorMode === 'in_world' && (input.allowActiveLaw || input.policyActionCode !== null);
    if (!needsCompiledPolicy) {
      return {
        actor,
        authorization: {
          actionCode: input.actionCode,
          allowed: true,
          context: baseContext,
          reasonCode: 'ALLOWED',
          resourceId: input.resourceId,
          resourceType: input.resourceType,
          ruleId: coarse.ruleId,
          ...(membershipSource ? { sources: [membershipSource] } : {}),
        },
        hiddenByAuthority: false,
      };
    }

    const [heldOffices, organizationMemberships] = await Promise.all([
      this.heldOffices(input.worldId, actorEntityId!, context.current_tick),
      this.organizationMemberships(input.worldId, actorEntityId!, context.active_world_version_id),
    ]);
    if (heldOffices.length > 64 || organizationMemberships.length > 64) {
      return {
        actor,
        authorization: {
          actionCode: input.actionCode,
          allowed: false,
          context: { ...baseContext, organizationMembershipCount: organizationMemberships.length },
          reasonCode: 'POLICY_CONTEXT_INVALID',
          resourceId: input.resourceId,
          resourceType: input.resourceType,
          ruleId: 'governance.compiled_policy.default_deny',
          ...(membershipSource ? { sources: [membershipSource] } : {}),
        },
        hiddenByAuthority: false,
      };
    }
    const policies = await this.policies(
      input,
      actorEntityId!,
      context.current_tick,
      context.active_world_version_id,
    );
    const membershipRoles = context.membership_role ? [context.membership_role] : [];
    const heldOfficeKeys = [...new Set(heldOffices.map((row) => row.office_key))].sort();
    const organizationKeys = [
      ...new Set(organizationMemberships.map((row) => row.organization_key)),
    ].sort();
    const organizationMembershipIds = new Set(
      organizationMemberships.map((row) => row.relationship_id),
    );
    let allowedPolicy: PolicyRow | undefined;
    const allowedPolicies = new Set<PolicyRow>();
    let policyFailure = 'POLICY_NOT_SATISFIED';
    for (const policy of policies) {
      if (
        (policy.authority_kind === 'direct_office' &&
          (!policy.office_term_id || !policy.office_term_number || !policy.office_term_checksum)) ||
        (policy.authority_kind === 'delegated_organization' &&
          (!policy.delegation_id ||
            !policy.delegation_checksum ||
            !policy.office_term_id ||
            !policy.office_term_number ||
            !policy.office_term_checksum ||
            !policy.organization_membership_id ||
            !organizationMembershipIds.has(policy.organization_membership_id)))
      ) {
        policyFailure = 'POLICY_CONTEXT_INVALID';
        continue;
      }
      const decision = evaluateGovernancePolicyV1(policy.policy, {
        action:
          policy.source_kind === 'law'
            ? input.actionCode
            : (input.policyActionCode ?? input.actionCode),
        actorMode: input.actorMode,
        heldOfficeKeys,
        membershipRoles,
        organizationKeys,
        resourceKey: input.resourceKey,
        resourceType: input.policyResourceType ?? input.resourceType,
        tick: context.current_tick,
      });
      if (decision.allowed) {
        allowedPolicy ??= policy;
        allowedPolicies.add(policy);
        continue;
      }
      if (decision.reasonCode !== 'POLICY_NOT_SATISFIED') policyFailure = decision.reasonCode;
    }
    const sources = authoritySources(
      membershipSource,
      heldOffices,
      organizationMemberships,
      policies,
      allowedPolicies,
      allowedPolicy,
    );
    return {
      actor,
      authorization: {
        actionCode: input.actionCode,
        allowed: allowedPolicy !== undefined,
        context: {
          ...baseContext,
          heldOfficeKeys,
          organizationKeys,
          policySourceCount: policies.length,
        },
        reasonCode: allowedPolicy ? 'POLICY_ALLOWED' : policyFailure,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        ruleId: allowedPolicy
          ? `governance.compiled.${allowedPolicy.source_kind}`
          : 'governance.compiled_policy.default_deny',
        ...(sources.length > 0 ? { sources } : {}),
      },
      hiddenByAuthority: false,
    };
  }

  private async heldOffices(
    worldId: string,
    actorEntityId: string,
    tick: string,
  ): Promise<HeldOfficeRow[]> {
    const result = await this.pool.query<HeldOfficeRow>(
      `/* governance:api:held-offices */
       select office.stable_key::text as office_key,term.id::text as term_id,
              term.term_number::text,term.checksum as term_checksum,
              lower(authority.effective_ticks)::text as effective_from_tick,
              upper(authority.effective_ticks)::text as effective_until_tick
         from office_seat_authority_intervals authority
         join office_terms term on term.world_id=authority.world_id
          and term.id=authority.term_id
         join political_offices office on office.world_id=authority.world_id
          and office.id=authority.office_id
        where authority.world_id=$1 and authority.holder_entity_id=$2
          and authority.effective_ticks @> $3::bigint
        order by office.stable_key::text collate "C",term.id
        limit 65`,
      [worldId, actorEntityId, tick],
    );
    return result.rows;
  }

  private async organizationMemberships(
    worldId: string,
    actorEntityId: string,
    activeWorldVersionId: string,
  ): Promise<OrganizationMembershipRow[]> {
    const result = await this.pool.query<OrganizationMembershipRow>(
      `/* governance:api:organization-memberships */
       select runtime.world_id::text,runtime.active_world_version_id::text,
              relationship.id::text as relationship_id,
              relationship.logical_key::text as relationship_key,
              relationship.source_entity_id::text,
              relationship.relationship_schema_version,
              relationship.attributes,
              relationship.created_world_version_id::text,
              relationship.row_version::text as relationship_row_version,
              organization.id::text as organization_entity_id,
              organization.logical_key::text as organization_key
         from world_runtime_heads runtime
         join world_relationships relationship
           on relationship.world_id=runtime.world_id
          and relationship.relationship_type='member_of'
          and relationship.source_entity_id=$2
          and relationship.retired_world_version_id is null
         join world_entities character
           on character.world_id=relationship.world_id
          and character.id=relationship.source_entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
         join world_entities organization
           on organization.world_id=relationship.world_id
          and organization.id=relationship.target_entity_id
          and organization.entity_type='organization'
          and organization.retired_world_version_id is null
        where runtime.world_id=$1 and runtime.active_world_version_id=$3
        order by organization.logical_key::text collate "C",relationship.id
        limit 65`,
      [worldId, actorEntityId, activeWorldVersionId],
    );
    return result.rows;
  }

  private async policies(
    input: GovernanceAuthorityPreparationInput,
    actorEntityId: string,
    tick: string,
    activeWorldVersionId: string,
  ): Promise<PolicyRow[]> {
    const promises: Array<Promise<{ rows: PolicyRow[] }>> = [];
    if (input.allowActiveLaw) {
      promises.push(
        this.pool.query<PolicyRow>(
          `/* governance:api:law-policies */
           select 'law'::text as source_kind,version.id::text as source_id,
                  version.law_version::text as source_version,
                  version.checksum as source_checksum,version.policy_ast as policy,
                  lower(authority.effective_ticks)::text as effective_from_tick,
                  upper(authority.effective_ticks)::text as effective_until_tick
             from law_authority_intervals authority
             join law_versions version on version.world_id=authority.world_id
              and version.id=authority.law_version_id
            where authority.world_id=$1 and authority.effective_ticks @> $2::bigint
            order by version.id`,
          [input.worldId, tick],
        ),
      );
    }
    if (input.policyActionCode) {
      promises.push(
        this.pool.query<PolicyRow>(
          `/* governance:api:institution-policies */
           select 'institution_power'::text as source_kind,power.id::text as source_id,
                  charter.charter_version::text as source_version,
                  power.checksum as source_checksum,power.scope_policy as policy,
                  lower(authority.effective_ticks)::text as effective_from_tick,
                  upper(authority.effective_ticks)::text as effective_until_tick
             from institution_powers power
             join institutions institution on institution.world_id=power.world_id
              and institution.id=power.institution_id and institution.status='active'
             join governing_charter_versions charter on charter.world_id=power.world_id
              and charter.id=power.charter_version_id
            join charter_authority_intervals authority on authority.world_id=power.world_id
              and authority.charter_version_id=power.charter_version_id
            where power.world_id=$1 and power.action_code=$2 and power.resource_type=$3
              and (
                ($5::text='institution' and institution.id::text=$6::text)
                or ($5::text='office' and exists (
                  select 1 from political_offices target_office
                   where target_office.world_id=power.world_id
                     and target_office.id::text=$6::text
                     and target_office.institution_id=power.institution_id
                ))
                or ($5::text='office_term' and exists (
                  select 1
                    from office_terms target_term
                    join political_offices target_office
                      on target_office.world_id=target_term.world_id
                     and target_office.id=target_term.office_id
                   where target_term.world_id=power.world_id
                     and target_term.id::text=$6::text
                     and target_office.institution_id=power.institution_id
                ))
              )
              and authority.effective_ticks @> $4::bigint
            order by power.id`,
          [
            input.worldId,
            input.policyActionCode,
            input.policyResourceType ?? input.resourceType,
            tick,
            input.resourceType,
            input.resourceId,
          ],
        ),
      );
      promises.push(
        this.pool.query<PolicyRow>(
          `/* governance:api:office-policies */
           select 'office_power'::text as source_kind,power.id::text as source_id,
                  charter.charter_version::text as source_version,
                  power.checksum as source_checksum,power.scope_policy as policy,
                  lower(seat_authority.effective_ticks)::text as effective_from_tick,
                  upper(seat_authority.effective_ticks)::text as effective_until_tick,
                  'direct_office'::text as authority_kind,
                  null::text as delegation_id,null::bytea as delegation_checksum,
                  null::text as organization_membership_id,
                  term.id::text as office_term_id,
                  term.term_number::text as office_term_number,
                  term.checksum as office_term_checksum
             from office_powers power
             join governing_charter_versions charter on charter.world_id=power.world_id
              and charter.id=power.charter_version_id
             join charter_authority_intervals charter_authority
              on charter_authority.world_id=power.world_id
              and charter_authority.charter_version_id=power.charter_version_id
             join office_seat_authority_intervals seat_authority
              on seat_authority.world_id=power.world_id and seat_authority.office_id=power.office_id
              and seat_authority.holder_entity_id=$4
             join office_terms term on term.world_id=seat_authority.world_id
              and term.id=seat_authority.term_id
            where power.world_id=$1 and power.action_code=$2 and power.resource_type=$3
              and charter_authority.effective_ticks @> $5::bigint
              and seat_authority.effective_ticks @> $5::bigint
              and (
                ($6::text='office' and power.office_id::text=$7::text)
                or ($6::text='office_term' and exists (
                  select 1 from office_terms target_term
                   where target_term.world_id=power.world_id
                     and target_term.id::text=$7::text
                     and target_term.office_id=power.office_id
                ))
              )
            order by power.id,term.id`,
          [
            input.worldId,
            input.policyActionCode,
            input.policyResourceType ?? input.resourceType,
            actorEntityId,
            tick,
            input.resourceType,
            input.resourceId,
          ],
        ),
      );
      promises.push(
        this.pool.query<PolicyRow>(
          `/* governance:api:delegated-office-policies */
           select 'office_power'::text as source_kind,power.id::text as source_id,
                  charter.charter_version::text as source_version,
                  power.checksum as source_checksum,power.scope_policy as policy,
                  lower(active_term.effective_ticks)::text as effective_from_tick,
                  upper(active_term.effective_ticks)::text as effective_until_tick,
                  'delegated_organization'::text as authority_kind,
                  delegation.id::text as delegation_id,
                  delegation.checksum as delegation_checksum,
                  membership.id::text as organization_membership_id,
                  active_term.term_id::text as office_term_id,
                  active_term.term_number::text as office_term_number,
                  active_term.term_checksum as office_term_checksum
             from office_power_delegations delegation
             join office_powers power on power.world_id=delegation.world_id
              and power.id=delegation.office_power_id
              and power.charter_version_id=delegation.charter_version_id
             join governing_charter_versions charter on charter.world_id=power.world_id
              and charter.id=power.charter_version_id
             join charter_authority_intervals charter_authority
              on charter_authority.world_id=power.world_id
              and charter_authority.charter_version_id=power.charter_version_id
             join world_runtime_heads runtime on runtime.world_id=power.world_id
             join world_relationships membership on membership.world_id=power.world_id
              and membership.relationship_type='member_of'
              and membership.source_entity_id=$4
              and membership.target_entity_id=delegation.grantee_organization_entity_id
              and membership.retired_world_version_id is null
             join world_entities character on character.world_id=membership.world_id
              and character.id=membership.source_entity_id
              and character.entity_type='player_character'
              and character.retired_world_version_id is null
             join world_entities organization on organization.world_id=membership.world_id
              and organization.id=membership.target_entity_id
              and organization.entity_type='organization'
              and organization.retired_world_version_id is null
             join lateral (
               select authority.effective_ticks,term.id as term_id,
                      term.term_number,term.checksum as term_checksum
                 from office_seat_authority_intervals authority
                 join office_terms term on term.world_id=authority.world_id
                  and term.id=authority.term_id
                where authority.world_id=power.world_id
                  and authority.office_id=power.office_id
                  and authority.effective_ticks @> $5::bigint
                order by authority.seat_id,term.id
                limit 1
             ) active_term on true
            where power.world_id=$1 and power.action_code=$2 and power.resource_type=$3
              and runtime.active_world_version_id=$6
              and charter_authority.effective_ticks @> $5::bigint
              and (
                ($7::text='office' and power.office_id::text=$8::text)
                or ($7::text='office_term' and exists (
                  select 1 from office_terms target_term
                   where target_term.world_id=power.world_id
                     and target_term.id::text=$8::text
                     and target_term.office_id=power.office_id
                ))
              )
            order by power.id,delegation.id,membership.id`,
          [
            input.worldId,
            input.policyActionCode,
            input.policyResourceType ?? input.resourceType,
            actorEntityId,
            tick,
            activeWorldVersionId,
            input.resourceType,
            input.resourceId,
          ],
        ),
      );
    }
    const results = await Promise.all(promises);
    return results
      .flatMap((result) => result.rows)
      .sort((left, right) =>
        `${left.source_kind}:${left.source_id}`.localeCompare(
          `${right.source_kind}:${right.source_id}`,
        ),
      );
  }
}

function membershipAuthoritySource(
  input: GovernanceAuthorityPreparationInput,
  context: AuthorityContextRow,
): GovernanceAuthoritySourceEvidence | null {
  if (!context.membership_role || !context.membership_row_version) return null;
  return {
    contribution: 'context',
    sourceChecksum: checksum({
      role: context.membership_role,
      rowVersion: context.membership_row_version,
      status: context.membership_status,
      userId: input.actorId,
      worldId: input.worldId,
    }),
    sourceId: input.actorId,
    sourceKind: 'membership_role',
    sourceVersion: context.membership_row_version,
  };
}

function authoritySources(
  membership: GovernanceAuthoritySourceEvidence | null,
  heldOffices: readonly HeldOfficeRow[],
  organizationMemberships: readonly OrganizationMembershipRow[],
  policies: readonly PolicyRow[],
  allowedPolicies: ReadonlySet<PolicyRow>,
  allowedPolicy: PolicyRow | undefined,
): GovernanceAuthoritySourceEvidence[] {
  const sources: GovernanceAuthoritySourceEvidence[] = [];
  const seen = new Set<string>();
  const add = (source: GovernanceAuthoritySourceEvidence): void => {
    const key = `${source.sourceKind}:${source.sourceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };
  if (membership) add(membership);
  for (const organizationMembership of organizationMemberships) {
    add(organizationMembershipAuthoritySource(organizationMembership));
  }
  for (const office of heldOffices.slice(0, 64)) {
    add({
      contribution: 'context',
      effectiveFromTick: office.effective_from_tick,
      effectiveUntilTick: office.effective_until_tick,
      sourceChecksum: office.term_checksum.toString('hex'),
      sourceId: office.term_id,
      sourceKind: 'office_term',
      sourceVersion: office.term_number,
    });
  }
  for (const policy of policies.slice(0, 24)) {
    add({
      contribution: allowedPolicies.has(policy) ? 'allow' : 'deny',
      effectiveFromTick: policy.effective_from_tick,
      effectiveUntilTick: policy.effective_until_tick,
      sourceChecksum: policy.source_checksum.toString('hex'),
      sourceId: policy.source_id,
      sourceKind: policy.source_kind,
      sourceVersion: policy.source_version,
    });
  }
  if (allowedPolicy && !policies.slice(0, 24).includes(allowedPolicy)) {
    add({
      contribution: 'allow',
      effectiveFromTick: allowedPolicy.effective_from_tick,
      effectiveUntilTick: allowedPolicy.effective_until_tick,
      sourceChecksum: allowedPolicy.source_checksum.toString('hex'),
      sourceId: allowedPolicy.source_id,
      sourceKind: allowedPolicy.source_kind,
      sourceVersion: allowedPolicy.source_version,
    });
  }
  if (
    allowedPolicy?.source_kind === 'office_power' &&
    allowedPolicy.office_term_id &&
    allowedPolicy.office_term_number &&
    allowedPolicy.office_term_checksum
  ) {
    add({
      contribution: 'context',
      effectiveFromTick: allowedPolicy.effective_from_tick,
      effectiveUntilTick: allowedPolicy.effective_until_tick,
      sourceChecksum: allowedPolicy.office_term_checksum.toString('hex'),
      sourceId: allowedPolicy.office_term_id,
      sourceKind: 'office_term',
      sourceVersion: allowedPolicy.office_term_number,
    });
  }
  if (
    allowedPolicy?.authority_kind === 'delegated_organization' &&
    allowedPolicy.delegation_id &&
    allowedPolicy.delegation_checksum
  ) {
    add({
      contribution: 'allow',
      effectiveFromTick: allowedPolicy.effective_from_tick,
      effectiveUntilTick: allowedPolicy.effective_until_tick,
      sourceChecksum: allowedPolicy.delegation_checksum.toString('hex'),
      sourceId: allowedPolicy.delegation_id,
      sourceKind: 'delegation',
      sourceVersion: allowedPolicy.source_version,
    });
  }
  return sources.map((source) => ({ ...source }));
}

function organizationMembershipAuthoritySource(
  membership: OrganizationMembershipRow,
): GovernanceAuthoritySourceEvidence {
  return {
    contribution: 'context',
    sourceChecksum: checksum({
      activeWorldVersionId: membership.active_world_version_id,
      attributes: membership.attributes,
      createdWorldVersionId: membership.created_world_version_id,
      organizationEntityId: membership.organization_entity_id,
      organizationKey: membership.organization_key,
      relationshipId: membership.relationship_id,
      relationshipKey: membership.relationship_key,
      relationshipRowVersion: membership.relationship_row_version,
      relationshipSchemaVersion: membership.relationship_schema_version,
      relationshipType: 'member_of',
      sourceEntityId: membership.source_entity_id,
      worldId: membership.world_id,
    }),
    sourceId: membership.relationship_id,
    sourceKind: 'organization_membership',
    sourceVersion: (BigInt(membership.relationship_row_version) + 1n).toString(),
  };
}

function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function governanceSqlPool(pool: Pool): GovernanceSqlPool {
  return {
    connect: async () => {
      const client = await pool.connect();
      const adapter: GovernanceSqlClient = {
        on: (event, listener) => client.on(event, listener),
        query: async <TRow = Record<string, unknown>>(
          query: string,
          values?: readonly unknown[],
        ) => {
          const result = await client.query(query, values ? [...values] : []);
          return { rowCount: result.rowCount, rows: result.rows as TRow[] };
        },
        release: (error) => client.release(error),
        removeListener: (event, listener) => client.removeListener(event, listener),
      };
      return adapter;
    },
  };
}

export function governanceExecutionInput(
  command: PublicGovernanceCommandRequestV1,
  preparation: GovernanceAuthorityPreparation,
  input: {
    correlationId: string;
    recentCredential?: GovernanceRecentCredentialProof;
    worldId: string;
  },
): PublicGovernanceCommandExecutionInput {
  return {
    actor: preparation.actor,
    authorization: preparation.authorization,
    causationId: null,
    command,
    correlationId: input.correlationId,
    ...(input.recentCredential ? { recentCredential: input.recentCredential } : {}),
    worldId: input.worldId,
  };
}
