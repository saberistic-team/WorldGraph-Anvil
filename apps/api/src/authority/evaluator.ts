import type {
  AuthorityAction,
  AuthorityContext,
  AuthorityDecision,
  AuthorityResource,
  AuthoritySubject,
} from '@worldgraph/contracts';

const readActions = new Set<AuthorityAction>(['world.read', 'membership.list']);
const administratorActions = new Set<AuthorityAction>([
  'world.rename',
  'invitation.create',
  'invitation.list',
  'invitation.revoke',
  'membership.remove',
]);
const creatorActions = new Set<AuthorityAction>(['membership.change_role', 'authority.audit.read']);
const primitiveReadActions = new Set<AuthorityAction>([
  'primitive.catalog.read',
  'primitive.retrieval.run',
]);
const primitiveAdminActions = new Set<AuthorityAction>([
  'primitive.draft.create',
  'primitive.draft.update',
  'primitive.version.publish',
  'primitive.version.deprecate',
  'primitive.version.reindex',
]);
const manifestReadActions = new Set<AuthorityAction>([
  'manifest.generation.read',
  'manifest.revision.read',
  'manifest.revision.diff',
]);
const manifestEditorActions = new Set<AuthorityAction>([
  'manifest.generation.start',
  'manifest.generation.cancel',
  'manifest.revision.create',
  'manifest.revision.validate',
]);
const compilerReadActions = new Set<AuthorityAction>([
  'world.compilation.read',
  'world.runtime.read',
]);
const compilerCreatorActions = new Set<AuthorityAction>([
  'world.compilation.start',
  'world.compilation.cancel',
  'world.compilation.retry',
]);
const ledgerReadActions = new Set<string>(['world.command.read', 'world.history.read']);
const ledgerAdministratorActions = new Set<string>(['world.command.submit', 'world.entity.rename']);
const simulationAdministratorActions = new Set<string>(['simulation.schedule']);
const economyReadActions = new Set<AuthorityAction>(['economy.read', 'asset.read']);
const economyCreatorActions = new Set<AuthorityAction>([
  'economy.initialize',
  'economy.legacy_seed.adopt',
  'economy.currency.issue',
  'economy.currency.freeze',
  'economy.wallet.freeze',
]);
const economyControllerActions = new Set<AuthorityAction>([
  'economy.currency.transfer',
  'asset.transfer',
  'asset.offer.create',
  'asset.offer.cancel',
  'asset.offer.accept',
]);
const commerceCreatorActions = new Set<AuthorityAction>(['commerce.initialize']);
const commerceControllerActions = new Set<AuthorityAction>([
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
]);

export function evaluateAuthority(
  subject: AuthoritySubject,
  action: AuthorityAction,
  _resource: AuthorityResource,
  context: AuthorityContext = {},
): AuthorityDecision {
  if (action === 'world.create') return allow('identity.active.create_world');
  if (action === 'invitation.accept') {
    return context.invitationValidated
      ? allow('invitation.validated_email_and_token')
      : deny('invitation.validation_required', 'INVITATION_NOT_VALIDATED');
  }
  if (ledgerReadActions.has(action)) {
    return subject.membershipStatus === 'active' && subject.membershipRole
      ? allow('ledger.membership_read')
      : deny('ledger.membership_required', 'WORLD_NOT_VISIBLE');
  }
  if (ledgerAdministratorActions.has(action)) {
    if (subject.membershipStatus !== 'active' || !subject.membershipRole) {
      return deny('ledger.membership_required', 'WORLD_NOT_VISIBLE');
    }
    return subject.membershipRole === 'creator' || subject.membershipRole === 'administrator'
      ? allow('ledger.world_role.authoritative_write')
      : deny('ledger.administrator_required', 'ACTION_NOT_PERMITTED');
  }
  if (action === 'simulation.manage' || simulationAdministratorActions.has(action)) {
    if (subject.membershipStatus !== 'active' || !subject.membershipRole) {
      return deny('simulation.membership_required', 'WORLD_NOT_VISIBLE');
    }
    if (action === 'simulation.manage') {
      return subject.membershipRole === 'creator'
        ? allow('simulation.creator_manage')
        : deny('simulation.creator_required', 'CREATOR_REQUIRED');
    }
    return subject.membershipRole === 'creator' || subject.membershipRole === 'administrator'
      ? allow('simulation.world_role.schedule')
      : deny('simulation.administrator_required', 'ACTION_NOT_PERMITTED');
  }
  // Economy authority never inherits the platform-admin bypass. Private wallet
  // and title authority is established from a current entity-controller row in
  // the command/query transaction after this coarse membership decision.
  if (
    economyReadActions.has(action) ||
    economyCreatorActions.has(action) ||
    economyControllerActions.has(action) ||
    commerceCreatorActions.has(action) ||
    commerceControllerActions.has(action) ||
    action === 'commerce.reconcile' ||
    action === 'economy.reconcile'
  ) {
    if (subject.membershipStatus !== 'active' || !subject.membershipRole) {
      return deny('economy.membership_required', 'WORLD_NOT_VISIBLE');
    }
    if (economyReadActions.has(action)) return allow('economy.membership_read');
    if (economyCreatorActions.has(action) || commerceCreatorActions.has(action)) {
      if (subject.membershipRole !== 'creator') {
        return deny('economy.creator_required', 'CREATOR_REQUIRED');
      }
      if (action === 'economy.currency.issue' && !context.overrideRequested) {
        return deny('economy.issuance_explicit_override_required', 'OVERRIDE_NOT_EXPLICIT');
      }
      return allow(
        action === 'economy.currency.issue'
          ? 'economy.creator_explicit_issuance_override'
          : 'economy.creator_command',
      );
    }
    if (action === 'economy.reconcile' || action === 'commerce.reconcile') {
      return subject.membershipRole === 'creator' || subject.membershipRole === 'administrator'
        ? allow('economy.world_role.reconcile')
        : deny('economy.reconcile_role_required', 'ACTION_NOT_PERMITTED');
    }
    return subject.membershipRole === 'observer'
      ? deny('economy.playable_membership_required', 'ACTION_NOT_PERMITTED')
      : allow(
          commerceControllerActions.has(action)
            ? 'commerce.controller_recheck_required'
            : 'economy.controller_recheck_required',
        );
  }
  if (primitiveReadActions.has(action)) return allow('identity.active.primitive_registry_read');
  // Manifest content and prompt-derived state are always membership scoped. In
  // particular, the platform role must not silently bypass creator-only approval.
  if (action.startsWith('manifest.')) {
    if (subject.membershipStatus !== 'active' || !subject.membershipRole) {
      return deny('manifest.membership_required', 'WORLD_NOT_VISIBLE');
    }
    if (action === 'manifest.revision.approve') {
      return subject.membershipRole === 'creator'
        ? allow('manifest.creator_approval')
        : deny('manifest.creator_approval_required', 'CREATOR_REQUIRED');
    }
    if (manifestReadActions.has(action)) return allow('manifest.membership_read');
    if (
      manifestEditorActions.has(action) &&
      (subject.membershipRole === 'creator' || subject.membershipRole === 'administrator')
    ) {
      return allow('manifest.world_role.editor');
    }
    return deny('manifest.editor_required', 'ACTION_NOT_PERMITTED');
  }
  if (action.startsWith('world.compilation.') || action === 'world.runtime.read') {
    if (subject.membershipStatus !== 'active' || !subject.membershipRole) {
      return deny('compiler.membership_required', 'WORLD_NOT_VISIBLE');
    }
    if (compilerReadActions.has(action)) return allow('compiler.membership_read');
    if (compilerCreatorActions.has(action) && subject.membershipRole === 'creator') {
      return allow('compiler.creator_command');
    }
    return deny('compiler.creator_required', 'CREATOR_REQUIRED');
  }
  if (subject.platformRole === 'platform_admin') {
    if (action === 'creator_override.use' && !context.overrideRequested) {
      return deny('override.explicit_confirmation_required', 'OVERRIDE_NOT_EXPLICIT');
    }
    return allow('platform_admin.explicit');
  }
  if (primitiveAdminActions.has(action)) {
    return deny('platform_admin.primitive_registry_required', 'PLATFORM_ADMIN_REQUIRED');
  }
  if (subject.membershipStatus !== 'active' || !subject.membershipRole) {
    return deny('membership.active_required', 'WORLD_NOT_VISIBLE');
  }
  if (readActions.has(action)) return allow('membership.active.read');
  if (
    administratorActions.has(action) &&
    (subject.membershipRole === 'creator' || subject.membershipRole === 'administrator')
  ) {
    return allow('world_role.administrator');
  }
  if (creatorActions.has(action) && subject.membershipRole === 'creator') {
    return allow('world_role.creator');
  }
  if (action === 'creator_override.use') {
    if (subject.membershipRole !== 'creator') {
      return deny('override.creator_required', 'CREATOR_REQUIRED');
    }
    if (!context.overrideRequested) {
      return deny('override.explicit_confirmation_required', 'OVERRIDE_NOT_EXPLICIT');
    }
    return allow('world_role.creator_override');
  }
  return deny('authority.default_deny', 'ACTION_NOT_PERMITTED');
}

function allow(ruleId: string): AuthorityDecision {
  return { allowed: true, reasonCode: 'ALLOWED', ruleId };
}

function deny(ruleId: string, reasonCode: string): AuthorityDecision {
  return { allowed: false, reasonCode, ruleId };
}
