import { Type, type TSchema } from '@sinclair/typebox';

import {
  AcceptAssetTransferOfferPayloadV1Schema,
  AdvanceSimulationPayloadV1Schema,
  AdoptLegacyEconomySeedPlanPayloadV1Schema,
  CancelScheduledActionPayloadV1Schema,
  CancelAssetTransferOfferPayloadV1Schema,
  CancelMarketListingPayloadV1Schema,
  AcceptEmploymentContractPayloadV1Schema,
  ConfigureBusinessFacilityPayloadV1Schema,
  ConfigureWorldClockPayloadV1Schema,
  CreateAssetTransferOfferPayloadV1Schema,
  CreateBusinessPayloadV1Schema,
  CreateEmploymentContractPayloadV1Schema,
  CreateMarketListingPayloadV1Schema,
  EndEmploymentContractPayloadV1Schema,
  FreezeCurrencyPayloadV1Schema,
  FreezeWalletPayloadV1Schema,
  InitializeWorldGovernancePayloadV1Schema,
  AdoptGovernanceSeedPlanPayloadV1Schema,
  CreateProposalPayloadV1Schema,
  SponsorProposalPayloadV1Schema,
  WithdrawProposalPayloadV1Schema,
  CastProposalBallotPayloadV1Schema,
  NominateCandidatePayloadV1Schema,
  AcceptNominationPayloadV1Schema,
  CastElectionBallotPayloadV1Schema,
  AppointOfficeholderPayloadV1Schema,
  RemoveOfficeholderPayloadV1Schema,
  ExecuteCreatorOverridePayloadV1Schema,
  RepairGovernanceResultPayloadV1Schema,
  InitializeWorldEconomyPayloadV1Schema,
  InitializeWorldCommercePayloadV1Schema,
  IssueCurrencyPayloadV1Schema,
  ReconcileWorldEconomyPayloadV1Schema,
  ReconcileWorldCommercePayloadV1Schema,
  ResolveSimulationFailurePayloadV1Schema,
  ScheduleWorldNoticePayloadV1Schema,
  PerformJobPayloadV1Schema,
  PurchaseMarketListingPayloadV1Schema,
  StartProductionRunPayloadV1Schema,
  TransferAssetPayloadV1Schema,
  TransferCurrencyPayloadV1Schema,
  UnfreezeCurrencyPayloadV1Schema,
  UnfreezeWalletPayloadV1Schema,
  createValidator,
  type AcceptAssetTransferOfferPayloadV1,
  type AdvanceSimulationPayloadV1,
  type AdoptLegacyEconomySeedPlanPayloadV1,
  type AuthorityAction,
  type CancelAssetTransferOfferPayloadV1,
  type CancelMarketListingPayloadV1,
  type AcceptEmploymentContractPayloadV1,
  type ConfigureBusinessFacilityPayloadV1,
  type CancelScheduledActionPayloadV1,
  type ConfigureWorldClockPayloadV1,
  type CreateAssetTransferOfferPayloadV1,
  type CreateBusinessPayloadV1,
  type CreateEmploymentContractPayloadV1,
  type CreateMarketListingPayloadV1,
  type EndEmploymentContractPayloadV1,
  type FreezeCurrencyPayloadV1,
  type FreezeWalletPayloadV1,
  type InitializeWorldGovernancePayloadV1,
  type AdoptGovernanceSeedPlanPayloadV1,
  type CreateProposalPayloadV1,
  type SponsorProposalPayloadV1,
  type WithdrawProposalPayloadV1,
  type CastProposalBallotPayloadV1,
  type NominateCandidatePayloadV1,
  type AcceptNominationPayloadV1,
  type CastElectionBallotPayloadV1,
  type AppointOfficeholderPayloadV1,
  type RemoveOfficeholderPayloadV1,
  type ExecuteCreatorOverridePayloadV1,
  type RepairGovernanceResultPayloadV1,
  type InitializeWorldEconomyPayloadV1,
  type InitializeWorldCommercePayloadV1,
  type IssueCurrencyPayloadV1,
  type ReconcileWorldEconomyPayloadV1,
  type ReconcileWorldCommercePayloadV1,
  type ResolveSimulationFailurePayloadV1,
  type ScheduleWorldNoticePayloadV1,
  type PerformJobPayloadV1,
  type PurchaseMarketListingPayloadV1,
  type StartProductionRunPayloadV1,
  type TransferAssetPayloadV1,
  type TransferCurrencyPayloadV1,
  type Validator,
  type WorldEntityStatePairV1,
} from '@worldgraph/contracts';

import {
  RenameWorldEntityPayloadTransportSchema,
  type RenameWorldEntityPayloadTransport,
} from './api-contracts.js';

export const RENAME_WORLD_ENTITY_COMMAND = 'RenameWorldEntityV1' as const;
export const WORLD_ENTITY_RENAMED_EVENT = 'WorldEntityRenamedV1' as const;
export const CONFIGURE_WORLD_CLOCK_COMMAND = 'ConfigureWorldClockV1' as const;
export const START_WORLD_CLOCK_COMMAND = 'StartWorldClockV1' as const;
export const PAUSE_WORLD_CLOCK_COMMAND = 'PauseWorldClockV1' as const;
export const ADVANCE_SIMULATION_COMMAND = 'AdvanceSimulationV1' as const;
export const SCHEDULE_WORLD_NOTICE_COMMAND = 'ScheduleWorldNoticeV1' as const;
export const CANCEL_SCHEDULED_ACTION_COMMAND = 'CancelScheduledActionV1' as const;
export const RESOLVE_SIMULATION_FAILURE_COMMAND = 'ResolveSimulationFailureV1' as const;
export const INITIALIZE_WORLD_ECONOMY_COMMAND = 'InitializeWorldEconomyV1' as const;
export const ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND = 'AdoptLegacyEconomySeedPlanV1' as const;
export const TRANSFER_CURRENCY_COMMAND = 'TransferCurrencyV1' as const;
export const ISSUE_CURRENCY_COMMAND = 'IssueCurrencyV1' as const;
export const FREEZE_CURRENCY_COMMAND = 'FreezeCurrencyV1' as const;
export const UNFREEZE_CURRENCY_COMMAND = 'UnfreezeCurrencyV1' as const;
export const FREEZE_WALLET_COMMAND = 'FreezeWalletV1' as const;
export const UNFREEZE_WALLET_COMMAND = 'UnfreezeWalletV1' as const;
export const TRANSFER_ASSET_COMMAND = 'TransferAssetV1' as const;
export const CREATE_ASSET_TRANSFER_OFFER_COMMAND = 'CreateAssetTransferOfferV1' as const;
export const CANCEL_ASSET_TRANSFER_OFFER_COMMAND = 'CancelAssetTransferOfferV1' as const;
export const ACCEPT_ASSET_TRANSFER_OFFER_COMMAND = 'AcceptAssetTransferOfferV1' as const;
export const RECONCILE_WORLD_ECONOMY_COMMAND = 'ReconcileWorldEconomyV1' as const;
export const INITIALIZE_WORLD_COMMERCE_COMMAND = 'InitializeWorldCommerceV1' as const;
export const CREATE_BUSINESS_COMMAND = 'CreateBusinessV1' as const;
export const CONFIGURE_BUSINESS_FACILITY_COMMAND = 'ConfigureBusinessFacilityV1' as const;
export const CREATE_EMPLOYMENT_CONTRACT_COMMAND = 'CreateEmploymentContractV1' as const;
export const ACCEPT_EMPLOYMENT_CONTRACT_COMMAND = 'AcceptEmploymentContractV1' as const;
export const END_EMPLOYMENT_CONTRACT_COMMAND = 'EndEmploymentContractV1' as const;
export const PERFORM_JOB_COMMAND = 'PerformJobV1' as const;
export const START_PRODUCTION_RUN_COMMAND = 'StartProductionRunV1' as const;
export const CREATE_MARKET_LISTING_COMMAND = 'CreateMarketListingV1' as const;
export const CANCEL_MARKET_LISTING_COMMAND = 'CancelMarketListingV1' as const;
export const PURCHASE_MARKET_LISTING_COMMAND = 'PurchaseMarketListingV1' as const;
export const RECONCILE_WORLD_COMMERCE_COMMAND = 'ReconcileWorldCommerceV1' as const;
export const INITIALIZE_WORLD_GOVERNANCE_COMMAND = 'InitializeWorldGovernanceV1' as const;
export const ADOPT_GOVERNANCE_SEED_PLAN_COMMAND = 'AdoptGovernanceSeedPlanV1' as const;
export const CREATE_PROPOSAL_COMMAND = 'CreateProposalV1' as const;
export const SPONSOR_PROPOSAL_COMMAND = 'SponsorProposalV1' as const;
export const WITHDRAW_PROPOSAL_COMMAND = 'WithdrawProposalV1' as const;
export const CAST_PROPOSAL_BALLOT_COMMAND = 'CastProposalBallotV1' as const;
export const NOMINATE_CANDIDATE_COMMAND = 'NominateCandidateV1' as const;
export const ACCEPT_NOMINATION_COMMAND = 'AcceptNominationV1' as const;
export const CAST_ELECTION_BALLOT_COMMAND = 'CastElectionBallotV1' as const;
export const APPOINT_OFFICEHOLDER_COMMAND = 'AppointOfficeholderV1' as const;
export const REMOVE_OFFICEHOLDER_COMMAND = 'RemoveOfficeholderV1' as const;
export const EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND = 'ExecuteCreatorOverrideV1' as const;
export const REPAIR_GOVERNANCE_RESULT_COMMAND = 'RepairGovernanceResultV1' as const;
export const ECONOMY_PUBLIC_COMMAND_TYPES = new Set<string>([
  INITIALIZE_WORLD_ECONOMY_COMMAND,
  ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND,
  TRANSFER_CURRENCY_COMMAND,
  ISSUE_CURRENCY_COMMAND,
  FREEZE_CURRENCY_COMMAND,
  UNFREEZE_CURRENCY_COMMAND,
  FREEZE_WALLET_COMMAND,
  UNFREEZE_WALLET_COMMAND,
  TRANSFER_ASSET_COMMAND,
  CREATE_ASSET_TRANSFER_OFFER_COMMAND,
  CANCEL_ASSET_TRANSFER_OFFER_COMMAND,
  ACCEPT_ASSET_TRANSFER_OFFER_COMMAND,
  RECONCILE_WORLD_ECONOMY_COMMAND,
]);
export const COMMERCE_PUBLIC_COMMAND_TYPES = new Set<string>([
  INITIALIZE_WORLD_COMMERCE_COMMAND,
  CREATE_BUSINESS_COMMAND,
  CONFIGURE_BUSINESS_FACILITY_COMMAND,
  CREATE_EMPLOYMENT_CONTRACT_COMMAND,
  ACCEPT_EMPLOYMENT_CONTRACT_COMMAND,
  END_EMPLOYMENT_CONTRACT_COMMAND,
  PERFORM_JOB_COMMAND,
  START_PRODUCTION_RUN_COMMAND,
  CREATE_MARKET_LISTING_COMMAND,
  CANCEL_MARKET_LISTING_COMMAND,
  PURCHASE_MARKET_LISTING_COMMAND,
  RECONCILE_WORLD_COMMERCE_COMMAND,
]);
export const GOVERNANCE_PUBLIC_COMMAND_TYPES = new Set<string>([
  INITIALIZE_WORLD_GOVERNANCE_COMMAND,
  ADOPT_GOVERNANCE_SEED_PLAN_COMMAND,
  CREATE_PROPOSAL_COMMAND,
  SPONSOR_PROPOSAL_COMMAND,
  WITHDRAW_PROPOSAL_COMMAND,
  CAST_PROPOSAL_BALLOT_COMMAND,
  NOMINATE_CANDIDATE_COMMAND,
  ACCEPT_NOMINATION_COMMAND,
  CAST_ELECTION_BALLOT_COMMAND,
  APPOINT_OFFICEHOLDER_COMMAND,
  REMOVE_OFFICEHOLDER_COMMAND,
  EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND,
  REPAIR_GOVERNANCE_RESULT_COMMAND,
]);
export const RENAMABLE_ENTITY_TYPES = new Set<WorldEntityStatePairV1['entityType']>([
  'actor_blueprint',
  'district',
  'institution',
  'organization',
  'player_character',
]);

export interface RegisteredCommand<Payload extends object = object> {
  action: AuthorityAction;
  aggregateType: string;
  commandType: string;
  eventType: string;
  payloadValidator: Validator<Payload>;
  schemaVersion: number;
}

export type RegisteredCommandPayload =
  | RenameWorldEntityPayloadTransport
  | ConfigureWorldClockPayloadV1
  | AdvanceSimulationPayloadV1
  | ScheduleWorldNoticePayloadV1
  | CancelScheduledActionPayloadV1
  | ResolveSimulationFailurePayloadV1
  | InitializeWorldEconomyPayloadV1
  | AdoptLegacyEconomySeedPlanPayloadV1
  | TransferCurrencyPayloadV1
  | IssueCurrencyPayloadV1
  | FreezeCurrencyPayloadV1
  | FreezeWalletPayloadV1
  | TransferAssetPayloadV1
  | CreateAssetTransferOfferPayloadV1
  | CancelAssetTransferOfferPayloadV1
  | AcceptAssetTransferOfferPayloadV1
  | ReconcileWorldEconomyPayloadV1
  | InitializeWorldCommercePayloadV1
  | CreateBusinessPayloadV1
  | ConfigureBusinessFacilityPayloadV1
  | CreateEmploymentContractPayloadV1
  | AcceptEmploymentContractPayloadV1
  | EndEmploymentContractPayloadV1
  | PerformJobPayloadV1
  | StartProductionRunPayloadV1
  | CreateMarketListingPayloadV1
  | CancelMarketListingPayloadV1
  | PurchaseMarketListingPayloadV1
  | ReconcileWorldCommercePayloadV1
  | InitializeWorldGovernancePayloadV1
  | AdoptGovernanceSeedPlanPayloadV1
  | CreateProposalPayloadV1
  | SponsorProposalPayloadV1
  | WithdrawProposalPayloadV1
  | CastProposalBallotPayloadV1
  | NominateCandidatePayloadV1
  | AcceptNominationPayloadV1
  | CastElectionBallotPayloadV1
  | AppointOfficeholderPayloadV1
  | RemoveOfficeholderPayloadV1
  | ExecuteCreatorOverridePayloadV1
  | RepairGovernanceResultPayloadV1
  | Record<string, never>;

export type AnyRegisteredCommand = RegisteredCommand<RegisteredCommandPayload>;

export class WorldCommandRegistry {
  private readonly handlers = new Map<string, AnyRegisteredCommand>();

  public constructor(commands: readonly AnyRegisteredCommand[] = registeredCommands()) {
    for (const command of commands) this.register(command);
  }

  public resolve(commandType: string, schemaVersion: number): AnyRegisteredCommand | null {
    return this.handlers.get(this.key(commandType, schemaVersion)) ?? null;
  }

  public register(command: AnyRegisteredCommand): void {
    const key = this.key(command.commandType, command.schemaVersion);
    if (this.handlers.has(key)) {
      throw new Error(`Duplicate command registration for ${key}.`);
    }
    this.handlers.set(key, Object.freeze(command));
  }

  public registeredVersions(): ReadonlyArray<{ schemaVersion: number; type: string }> {
    return [...this.handlers.values()]
      .map((handler) => ({ schemaVersion: handler.schemaVersion, type: handler.commandType }))
      .sort((left, right) =>
        left.type === right.type
          ? left.schemaVersion - right.schemaVersion
          : left.type.localeCompare(right.type, 'en'),
      );
  }

  private key(commandType: string, schemaVersion: number): string {
    return `${commandType}@${String(schemaVersion)}`;
  }
}

function renameWorldEntityCommand(): AnyRegisteredCommand {
  return {
    action: 'world.entity.rename',
    aggregateType: 'world_entity',
    commandType: RENAME_WORLD_ENTITY_COMMAND,
    eventType: WORLD_ENTITY_RENAMED_EVENT,
    payloadValidator: createValidator<RenameWorldEntityPayloadTransport>(
      RenameWorldEntityPayloadTransportSchema,
    ),
    schemaVersion: 1,
  };
}

function registeredCommands(): AnyRegisteredCommand[] {
  return [
    renameWorldEntityCommand(),
    simulationCommand(
      CONFIGURE_WORLD_CLOCK_COMMAND,
      'simulation.manage',
      'WorldClockConfiguredV1',
      ConfigureWorldClockPayloadV1Schema,
    ),
    simulationCommand(
      START_WORLD_CLOCK_COMMAND,
      'simulation.manage',
      'WorldClockStartedV1',
      Type.Object({}, { additionalProperties: false }),
    ),
    simulationCommand(
      PAUSE_WORLD_CLOCK_COMMAND,
      'simulation.manage',
      'WorldClockPausedV1',
      Type.Object({}, { additionalProperties: false }),
    ),
    simulationCommand(
      ADVANCE_SIMULATION_COMMAND,
      'simulation.manage',
      'SimulationAdvancedV1',
      AdvanceSimulationPayloadV1Schema,
    ),
    simulationCommand(
      SCHEDULE_WORLD_NOTICE_COMMAND,
      'simulation.schedule',
      'ScheduledActionCreatedV1',
      ScheduleWorldNoticePayloadV1Schema,
    ),
    simulationCommand(
      CANCEL_SCHEDULED_ACTION_COMMAND,
      'simulation.schedule',
      'ScheduledActionCancelledV1',
      CancelScheduledActionPayloadV1Schema,
    ),
    simulationCommand(
      RESOLVE_SIMULATION_FAILURE_COMMAND,
      'simulation.manage',
      'SimulationFailureResolvedV1',
      ResolveSimulationFailurePayloadV1Schema,
    ),
    economyCommand(
      INITIALIZE_WORLD_ECONOMY_COMMAND,
      'economy.initialize',
      'world_economy',
      'WorldEconomyInitializedV1',
      InitializeWorldEconomyPayloadV1Schema,
    ),
    economyCommand(
      ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND,
      'economy.legacy_seed.adopt',
      'economy_seed_plan',
      'LegacyEconomySeedPlanAdoptedV1',
      AdoptLegacyEconomySeedPlanPayloadV1Schema,
    ),
    economyCommand(
      TRANSFER_CURRENCY_COMMAND,
      'economy.currency.transfer',
      'currency',
      'CurrencyTransferredV1',
      TransferCurrencyPayloadV1Schema,
    ),
    economyCommand(
      ISSUE_CURRENCY_COMMAND,
      'economy.currency.issue',
      'currency',
      'CurrencyIssuedV1',
      IssueCurrencyPayloadV1Schema,
    ),
    economyCommand(
      FREEZE_CURRENCY_COMMAND,
      'economy.currency.freeze',
      'currency',
      'CurrencyFrozenV1',
      FreezeCurrencyPayloadV1Schema,
    ),
    economyCommand(
      UNFREEZE_CURRENCY_COMMAND,
      'economy.currency.freeze',
      'currency',
      'CurrencyUnfrozenV1',
      UnfreezeCurrencyPayloadV1Schema,
    ),
    economyCommand(
      FREEZE_WALLET_COMMAND,
      'economy.wallet.freeze',
      'wallet',
      'WalletFrozenV1',
      FreezeWalletPayloadV1Schema,
    ),
    economyCommand(
      UNFREEZE_WALLET_COMMAND,
      'economy.wallet.freeze',
      'wallet',
      'WalletUnfrozenV1',
      UnfreezeWalletPayloadV1Schema,
    ),
    economyCommand(
      TRANSFER_ASSET_COMMAND,
      'asset.transfer',
      'asset',
      'AssetOwnershipTransferredV1',
      TransferAssetPayloadV1Schema,
    ),
    economyCommand(
      CREATE_ASSET_TRANSFER_OFFER_COMMAND,
      'asset.offer.create',
      'asset_transfer_offer',
      'AssetTransferOfferCreatedV1',
      CreateAssetTransferOfferPayloadV1Schema,
    ),
    economyCommand(
      CANCEL_ASSET_TRANSFER_OFFER_COMMAND,
      'asset.offer.cancel',
      'asset_transfer_offer',
      'AssetTransferOfferCancelledV1',
      CancelAssetTransferOfferPayloadV1Schema,
    ),
    economyCommand(
      ACCEPT_ASSET_TRANSFER_OFFER_COMMAND,
      'asset.offer.accept',
      'asset_transfer_offer',
      'AssetTransferOfferAcceptedV1',
      AcceptAssetTransferOfferPayloadV1Schema,
    ),
    economyCommand(
      RECONCILE_WORLD_ECONOMY_COMMAND,
      'economy.reconcile',
      'world_economy',
      'WorldEconomyReconciledV1',
      ReconcileWorldEconomyPayloadV1Schema,
    ),
    economyCommand(
      INITIALIZE_WORLD_COMMERCE_COMMAND,
      'commerce.initialize',
      'world_commerce',
      'WorldCommerceInitializedV1',
      InitializeWorldCommercePayloadV1Schema,
    ),
    economyCommand(
      CREATE_BUSINESS_COMMAND,
      'commerce.business.create',
      'business',
      'BusinessCreatedV1',
      CreateBusinessPayloadV1Schema,
    ),
    economyCommand(
      CONFIGURE_BUSINESS_FACILITY_COMMAND,
      'commerce.business.manage',
      'business_facility',
      'BusinessFacilityConfiguredV1',
      ConfigureBusinessFacilityPayloadV1Schema,
    ),
    economyCommand(
      CREATE_EMPLOYMENT_CONTRACT_COMMAND,
      'commerce.employment.create',
      'employment_contract',
      'EmploymentContractCreatedV1',
      CreateEmploymentContractPayloadV1Schema,
    ),
    economyCommand(
      ACCEPT_EMPLOYMENT_CONTRACT_COMMAND,
      'commerce.employment.accept',
      'employment_contract',
      'EmploymentContractAcceptedV1',
      AcceptEmploymentContractPayloadV1Schema,
    ),
    economyCommand(
      END_EMPLOYMENT_CONTRACT_COMMAND,
      'commerce.employment.end',
      'employment_contract',
      'EmploymentContractEndedV1',
      EndEmploymentContractPayloadV1Schema,
    ),
    economyCommand(
      PERFORM_JOB_COMMAND,
      'commerce.employment.work',
      'work_record',
      'WorkRecordedV1',
      PerformJobPayloadV1Schema,
    ),
    economyCommand(
      START_PRODUCTION_RUN_COMMAND,
      'commerce.production.start',
      'production_run',
      'ProductionRunStartedV1',
      StartProductionRunPayloadV1Schema,
    ),
    economyCommand(
      CREATE_MARKET_LISTING_COMMAND,
      'commerce.market.list',
      'market_listing',
      'MarketListingCreatedV1',
      CreateMarketListingPayloadV1Schema,
    ),
    economyCommand(
      CANCEL_MARKET_LISTING_COMMAND,
      'commerce.market.cancel',
      'market_listing',
      'MarketListingCancelledV1',
      CancelMarketListingPayloadV1Schema,
    ),
    economyCommand(
      PURCHASE_MARKET_LISTING_COMMAND,
      'commerce.market.purchase',
      'market_trade',
      'MarketTradeCompletedV1',
      PurchaseMarketListingPayloadV1Schema,
    ),
    economyCommand(
      RECONCILE_WORLD_COMMERCE_COMMAND,
      'commerce.reconcile',
      'world_commerce',
      'WorldCommerceReconciledV1',
      ReconcileWorldCommercePayloadV1Schema,
    ),
    governanceCommand(
      INITIALIZE_WORLD_GOVERNANCE_COMMAND,
      'governance.initialize',
      'world_governance',
      'WorldGovernanceInitializedV1',
      InitializeWorldGovernancePayloadV1Schema,
    ),
    governanceCommand(
      ADOPT_GOVERNANCE_SEED_PLAN_COMMAND,
      'governance.initialize',
      'governance_seed_plan',
      'GovernanceSeedPlanAdoptedV1',
      AdoptGovernanceSeedPlanPayloadV1Schema,
    ),
    governanceCommand(
      CREATE_PROPOSAL_COMMAND,
      'governance.proposal.create',
      'proposal',
      'GovernanceLifecycleChangedV1',
      CreateProposalPayloadV1Schema,
    ),
    governanceCommand(
      SPONSOR_PROPOSAL_COMMAND,
      'governance.proposal.sponsor',
      'proposal',
      'GovernanceLifecycleChangedV1',
      SponsorProposalPayloadV1Schema,
    ),
    governanceCommand(
      WITHDRAW_PROPOSAL_COMMAND,
      'governance.proposal.withdraw',
      'proposal',
      'GovernanceLifecycleChangedV1',
      WithdrawProposalPayloadV1Schema,
    ),
    governanceCommand(
      CAST_PROPOSAL_BALLOT_COMMAND,
      'governance.ballot.cast',
      'governance_contest',
      'ProposalBallotRecordedSecretV1',
      CastProposalBallotPayloadV1Schema,
    ),
    governanceCommand(
      NOMINATE_CANDIDATE_COMMAND,
      'governance.candidate.nominate',
      'candidacy',
      'GovernanceCandidacyChangedV1',
      NominateCandidatePayloadV1Schema,
    ),
    governanceCommand(
      ACCEPT_NOMINATION_COMMAND,
      'governance.candidate.accept',
      'candidacy',
      'GovernanceCandidacyChangedV1',
      AcceptNominationPayloadV1Schema,
    ),
    governanceCommand(
      CAST_ELECTION_BALLOT_COMMAND,
      'governance.ballot.cast',
      'governance_contest',
      'ElectionBallotRecordedSecretV1',
      CastElectionBallotPayloadV1Schema,
    ),
    governanceCommand(
      APPOINT_OFFICEHOLDER_COMMAND,
      'governance.office.appoint',
      'office_term',
      'GovernanceOfficeTermChangedV1',
      AppointOfficeholderPayloadV1Schema,
    ),
    governanceCommand(
      REMOVE_OFFICEHOLDER_COMMAND,
      'governance.office.remove',
      'office_term',
      'GovernanceOfficeTermChangedV1',
      RemoveOfficeholderPayloadV1Schema,
    ),
    governanceCommand(
      EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND,
      'governance.override.execute',
      'governance_override',
      'GovernanceOverrideExecutedV1',
      ExecuteCreatorOverridePayloadV1Schema,
    ),
    governanceCommand(
      REPAIR_GOVERNANCE_RESULT_COMMAND,
      'governance.result.repair',
      'governance_repair',
      'GovernanceRepairAppendedV1',
      RepairGovernanceResultPayloadV1Schema,
    ),
  ];
}

function governanceCommand(
  commandType: string,
  action: AuthorityAction,
  aggregateType: string,
  eventType: string,
  payloadSchema: TSchema,
): AnyRegisteredCommand {
  return {
    action,
    aggregateType,
    commandType,
    eventType,
    payloadValidator: createValidator<RegisteredCommandPayload>(payloadSchema),
    schemaVersion: 1,
  };
}

function economyCommand(
  commandType: string,
  action: AuthorityAction,
  aggregateType: string,
  eventType: string,
  payloadSchema: TSchema,
): AnyRegisteredCommand {
  return {
    action,
    aggregateType,
    commandType,
    eventType,
    payloadValidator: createValidator<RegisteredCommandPayload>(payloadSchema),
    schemaVersion: 1,
  };
}

function simulationCommand(
  commandType: string,
  action: 'simulation.manage' | 'simulation.schedule',
  eventType: string,
  payloadSchema: TSchema,
): AnyRegisteredCommand {
  return {
    action,
    aggregateType:
      commandType === SCHEDULE_WORLD_NOTICE_COMMAND ||
      commandType === CANCEL_SCHEDULED_ACTION_COMMAND
        ? 'scheduled_action'
        : commandType === RESOLVE_SIMULATION_FAILURE_COMMAND
          ? 'simulation_failure'
          : 'simulation_clock',
    commandType,
    eventType,
    payloadValidator: createValidator<RegisteredCommandPayload>(payloadSchema),
    schemaVersion: 1,
  };
}
