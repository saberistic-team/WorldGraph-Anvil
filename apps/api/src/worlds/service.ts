import type {
  AcceptInvitationRequest,
  ApplicationNotification,
  AuthorityAction,
  AuthorityDecision,
  ChangeMembershipRoleRequest,
  Clock,
  CreateInvitationRequest,
  CreateWorldRequest,
  CreatorOverrideRequest,
  IdGenerator,
  Invitation,
  Membership,
  RemoveMembershipRequest,
  RenameWorldRequest,
  World,
} from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';

import { evaluateAuthority } from '../authority/evaluator.js';
import { buildCommand } from '../application/command.js';
import { ApplicationError } from '../application/errors.js';
import type { NotificationSink } from '../application/notifications.js';
import {
  decodeDurableLegacyRejection,
  derivedLegacyLedgerUuid,
  encodeDurableLegacyRejection,
  legacyLedgerRejectionCode,
  type LegacyMutationCommandContext,
} from '../commands/legacy-mutation-ledger.js';
import type { AuthenticatedActor } from '../identity/service.js';
import { normalizeEmail, redactAuditMetadata } from '../identity/security.js';
import type { PostgresRepository } from '../repositories/postgres-repository.js';
import { normalizeCreatorOverrideReason } from './validation.js';

interface RequestCommandContext {
  idempotencyKey: string;
  requestId: string;
}

export class WorldService {
  public constructor(
    private readonly repository: PostgresRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly invitationToken: (invitationId: string) => string,
    private readonly invitationTokenHash: (rawToken: string) => Buffer,
    private readonly notifications: NotificationSink,
  ) {}

  public async listWorlds(actor: AuthenticatedActor): Promise<World[]> {
    return this.repository.listWorlds(actor.user.id);
  }

  public async getWorld(actor: AuthenticatedActor, worldId: string): Promise<World> {
    return this.visibleWorld(actor, worldId, 'world.read');
  }

  public async createWorld(
    actor: AuthenticatedActor,
    payload: CreateWorldRequest,
    context: RequestCommandContext,
  ): Promise<World> {
    const name = cleanWorldName(payload.name);
    const slug = payload.slug ?? slugify(name);
    const command = buildCommand(
      {
        action: 'world.create',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: { name, slug },
        requestId: context.requestId,
      },
      this.ids,
    );
    const worldId = this.ids.next();
    const decision = this.assertApplicationAuthority(actor, 'world.create', worldId);
    let applied = false;
    const body = await this.idempotent(actor, command, 201, async (repository) => {
      applied = true;
      const world = await repository.createWorld({
        actorUserId: actor.user.id,
        id: worldId,
        name,
        slug,
      });
      await repository.insertAudit(
        this.audit(command, 'world', 'world.created', world.id, undefined, decision),
      );
      return { world };
    });
    const world = body.world as World;
    if (applied) {
      await this.notifications.publish({
        id: this.ids.next(),
        occurredAt: this.clock.now().toISOString(),
        payload: { actorUserId: actor.user.id, worldId: world.id },
        schemaVersion: 1,
        type: 'WorldCreated',
      });
    }
    return world;
  }

  public async renameWorld(
    actor: AuthenticatedActor,
    worldId: string,
    payload: RenameWorldRequest,
    context: RequestCommandContext,
  ): Promise<World> {
    const command = buildCommand(
      {
        action: 'world.rename',
        actorUserId: actor.user.id,
        expectedRowVersion: payload.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { name: payload.name },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    let body: Record<string, unknown>;
    try {
      body = await this.idempotent(actor, command, 200, async (repository) => {
        const name = cleanWorldName(payload.name);
        const locked = await repository.getWorld(
          actor.user.id,
          worldId,
          true,
          actor.user.platformRole === 'platform_admin',
        );
        if (!locked) this.notFound();
        const decision = this.assertAuthority(actor, locked, 'world.rename');
        const updated = repository.worldFromRow(
          await repository.renameWorld(worldId, name, payload.expectedRowVersion),
        );
        updated.role = locked.role;
        await repository.insertAudit(
          this.audit(command, 'authority', 'world.renamed', worldId, undefined, decision),
        );
        await repository.appendLegacyMutation({
          ...this.legacyLedgerContext(actor, command, decision.ruleId),
          event: {
            aggregateId: worldId,
            aggregateType: 'world',
            eventType: 'WorldRenamedV1',
            payload: { newName: updated.name, previousName: locked.name },
          },
          worldId,
        });
        return { world: updated };
      });
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.statusCode === 403 &&
        !(await this.repository.worldLedgerAnchored(worldId))
      ) {
        const reasonCode =
          typeof error.details?.reasonCode === 'string' ? error.details.reasonCode : error.code;
        const ruleId =
          typeof error.details?.ruleId === 'string'
            ? error.details.ruleId
            : 'authority.target_denied';
        telemetry.authorizationDecisions.add(1, { action: 'world.rename', outcome: 'denied' });
        await this.recordDenial(
          actor,
          worldId,
          'world.rename',
          worldId,
          reasonCode,
          true,
          { allowed: false, reasonCode, ruleId },
          context.requestId,
        );
      }
      throw error;
    }
    return body.world as World;
  }

  public async listMemberships(actor: AuthenticatedActor, worldId: string): Promise<Membership[]> {
    return this.authorizedRead(actor, worldId, 'membership.list', (repository) =>
      repository.listMemberships(worldId),
    );
  }

  public async changeMembershipRole(
    actor: AuthenticatedActor,
    worldId: string,
    targetUserId: string,
    payload: ChangeMembershipRoleRequest,
    context: RequestCommandContext,
  ): Promise<Record<string, unknown>> {
    const command = buildCommand(
      {
        action: 'membership.change_role',
        actorUserId: actor.user.id,
        expectedRowVersion: payload.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { role: payload.role, targetUserId },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    let applied = false;
    let result: Record<string, unknown>;
    try {
      result = await this.idempotent(actor, command, 200, async (repository) => {
        applied = true;
        const world = await repository.getWorld(
          actor.user.id,
          worldId,
          true,
          actor.user.platformRole === 'platform_admin',
        );
        if (!world) this.notFound();
        const decision = this.assertAuthority(actor, world, 'membership.change_role');
        const target = await repository.getMembership(worldId, targetUserId, true);
        if (!target || target.status !== 'active') this.notFound();
        if (target.role === 'creator') {
          throw new ApplicationError('FORBIDDEN', 'Creator authority cannot be transferred.', 403, {
            reasonCode: 'CREATOR_MEMBERSHIP_IMMUTABLE',
            ruleId: 'membership.creator_immutable',
          });
        }
        if (target.role === 'administrator' && payload.role !== 'administrator') {
          throw new ApplicationError(
            'CREATOR_OVERRIDE_REQUIRED',
            'Demoting an administrator requires an explicit creator override.',
            403,
            {
              reasonCode: 'CREATOR_OVERRIDE_REQUIRED',
              ruleId: 'membership.administrator_demotion_override_required',
            },
          );
        }
        const membership = await repository.changeMembershipRole({
          expectedRowVersion: payload.expectedRowVersion,
          role: payload.role,
          targetUserId,
          worldId,
        });
        await repository.insertAudit(
          this.audit(
            command,
            'authority',
            'membership.role_changed',
            targetUserId,
            worldId,
            decision,
          ),
        );
        await repository.appendLegacyMutation({
          ...this.legacyLedgerContext(actor, command, decision.ruleId),
          event: {
            aggregateId: targetUserId,
            aggregateType: 'world_membership',
            eventType: 'WorldMembershipRoleChangedV1',
            payload: {
              newRole: membership.role,
              previousRole: target.role,
              targetUserId,
            },
          },
          worldId,
        });
        return { membership };
      });
    } catch (error) {
      await this.persistTargetDenial(
        error,
        actor,
        worldId,
        'membership.change_role',
        targetUserId,
        context.requestId,
      );
      throw error;
    }
    if (applied) {
      await this.publish('MembershipRoleChanged', {
        actorUserId: actor.user.id,
        role: payload.role,
        targetUserId,
        worldId,
      });
    }
    return result;
  }

  public async removeMembership(
    actor: AuthenticatedActor,
    worldId: string,
    targetUserId: string,
    payload: RemoveMembershipRequest,
    context: RequestCommandContext,
  ): Promise<Record<string, unknown>> {
    const command = buildCommand(
      {
        action: 'membership.remove',
        actorUserId: actor.user.id,
        expectedRowVersion: payload.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload: { targetUserId },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    let applied = false;
    let result: Record<string, unknown>;
    try {
      result = await this.idempotent(actor, command, 200, async (repository) => {
        applied = true;
        const world = await repository.getWorld(
          actor.user.id,
          worldId,
          true,
          actor.user.platformRole === 'platform_admin',
        );
        if (!world) this.notFound();
        const decision = this.assertAuthority(actor, world, 'membership.remove');
        const target = await repository.getMembership(worldId, targetUserId, true);
        if (!target || target.status !== 'active') this.notFound();
        if (target.role === 'creator' || target.role === 'administrator') {
          throw new ApplicationError(
            'FORBIDDEN',
            'That membership cannot be removed normally.',
            403,
            {
              reasonCode: 'PROTECTED_MEMBERSHIP_REMOVAL_FORBIDDEN',
              ruleId: 'membership.protected_role_removal_denied',
            },
          );
        }
        const membership = await repository.removeMembership({
          expectedRowVersion: payload.expectedRowVersion,
          targetUserId,
          worldId,
        });
        await repository.insertAudit(
          this.audit(command, 'authority', 'membership.removed', targetUserId, worldId, decision),
        );
        await repository.appendLegacyMutation({
          ...this.legacyLedgerContext(actor, command, decision.ruleId),
          event: {
            aggregateId: targetUserId,
            aggregateType: 'world_membership',
            eventType: 'WorldMembershipRemovedV1',
            payload: { previousRole: target.role, targetUserId },
          },
          worldId,
        });
        return { membership };
      });
    } catch (error) {
      await this.persistTargetDenial(
        error,
        actor,
        worldId,
        'membership.remove',
        targetUserId,
        context.requestId,
      );
      throw error;
    }
    if (applied) {
      await this.publish('MembershipRemoved', {
        actorUserId: actor.user.id,
        targetUserId,
        worldId,
      });
    }
    return result;
  }

  public async listInvitations(actor: AuthenticatedActor, worldId: string): Promise<Invitation[]> {
    return this.authorizedRead(actor, worldId, 'invitation.list', (repository) =>
      repository.listInvitations(worldId),
    );
  }

  public async createInvitation(
    actor: AuthenticatedActor,
    worldId: string,
    payload: CreateInvitationRequest,
    context: RequestCommandContext,
  ): Promise<{ invitation: Invitation; rawToken: string }> {
    const email = normalizeEmail(payload.email);
    const command = buildCommand(
      {
        action: 'invitation.create',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: { email, expiresIn: payload.expiresIn, role: payload.role },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    const invitationId = this.ids.next();
    const rawToken = this.invitationToken(invitationId);
    let applied = false;
    const body = await this.idempotent(actor, command, 201, async (repository) => {
      applied = true;
      const world = await repository.getWorld(
        actor.user.id,
        worldId,
        true,
        actor.user.platformRole === 'platform_admin',
      );
      if (!world) this.notFound();
      const decision = this.assertAuthority(actor, world, 'invitation.create');
      const invitation = await repository.createInvitation({
        createdByUserId: actor.user.id,
        email,
        expiresAt: new Date(this.clock.now().getTime() + payload.expiresIn * 1_000),
        id: invitationId,
        role: payload.role,
        tokenHash: this.invitationTokenHash(rawToken),
        worldId,
      });
      await repository.insertAudit(
        this.audit(command, 'invitation', 'invitation.created', invitation.id, worldId, decision),
      );
      await repository.appendLegacyMutation({
        ...this.legacyLedgerContext(actor, command, decision.ruleId),
        event: {
          aggregateId: invitation.id,
          aggregateType: 'world_invitation',
          eventType: 'WorldInvitationCreatedV1',
          payload: { intendedRole: invitation.intendedRole, invitationId: invitation.id },
        },
        worldId,
      });
      return { invitation };
    });
    const invitation = body.invitation as Invitation;
    if (applied) {
      await this.publish('InvitationCreated', {
        actorUserId: actor.user.id,
        invitationId: invitation.id,
        intendedRole: invitation.intendedRole,
        worldId,
      });
      telemetry.invitationLifecycle.add(1, { outcome: 'created' });
    }
    return { invitation, rawToken: this.invitationToken(invitation.id) };
  }

  public async revokeInvitation(
    actor: AuthenticatedActor,
    worldId: string,
    invitationId: string,
    context: RequestCommandContext,
  ): Promise<Invitation> {
    const command = buildCommand(
      {
        action: 'invitation.revoke',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: { invitationId },
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    let applied = false;
    const body = await this.idempotent(actor, command, 200, async (repository) => {
      applied = true;
      const world = await repository.getWorld(
        actor.user.id,
        worldId,
        true,
        actor.user.platformRole === 'platform_admin',
      );
      if (!world) this.notFound();
      const decision = this.assertAuthority(actor, world, 'invitation.revoke');
      const invitation = await repository.revokeInvitation(worldId, invitationId);
      await repository.insertAudit(
        this.audit(command, 'invitation', 'invitation.revoked', invitationId, worldId, decision),
      );
      await repository.appendLegacyMutation({
        ...this.legacyLedgerContext(actor, command, decision.ruleId),
        event: {
          aggregateId: invitationId,
          aggregateType: 'world_invitation',
          eventType: 'WorldInvitationRevokedV1',
          payload: { intendedRole: invitation.intendedRole, invitationId },
        },
        worldId,
      });
      return { invitation };
    });
    const invitation = body.invitation as Invitation;
    if (applied) {
      await this.publish('InvitationRevoked', {
        actorUserId: actor.user.id,
        invitationId,
        worldId,
      });
      telemetry.invitationLifecycle.add(1, { outcome: 'revoked' });
    }
    return invitation;
  }

  public async acceptInvitation(
    actor: AuthenticatedActor,
    payload: AcceptInvitationRequest,
    context: RequestCommandContext,
  ): Promise<Record<string, unknown>> {
    const command = buildCommand(
      {
        action: 'invitation.accept',
        actorUserId: actor.user.id,
        idempotencyKey: context.idempotencyKey,
        payload: { tokenDigest: this.invitationTokenHash(payload.rawToken).toString('hex') },
        requestId: context.requestId,
      },
      this.ids,
    );
    let applied = false;
    const result = await this.idempotent(actor, command, 200, async (repository) => {
      applied = true;
      const accepted = await repository.acceptInvitation({
        email: actor.user.email,
        tokenHash: this.invitationTokenHash(payload.rawToken),
        userId: actor.user.id,
      });
      const decision = this.assertApplicationAuthority(
        actor,
        'invitation.accept',
        accepted.worldId,
        true,
      );
      await repository.insertAudit(
        this.audit(
          command,
          'invitation',
          'invitation.accepted',
          actor.user.id,
          accepted.worldId,
          decision,
        ),
      );
      await repository.appendLegacyMutation({
        ...this.legacyLedgerContext(actor, command, decision.ruleId),
        event: {
          aggregateId: accepted.invitationId,
          aggregateType: 'world_invitation',
          eventType: 'WorldInvitationAcceptedV1',
          payload: {
            intendedRole: accepted.role,
            invitationId: accepted.invitationId,
            targetUserId: actor.user.id,
          },
        },
        worldId: accepted.worldId,
      });
      return { membership: { role: accepted.role, worldId: accepted.worldId } };
    });
    if (applied) {
      const membership = result.membership as { worldId: string };
      await this.publish('InvitationAccepted', {
        actorUserId: actor.user.id,
        worldId: membership.worldId,
      });
      telemetry.invitationLifecycle.add(1, { outcome: 'accepted' });
    }
    return result;
  }

  public async creatorOverride(
    actor: AuthenticatedActor,
    worldId: string,
    payload: CreatorOverrideRequest,
    context: RequestCommandContext,
  ): Promise<Record<string, unknown>> {
    const command = buildCommand(
      {
        action: 'creator_override.use',
        actorUserId: actor.user.id,
        expectedRowVersion: payload.expectedRowVersion,
        idempotencyKey: context.idempotencyKey,
        payload,
        requestId: context.requestId,
        resourceId: worldId,
      },
      this.ids,
    );
    let applied = false;
    let result: Record<string, unknown>;
    try {
      result = await this.idempotent(actor, command, 200, async (repository) => {
        applied = true;
        const normalizedPayload = {
          ...payload,
          reason: normalizeCreatorOverrideReason(payload.reason),
        };
        const lockedWorld = await repository.getWorld(
          actor.user.id,
          worldId,
          true,
          actor.user.platformRole === 'platform_admin',
        );
        if (!lockedWorld) this.notFound();
        const decision = this.assertAuthority(actor, lockedWorld, 'creator_override.use', true);
        const target = await repository.getMembership(
          worldId,
          normalizedPayload.targetUserId,
          true,
        );
        if (!target || target.status !== 'active' || target.role !== 'administrator') {
          throw new ApplicationError('FORBIDDEN', 'The override target is not eligible.', 403, {
            reasonCode: 'OVERRIDE_TARGET_NOT_ELIGIBLE',
            ruleId: 'override.target_administrator_required',
          });
        }
        const membership = await repository.changeMembershipRole({
          expectedRowVersion: normalizedPayload.expectedRowVersion,
          role: 'player',
          targetUserId: normalizedPayload.targetUserId,
          worldId,
        });
        const auditId = this.ids.next();
        await repository.insertAudit({
          ...this.audit(
            command,
            'creator_override',
            'membership.force_demote_administrator',
            normalizedPayload.targetUserId,
            worldId,
            decision,
          ),
          id: auditId,
          metadata: redactAuditMetadata({
            authorityReasonCode: decision.reasonCode,
            authorityRuleId: decision.ruleId,
            override: true,
          }),
          reasonCode: 'CREATOR_OVERRIDE_USED',
        });
        const overrideId = this.ids.next();
        await repository.insertCreatorOverride({
          action: normalizedPayload.action,
          actorUserId: actor.user.id,
          auditRecordId: auditId,
          authorityRuleId: decision.ruleId,
          commandId: command.commandId,
          id: overrideId,
          reason: normalizedPayload.reason,
          targetId: normalizedPayload.targetUserId,
          targetType: 'world_membership',
          worldId,
        });
        await repository.appendLegacyMutation({
          ...this.legacyLedgerContext(actor, command, decision.ruleId, overrideId),
          event: {
            aggregateId: normalizedPayload.targetUserId,
            aggregateType: 'world_membership',
            eventType: 'CreatorOverrideUsedV1',
            payload: {
              authorityRuleId: decision.ruleId,
              commandType: 'UseCreatorOverrideV1',
              overrideId,
              reasonCode: 'CREATOR_OVERRIDE_USED',
              targetId: normalizedPayload.targetUserId,
              targetType: 'world_membership',
            },
          },
          worldId,
        });
        return {
          membership,
          override: { action: normalizedPayload.action, auditRecordId: auditId },
        };
      });
    } catch (error) {
      await this.persistTargetDenial(
        error,
        actor,
        worldId,
        'creator_override.use',
        payload.targetUserId,
        context.requestId,
      );
      throw error;
    }
    if (applied) {
      await this.publish('CreatorOverrideUsed', {
        action: payload.action,
        actorUserId: actor.user.id,
        targetUserId: payload.targetUserId,
        worldId,
      });
      telemetry.creatorOverrides.add(1, { action: payload.action });
    }
    return result;
  }

  public async listAuthorityAudit(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.authorizedRead(actor, worldId, 'authority.audit.read', (repository) =>
      repository.listAuthorityAudit(worldId),
    );
  }

  private async visibleWorld(
    actor: AuthenticatedActor,
    worldId: string,
    action: AuthorityAction,
    options: { overrideRequested?: boolean; requestId?: string } = {},
  ): Promise<World> {
    const world = await this.repository.getWorld(
      actor.user.id,
      worldId,
      false,
      actor.user.platformRole === 'platform_admin',
    );
    const requestId = options.requestId ?? this.ids.next();
    if (!world) {
      telemetry.authorizationDecisions.add(1, { action, outcome: 'denied' });
      await this.recordDenial(
        actor,
        worldId,
        action,
        worldId,
        'WORLD_NOT_VISIBLE',
        false,
        undefined,
        requestId,
      );
      this.notFound();
    }
    try {
      this.assertAuthority(actor, world, action, options.overrideRequested ?? false);
      telemetry.authorizationDecisions.add(1, { action, outcome: 'allowed' });
    } catch (error) {
      telemetry.authorizationDecisions.add(1, { action, outcome: 'denied' });
      const reasonCode =
        error instanceof ApplicationError && typeof error.details?.reasonCode === 'string'
          ? error.details.reasonCode
          : 'ACTION_NOT_PERMITTED';
      const ruleId =
        error instanceof ApplicationError && typeof error.details?.ruleId === 'string'
          ? error.details.ruleId
          : 'authority.default_deny';
      await this.recordDenial(
        actor,
        worldId,
        action,
        worldId,
        reasonCode,
        true,
        { allowed: false, reasonCode, ruleId },
        requestId,
      );
      throw error;
    }
    return world;
  }

  private assertAuthority(
    actor: AuthenticatedActor,
    world: World,
    action: AuthorityAction,
    overrideRequested = false,
  ) {
    const decision = evaluateAuthority(
      {
        ...(world.role ? { membershipRole: world.role, membershipStatus: 'active' as const } : {}),
        platformRole: actor.user.platformRole,
        userId: actor.user.id,
      },
      action,
      { worldId: world.id },
      { overrideRequested },
    );
    if (!decision.allowed) {
      throw new ApplicationError('FORBIDDEN', 'This action is not permitted.', 403, {
        reasonCode: decision.reasonCode,
        ruleId: decision.ruleId,
      });
    }
    return decision;
  }

  private assertApplicationAuthority(
    actor: AuthenticatedActor,
    action: 'invitation.accept' | 'world.create',
    worldId: string,
    invitationValidated = false,
  ): AuthorityDecision {
    const decision = evaluateAuthority(
      {
        platformRole: actor.user.platformRole,
        userId: actor.user.id,
      },
      action,
      { worldId },
      { invitationValidated },
    );
    if (!decision.allowed) {
      throw new ApplicationError('FORBIDDEN', 'This action is not permitted.', 403, {
        reasonCode: decision.reasonCode,
        ruleId: decision.ruleId,
      });
    }
    return decision;
  }

  private async authorizedRead<T>(
    actor: AuthenticatedActor,
    worldId: string,
    action: 'authority.audit.read' | 'invitation.list' | 'membership.list',
    read: (repository: PostgresRepository) => Promise<T>,
  ): Promise<T> {
    const result = await this.repository.transaction(async (repository) => {
      const world = await repository.getWorld(
        actor.user.id,
        worldId,
        true,
        actor.user.platformRole === 'platform_admin',
      );
      if (!world) return { kind: 'not_found' as const };
      const decision = evaluateAuthority(
        {
          ...(world.role
            ? { membershipRole: world.role, membershipStatus: 'active' as const }
            : {}),
          platformRole: actor.user.platformRole,
          userId: actor.user.id,
        },
        action,
        { worldId },
      );
      if (!decision.allowed) return { decision, kind: 'denied' as const };
      return { decision, kind: 'allowed' as const, value: await read(repository) };
    });
    if (result.kind === 'not_found') {
      telemetry.authorizationDecisions.add(1, { action, outcome: 'denied' });
      await this.recordDenial(actor, worldId, action, worldId, 'WORLD_NOT_VISIBLE', false);
      this.notFound();
    }
    if (result.kind === 'denied') {
      telemetry.authorizationDecisions.add(1, { action, outcome: 'denied' });
      await this.recordDenial(
        actor,
        worldId,
        action,
        worldId,
        result.decision.reasonCode,
        true,
        result.decision,
      );
      throw new ApplicationError('FORBIDDEN', 'This action is not permitted.', 403, {
        reasonCode: result.decision.reasonCode,
        ruleId: result.decision.ruleId,
      });
    }
    telemetry.authorizationDecisions.add(1, { action, outcome: 'allowed' });
    return result.value;
  }

  private async recordDenial(
    actor: AuthenticatedActor,
    worldId: string,
    action: AuthorityAction,
    targetId: string,
    reasonCode: string,
    visibleWorld: boolean,
    decision?: AuthorityDecision,
    requestId = this.ids.next(),
    targetType: 'world' | 'world_membership' = 'world',
  ): Promise<void> {
    await this.repository.insertAudit({
      action,
      actorUserId: actor.user.id,
      category: 'authority',
      correlationId: requestId,
      id: this.ids.next(),
      metadata: redactAuditMetadata({
        ...(decision
          ? {
              authorityReasonCode: decision.reasonCode,
              authorityRuleId: decision.ruleId,
            }
          : {}),
      }),
      outcome: 'denied',
      reasonCode,
      requestId,
      targetId,
      targetType,
      worldId: visibleWorld ? worldId : null,
    });
  }

  private async persistTargetDenial(
    error: unknown,
    actor: AuthenticatedActor,
    worldId: string,
    action: 'creator_override.use' | 'membership.change_role' | 'membership.remove',
    targetId: string,
    requestId: string,
  ): Promise<void> {
    if (!(error instanceof ApplicationError) || error.statusCode !== 403) return;
    const reasonCode =
      typeof error.details?.reasonCode === 'string' ? error.details.reasonCode : error.code;
    const ruleId =
      typeof error.details?.ruleId === 'string' ? error.details.ruleId : 'authority.target_denied';
    const decision: AuthorityDecision = { allowed: false, reasonCode, ruleId };
    telemetry.authorizationDecisions.add(1, { action, outcome: 'denied' });
    await this.recordDenial(
      actor,
      worldId,
      action,
      targetId,
      reasonCode,
      true,
      decision,
      requestId,
      'world_membership',
    );
  }

  private notFound(): never {
    throw new ApplicationError('NOT_FOUND', 'The world was not found.', 404);
  }

  private audit(
    command: ReturnType<typeof buildCommand>,
    category: string,
    action: string,
    targetId: string,
    worldId?: string,
    decision?: AuthorityDecision,
  ) {
    return {
      action,
      actorUserId: command.actorUserId,
      category,
      correlationId: command.correlationId,
      id: this.ids.next(),
      metadata: redactAuditMetadata({
        ...(decision
          ? {
              authorityReasonCode: decision.reasonCode,
              authorityRuleId: decision.ruleId,
            }
          : {}),
      }),
      outcome: 'allowed',
      reasonCode: 'COMMAND_APPLIED',
      requestId: command.requestId,
      targetId,
      targetType: category,
      worldId: worldId ?? (category === 'world' ? targetId : null),
    };
  }

  private async idempotent(
    actor: AuthenticatedActor,
    command: ReturnType<typeof buildCommand>,
    status: number,
    operation: (repository: PostgresRepository) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const result = await this.repository.transaction(async (repository) => {
      const identity = {
        actorId: command.actorUserId,
        expiresAt: new Date(this.clock.now().getTime() + 86_400_000),
        key: command.idempotencyKey,
        requestHash: command.requestHashBytes,
        scope: command.action,
      };
      let started;
      try {
        started = await repository.beginIdempotency(identity);
      } catch (error) {
        telemetry.idempotency.add(1, { outcome: 'conflict' });
        throw error;
      }
      if (started.kind === 'replay') {
        telemetry.idempotency.add(1, { outcome: 'replay' });
        return { body: started.body, rejection: decodeDurableLegacyRejection(started.body) };
      }
      telemetry.idempotency.add(1, { outcome: 'new' });
      let body: Record<string, unknown>;
      try {
        body = await operation(repository);
      } catch (error) {
        if (!(error instanceof ApplicationError) || !command.resourceId) throw error;
        if (typeof repository.rejectLegacyMutation !== 'function') throw error;
        if (
          error.statusCode === 403 &&
          !['creator_override.use', 'membership.change_role', 'membership.remove'].includes(
            command.action,
          )
        ) {
          const reasonCode =
            typeof error.details?.reasonCode === 'string' ? error.details.reasonCode : error.code;
          const ruleId =
            typeof error.details?.ruleId === 'string'
              ? error.details.ruleId
              : 'authority.target_denied';
          await repository.insertAudit({
            action: command.action,
            actorUserId: actor.user.id,
            category: 'authority',
            correlationId: command.correlationId,
            id: derivedLegacyLedgerUuid(command.commandId, 'security-audit:denied'),
            metadata: redactAuditMetadata({
              authorityReasonCode: reasonCode,
              authorityRuleId: ruleId,
            }),
            outcome: 'denied',
            reasonCode,
            requestId: command.requestId,
            targetId: command.resourceId,
            targetType: 'world',
            worldId: command.resourceId,
          });
          telemetry.authorizationDecisions.add(1, { action: command.action, outcome: 'denied' });
        }
        const appended = await repository.rejectLegacyMutation({
          actorType: this.ledgerActorType(actor),
          command,
          decidedAt: this.clock.now(),
          rejectionCode: legacyLedgerRejectionCode(error),
          worldId: command.resourceId,
        });
        if (appended.kind === 'unanchored') throw error;
        const body = encodeDurableLegacyRejection(error);
        await repository.completeIdempotency(identity, error.statusCode, body);
        return { body, rejection: error };
      }
      await repository.completeIdempotency(identity, status, body);
      return { body, rejection: null };
    });
    if (result.rejection) throw result.rejection;
    return result.body;
  }

  private legacyLedgerContext(
    actor: AuthenticatedActor,
    command: ReturnType<typeof buildCommand>,
    authorizationRuleId: string,
    overrideId: string | null = null,
  ): LegacyMutationCommandContext {
    return {
      actorType: this.ledgerActorType(actor),
      authorizationRuleId,
      command,
      decidedAt: this.clock.now(),
      overrideId,
    };
  }

  private ledgerActorType(actor: AuthenticatedActor): LegacyMutationCommandContext['actorType'] {
    return actor.user.platformRole === 'platform_admin' ? 'platform_admin' : 'user';
  }

  private async publish<
    T extends Exclude<ApplicationNotification['type'], 'IdentityRegistered' | 'WorldCreated'>,
  >(type: T, payload: Extract<ApplicationNotification, { type: T }>['payload']): Promise<void> {
    await this.notifications.publish({
      id: this.ids.next(),
      occurredAt: this.clock.now().toISOString(),
      payload,
      schemaVersion: 1,
      type,
    } as Extract<ApplicationNotification, { type: T }>);
  }
}

function cleanWorldName(value: string): string {
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < 2 || normalized.length > 100 || containsControlCharacters(normalized)) {
    throw new ApplicationError('VALIDATION_FAILED', 'The world name is invalid.', 400);
  }
  return normalized;
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 63)
    .replace(/-$/u, '');
  if (slug.length >= 3) return slug;
  return `world-${slug || 'new'}`;
}
