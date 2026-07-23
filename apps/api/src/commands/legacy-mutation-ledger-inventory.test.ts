import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGACY_LEDGER_ADAPTED_ACTIONS } from './legacy-mutation-ledger.js';

const serviceFiles = [
  'apps/api/src/worlds/service.ts',
  'apps/api/src/manifests/service.ts',
  'apps/api/src/compilation/service.ts',
  'apps/api/src/primitives/service.ts',
] as const;

const intentionalExclusions = [
  // There is no per-world ledger before truthful compiled/imported genesis.
  'world.create',
  // Generation, validation and compilation are computation/job bookkeeping.
  'manifest.generation.cancel',
  'manifest.generation.start',
  'manifest.revision.validate',
  'world.compilation.cancel',
  'world.compilation.retry',
  'world.compilation.start',
  // Primitive catalog authority is platform-global rather than world-scoped.
  'primitive.draft.create',
  'primitive.draft.update',
  'primitive.version.deprecate',
  'primitive.version.publish',
  'primitive.version.reindex',
] as const;

const expectedEventByAction = {
  'creator_override.use': 'CreatorOverrideUsedV1',
  'invitation.accept': 'WorldInvitationAcceptedV1',
  'invitation.create': 'WorldInvitationCreatedV1',
  'invitation.revoke': 'WorldInvitationRevokedV1',
  'manifest.revision.approve': 'ManifestApprovedV1',
  'manifest.revision.create': 'ManifestRevisionCreatedV1',
  'membership.change_role': 'WorldMembershipRoleChangedV1',
  'membership.remove': 'WorldMembershipRemovedV1',
  'world.rename': 'WorldRenamedV1',
} as const;

describe('legacy authoritative mutation inventory', () => {
  it('classifies every pre-M06 public command as adapted or intentionally out of scope', () => {
    const discovered = serviceFiles.flatMap((file) => buildCommandActions(source(file))).sort();
    const classified = [...LEGACY_LEDGER_ADAPTED_ACTIONS, ...intentionalExclusions].sort();
    expect(discovered).toEqual(classified);
    expect(LEGACY_LEDGER_ADAPTED_ACTIONS).toEqual(Object.keys(expectedEventByAction).sort());
  });

  it('requires an explicit accepted-ledger append and versioned event at every adapted call site', () => {
    const worldService = source('apps/api/src/worlds/service.ts');
    const manifestService = source('apps/api/src/manifests/service.ts');
    expect(occurrences(worldService, 'repository.appendLegacyMutation({')).toBe(7);
    expect(occurrences(manifestService, 'repository.appendLegacyMutation({')).toBe(2);
    for (const eventType of Object.values(expectedEventByAction)) {
      expect(`${worldService}\n${manifestService}`).toContain(`eventType: '${eventType}'`);
    }
  });

  it('keeps the adapter registry closed rather than accepting arbitrary event names', () => {
    const adapter = source('apps/api/src/commands/legacy-mutation-ledger.ts');
    expect(adapter).toContain('registration.eventType !== input.event.eventType');
    expect(adapter).not.toMatch(/eventType:\s*string/u);
  });
});

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

function buildCommandActions(value: string): string[] {
  return [...value.matchAll(/buildCommand\(\s*\{\s*action:\s*'([^']+)'/gu)].map(
    (match) => match[1]!,
  );
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}
