import { Type, type Static } from '@sinclair/typebox';

import type { PlatformRoleSchema } from './identity.js';

export const WorldRoleSchema = Type.Union([
  Type.Literal('creator'),
  Type.Literal('administrator'),
  Type.Literal('player'),
  Type.Literal('observer'),
]);
export const MembershipStatusSchema = Type.Union([Type.Literal('active'), Type.Literal('removed')]);

export const AuthorityActionSchema = Type.Union([
  Type.Literal('world.create'),
  Type.Literal('world.read'),
  Type.Literal('world.rename'),
  Type.Literal('membership.list'),
  Type.Literal('membership.change_role'),
  Type.Literal('membership.remove'),
  Type.Literal('invitation.list'),
  Type.Literal('invitation.create'),
  Type.Literal('invitation.revoke'),
  Type.Literal('invitation.accept'),
  Type.Literal('authority.audit.read'),
  Type.Literal('creator_override.use'),
  Type.Literal('primitive.catalog.read'),
  Type.Literal('primitive.retrieval.run'),
  Type.Literal('primitive.draft.create'),
  Type.Literal('primitive.draft.update'),
  Type.Literal('primitive.version.publish'),
  Type.Literal('primitive.version.deprecate'),
  Type.Literal('primitive.version.reindex'),
  Type.Literal('manifest.generation.start'),
  Type.Literal('manifest.generation.read'),
  Type.Literal('manifest.generation.cancel'),
  Type.Literal('manifest.revision.create'),
  Type.Literal('manifest.revision.read'),
  Type.Literal('manifest.revision.validate'),
  Type.Literal('manifest.revision.diff'),
  Type.Literal('manifest.revision.approve'),
  Type.Literal('world.compilation.start'),
  Type.Literal('world.compilation.read'),
  Type.Literal('world.compilation.cancel'),
  Type.Literal('world.compilation.retry'),
  Type.Literal('world.runtime.read'),
  Type.Literal('world.command.submit'),
  Type.Literal('world.command.read'),
  Type.Literal('world.history.read'),
  Type.Literal('world.entity.rename'),
  Type.Literal('simulation.manage'),
  Type.Literal('simulation.schedule'),
  Type.Literal('economy.read'),
  Type.Literal('economy.initialize'),
  Type.Literal('economy.legacy_seed.adopt'),
  Type.Literal('economy.currency.transfer'),
  Type.Literal('economy.currency.issue'),
  Type.Literal('economy.currency.freeze'),
  Type.Literal('economy.wallet.freeze'),
  Type.Literal('economy.reconcile'),
  Type.Literal('commerce.initialize'),
  Type.Literal('commerce.business.create'),
  Type.Literal('commerce.business.manage'),
  Type.Literal('commerce.employment.create'),
  Type.Literal('commerce.employment.accept'),
  Type.Literal('commerce.employment.end'),
  Type.Literal('commerce.employment.work'),
  Type.Literal('commerce.production.start'),
  Type.Literal('commerce.market.list'),
  Type.Literal('commerce.market.cancel'),
  Type.Literal('commerce.market.purchase'),
  Type.Literal('commerce.reconcile'),
  Type.Literal('asset.read'),
  Type.Literal('asset.transfer'),
  Type.Literal('asset.offer.create'),
  Type.Literal('asset.offer.cancel'),
  Type.Literal('asset.offer.accept'),
]);

export const AuthorityDecisionSchema = Type.Object(
  {
    allowed: Type.Boolean(),
    reasonCode: Type.String({ maxLength: 80, minLength: 1 }),
    ruleId: Type.String({ maxLength: 100, minLength: 1 }),
  },
  { additionalProperties: false },
);

export interface AuthoritySubject {
  membershipRole?: WorldRole;
  membershipStatus?: MembershipStatus;
  platformRole: Static<typeof PlatformRoleSchema>;
  userId: string;
}

export interface AuthorityResource {
  primitiveVersionId?: string;
  targetRole?: WorldRole;
  targetUserId?: string;
  worldId?: string;
}

export interface AuthorityContext {
  futureOrganizationRoles?: readonly string[];
  futureOfficeRoles?: readonly string[];
  invitationValidated?: boolean;
  overrideRequested?: boolean;
}

export type AuthorityAction = Static<typeof AuthorityActionSchema>;
export type AuthorityDecision = Static<typeof AuthorityDecisionSchema>;
export type MembershipStatus = Static<typeof MembershipStatusSchema>;
export type WorldRole = Static<typeof WorldRoleSchema>;
