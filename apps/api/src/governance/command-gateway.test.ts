import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresGovernanceCommandGateway } from './command-gateway.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const entityId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const institutionId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const sourceId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const activeWorldVersionId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const officeId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const officeTermId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const organizationId = '018f8652-3cb6-7d52-904b-cce7901d7e29';
const relationshipId = '018f8652-3cb6-7d52-904b-cce7901d7e30';
const delegationId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
const otherOfficeId = '018f8652-3cb6-7d52-904b-cce7901d7e32';
const otherOfficeTermId = '018f8652-3cb6-7d52-904b-cce7901d7e33';

describe('PostgresGovernanceCommandGateway authority preparation', () => {
  it('combines coarse membership with the compiled institution policy and records sources', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('governance:api:authority-context')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            actor_entity_ids: [entityId],
            current_tick: '12',
            membership_role: 'player',
            membership_row_version: '2',
            membership_status: 'active',
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:held-offices')) return result([]);
      if (sql.includes('governance:api:organization-memberships')) return result([]);
      if (sql.includes('governance:api:institution-policies')) {
        return result([
          {
            effective_from_tick: '0',
            effective_until_tick: null,
            policy: { kind: 'membership_role', role: 'player' },
            source_checksum: Buffer.alloc(32, 7),
            source_id: sourceId,
            source_kind: 'institution_power',
            source_version: '1',
          },
        ]);
      }
      if (sql.includes('governance:api:office-policies')) return result([]);
      if (sql.includes('governance:api:delegated-office-policies')) return result([]);
      throw new Error(`Unexpected authority query: ${sql}`);
    });
    const gateway = gatewayWith(query);

    const prepared = await gateway.prepareAuthority({
      actionCode: 'governance.proposal.create',
      actorId,
      actorMode: 'in_world',
      allowActiveLaw: false,
      overrideRequested: false,
      platformRole: 'user',
      policyActionCode: 'governance.propose',
      policyResourceType: 'proposal',
      resourceId: institutionId,
      resourceKey: 'proposal:transit-one',
      resourceType: 'institution',
      worldId,
    });

    expect(prepared).toMatchObject({
      actor: { actorEntityId: entityId, actorId, actorType: 'user' },
      authorization: {
        actionCode: 'governance.proposal.create',
        allowed: true,
        reasonCode: 'POLICY_ALLOWED',
        ruleId: 'governance.compiled.institution_power',
      },
      hiddenByAuthority: false,
    });
    expect(prepared?.authorization.sources).toEqual([
      expect.objectContaining({ sourceKind: 'membership_role', sourceVersion: '2' }),
      expect.objectContaining({
        contribution: 'allow',
        sourceId,
        sourceKind: 'institution_power',
      }),
    ]);
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /secret_ballot_choices|ballot_choice_revisions|ballot_effective_revisions/u,
    );
    expect(query.mock.calls[0]?.[0]).toContain("controller.control_scope='primary'");
    expect(query.mock.calls[0]?.[0]).toContain("entity.entity_type='player_character'");
  });

  it('fails closed before policy lookup when a user controls zero or multiple actors', async () => {
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('governance:api:authority-context')) {
        throw new Error('Compiled policy lookup must not run for an ambiguous actor.');
      }
      return result([
        {
          active_world_version_id: activeWorldVersionId,
          actor_entity_ids: [entityId, sourceId],
          current_tick: '12',
          membership_role: 'player',
          membership_row_version: '1',
          membership_status: 'active',
          world_id: worldId,
        },
      ]);
    });

    const prepared = await gatewayWith(query).prepareAuthority({
      actionCode: 'governance.ballot.cast',
      actorId,
      actorMode: 'in_world',
      allowActiveLaw: true,
      overrideRequested: false,
      platformRole: 'user',
      policyActionCode: null,
      resourceId: institutionId,
      resourceKey: null,
      resourceType: 'proposal',
      worldId,
    });

    expect(prepared).toMatchObject({
      actor: { actorEntityId: null },
      authorization: {
        allowed: false,
        reasonCode: 'ACTOR_ENTITY_AMBIGUOUS',
        ruleId: 'governance.actor_entity.fail_closed',
      },
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('keeps explicit platform administration distinct from civic actor mode', async () => {
    const query = vi.fn(async () =>
      result([
        {
          active_world_version_id: activeWorldVersionId,
          actor_entity_ids: [],
          current_tick: '0',
          membership_role: null,
          membership_row_version: null,
          membership_status: null,
          world_id: worldId,
        },
      ]),
    );

    const prepared = await gatewayWith(query).prepareAuthority({
      actionCode: 'governance.initialize',
      actorId,
      actorMode: 'administrator',
      allowActiveLaw: false,
      overrideRequested: false,
      platformRole: 'platform_admin',
      policyActionCode: null,
      resourceId: worldId,
      resourceKey: null,
      resourceType: 'world_governance',
      worldId,
    });

    expect(prepared).toMatchObject({
      actor: { actorEntityId: null, actorId, actorType: 'platform_admin' },
      authorization: {
        allowed: true,
        reasonCode: 'ALLOWED',
        ruleId: 'governance.platform_administrator_initialize',
      },
    });
  });

  it('evaluates a platform administrator using their character for in-world civic mode', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('governance:api:authority-context')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            actor_entity_ids: [entityId],
            current_tick: '12',
            membership_role: 'player',
            membership_row_version: '2',
            membership_status: 'active',
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:held-offices')) return result([]);
      if (sql.includes('governance:api:organization-memberships')) return result([]);
      if (sql.includes('governance:api:law-policies')) {
        return result([
          {
            effective_from_tick: '0',
            effective_until_tick: null,
            policy: { kind: 'membership_role', role: 'player' },
            source_checksum: Buffer.alloc(32, 8),
            source_id: sourceId,
            source_kind: 'law',
            source_version: '1',
          },
        ]);
      }
      throw new Error(`Unexpected authority query: ${sql}`);
    });

    const prepared = await gatewayWith(query).prepareAuthority({
      actionCode: 'governance.ballot.cast',
      actorId,
      actorMode: 'in_world',
      allowActiveLaw: true,
      overrideRequested: false,
      platformRole: 'platform_admin',
      policyActionCode: null,
      resourceId: institutionId,
      resourceKey: null,
      resourceType: 'proposal',
      worldId,
    });

    expect(prepared).toMatchObject({
      actor: { actorEntityId: entityId, actorId, actorType: 'user' },
      authorization: { allowed: true, reasonCode: 'POLICY_ALLOWED' },
    });
  });

  it('retains an allowing policy beyond the bounded diagnostic source prefix', async () => {
    const policies = Array.from({ length: 25 }, (_, index) => ({
      effective_from_tick: '0',
      effective_until_tick: null,
      policy:
        index === 24
          ? { kind: 'membership_role', role: 'player' }
          : { kind: 'actor_mode', mode: 'creator' },
      source_checksum: Buffer.alloc(32, index + 1),
      source_id: `018f8652-3cb6-7d52-904b-${(100 + index).toString(16).padStart(12, '0')}`,
      source_kind: 'institution_power',
      source_version: '1',
    }));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('governance:api:authority-context')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            actor_entity_ids: [entityId],
            current_tick: '12',
            membership_role: 'player',
            membership_row_version: '2',
            membership_status: 'active',
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:held-offices')) return result([]);
      if (sql.includes('governance:api:organization-memberships')) return result([]);
      if (sql.includes('governance:api:institution-policies')) return result(policies);
      if (sql.includes('governance:api:office-policies')) return result([]);
      if (sql.includes('governance:api:delegated-office-policies')) return result([]);
      throw new Error(`Unexpected authority query: ${sql}`);
    });

    const prepared = await gatewayWith(query).prepareAuthority({
      actionCode: 'governance.proposal.create',
      actorId,
      actorMode: 'in_world',
      allowActiveLaw: false,
      overrideRequested: false,
      platformRole: 'user',
      policyActionCode: 'governance.propose',
      policyResourceType: 'proposal',
      resourceId: institutionId,
      resourceKey: 'proposal:bounded-source-proof',
      resourceType: 'institution',
      worldId,
    });

    expect(prepared?.authorization.allowed).toBe(true);
    expect(prepared?.authorization.sources).toContainEqual(
      expect.objectContaining({
        contribution: 'allow',
        sourceId: policies[24]!.source_id,
        sourceKind: 'institution_power',
      }),
    );
  });

  it('binds institution authority to its exact target office or office term', async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('governance:api:authority-context')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            actor_entity_ids: [entityId],
            current_tick: '12',
            membership_role: 'player',
            membership_row_version: '2',
            membership_status: 'active',
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:held-offices')) return result([]);
      if (sql.includes('governance:api:organization-memberships')) return result([]);
      if (sql.includes('governance:api:institution-policies')) {
        const exactOffice = values?.[4] === 'office' && values?.[5] === officeId;
        const exactTerm = values?.[4] === 'office_term' && values?.[5] === officeTermId;
        if (!exactOffice && !exactTerm) return result([]);
        return result([
          {
            effective_from_tick: '0',
            effective_until_tick: null,
            policy: { kind: 'membership_role', role: 'player' },
            source_checksum: Buffer.alloc(32, 9),
            source_id: sourceId,
            source_kind: 'institution_power',
            source_version: '1',
          },
        ]);
      }
      if (sql.includes('governance:api:office-policies')) return result([]);
      if (sql.includes('governance:api:delegated-office-policies')) return result([]);
      throw new Error(`Unexpected authority query: ${sql}`);
    });
    const gateway = gatewayWith(query);
    const base = {
      actionCode: 'governance.office.appoint' as const,
      actorId,
      actorMode: 'in_world' as const,
      allowActiveLaw: false,
      overrideRequested: false,
      platformRole: 'user' as const,
      policyActionCode: 'governance.appoint',
      policyResourceType: 'office',
      resourceKey: null,
      worldId,
    };

    await expect(
      gateway.prepareAuthority({ ...base, resourceId: officeId, resourceType: 'office' }),
    ).resolves.toMatchObject({ authorization: { allowed: true } });
    await expect(
      gateway.prepareAuthority({
        ...base,
        resourceId: officeTermId,
        resourceType: 'office_term',
      }),
    ).resolves.toMatchObject({ authorization: { allowed: true } });
    await expect(
      gateway.prepareAuthority({
        ...base,
        resourceId: otherOfficeId,
        resourceType: 'office',
      }),
    ).resolves.toMatchObject({ authorization: { allowed: false } });
    await expect(
      gateway.prepareAuthority({
        ...base,
        resourceId: otherOfficeTermId,
        resourceType: 'office_term',
      }),
    ).resolves.toMatchObject({ authorization: { allowed: false } });

    const institutionSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('governance:api:institution-policies'));
    expect(institutionSql).toContain("$5::text='office'");
    expect(institutionSql).toContain('target_office.institution_id=power.institution_id');
    expect(institutionSql).toContain("$5::text='office_term'");
    expect(institutionSql).toContain('target_office.id=target_term.office_id');
  });

  it('binds direct office authority to the exact office or target term', async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('governance:api:authority-context')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            actor_entity_ids: [entityId],
            current_tick: '12',
            membership_role: 'player',
            membership_row_version: '2',
            membership_status: 'active',
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:held-offices')) {
        return result([
          {
            effective_from_tick: '0',
            effective_until_tick: null,
            office_key: 'office:guild-council:treasurer',
            term_checksum: Buffer.alloc(32, 4),
            term_id: officeTermId,
            term_number: '1',
          },
        ]);
      }
      if (sql.includes('governance:api:organization-memberships')) return result([]);
      if (sql.includes('governance:api:institution-policies')) return result([]);
      if (sql.includes('governance:api:delegated-office-policies')) return result([]);
      if (sql.includes('governance:api:office-policies')) {
        const exactOffice = values?.[5] === 'office' && values?.[6] === officeId;
        const exactTerm = values?.[5] === 'office_term' && values?.[6] === officeTermId;
        if (!exactOffice && !exactTerm) return result([]);
        return result([
          {
            authority_kind: 'direct_office',
            delegation_checksum: null,
            delegation_id: null,
            effective_from_tick: '0',
            effective_until_tick: null,
            office_term_checksum: Buffer.alloc(32, 4),
            office_term_id: officeTermId,
            office_term_number: '1',
            organization_membership_id: null,
            policy: { kind: 'membership_role', role: 'player' },
            source_checksum: Buffer.alloc(32, 5),
            source_id: sourceId,
            source_kind: 'office_power',
            source_version: '1',
          },
        ]);
      }
      throw new Error(`Unexpected authority query: ${sql}`);
    });
    const gateway = gatewayWith(query);
    const base = {
      actionCode: 'governance.office.appoint' as const,
      actorId,
      actorMode: 'in_world' as const,
      allowActiveLaw: false,
      overrideRequested: false,
      platformRole: 'user' as const,
      policyActionCode: 'governance.appoint',
      policyResourceType: 'office',
      resourceKey: null,
      worldId,
    };

    await expect(
      gateway.prepareAuthority({ ...base, resourceId: officeId, resourceType: 'office' }),
    ).resolves.toMatchObject({ authorization: { allowed: true } });
    await expect(
      gateway.prepareAuthority({
        ...base,
        resourceId: officeTermId,
        resourceType: 'office_term',
      }),
    ).resolves.toMatchObject({ authorization: { allowed: true } });
    await expect(
      gateway.prepareAuthority({
        ...base,
        resourceId: institutionId,
        resourceType: 'office',
      }),
    ).resolves.toMatchObject({ authorization: { allowed: false } });
    const officeSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('governance:api:office-policies'));
    expect(officeSql).toContain("$6::text='office_term'");
    expect(officeSql).toContain('target_term.office_id=power.office_id');
  });

  it('records exact organization, delegation, and active-term evidence for delegated power', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('governance:api:authority-context')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            actor_entity_ids: [entityId],
            current_tick: '12',
            membership_role: 'player',
            membership_row_version: '2',
            membership_status: 'active',
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:held-offices')) return result([]);
      if (sql.includes('governance:api:organization-memberships')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            attributes: {},
            created_world_version_id: activeWorldVersionId,
            organization_entity_id: organizationId,
            organization_key: 'organization:artisan-guild',
            relationship_id: relationshipId,
            relationship_key: 'relationship:artisan-member',
            relationship_row_version: '0',
            relationship_schema_version: 1,
            source_entity_id: entityId,
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:institution-policies')) return result([]);
      if (sql.includes('governance:api:office-policies')) return result([]);
      if (sql.includes('governance:api:delegated-office-policies')) {
        return result([
          {
            authority_kind: 'delegated_organization',
            delegation_checksum: Buffer.alloc(32, 6),
            delegation_id: delegationId,
            effective_from_tick: '0',
            effective_until_tick: null,
            office_term_checksum: Buffer.alloc(32, 7),
            office_term_id: officeTermId,
            office_term_number: '1',
            organization_membership_id: relationshipId,
            policy: {
              kind: 'member_of_organization',
              organizationKey: 'organization:artisan-guild',
            },
            source_checksum: Buffer.alloc(32, 8),
            source_id: sourceId,
            source_kind: 'office_power',
            source_version: '1',
          },
        ]);
      }
      throw new Error(`Unexpected authority query: ${sql}`);
    });

    const prepared = await gatewayWith(query).prepareAuthority({
      actionCode: 'governance.office.appoint',
      actorId,
      actorMode: 'in_world',
      allowActiveLaw: false,
      overrideRequested: false,
      platformRole: 'user',
      policyActionCode: 'governance.appoint',
      policyResourceType: 'office',
      resourceId: officeId,
      resourceKey: null,
      resourceType: 'office',
      worldId,
    });

    expect(prepared?.authorization.allowed).toBe(true);
    expect(prepared?.authorization.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: relationshipId,
          sourceKind: 'organization_membership',
        }),
        expect.objectContaining({ sourceId: officeTermId, sourceKind: 'office_term' }),
        expect.objectContaining({ sourceId: delegationId, sourceKind: 'delegation' }),
      ]),
    );
  });

  it('applies active-law authority on the half-open world-tick boundary', async () => {
    const prepareAt = async (tick: string) => {
      const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes('governance:api:authority-context')) {
          return result([
            {
              active_world_version_id: activeWorldVersionId,
              actor_entity_ids: [entityId],
              current_tick: tick,
              membership_role: 'player',
              membership_row_version: '2',
              membership_status: 'active',
              world_id: worldId,
            },
          ]);
        }
        if (sql.includes('governance:api:held-offices')) return result([]);
        if (sql.includes('governance:api:organization-memberships')) return result([]);
        if (sql.includes('governance:api:law-policies')) {
          expect(values).toEqual([worldId, tick]);
          const active = BigInt(tick) >= 10n && BigInt(tick) < 20n;
          return result(
            active
              ? [
                  {
                    effective_from_tick: '10',
                    effective_until_tick: '20',
                    policy: { kind: 'membership_role', role: 'player' },
                    source_checksum: Buffer.alloc(32, 10),
                    source_id: sourceId,
                    source_kind: 'law',
                    source_version: '1',
                  },
                ]
              : [],
          );
        }
        throw new Error(`Unexpected authority query: ${sql}`);
      });
      const prepared = await gatewayWith(query).prepareAuthority({
        actionCode: 'governance.ballot.cast',
        actorId,
        actorMode: 'in_world',
        allowActiveLaw: true,
        overrideRequested: false,
        platformRole: 'user',
        policyActionCode: null,
        resourceId: institutionId,
        resourceKey: null,
        resourceType: 'proposal',
        worldId,
      });
      const policySql = query.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes('governance:api:law-policies'));
      expect(policySql).toContain('authority.effective_ticks @> $2::bigint');
      return prepared;
    };

    await expect(prepareAt('9')).resolves.toMatchObject({ authorization: { allowed: false } });
    await expect(prepareAt('10')).resolves.toMatchObject({ authorization: { allowed: true } });
    await expect(prepareAt('19')).resolves.toMatchObject({ authorization: { allowed: true } });
    await expect(prepareAt('20')).resolves.toMatchObject({ authorization: { allowed: false } });
  });

  it('denies silent creator civic bypass while allowing the dedicated explicit override mode', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('governance:api:authority-context')) {
        return result([
          {
            active_world_version_id: activeWorldVersionId,
            actor_entity_ids: [entityId],
            current_tick: '12',
            membership_role: 'creator',
            membership_row_version: '3',
            membership_status: 'active',
            world_id: worldId,
          },
        ]);
      }
      if (sql.includes('governance:api:held-offices')) return result([]);
      if (sql.includes('governance:api:organization-memberships')) return result([]);
      if (sql.includes('governance:api:institution-policies')) return result([]);
      if (sql.includes('governance:api:office-policies')) return result([]);
      if (sql.includes('governance:api:delegated-office-policies')) return result([]);
      throw new Error(`Unexpected authority query: ${sql}`);
    });
    const gateway = gatewayWith(query);

    await expect(
      gateway.prepareAuthority({
        actionCode: 'governance.office.appoint',
        actorId,
        actorMode: 'in_world',
        allowActiveLaw: false,
        overrideRequested: false,
        platformRole: 'user',
        policyActionCode: 'governance.appoint',
        policyResourceType: 'office',
        resourceId: officeId,
        resourceKey: null,
        resourceType: 'office',
        worldId,
      }),
    ).resolves.toMatchObject({
      actor: { actorEntityId: entityId, actorType: 'user' },
      authorization: {
        allowed: false,
        ruleId: 'governance.compiled_policy.default_deny',
      },
    });

    await expect(
      gateway.prepareAuthority({
        actionCode: 'governance.override.execute',
        actorId,
        actorMode: 'creator',
        allowActiveLaw: false,
        overrideRequested: true,
        platformRole: 'user',
        policyActionCode: null,
        resourceId: worldId,
        resourceKey: null,
        resourceType: 'governance_override',
        worldId,
      }),
    ).resolves.toMatchObject({
      actor: { actorEntityId: null, actorType: 'user' },
      authorization: {
        allowed: true,
        ruleId: 'governance.creator_explicit_override',
      },
    });
  });
});

function gatewayWith(query: ReturnType<typeof vi.fn>): PostgresGovernanceCommandGateway {
  return new PostgresGovernanceCommandGateway({ query } as unknown as Pool, {
    ids: { next: () => worldId },
  });
}

function result(rows: unknown[]) {
  return { command: '', fields: [], oid: 0, rowCount: rows.length, rows };
}
