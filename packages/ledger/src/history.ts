import {
  HISTORY_SCHEMA_VERSION,
  createValidator,
  DomainEventEnvelopeV1Schema,
  LedgerEntryV1Schema,
  type DomainEventEnvelopeV1,
  type JsonValue,
  type LedgerEntryV1,
  type LedgerVisibility,
  type Validator,
  type WorldCommandEnvelopeV1,
  type WorldCommandResultV1,
  type WorldHistoryEntryV1,
} from '@worldgraph/contracts';

export const HISTORY_TEMPLATES_V1 = {
  'history.authority.creator_override': 'A creator override was used for {targetType} {targetId}.',
  'history.command.accepted': '{commandType} was accepted.',
  'history.command.rejected': '{commandType} was rejected with {rejectionCode}.',
  'history.entity.renamed': '{entityType} {entityKey} was renamed to {newDisplayName}.',
  'history.economy.currency_frozen': 'A world currency was frozen at version {currencyVersion}.',
  'history.economy.currency_issued': 'A creator-authorized currency issuance was recorded.',
  'history.economy.currency_transferred': 'A participant currency transfer was recorded.',
  'history.economy.currency_unfrozen':
    'A world currency was unfrozen at version {currencyVersion}.',
  'history.economy.initialized':
    'The closed-loop economy was initialized from seed plan schema {seedPlanSchemaVersion}.',
  'history.economy.legacy_seed_adopted':
    'A reviewed legacy economy seed plan was adopted with {adapterId}.',
  'history.economy.reconciled':
    'Economy reconciliation finished with status {status} and {mismatchCount} mismatches.',
  'history.economy.repair_applied':
    'An audited append-only economy repair was applied ({repairKind}).',
  'history.economy.wallet_frozen': 'A participant wallet was frozen at version {walletVersion}.',
  'history.economy.wallet_unfrozen':
    'A participant wallet was unfrozen at version {walletVersion}.',
  'history.commerce.initialized': 'Closed-loop production and commerce were initialized.',
  'history.commerce.business_created': 'A business specialization was created.',
  'history.commerce.facility_configured': 'A business production facility was configured.',
  'history.commerce.contract_created': 'A private employment offer was created.',
  'history.commerce.contract_accepted': 'A private employment offer was accepted.',
  'history.commerce.contract_ended': 'A private employment contract ended.',
  'history.commerce.work_recorded': 'A private work record was accepted.',
  'history.commerce.payroll_settled': 'A private payroll settlement completed.',
  'history.commerce.payroll_failed': 'A private payroll settlement failed.',
  'history.commerce.production_started': 'A deterministic production run started.',
  'history.commerce.resources_consumed': 'Reserved production inputs were consumed.',
  'history.commerce.resources_produced': 'Production outputs were credited.',
  'history.commerce.production_failed': 'A production run failed without duplicate output.',
  'history.commerce.listing_changed': 'A fixed-price market listing changed to {status}.',
  'history.commerce.inventory_transferred': 'Listed inventory was transferred atomically.',
  'history.commerce.trade_completed': 'A fixed-price market trade completed.',
  'history.commerce.tax_assessed': 'A configured fictional tax was assessed.',
  'history.commerce.treasury_revenue': 'Tax revenue was recorded in the public treasury.',
  'history.commerce.reconciled':
    'Closed-loop economy reconciliation finished with {mismatchCount} mismatches.',
  'history.commerce.projection_repaired':
    'An approved commerce projection repair applied {repairFactCount} immutable repair facts.',
  'history.genesis.compiled': 'The compiled world was anchored at version {worldVersionNumber}.',
  'history.genesis.imported':
    'The existing world state was truthfully imported at version {worldVersionNumber}.',
  'history.governance.ballot_recorded':
    'A {ballotMode} ballot receipt was recorded for a {contestType}.',
  'history.governance.candidacy_changed':
    'A candidacy changed to {status} for election {electionId}.',
  'history.governance.initialized':
    'World governance was initialized from seed plan {seedPlanHash}.',
  'history.governance.law_activated':
    'Law version {lawVersion} became authoritative at tick {effectiveFromTick}.',
  'history.governance.lifecycle_changed':
    'A {aggregateType} changed to {status} at tick {occurredTick}.',
  'history.governance.override_executed':
    'An explicit {actorMode} governance override was executed ({reasonCode}).',
  'history.governance.repair_appended': 'A linked governance repair was appended ({repairKind}).',
  'history.governance.result_finalized': 'An immutable {aggregateType} result was finalized.',
  'history.governance.seed_plan_adopted':
    'A reviewed governance seed plan was adopted ({adoptionReasonHash}).',
  'history.governance.term_changed': 'Office seat {seatIndex} term status changed to {status}.',
  'history.invitation.accepted': 'Invitation {invitationId} was accepted.',
  'history.invitation.created': 'Invitation {invitationId} was created for role {intendedRole}.',
  'history.invitation.revoked': 'Invitation {invitationId} was revoked.',
  'history.manifest.approved': 'Manifest revision {revisionId} was approved.',
  'history.manifest.revision_created': 'Manifest revision {revisionId} was created.',
  'history.membership.removed': 'Membership {targetUserId} was removed.',
  'history.membership.role_changed':
    'Membership {targetUserId} changed from {previousRole} to {newRole}.',
  'history.ownership.asset_transferred': 'Asset {assetKey} ownership changed by {transferKind}.',
  'history.ownership.offer_accepted': 'A direct asset transfer offer was accepted.',
  'history.ownership.offer_cancelled': 'A direct asset transfer offer was cancelled.',
  'history.ownership.offer_created':
    'A direct asset transfer offer was created for expiry tick {expiresAtTick}.',
  'history.ownership.offer_expired': 'A direct asset transfer offer expired.',
  'history.ownership.purchase_recorded': 'An atomic asset purchase was recorded.',
  'history.repair.projection_anchored':
    'A projection repair anchor was appended for {projectionName}.',
  'history.simulation.advanced': 'Simulation advanced from tick {fromTick} to {toTick}.',
  'history.simulation.clock_auto_paused':
    'The world clock auto-paused at tick {tick} after {errorCode}.',
  'history.simulation.clock_configured': 'The world clock was configured at tick {tick}.',
  'history.simulation.clock_paused': 'The world clock was paused at tick {tick}.',
  'history.simulation.clock_started': 'The world clock was started at tick {tick}.',
  'history.simulation.failure_recorded':
    'Simulation failure {errorCode} was recorded at tick {tick}.',
  'history.simulation.failure_resolved':
    'Simulation failure {failureId} was resolved with {resolution}.',
  'history.simulation.initialized': 'World simulation was initialized at tick {currentTick}.',
  'history.simulation.notice_emitted':
    'A {visibility} world notice was emitted at tick {emittedAtTick}.',
  'history.simulation.schedule_cancelled': 'Scheduled action {scheduleId} was cancelled.',
  'history.simulation.schedule_created':
    'Scheduled action {scheduleId} was created for tick {dueTick}.',
  'history.simulation.schedule_executed':
    'Scheduled action {scheduleId} was executed at tick {dueTick}.',
  'history.world.renamed': 'The world was renamed from {previousName} to {newName}.',
} as const;

export type HistoryTemplateKeyV1 = keyof typeof HISTORY_TEMPLATES_V1;

const eventValidator: Validator<DomainEventEnvelopeV1> = createValidator<DomainEventEnvelopeV1>(
  DomainEventEnvelopeV1Schema,
);
const ledgerEntryValidator: Validator<LedgerEntryV1> =
  createValidator<LedgerEntryV1>(LedgerEntryV1Schema);

function historyFields(event: DomainEventEnvelopeV1): {
  category: WorldHistoryEntryV1['category'];
  summaryArgs: Record<string, JsonValue>;
  targetId: string | null;
  targetType: string | null;
  titleKey: HistoryTemplateKeyV1;
  visibility: LedgerVisibility;
} {
  switch (event.eventType) {
    case 'WorldStateImportedV1':
      return {
        category: 'genesis',
        summaryArgs: {
          artifactHash: event.payload.artifactHash,
          controllers: event.payload.rowCounts.controllers,
          entities: event.payload.rowCounts.entities,
          relationships: event.payload.rowCounts.relationships,
          worldVersionNumber: event.payload.worldVersionNumber,
        },
        targetId: event.payload.activeWorldVersionId,
        targetType: 'world_version',
        titleKey: 'history.genesis.imported',
        visibility: 'member',
      };
    case 'WorldCompiledGenesisV1':
      return {
        category: 'genesis',
        summaryArgs: {
          artifactHash: event.payload.artifactHash,
          controllers: event.payload.rowCounts.controllers,
          entities: event.payload.rowCounts.entities,
          relationships: event.payload.rowCounts.relationships,
          worldVersionNumber: event.payload.worldVersionNumber,
        },
        targetId: event.payload.activeWorldVersionId,
        targetType: 'world_version',
        titleKey: 'history.genesis.compiled',
        visibility: 'member',
      };
    case 'WorldEntityRenamedV1':
      return {
        category: 'entity',
        summaryArgs: {
          entityKey: event.payload.entityKey,
          entityType: event.payload.entityType,
          newDisplayName: event.payload.newDisplayName,
          previousDisplayName: event.payload.previousDisplayName,
        },
        targetId: event.payload.entityKey,
        targetType: 'world_entity',
        titleKey: 'history.entity.renamed',
        visibility: 'member',
      };
    case 'WorldRenamedV1':
      return {
        category: 'world',
        summaryArgs: {
          newName: event.payload.newName,
          previousName: event.payload.previousName,
        },
        targetId: event.worldId,
        targetType: 'world',
        titleKey: 'history.world.renamed',
        visibility: 'member',
      };
    case 'WorldMembershipRoleChangedV1':
      return {
        category: 'membership',
        summaryArgs: {
          newRole: event.payload.newRole,
          previousRole: event.payload.previousRole,
          targetUserId: event.payload.targetUserId,
        },
        targetId: event.payload.targetUserId,
        targetType: 'world_membership',
        titleKey: 'history.membership.role_changed',
        visibility: 'creator',
      };
    case 'WorldMembershipRemovedV1':
      return {
        category: 'membership',
        summaryArgs: {
          previousRole: event.payload.previousRole,
          targetUserId: event.payload.targetUserId,
        },
        targetId: event.payload.targetUserId,
        targetType: 'world_membership',
        titleKey: 'history.membership.removed',
        visibility: 'creator',
      };
    case 'WorldInvitationCreatedV1':
      return {
        category: 'invitation',
        summaryArgs: {
          intendedRole: event.payload.intendedRole,
          invitationId: event.payload.invitationId,
        },
        targetId: event.payload.invitationId,
        targetType: 'world_invitation',
        titleKey: 'history.invitation.created',
        visibility: 'creator',
      };
    case 'WorldInvitationRevokedV1':
      return {
        category: 'invitation',
        summaryArgs: {
          intendedRole: event.payload.intendedRole,
          invitationId: event.payload.invitationId,
        },
        targetId: event.payload.invitationId,
        targetType: 'world_invitation',
        titleKey: 'history.invitation.revoked',
        visibility: 'creator',
      };
    case 'WorldInvitationAcceptedV1':
      return {
        category: 'invitation',
        summaryArgs: {
          intendedRole: event.payload.intendedRole,
          invitationId: event.payload.invitationId,
          targetUserId: event.payload.targetUserId,
        },
        targetId: event.payload.invitationId,
        targetType: 'world_invitation',
        titleKey: 'history.invitation.accepted',
        visibility: 'creator',
      };
    case 'ManifestRevisionCreatedV1':
      return {
        category: 'manifest',
        summaryArgs: {
          contentHash: event.payload.contentHash,
          revisionId: event.payload.revisionId,
          revisionNumber: event.payload.revisionNumber,
        },
        targetId: event.payload.revisionId,
        targetType: 'manifest_revision',
        titleKey: 'history.manifest.revision_created',
        visibility: 'member',
      };
    case 'ManifestApprovedV1':
      return {
        category: 'manifest',
        summaryArgs: {
          contentHash: event.payload.contentHash,
          revisionId: event.payload.revisionId,
        },
        targetId: event.payload.revisionId,
        targetType: 'manifest_revision',
        titleKey: 'history.manifest.approved',
        visibility: 'member',
      };
    case 'CreatorOverrideUsedV1':
      return {
        category: 'authority',
        summaryArgs: {
          commandType: event.payload.commandType,
          overrideUsed: true,
          reasonCode: event.payload.reasonCode,
          targetId: event.payload.targetId,
          targetType: event.payload.targetType,
        },
        targetId: event.payload.targetId,
        targetType: event.payload.targetType,
        titleKey: 'history.authority.creator_override',
        visibility: 'creator',
      };
    case 'ProjectionRepairAnchoredV1':
      return {
        category: 'repair',
        summaryArgs: {
          fromChecksum: event.payload.fromChecksum,
          projectionName: event.payload.projectionName,
          reasonCode: event.payload.reasonCode,
          toChecksum: event.payload.toChecksum,
        },
        targetId: event.payload.projectionName,
        targetType: 'projection',
        titleKey: 'history.repair.projection_anchored',
        visibility: 'operator',
      };
    case 'WorldSimulationInitializedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          currentTick: event.payload.currentTick,
          processRegistryVersion: event.payload.processRegistryVersion,
          provenance: event.payload.provenance,
        },
        targetId: event.worldId,
        targetType: 'world_simulation',
        titleKey: 'history.simulation.initialized',
        visibility: 'member',
      };
    case 'WorldClockConfiguredV1':
      return {
        category: 'simulation',
        summaryArgs: { tick: event.payload.tick },
        targetId: event.worldId,
        targetType: 'world_clock',
        titleKey: 'history.simulation.clock_configured',
        visibility: 'creator',
      };
    case 'WorldClockStartedV1':
      return {
        category: 'simulation',
        summaryArgs: { tick: event.payload.tick },
        targetId: event.worldId,
        targetType: 'world_clock',
        titleKey: 'history.simulation.clock_started',
        visibility: 'member',
      };
    case 'WorldClockPausedV1':
      return {
        category: 'simulation',
        summaryArgs: { reason: event.payload.reason, tick: event.payload.tick },
        targetId: event.worldId,
        targetType: 'world_clock',
        titleKey: 'history.simulation.clock_paused',
        visibility: 'member',
      };
    case 'SimulationAdvancedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          executedScheduleCount: event.payload.executedScheduleCount,
          fromTick: event.payload.fromTick,
          tickCount: event.payload.tickCount,
          toTick: event.payload.toTick,
        },
        targetId: event.worldId,
        targetType: 'world_simulation',
        titleKey: 'history.simulation.advanced',
        visibility: 'member',
      };
    case 'ScheduledActionCreatedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          actionType: event.payload.actionType,
          dueTick: event.payload.dueTick,
          priority: event.payload.priority,
          scheduleId: event.payload.scheduleId,
          scheduleSequence: event.payload.scheduleSequence,
          ...(event.payload.actionType === 'EmitWorldNoticeV1'
            ? { visibility: event.payload.payload.visibility }
            : {}),
        },
        targetId: event.payload.scheduleId,
        targetType: 'scheduled_action',
        titleKey: 'history.simulation.schedule_created',
        visibility: 'creator',
      };
    case 'ScheduledActionCancelledV1':
      return {
        category: 'simulation',
        summaryArgs: {
          actionType: event.payload.actionType,
          dueTick: event.payload.dueTick,
          scheduleId: event.payload.scheduleId,
          scheduleSequence: event.payload.scheduleSequence,
        },
        targetId: event.payload.scheduleId,
        targetType: 'scheduled_action',
        titleKey: 'history.simulation.schedule_cancelled',
        visibility: 'creator',
      };
    case 'ScheduledActionExecutedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          actionType: event.payload.actionType,
          dueTick: event.payload.dueTick,
          processVersion: event.payload.processVersion,
          scheduleId: event.payload.scheduleId,
          scheduleSequence: event.payload.scheduleSequence,
        },
        targetId: event.payload.scheduleId,
        targetType: 'scheduled_action',
        titleKey: 'history.simulation.schedule_executed',
        visibility: 'creator',
      };
    case 'WorldNoticeEmittedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          emittedAtTick: event.payload.emittedAtTick,
          scheduleId: event.payload.scheduleId,
          visibility: event.payload.visibility,
        },
        targetId: event.payload.scheduleId,
        targetType: 'world_notice',
        titleKey: 'history.simulation.notice_emitted',
        visibility: event.payload.visibility,
      };
    case 'SimulationFailureRecordedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          attempts: event.payload.attempts,
          errorCode: event.payload.errorCode,
          processType: event.payload.processType,
          processVersion: event.payload.processVersion,
          scheduleId: event.payload.scheduleId,
          tick: event.payload.tick,
        },
        targetId: event.aggregateId,
        targetType: 'simulation_failure',
        titleKey: 'history.simulation.failure_recorded',
        visibility: 'creator',
      };
    case 'SimulationFailureResolvedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          failureId: event.payload.failureId,
          resolution: event.payload.resolution,
          scheduleId: event.payload.scheduleId,
          tick: event.payload.tick,
        },
        targetId: event.payload.failureId,
        targetType: 'simulation_failure',
        titleKey: 'history.simulation.failure_resolved',
        visibility: 'creator',
      };
    case 'WorldClockAutoPausedV1':
      return {
        category: 'simulation',
        summaryArgs: {
          errorCode: event.payload.errorCode,
          failureId: event.payload.failureId,
          tick: event.payload.tick,
        },
        targetId: event.payload.failureId,
        targetType: 'simulation_failure',
        titleKey: 'history.simulation.clock_auto_paused',
        visibility: 'creator',
      };
    case 'LegacyEconomySeedPlanAdoptedV1':
      return {
        category: 'economy',
        summaryArgs: {
          adapterId: event.payload.adapterId,
          adapterVersion: event.payload.adapterVersion,
          compiledWorldVersionId: event.payload.compiledWorldVersionId,
        },
        targetId: event.payload.compiledWorldVersionId,
        targetType: 'compiled_economy_seed_plan',
        titleKey: 'history.economy.legacy_seed_adopted',
        visibility: 'creator',
      };
    case 'WorldEconomyInitializedV1':
      return {
        category: 'economy',
        summaryArgs: {
          assetCount: event.payload.assetCount,
          ownershipCount: event.payload.ownershipCount,
          seedPlanSchemaVersion: event.payload.seedPlanSchemaVersion,
          walletCount: event.payload.walletCount,
        },
        targetId: event.worldId,
        targetType: 'world_economy',
        titleKey: 'history.economy.initialized',
        visibility: 'member',
      };
    case 'WorldEconomyReconciledV1':
      return {
        category: 'economy',
        summaryArgs: {
          checkedStateRevision: event.payload.checkedStateRevision,
          mismatchCount: event.payload.mismatchCount,
          status: event.payload.status,
        },
        targetId: event.payload.runId,
        targetType: 'economy_reconciliation',
        titleKey: 'history.economy.reconciled',
        visibility: 'member',
      };
    case 'WorldEconomyRepairedV1':
      return {
        category: 'repair',
        summaryArgs: {
          reasonCode: event.payload.reasonCode,
          repairKind: event.payload.repairKind,
        },
        targetId: event.worldId,
        targetType: 'world_economy',
        titleKey: 'history.economy.repair_applied',
        visibility: 'member',
      };
    case 'CurrencyIssuedV1':
      return {
        category: 'economy',
        summaryArgs: { operation: 'creator_issuance' },
        targetId: event.payload.currencyId,
        targetType: 'currency',
        titleKey: 'history.economy.currency_issued',
        visibility: 'creator',
      };
    case 'CurrencyTransferredV1':
      return {
        category: 'economy',
        summaryArgs: { transactionId: event.payload.transactionId },
        targetId: event.payload.transactionId,
        targetType: 'financial_transaction',
        titleKey: 'history.economy.currency_transferred',
        visibility: 'participant',
      };
    case 'CurrencyFrozenV1':
      return {
        category: 'economy',
        summaryArgs: {
          currencyId: event.payload.currencyId,
          currencyVersion: event.payload.currencyVersion,
        },
        targetId: event.payload.currencyId,
        targetType: 'currency',
        titleKey: 'history.economy.currency_frozen',
        visibility: 'member',
      };
    case 'CurrencyUnfrozenV1':
      return {
        category: 'economy',
        summaryArgs: {
          currencyId: event.payload.currencyId,
          currencyVersion: event.payload.currencyVersion,
        },
        targetId: event.payload.currencyId,
        targetType: 'currency',
        titleKey: 'history.economy.currency_unfrozen',
        visibility: 'member',
      };
    case 'WalletFrozenV1':
      return {
        category: 'economy',
        summaryArgs: { walletVersion: event.payload.walletVersion },
        targetId: event.payload.walletId,
        targetType: 'wallet',
        titleKey: 'history.economy.wallet_frozen',
        visibility: 'participant',
      };
    case 'WalletUnfrozenV1':
      return {
        category: 'economy',
        summaryArgs: { walletVersion: event.payload.walletVersion },
        targetId: event.payload.walletId,
        targetType: 'wallet',
        titleKey: 'history.economy.wallet_unfrozen',
        visibility: 'participant',
      };
    case 'AssetOwnershipTransferredV1':
      return {
        category: 'ownership',
        summaryArgs: {
          assetKey: event.payload.assetKey,
          ownershipVersion: event.payload.ownershipVersion,
          transferKind: event.payload.transferKind,
        },
        targetId: event.payload.assetId,
        targetType: 'asset',
        titleKey: 'history.ownership.asset_transferred',
        visibility: 'member',
      };
    case 'AssetTransferOfferCreatedV1':
      return {
        category: 'ownership',
        summaryArgs: {
          expiresAtTick: event.payload.expiresAtTick,
          offerId: event.payload.offerId,
        },
        targetId: event.payload.offerId,
        targetType: 'asset_transfer_offer',
        titleKey: 'history.ownership.offer_created',
        visibility: 'participant',
      };
    case 'AssetTransferOfferCancelledV1':
      return {
        category: 'ownership',
        summaryArgs: {
          offerId: event.payload.offerId,
          offerVersion: event.payload.offerVersion,
        },
        targetId: event.payload.offerId,
        targetType: 'asset_transfer_offer',
        titleKey: 'history.ownership.offer_cancelled',
        visibility: 'participant',
      };
    case 'AssetTransferOfferAcceptedV1':
      return {
        category: 'ownership',
        summaryArgs: {
          offerId: event.payload.offerId,
          offerVersion: event.payload.offerVersion,
        },
        targetId: event.payload.offerId,
        targetType: 'asset_transfer_offer',
        titleKey: 'history.ownership.offer_accepted',
        visibility: 'participant',
      };
    case 'AssetTransferOfferExpiredV1':
      return {
        category: 'ownership',
        summaryArgs: {
          expiredAtTick: event.payload.expiredAtTick,
          offerId: event.payload.offerId,
          offerVersion: event.payload.offerVersion,
        },
        targetId: event.payload.offerId,
        targetType: 'asset_transfer_offer',
        titleKey: 'history.ownership.offer_expired',
        visibility: 'participant',
      };
    case 'AssetPurchasedV1':
      return {
        category: 'ownership',
        summaryArgs: {
          assetId: event.payload.assetId,
          offerId: event.payload.offerId,
        },
        targetId: event.payload.assetId,
        targetType: 'asset',
        titleKey: 'history.ownership.purchase_recorded',
        visibility: 'participant',
      };
    case 'WorldCommerceInitializedV1':
      return {
        category: 'economy',
        summaryArgs: {
          businessCount: event.payload.businessCount,
          inventoryCount: event.payload.inventoryCount,
          resourceTypeCount: event.payload.resourceTypeCount,
        },
        targetId: event.worldId,
        targetType: 'world_commerce',
        titleKey: 'history.commerce.initialized',
        visibility: 'member',
      };
    case 'BusinessCreatedV1':
      return {
        category: 'economy',
        summaryArgs: { businessId: event.payload.businessId },
        targetId: event.payload.businessId,
        targetType: 'business',
        titleKey: 'history.commerce.business_created',
        visibility: 'member',
      };
    case 'BusinessFacilityConfiguredV1':
      return {
        category: 'economy',
        summaryArgs: { facilityId: event.payload.facilityId },
        targetId: event.payload.facilityId,
        targetType: 'business_facility',
        titleKey: 'history.commerce.facility_configured',
        visibility: 'member',
      };
    case 'EmploymentContractCreatedV1':
    case 'EmploymentContractAcceptedV1':
    case 'EmploymentContractEndedV1':
      return {
        category: 'economy',
        summaryArgs: { contractId: event.payload.contractId, status: event.payload.status },
        targetId: event.payload.contractId,
        targetType: 'employment_contract',
        titleKey:
          event.eventType === 'EmploymentContractCreatedV1'
            ? 'history.commerce.contract_created'
            : event.eventType === 'EmploymentContractAcceptedV1'
              ? 'history.commerce.contract_accepted'
              : 'history.commerce.contract_ended',
        visibility: 'participant',
      };
    case 'WorkRecordedV1':
      return {
        category: 'economy',
        summaryArgs: { contractId: event.payload.contractId },
        targetId: event.payload.workRecordId,
        targetType: 'work_record',
        titleKey: 'history.commerce.work_recorded',
        visibility: 'participant',
      };
    case 'PayrollSettledV1':
      return {
        category: 'economy',
        summaryArgs: { payrollRecordId: event.payload.payrollRecordId },
        targetId: event.payload.payrollRecordId,
        targetType: 'payroll_record',
        titleKey: 'history.commerce.payroll_settled',
        visibility: 'participant',
      };
    case 'PayrollFailedV1':
      return {
        category: 'economy',
        summaryArgs: {
          errorCode: event.payload.errorCode,
          payrollRecordId: event.payload.payrollRecordId,
        },
        targetId: event.payload.payrollRecordId,
        targetType: 'payroll_record',
        titleKey: 'history.commerce.payroll_failed',
        visibility: 'participant',
      };
    case 'ProductionRunStartedV1':
      return {
        category: 'economy',
        summaryArgs: {
          dueTick: event.payload.dueTick,
          productionRunId: event.payload.productionRunId,
        },
        targetId: event.payload.productionRunId,
        targetType: 'production_run',
        titleKey: 'history.commerce.production_started',
        visibility: 'member',
      };
    case 'ResourcesConsumedV1':
    case 'ResourcesProducedV1':
      return {
        category: 'economy',
        summaryArgs: { productionRunId: event.payload.productionRunId },
        targetId: event.payload.productionRunId,
        targetType: 'production_run',
        titleKey:
          event.eventType === 'ResourcesConsumedV1'
            ? 'history.commerce.resources_consumed'
            : 'history.commerce.resources_produced',
        visibility: 'member',
      };
    case 'ProductionFailedV1':
      return {
        category: 'economy',
        summaryArgs: {
          errorCode: event.payload.errorCode,
          productionRunId: event.payload.productionRunId,
        },
        targetId: event.payload.productionRunId,
        targetType: 'production_run',
        titleKey: 'history.commerce.production_failed',
        visibility: 'member',
      };
    case 'MarketListingCreatedV1':
    case 'MarketListingCancelledV1':
    case 'MarketListingExpiredV1':
    case 'MarketListingPartiallyFilledV1':
    case 'MarketListingFilledV1':
      return {
        category: 'economy',
        summaryArgs: { listingId: event.payload.listingId, status: event.payload.status },
        targetId: event.payload.listingId,
        targetType: 'market_listing',
        titleKey: 'history.commerce.listing_changed',
        visibility: 'member',
      };
    case 'InventoryTransferredV1':
      return {
        category: 'economy',
        summaryArgs: { tradeId: event.payload.tradeId },
        targetId: event.payload.tradeId,
        targetType: 'market_trade',
        titleKey: 'history.commerce.inventory_transferred',
        visibility: 'member',
      };
    case 'MarketTradeCompletedV1':
      return {
        category: 'economy',
        summaryArgs: { listingId: event.payload.listingId, tradeId: event.payload.tradeId },
        targetId: event.payload.tradeId,
        targetType: 'market_trade',
        titleKey: 'history.commerce.trade_completed',
        visibility: 'member',
      };
    case 'TaxAssessedV1':
      return {
        category: 'economy',
        summaryArgs: { assessmentId: event.payload.assessmentId },
        targetId: event.payload.assessmentId,
        targetType: 'tax_assessment',
        titleKey: 'history.commerce.tax_assessed',
        visibility: 'member',
      };
    case 'TreasuryRevenueRecordedV1':
      return {
        category: 'economy',
        summaryArgs: { assessmentId: event.payload.assessmentId },
        targetId: event.payload.treasuryWalletId,
        targetType: 'treasury',
        titleKey: 'history.commerce.treasury_revenue',
        visibility: 'member',
      };
    case 'WorldCommerceReconciledV1':
      return {
        category: 'economy',
        summaryArgs: {
          mismatchCount: event.payload.mismatchCount,
          status: event.payload.status,
        },
        targetId: event.payload.reconciliationRunId,
        targetType: 'commerce_reconciliation',
        titleKey: 'history.commerce.reconciled',
        visibility: 'member',
      };
    case 'WorldCommerceProjectionRepairedV1':
      return {
        category: 'repair',
        summaryArgs: {
          repairFactCount: event.payload.repairFactCount,
        },
        targetId: event.payload.repairPlanId,
        targetType: 'commerce_projection_repair',
        titleKey: 'history.commerce.projection_repaired',
        visibility: 'operator',
      };
    case 'ProposalBallotRecordedPublicV1':
      return {
        category: 'governance',
        summaryArgs: {
          ballotMode: 'public',
          contestType: 'proposal',
          disclosure: event.payload.disclosure,
          turnoutCount: event.payload.turnoutCount,
          ...('receiptHash' in event.payload ? { receiptHash: event.payload.receiptHash } : {}),
        },
        targetId: event.payload.proposalId,
        targetType: 'proposal',
        titleKey: 'history.governance.ballot_recorded',
        visibility: 'member',
      };
    case 'ProposalBallotRecordedSecretV1':
      return {
        category: 'governance',
        summaryArgs: {
          ballotMode: 'secret',
          contestType: 'proposal',
          receiptHash: event.payload.receiptHash,
        },
        targetId: event.payload.proposalId,
        targetType: 'proposal',
        titleKey: 'history.governance.ballot_recorded',
        visibility: 'member',
      };
    case 'ElectionBallotRecordedPublicV1':
      return {
        category: 'governance',
        summaryArgs: {
          ballotMode: 'public',
          contestType: 'election',
          disclosure: event.payload.disclosure,
          turnoutCount: event.payload.turnoutCount,
          ...('receiptHash' in event.payload ? { receiptHash: event.payload.receiptHash } : {}),
        },
        targetId: event.payload.electionId,
        targetType: 'election',
        titleKey: 'history.governance.ballot_recorded',
        visibility: 'member',
      };
    case 'ElectionBallotRecordedSecretV1':
      return {
        category: 'governance',
        summaryArgs: {
          ballotMode: 'secret',
          contestType: 'election',
          receiptHash: event.payload.receiptHash,
        },
        targetId: event.payload.electionId,
        targetType: 'election',
        titleKey: 'history.governance.ballot_recorded',
        visibility: 'member',
      };
    case 'GovernanceLifecycleChangedV1':
      return {
        category: 'governance',
        summaryArgs: {
          aggregateType: event.payload.aggregateType,
          occurredTick: event.payload.occurredTick,
          status: event.payload.status,
        },
        targetId: event.payload.aggregateId,
        targetType: event.payload.aggregateType,
        titleKey: 'history.governance.lifecycle_changed',
        visibility: 'public',
      };
    case 'WorldGovernanceInitializedV1':
      return {
        category: 'governance',
        summaryArgs: {
          seedPlanHash: event.payload.seedPlanHash,
          sourceWorldVersionId: event.payload.sourceWorldVersionId,
        },
        targetId: event.worldId,
        targetType: 'world_governance',
        titleKey: 'history.governance.initialized',
        visibility: 'public',
      };
    case 'GovernanceSeedPlanAdoptedV1':
      return {
        category: 'governance',
        summaryArgs: {
          adoptionReasonHash: event.payload.adoptionReasonHash,
          seedPlanHash: event.payload.seedPlanHash,
        },
        targetId: event.worldId,
        targetType: 'world_governance',
        titleKey: 'history.governance.seed_plan_adopted',
        visibility: 'public',
      };
    case 'GovernanceCandidacyChangedV1':
      return {
        category: 'governance',
        summaryArgs: {
          electionId: event.payload.electionId,
          status: event.payload.status,
        },
        targetId: event.payload.candidacyId,
        targetType: 'candidacy',
        titleKey: 'history.governance.candidacy_changed',
        visibility: 'public',
      };
    case 'GovernanceResultFinalizedV1':
      return {
        category: 'governance',
        summaryArgs: {
          aggregateType: event.payload.aggregateType,
          inputChecksum: event.payload.inputChecksum,
          resultChecksum: event.payload.resultChecksum,
        },
        targetId: event.payload.resultId,
        targetType: `${event.payload.aggregateType}_result`,
        titleKey: 'history.governance.result_finalized',
        visibility: 'public',
      };
    case 'GovernanceLawVersionActivatedV1':
      return {
        category: 'governance',
        summaryArgs: {
          effectiveFromTick: event.payload.effectiveFromTick,
          lawVersion: event.payload.lawVersion,
        },
        targetId: event.payload.lawId,
        targetType: 'law',
        titleKey: 'history.governance.law_activated',
        visibility: 'public',
      };
    case 'GovernanceOfficeTermChangedV1':
      return {
        category: 'governance',
        summaryArgs: {
          seatIndex: event.payload.seatIndex,
          status: event.payload.status,
        },
        targetId: event.payload.termId,
        targetType: 'office_term',
        titleKey: 'history.governance.term_changed',
        visibility: 'public',
      };
    case 'GovernanceOverrideExecutedV1':
      return {
        category: 'governance',
        summaryArgs: {
          actorMode: event.payload.actorMode,
          impactHash: event.payload.impactHash,
          overrideUsed: true,
          reasonCode: event.payload.reasonCode,
        },
        targetId: event.payload.overrideId,
        targetType: 'governance_override',
        titleKey: 'history.governance.override_executed',
        visibility: 'public',
      };
    case 'GovernanceRepairAppendedV1':
      return {
        category: 'governance',
        summaryArgs: {
          repairKind: event.payload.repairKind,
          replacementResultChecksum: event.payload.replacementResultChecksum,
          sourceResultId: event.payload.sourceResultId,
        },
        targetId: event.payload.repairId,
        targetType: 'governance_repair',
        titleKey: 'history.governance.repair_appended',
        visibility: 'public',
      };
  }
}

export function projectWorldHistoryEntryV1(
  event: DomainEventEnvelopeV1,
  ledgerEntry: LedgerEntryV1,
): WorldHistoryEntryV1 {
  if (!eventValidator.is(event)) throw new TypeError('Invalid domain event contract.');
  if (!ledgerEntryValidator.is(ledgerEntry)) throw new TypeError('Invalid ledger entry contract.');
  if (ledgerEntry.eventId !== event.eventId) {
    throw new Error('History ledger/event link mismatch.');
  }
  if (ledgerEntry.worldId !== event.worldId) {
    throw new Error('History world scope mismatch.');
  }
  const fields = historyFields(event);
  return {
    actor: event.metadata.actor,
    category: fields.category,
    commandId: event.commandId,
    correlationId: event.metadata.correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    historySchemaVersion: HISTORY_SCHEMA_VERSION,
    ledgerSequence: ledgerEntry.ledgerSequence,
    occurredAt: event.occurredAt,
    resultingStateRevision: event.resultingStateRevision,
    summaryArgs: fields.summaryArgs,
    targetId: fields.targetId,
    targetType: fields.targetType,
    titleKey: fields.titleKey,
    visibility: fields.visibility,
    worldId: event.worldId,
  };
}

export function projectCommandWorldHistoryEntryV1(
  command: WorldCommandEnvelopeV1,
  result: Extract<WorldCommandResultV1, { status: 'accepted' | 'rejected' }>,
  ledgerEntry: LedgerEntryV1,
): WorldHistoryEntryV1 {
  if (!ledgerEntryValidator.is(ledgerEntry)) throw new TypeError('Invalid ledger entry contract.');
  if (ledgerEntry.commandId !== command.commandId || ledgerEntry.eventId !== null) {
    throw new Error('History command/ledger link mismatch.');
  }
  if (
    (result.status === 'accepted' && ledgerEntry.entryKind !== 'command_accepted') ||
    (result.status === 'rejected' && ledgerEntry.entryKind !== 'command_rejected')
  ) {
    throw new Error('History command result/ledger kind mismatch.');
  }
  return {
    actor: command.actor,
    category: 'command',
    commandId: command.commandId,
    correlationId: command.correlationId,
    eventId: null,
    eventType: null,
    historySchemaVersion: HISTORY_SCHEMA_VERSION,
    ledgerSequence: ledgerEntry.ledgerSequence,
    occurredAt: ledgerEntry.recordedAt,
    resultingStateRevision: result.status === 'accepted' ? result.resultingStateRevision : null,
    summaryArgs:
      result.status === 'accepted'
        ? { commandType: command.type, entityKey: command.payload.entityKey }
        : {
            commandType: command.type,
            entityKey: command.payload.entityKey,
            rejectionCode: result.rejectionCode,
          },
    targetId: command.payload.entityKey,
    targetType: 'world_entity',
    titleKey:
      result.status === 'accepted' ? 'history.command.accepted' : 'history.command.rejected',
    visibility: result.status === 'accepted' ? 'member' : 'creator',
    worldId: command.worldId,
  };
}

/** Filters before pagination so hidden rows do not leak through counts or cursor gaps. */
export function visibleWorldHistoryEntriesV1(
  entries: readonly WorldHistoryEntryV1[],
  audience: LedgerVisibility,
): readonly WorldHistoryEntryV1[] {
  const allowed: Record<LedgerVisibility, ReadonlySet<LedgerVisibility>> = {
    public: new Set(['public']),
    member: new Set(['public', 'member']),
    creator: new Set(['public', 'member', 'creator']),
    operator: new Set(['public', 'member', 'creator', 'operator']),
    participant: new Set(['public', 'member', 'participant']),
  };
  return entries.filter((entry) => allowed[audience].has(entry.visibility));
}

export function renderWorldHistoryTitleV1(entry: WorldHistoryEntryV1): string {
  const template = HISTORY_TEMPLATES_V1[entry.titleKey as HistoryTemplateKeyV1];
  if (!template) throw new Error(`Unknown history title template: ${entry.titleKey}`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key: string) => {
    const value = entry.summaryArgs[key];
    if (typeof value !== 'string' && typeof value !== 'number') return 'unknown';
    return String(value);
  });
}

export function redactCommandForHistoryV1(
  command: WorldCommandEnvelopeV1,
  payloadHash: string,
): Record<string, JsonValue> {
  return {
    commandType: command.type,
    entityKey: command.payload.entityKey,
    expectedAggregateVersion: command.expectedAggregateVersion,
    expectedStateRevision: command.expectedStateRevision,
    expectedWorldVersion: command.expectedWorldVersion,
    payloadHash,
  };
}
