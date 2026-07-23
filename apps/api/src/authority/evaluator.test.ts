import { describe, expect, it } from 'vitest';

import type { AuthorityAction, AuthoritySubject } from '@worldgraph/contracts';

import { evaluateAuthority } from './evaluator.js';

const world = { worldId: '018f8652-3cb6-7d52-904b-cce7901d7e25' };
const userId = '018f8652-3cb6-7d52-904b-cce7901d7e26';

function subject(membershipRole?: AuthoritySubject['membershipRole']): AuthoritySubject {
  return {
    ...(membershipRole ? { membershipRole, membershipStatus: 'active' as const } : {}),
    platformRole: 'user',
    userId,
  };
}

describe('deny-by-default authority evaluator', () => {
  it.each<[AuthoritySubject['membershipRole'], AuthorityAction, boolean]>([
    ['creator', 'membership.change_role', true],
    ['administrator', 'invitation.create', true],
    ['administrator', 'membership.remove', true],
    ['administrator', 'membership.change_role', false],
    ['player', 'world.rename', false],
    ['observer', 'world.read', true],
    [undefined, 'world.read', false],
  ])('%s / %s => %s', (role, action, allowed) => {
    expect(evaluateAuthority(subject(role), action, world).allowed).toBe(allowed);
  });

  it('requires an explicit path for creator overrides and ignores future role attributes', () => {
    expect(
      evaluateAuthority(subject('creator'), 'creator_override.use', world, {
        futureOfficeRoles: ['mayor'],
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAuthority(subject('creator'), 'creator_override.use', world, {
        overrideRequested: true,
      }),
    ).toMatchObject({ allowed: true, ruleId: 'world_role.creator_override' });
    expect(
      evaluateAuthority(subject(), 'world.rename', world, { futureOfficeRoles: ['mayor'] }).allowed,
    ).toBe(false);
  });

  it('distinguishes authenticated application policy from world membership policy', () => {
    expect(evaluateAuthority(subject(), 'world.create', world)).toMatchObject({
      allowed: true,
      ruleId: 'identity.active.create_world',
    });
    expect(evaluateAuthority(subject(), 'invitation.accept', world).allowed).toBe(false);
    expect(
      evaluateAuthority(subject(), 'invitation.accept', world, { invitationValidated: true }),
    ).toMatchObject({ allowed: true, ruleId: 'invitation.validated_email_and_token' });
  });

  it('treats registry reads as global and registry mutation as platform-admin-only', () => {
    expect(evaluateAuthority(subject(), 'primitive.catalog.read', {})).toMatchObject({
      allowed: true,
      ruleId: 'identity.active.primitive_registry_read',
    });
    expect(evaluateAuthority(subject(), 'primitive.retrieval.run', {}).allowed).toBe(true);
    expect(evaluateAuthority(subject('creator'), 'primitive.version.publish', {})).toMatchObject({
      allowed: false,
      reasonCode: 'PLATFORM_ADMIN_REQUIRED',
    });
    expect(
      evaluateAuthority(
        { ...subject(), platformRole: 'platform_admin' },
        'primitive.version.publish',
        {},
      ).allowed,
    ).toBe(true);
  });

  it('scopes manifest content to members and approval to the current creator', () => {
    expect(evaluateAuthority(subject('observer'), 'manifest.revision.read', world).allowed).toBe(
      true,
    );
    expect(
      evaluateAuthority(subject('administrator'), 'manifest.generation.start', world),
    ).toMatchObject({ allowed: true, ruleId: 'manifest.world_role.editor' });
    expect(
      evaluateAuthority(subject('administrator'), 'manifest.revision.approve', world),
    ).toMatchObject({ allowed: false, reasonCode: 'CREATOR_REQUIRED' });
    expect(evaluateAuthority(subject('creator'), 'manifest.revision.approve', world)).toMatchObject(
      {
        allowed: true,
        ruleId: 'manifest.creator_approval',
      },
    );
    expect(
      evaluateAuthority(
        { ...subject(), platformRole: 'platform_admin' },
        'manifest.revision.read',
        world,
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'WORLD_NOT_VISIBLE' });
  });

  it('scopes compiler commands to the creator and runtime graph reads to members', () => {
    expect(evaluateAuthority(subject('creator'), 'world.compilation.start', world)).toMatchObject({
      allowed: true,
      ruleId: 'compiler.creator_command',
    });
    expect(
      evaluateAuthority(subject('administrator'), 'world.compilation.retry', world),
    ).toMatchObject({ allowed: false, reasonCode: 'CREATOR_REQUIRED' });
    expect(evaluateAuthority(subject('observer'), 'world.runtime.read', world)).toMatchObject({
      allowed: true,
      ruleId: 'compiler.membership_read',
    });
    expect(
      evaluateAuthority(
        { ...subject(), platformRole: 'platform_admin' },
        'world.compilation.start',
        world,
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'WORLD_NOT_VISIBLE' });
  });

  it('scopes ledger/history reads to members and entity commands to creator or administrator', () => {
    const world = { worldId: '018f8652-3cb6-7d52-904b-cce7901d7e22' };

    expect(evaluateAuthority(subject('observer'), 'world.history.read', world)).toMatchObject({
      allowed: true,
      ruleId: 'ledger.membership_read',
    });
    expect(evaluateAuthority(subject('administrator'), 'world.entity.rename', world)).toMatchObject(
      { allowed: true, ruleId: 'ledger.world_role.authoritative_write' },
    );
    expect(evaluateAuthority(subject('player'), 'world.entity.rename', world)).toMatchObject({
      allowed: false,
      reasonCode: 'ACTION_NOT_PERMITTED',
    });
    expect(
      evaluateAuthority(
        { platformRole: 'platform_admin', userId: '018f8652-3cb6-7d52-904b-cce7901d7e21' },
        'world.entity.rename',
        world,
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'WORLD_NOT_VISIBLE' });
  });

  it('keeps manual clock control creator-only and scheduling administrator-capable', () => {
    expect(evaluateAuthority(subject('creator'), 'simulation.manage', world)).toMatchObject({
      allowed: true,
      ruleId: 'simulation.creator_manage',
    });
    expect(evaluateAuthority(subject('administrator'), 'simulation.manage', world)).toMatchObject({
      allowed: false,
      reasonCode: 'CREATOR_REQUIRED',
    });
    expect(evaluateAuthority(subject('administrator'), 'simulation.schedule', world)).toMatchObject(
      {
        allowed: true,
        ruleId: 'simulation.world_role.schedule',
      },
    );
    expect(evaluateAuthority(subject('observer'), 'simulation.schedule', world)).toMatchObject({
      allowed: false,
      reasonCode: 'ACTION_NOT_PERMITTED',
    });
  });

  it('keeps economy reads membership-scoped and controller commands playable', () => {
    expect(evaluateAuthority(subject('observer'), 'economy.read', world)).toMatchObject({
      allowed: true,
      ruleId: 'economy.membership_read',
    });
    expect(evaluateAuthority(subject('player'), 'economy.currency.transfer', world)).toMatchObject({
      allowed: true,
      ruleId: 'economy.controller_recheck_required',
    });
    expect(evaluateAuthority(subject('observer'), 'asset.offer.accept', world)).toMatchObject({
      allowed: false,
      reasonCode: 'ACTION_NOT_PERMITTED',
    });
  });

  it('requires creator membership and explicit confirmation for virtual issuance', () => {
    expect(evaluateAuthority(subject('creator'), 'economy.currency.issue', world)).toMatchObject({
      allowed: false,
      reasonCode: 'OVERRIDE_NOT_EXPLICIT',
    });
    expect(
      evaluateAuthority(subject('creator'), 'economy.currency.issue', world, {
        overrideRequested: true,
      }),
    ).toMatchObject({
      allowed: true,
      ruleId: 'economy.creator_explicit_issuance_override',
    });
    expect(evaluateAuthority(subject('administrator'), 'economy.initialize', world)).toMatchObject({
      allowed: false,
      reasonCode: 'CREATOR_REQUIRED',
    });
  });

  it('uses coarse commerce membership gates and requires transactional controller rechecks', () => {
    for (const action of [
      'commerce.business.create',
      'commerce.business.manage',
      'commerce.employment.create',
      'commerce.employment.accept',
      'commerce.employment.end',
      'commerce.employment.work',
      'commerce.production.start',
      'commerce.market.list',
      'commerce.market.cancel',
      'commerce.market.purchase',
    ] as const) {
      for (const role of ['player', 'administrator', 'creator'] as const) {
        expect(evaluateAuthority(subject(role), action, world)).toMatchObject({
          allowed: true,
          ruleId: 'commerce.controller_recheck_required',
        });
      }
      expect(evaluateAuthority(subject('observer'), action, world)).toMatchObject({
        allowed: false,
        reasonCode: 'ACTION_NOT_PERMITTED',
      });
      expect(evaluateAuthority(subject(), action, world)).toMatchObject({
        allowed: false,
        reasonCode: 'WORLD_NOT_VISIBLE',
      });
    }
    expect(evaluateAuthority(subject('creator'), 'commerce.initialize', world)).toMatchObject({
      allowed: true,
      ruleId: 'economy.creator_command',
    });
    expect(evaluateAuthority(subject('administrator'), 'commerce.initialize', world)).toMatchObject(
      {
        allowed: false,
        reasonCode: 'CREATOR_REQUIRED',
      },
    );
    expect(evaluateAuthority(subject('administrator'), 'commerce.reconcile', world)).toMatchObject({
      allowed: true,
      ruleId: 'economy.world_role.reconcile',
    });
  });

  it('does not let platform role synthesize wallet, asset, or creator economy authority', () => {
    const platformAdmin: AuthoritySubject = {
      platformRole: 'platform_admin',
      userId,
    };
    for (const action of [
      'economy.read',
      'economy.currency.transfer',
      'asset.transfer',
      'economy.currency.issue',
    ] as const) {
      expect(evaluateAuthority(platformAdmin, action, world)).toMatchObject({
        allowed: false,
        reasonCode: 'WORLD_NOT_VISIBLE',
      });
    }
  });
});
