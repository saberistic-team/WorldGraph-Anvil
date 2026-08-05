import type { TSchema } from '@sinclair/typebox';
import {
  AssetOwnershipTransferredPayloadV1Schema,
  AssetPurchasedPayloadV1Schema,
  AssetTransferOfferAcceptedPayloadV1Schema,
  AssetTransferOfferCancelledPayloadV1Schema,
  AssetTransferOfferCreatedPayloadV1Schema,
  AssetTransferOfferExpiredPayloadV1Schema,
  BusinessCreatedPayloadV1Schema,
  BusinessFacilityConfiguredPayloadV1Schema,
  CurrencyFrozenPayloadV1Schema,
  CurrencyIssuedPayloadV1Schema,
  CurrencyTransferredPayloadV1Schema,
  CurrencyUnfrozenPayloadV1Schema,
  CreatorOverrideUsedPayloadV1Schema,
  DomainEventEnvelopeV1Schema,
  EmploymentContractLifecyclePayloadV1Schema,
  ElectionBallotRecordedPublicEventV1Schema,
  ElectionBallotRecordedSecretEventV1Schema,
  GovernanceCandidacyChangedEventV1Schema,
  GovernanceLawVersionActivatedEventV1Schema,
  GovernanceLifecycleEventV1Schema,
  GovernanceOfficeTermChangedEventV1Schema,
  GovernanceOverrideExecutedEventV1Schema,
  GovernanceRepairAppendedEventV1Schema,
  GovernanceResultFinalizedEventV1Schema,
  GovernanceSeedPlanAdoptedEventV1Schema,
  InventoryTransferredPayloadV1Schema,
  ManifestApprovedPayloadV1Schema,
  ManifestRevisionCreatedPayloadV1Schema,
  LegacyEconomySeedPlanAdoptedPayloadV1Schema,
  MarketListingLifecyclePayloadV1Schema,
  MarketTradeCompletedPayloadV1Schema,
  PayrollFailedPayloadV1Schema,
  PayrollSettledPayloadV1Schema,
  ProductionFailedPayloadV1Schema,
  ProductionResourcesPayloadV1Schema,
  ProductionRunStartedPayloadV1Schema,
  ProposalBallotRecordedPublicEventV1Schema,
  ProposalBallotRecordedSecretEventV1Schema,
  ProjectionRepairAnchoredPayloadV1Schema,
  RenameWorldEntityPayloadV1Schema,
  ScheduledActionCancelledPayloadV1Schema,
  ScheduledActionCreatedPayloadV1Schema,
  ScheduledActionExecutedPayloadV1Schema,
  SimulationAdvancedPayloadV1Schema,
  SimulationFailureRecordedPayloadV1Schema,
  SimulationFailureResolvedPayloadV1Schema,
  TaxAssessedPayloadV1Schema,
  TreasuryRevenueRecordedPayloadV1Schema,
  WorkRecordedPayloadV1Schema,
  WorldCommandEnvelopeV1Schema,
  WorldClockAutoPausedPayloadV1Schema,
  WorldClockConfiguredPayloadV1Schema,
  WorldClockPausedPayloadV1Schema,
  WorldClockStartedPayloadV1Schema,
  WorldCompiledGenesisPayloadV1Schema,
  WorldCommerceInitializedPayloadV1Schema,
  WorldCommerceProjectionRepairedPayloadV1Schema,
  WorldCommerceReconciledPayloadV1Schema,
  WorldGovernanceInitializedEventV1Schema,
  WorldEntityRenamedPayloadV1Schema,
  WorldInvitationAcceptedPayloadV1Schema,
  WorldInvitationCreatedPayloadV1Schema,
  WorldInvitationRevokedPayloadV1Schema,
  WorldMembershipRemovedPayloadV1Schema,
  WorldMembershipRoleChangedPayloadV1Schema,
  WorldNoticeEmittedPayloadV1Schema,
  WorldRenamedPayloadV1Schema,
  WorldSimulationInitializedPayloadV1Schema,
  WorldStateImportedPayloadV1Schema,
  WalletFrozenPayloadV1Schema,
  WalletUnfrozenPayloadV1Schema,
  WorldEconomyInitializedPayloadV1Schema,
  WorldEconomyReconciledPayloadV1Schema,
  WorldEconomyRepairedPayloadV1Schema,
  createValidator,
  type DomainEventEnvelopeV1,
  type WorldCommandEnvelopeV1,
  type Validator,
} from '@worldgraph/contracts';

import { decideRenameWorldEntityV1, reduceWorldEntityRenamedV1 } from './rename-world-entity.js';
import { computeWorldProjectionChecksumV1 } from './projection.js';
import type {
  RenameWorldEntityDecisionStateV1,
  RenameWorldEntityDecisionV1,
  WorldProjectionV1,
} from './types.js';

export interface CommandRegistrationV1<
  TState = RenameWorldEntityDecisionStateV1,
  TDecision = RenameWorldEntityDecisionV1,
> {
  decide: (command: WorldCommandEnvelopeV1, state: TState) => TDecision;
  payloadSchema: TSchema;
  schemaVersion: number;
  type: string;
}

export class CommandRegistryV1<
  TState = RenameWorldEntityDecisionStateV1,
  TDecision = RenameWorldEntityDecisionV1,
> {
  readonly #registrations = new Map<string, CommandRegistrationV1<TState, TDecision>>();
  readonly #envelopeValidator: Validator<WorldCommandEnvelopeV1> =
    createValidator<WorldCommandEnvelopeV1>(WorldCommandEnvelopeV1Schema);

  register(registration: CommandRegistrationV1<TState, TDecision>): this {
    const key = this.#key(registration.type, registration.schemaVersion);
    if (this.#registrations.has(key)) throw new Error(`Duplicate command registration: ${key}`);
    this.#registrations.set(key, registration);
    return this;
  }

  registeredCommands(): readonly { schemaVersion: number; type: string }[] {
    return [...this.#registrations.values()]
      .map(({ schemaVersion, type }) => ({ schemaVersion, type }))
      .sort((left, right) =>
        left.type === right.type
          ? left.schemaVersion - right.schemaVersion
          : left.type < right.type
            ? -1
            : left.type > right.type
              ? 1
              : 0,
      );
  }

  decide(value: unknown, state: TState): TDecision {
    if (!this.#envelopeValidator.is(value)) throw new TypeError('Invalid command envelope.');
    const registration = this.#registrations.get(this.#key(value.type, value.schemaVersion));
    if (!registration)
      throw new Error(`Unknown command type/schema: ${value.type}@${value.schemaVersion}`);
    if (!createValidator(registration.payloadSchema).is(value.payload)) {
      throw new TypeError('Invalid command payload.');
    }
    return registration.decide(value, state);
  }

  #key(type: string, schemaVersion: number): string {
    return `${type}@${schemaVersion}`;
  }
}

export function createDefaultCommandRegistry(): CommandRegistryV1 {
  return new CommandRegistryV1().register({
    decide: decideRenameWorldEntityV1,
    payloadSchema: RenameWorldEntityPayloadV1Schema,
    schemaVersion: 1,
    type: 'RenameWorldEntityV1',
  });
}

export type EventReducerV1<TProjection extends WorldProjectionV1 = WorldProjectionV1> = (
  projection: TProjection,
  event: DomainEventEnvelopeV1,
) => TProjection;

export interface EventRegistrationV1<TProjection extends WorldProjectionV1 = WorldProjectionV1> {
  eventSchemaVersion: number;
  eventType: string;
  payloadSchema: TSchema;
  reduce: EventReducerV1<TProjection>;
}

export interface EventUpcasterV1 {
  eventType: string;
  fromSchemaVersion: number;
  toSchemaVersion: number;
  upcast: (payload: unknown) => unknown;
}

export interface UpcastedEventPayloadV1 {
  eventSchemaVersion: number;
  eventType: string;
  payload: unknown;
}

export class EventRegistryV1<TProjection extends WorldProjectionV1 = WorldProjectionV1> {
  readonly #events = new Map<string, EventRegistrationV1<TProjection>>();
  readonly #upcasters = new Map<string, EventUpcasterV1>();
  readonly #eventValidator: Validator<DomainEventEnvelopeV1> =
    createValidator<DomainEventEnvelopeV1>(DomainEventEnvelopeV1Schema);

  register(registration: EventRegistrationV1<TProjection>): this {
    if (this.#events.has(registration.eventType)) {
      throw new Error(`Duplicate event registration: ${registration.eventType}`);
    }
    this.#events.set(registration.eventType, registration);
    return this;
  }

  registerUpcaster(upcaster: EventUpcasterV1): this {
    if (upcaster.toSchemaVersion !== upcaster.fromSchemaVersion + 1) {
      throw new Error('Event upcasters must advance exactly one schema version.');
    }
    const key = this.#upcasterKey(upcaster.eventType, upcaster.fromSchemaVersion);
    if (this.#upcasters.has(key)) throw new Error(`Duplicate event upcaster: ${key}`);
    this.#upcasters.set(key, upcaster);
    return this;
  }

  registeredEvents(): readonly { eventSchemaVersion: number; eventType: string }[] {
    return [...this.#events.values()]
      .map(({ eventSchemaVersion, eventType }) => ({ eventSchemaVersion, eventType }))
      .sort((left, right) =>
        left.eventType < right.eventType ? -1 : left.eventType > right.eventType ? 1 : 0,
      );
  }

  upcastPayload(
    eventType: string,
    eventSchemaVersion: number,
    payload: unknown,
  ): UpcastedEventPayloadV1 {
    const registration = this.#events.get(eventType);
    if (!registration) throw new Error(`Unknown event type: ${eventType}`);
    if (eventSchemaVersion > registration.eventSchemaVersion) {
      throw new Error(`Unsupported future event schema: ${eventType}@${eventSchemaVersion}`);
    }

    let version = eventSchemaVersion;
    let currentPayload = payload;
    while (version < registration.eventSchemaVersion) {
      const upcaster = this.#upcasters.get(this.#upcasterKey(eventType, version));
      if (!upcaster) throw new Error(`Missing event upcaster: ${eventType}@${version}`);
      currentPayload = upcaster.upcast(currentPayload);
      version = upcaster.toSchemaVersion;
    }
    if (!createValidator(registration.payloadSchema).is(currentPayload)) {
      throw new TypeError(`Invalid event payload: ${eventType}@${version}`);
    }
    return { eventSchemaVersion: version, eventType, payload: currentPayload };
  }

  apply(projection: TProjection, event: DomainEventEnvelopeV1): TProjection {
    if (!this.#eventValidator.is(event)) throw new TypeError('Invalid domain event envelope.');
    const registration = this.#events.get(event.eventType);
    if (!registration) throw new Error(`Unknown event type: ${event.eventType}`);
    const current = this.upcastPayload(event.eventType, event.eventSchemaVersion, event.payload);
    const inMemoryEvent = {
      ...event,
      eventSchemaVersion: current.eventSchemaVersion,
      payload: current.payload,
    } as DomainEventEnvelopeV1;
    const stateRevision = projection.stateRevision;
    const reduced = registration.reduce(projection, inMemoryEvent);
    if (reduced.stateRevision !== stateRevision) {
      throw new Error(`Event reducer changed state revision at event ${event.eventId}.`);
    }
    return reduced;
  }

  #upcasterKey(eventType: string, fromSchemaVersion: number): string {
    return `${eventType}@${fromSchemaVersion}`;
  }
}

const unchangedProjection: EventReducerV1 = (projection) => projection;

const reduceProjectionRepairAnchoredV1: EventReducerV1 = (projection, event) => {
  if (event.eventType !== 'ProjectionRepairAnchoredV1') {
    throw new Error('Projection repair reducer received another event type.');
  }
  const checksum = computeWorldProjectionChecksumV1(projection);
  if (checksum !== event.payload.toChecksum) {
    throw new Error(`Replay repair checksum mismatch at event ${event.eventId}.`);
  }
  return projection;
};

export function createDefaultEventRegistry(): EventRegistryV1 {
  return new EventRegistryV1()
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldStateImportedV1',
      payloadSchema: WorldStateImportedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldCompiledGenesisV1',
      payloadSchema: WorldCompiledGenesisPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldEntityRenamedV1',
      payloadSchema: WorldEntityRenamedPayloadV1Schema,
      reduce: (projection, event) =>
        reduceWorldEntityRenamedV1(
          projection,
          event as Extract<DomainEventEnvelopeV1, { eventType: 'WorldEntityRenamedV1' }>,
        ),
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'CreatorOverrideUsedV1',
      payloadSchema: CreatorOverrideUsedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldRenamedV1',
      payloadSchema: WorldRenamedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldMembershipRoleChangedV1',
      payloadSchema: WorldMembershipRoleChangedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldMembershipRemovedV1',
      payloadSchema: WorldMembershipRemovedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldInvitationCreatedV1',
      payloadSchema: WorldInvitationCreatedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldInvitationRevokedV1',
      payloadSchema: WorldInvitationRevokedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldInvitationAcceptedV1',
      payloadSchema: WorldInvitationAcceptedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ManifestRevisionCreatedV1',
      payloadSchema: ManifestRevisionCreatedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ManifestApprovedV1',
      payloadSchema: ManifestApprovedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ProjectionRepairAnchoredV1',
      payloadSchema: ProjectionRepairAnchoredPayloadV1Schema,
      reduce: reduceProjectionRepairAnchoredV1,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldSimulationInitializedV1',
      payloadSchema: WorldSimulationInitializedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldClockConfiguredV1',
      payloadSchema: WorldClockConfiguredPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldClockStartedV1',
      payloadSchema: WorldClockStartedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldClockPausedV1',
      payloadSchema: WorldClockPausedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'SimulationAdvancedV1',
      payloadSchema: SimulationAdvancedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ScheduledActionCreatedV1',
      payloadSchema: ScheduledActionCreatedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ScheduledActionCancelledV1',
      payloadSchema: ScheduledActionCancelledPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ScheduledActionExecutedV1',
      payloadSchema: ScheduledActionExecutedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldNoticeEmittedV1',
      payloadSchema: WorldNoticeEmittedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'SimulationFailureRecordedV1',
      payloadSchema: SimulationFailureRecordedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'SimulationFailureResolvedV1',
      payloadSchema: SimulationFailureResolvedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldClockAutoPausedV1',
      payloadSchema: WorldClockAutoPausedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'LegacyEconomySeedPlanAdoptedV1',
      payloadSchema: LegacyEconomySeedPlanAdoptedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldEconomyInitializedV1',
      payloadSchema: WorldEconomyInitializedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldEconomyReconciledV1',
      payloadSchema: WorldEconomyReconciledPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldEconomyRepairedV1',
      payloadSchema: WorldEconomyRepairedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'CurrencyIssuedV1',
      payloadSchema: CurrencyIssuedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'CurrencyTransferredV1',
      payloadSchema: CurrencyTransferredPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'CurrencyFrozenV1',
      payloadSchema: CurrencyFrozenPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'CurrencyUnfrozenV1',
      payloadSchema: CurrencyUnfrozenPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WalletFrozenV1',
      payloadSchema: WalletFrozenPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WalletUnfrozenV1',
      payloadSchema: WalletUnfrozenPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'AssetOwnershipTransferredV1',
      payloadSchema: AssetOwnershipTransferredPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'AssetTransferOfferCreatedV1',
      payloadSchema: AssetTransferOfferCreatedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'AssetTransferOfferCancelledV1',
      payloadSchema: AssetTransferOfferCancelledPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'AssetTransferOfferAcceptedV1',
      payloadSchema: AssetTransferOfferAcceptedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'AssetTransferOfferExpiredV1',
      payloadSchema: AssetTransferOfferExpiredPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'AssetPurchasedV1',
      payloadSchema: AssetPurchasedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldCommerceInitializedV1',
      payloadSchema: WorldCommerceInitializedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'BusinessCreatedV1',
      payloadSchema: BusinessCreatedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'BusinessFacilityConfiguredV1',
      payloadSchema: BusinessFacilityConfiguredPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'EmploymentContractCreatedV1',
      payloadSchema: EmploymentContractLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'EmploymentContractAcceptedV1',
      payloadSchema: EmploymentContractLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'EmploymentContractEndedV1',
      payloadSchema: EmploymentContractLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorkRecordedV1',
      payloadSchema: WorkRecordedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'PayrollSettledV1',
      payloadSchema: PayrollSettledPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'PayrollFailedV1',
      payloadSchema: PayrollFailedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ProductionRunStartedV1',
      payloadSchema: ProductionRunStartedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ResourcesConsumedV1',
      payloadSchema: ProductionResourcesPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ResourcesProducedV1',
      payloadSchema: ProductionResourcesPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ProductionFailedV1',
      payloadSchema: ProductionFailedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'MarketListingCreatedV1',
      payloadSchema: MarketListingLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'MarketListingCancelledV1',
      payloadSchema: MarketListingLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'MarketListingExpiredV1',
      payloadSchema: MarketListingLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'MarketListingPartiallyFilledV1',
      payloadSchema: MarketListingLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'MarketListingFilledV1',
      payloadSchema: MarketListingLifecyclePayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'InventoryTransferredV1',
      payloadSchema: InventoryTransferredPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'MarketTradeCompletedV1',
      payloadSchema: MarketTradeCompletedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'TaxAssessedV1',
      payloadSchema: TaxAssessedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'TreasuryRevenueRecordedV1',
      payloadSchema: TreasuryRevenueRecordedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldCommerceReconciledV1',
      payloadSchema: WorldCommerceReconciledPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldCommerceProjectionRepairedV1',
      payloadSchema: WorldCommerceProjectionRepairedPayloadV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ProposalBallotRecordedPublicV1',
      payloadSchema: ProposalBallotRecordedPublicEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ProposalBallotRecordedSecretV1',
      payloadSchema: ProposalBallotRecordedSecretEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ElectionBallotRecordedPublicV1',
      payloadSchema: ElectionBallotRecordedPublicEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'ElectionBallotRecordedSecretV1',
      payloadSchema: ElectionBallotRecordedSecretEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceLifecycleChangedV1',
      payloadSchema: GovernanceLifecycleEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'WorldGovernanceInitializedV1',
      payloadSchema: WorldGovernanceInitializedEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceSeedPlanAdoptedV1',
      payloadSchema: GovernanceSeedPlanAdoptedEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceCandidacyChangedV1',
      payloadSchema: GovernanceCandidacyChangedEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceResultFinalizedV1',
      payloadSchema: GovernanceResultFinalizedEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceLawVersionActivatedV1',
      payloadSchema: GovernanceLawVersionActivatedEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceOfficeTermChangedV1',
      payloadSchema: GovernanceOfficeTermChangedEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceOverrideExecutedV1',
      payloadSchema: GovernanceOverrideExecutedEventV1Schema,
      reduce: unchangedProjection,
    })
    .register({
      eventSchemaVersion: 1,
      eventType: 'GovernanceRepairAppendedV1',
      payloadSchema: GovernanceRepairAppendedEventV1Schema,
      reduce: unchangedProjection,
    });
}
