import { describe, expect, it } from 'vitest';

import {
  ACCEPT_ASSET_TRANSFER_OFFER_COMMAND,
  ACCEPT_EMPLOYMENT_CONTRACT_COMMAND,
  ACCEPT_NOMINATION_COMMAND,
  ADVANCE_SIMULATION_COMMAND,
  ADOPT_GOVERNANCE_SEED_PLAN_COMMAND,
  ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND,
  APPOINT_OFFICEHOLDER_COMMAND,
  CANCEL_ASSET_TRANSFER_OFFER_COMMAND,
  CANCEL_MARKET_LISTING_COMMAND,
  CANCEL_SCHEDULED_ACTION_COMMAND,
  CAST_ELECTION_BALLOT_COMMAND,
  CAST_PROPOSAL_BALLOT_COMMAND,
  COMMERCE_PUBLIC_COMMAND_TYPES,
  CONFIGURE_WORLD_CLOCK_COMMAND,
  CONFIGURE_BUSINESS_FACILITY_COMMAND,
  CREATE_ASSET_TRANSFER_OFFER_COMMAND,
  CREATE_BUSINESS_COMMAND,
  CREATE_EMPLOYMENT_CONTRACT_COMMAND,
  CREATE_MARKET_LISTING_COMMAND,
  CREATE_PROPOSAL_COMMAND,
  END_EMPLOYMENT_CONTRACT_COMMAND,
  EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND,
  FREEZE_CURRENCY_COMMAND,
  FREEZE_WALLET_COMMAND,
  GOVERNANCE_PUBLIC_COMMAND_TYPES,
  INITIALIZE_WORLD_ECONOMY_COMMAND,
  INITIALIZE_WORLD_COMMERCE_COMMAND,
  INITIALIZE_WORLD_GOVERNANCE_COMMAND,
  ISSUE_CURRENCY_COMMAND,
  NOMINATE_CANDIDATE_COMMAND,
  PAUSE_WORLD_CLOCK_COMMAND,
  PERFORM_JOB_COMMAND,
  PURCHASE_MARKET_LISTING_COMMAND,
  RECONCILE_WORLD_COMMERCE_COMMAND,
  RECONCILE_WORLD_ECONOMY_COMMAND,
  REMOVE_OFFICEHOLDER_COMMAND,
  RENAME_WORLD_ENTITY_COMMAND,
  REPAIR_GOVERNANCE_RESULT_COMMAND,
  RENAMABLE_ENTITY_TYPES,
  RESOLVE_SIMULATION_FAILURE_COMMAND,
  SCHEDULE_WORLD_NOTICE_COMMAND,
  SPONSOR_PROPOSAL_COMMAND,
  START_WORLD_CLOCK_COMMAND,
  START_PRODUCTION_RUN_COMMAND,
  TRANSFER_ASSET_COMMAND,
  TRANSFER_CURRENCY_COMMAND,
  UNFREEZE_CURRENCY_COMMAND,
  UNFREEZE_WALLET_COMMAND,
  WITHDRAW_PROPOSAL_COMMAND,
  WorldCommandRegistry,
} from './registry.js';

describe('world command registry', () => {
  it('resolves only the exact allowlisted type and schema version', () => {
    const registry = new WorldCommandRegistry();

    expect(registry.resolve(RENAME_WORLD_ENTITY_COMMAND, 1)).toMatchObject({
      action: 'world.entity.rename',
      eventType: 'WorldEntityRenamedV1',
    });
    expect(registry.resolve(RENAME_WORLD_ENTITY_COMMAND, 2)).toBeNull();
    expect(registry.resolve(RESOLVE_SIMULATION_FAILURE_COMMAND, 1)).toMatchObject({
      action: 'simulation.manage',
      eventType: 'SimulationFailureResolvedV1',
    });
    expect(registry.resolve(PURCHASE_MARKET_LISTING_COMMAND, 1)).toMatchObject({
      action: 'commerce.market.purchase',
      aggregateType: 'market_trade',
      eventType: 'MarketTradeCompletedV1',
    });
    expect(registry.resolve('ArbitraryJsonPatchV1', 1)).toBeNull();
    expect(registry.resolve('ExpireAssetTransferOfferV1', 1)).toBeNull();
    expect(registry.resolve('RepairWorldEconomyV1', 1)).toBeNull();
    expect(registry.resolve('RepairEconomicProjectionV1', 1)).toBeNull();
    expect(COMMERCE_PUBLIC_COMMAND_TYPES.has('RepairEconomicProjectionV1')).toBe(false);
    expect(GOVERNANCE_PUBLIC_COMMAND_TYPES.has('CloseAndTallyProposalV1')).toBe(false);
    expect(GOVERNANCE_PUBLIC_COMMAND_TYPES.has('CertifyElectionV1')).toBe(false);
    expect(registry.resolve(CAST_PROPOSAL_BALLOT_COMMAND, 1)).toMatchObject({
      action: 'governance.ballot.cast',
      aggregateType: 'governance_contest',
    });
    expect(registry.resolve(REPAIR_GOVERNANCE_RESULT_COMMAND, 1)).toMatchObject({
      action: 'governance.result.repair',
      aggregateType: 'governance_repair',
    });
    expect(registry.registeredVersions()).toEqual([
      { schemaVersion: 1, type: ACCEPT_ASSET_TRANSFER_OFFER_COMMAND },
      { schemaVersion: 1, type: ACCEPT_EMPLOYMENT_CONTRACT_COMMAND },
      { schemaVersion: 1, type: ACCEPT_NOMINATION_COMMAND },
      { schemaVersion: 1, type: ADOPT_GOVERNANCE_SEED_PLAN_COMMAND },
      { schemaVersion: 1, type: ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND },
      { schemaVersion: 1, type: ADVANCE_SIMULATION_COMMAND },
      { schemaVersion: 1, type: APPOINT_OFFICEHOLDER_COMMAND },
      { schemaVersion: 1, type: CANCEL_ASSET_TRANSFER_OFFER_COMMAND },
      { schemaVersion: 1, type: CANCEL_MARKET_LISTING_COMMAND },
      { schemaVersion: 1, type: CANCEL_SCHEDULED_ACTION_COMMAND },
      { schemaVersion: 1, type: CAST_ELECTION_BALLOT_COMMAND },
      { schemaVersion: 1, type: CAST_PROPOSAL_BALLOT_COMMAND },
      { schemaVersion: 1, type: CONFIGURE_BUSINESS_FACILITY_COMMAND },
      { schemaVersion: 1, type: CONFIGURE_WORLD_CLOCK_COMMAND },
      { schemaVersion: 1, type: CREATE_ASSET_TRANSFER_OFFER_COMMAND },
      { schemaVersion: 1, type: CREATE_BUSINESS_COMMAND },
      { schemaVersion: 1, type: CREATE_EMPLOYMENT_CONTRACT_COMMAND },
      { schemaVersion: 1, type: CREATE_MARKET_LISTING_COMMAND },
      { schemaVersion: 1, type: CREATE_PROPOSAL_COMMAND },
      { schemaVersion: 1, type: END_EMPLOYMENT_CONTRACT_COMMAND },
      { schemaVersion: 1, type: EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND },
      { schemaVersion: 1, type: FREEZE_CURRENCY_COMMAND },
      { schemaVersion: 1, type: FREEZE_WALLET_COMMAND },
      { schemaVersion: 1, type: INITIALIZE_WORLD_COMMERCE_COMMAND },
      { schemaVersion: 1, type: INITIALIZE_WORLD_ECONOMY_COMMAND },
      { schemaVersion: 1, type: INITIALIZE_WORLD_GOVERNANCE_COMMAND },
      { schemaVersion: 1, type: ISSUE_CURRENCY_COMMAND },
      { schemaVersion: 1, type: NOMINATE_CANDIDATE_COMMAND },
      { schemaVersion: 1, type: PAUSE_WORLD_CLOCK_COMMAND },
      { schemaVersion: 1, type: PERFORM_JOB_COMMAND },
      { schemaVersion: 1, type: PURCHASE_MARKET_LISTING_COMMAND },
      { schemaVersion: 1, type: RECONCILE_WORLD_COMMERCE_COMMAND },
      { schemaVersion: 1, type: RECONCILE_WORLD_ECONOMY_COMMAND },
      { schemaVersion: 1, type: REMOVE_OFFICEHOLDER_COMMAND },
      { schemaVersion: 1, type: RENAME_WORLD_ENTITY_COMMAND },
      { schemaVersion: 1, type: REPAIR_GOVERNANCE_RESULT_COMMAND },
      { schemaVersion: 1, type: RESOLVE_SIMULATION_FAILURE_COMMAND },
      { schemaVersion: 1, type: SCHEDULE_WORLD_NOTICE_COMMAND },
      { schemaVersion: 1, type: SPONSOR_PROPOSAL_COMMAND },
      { schemaVersion: 1, type: START_PRODUCTION_RUN_COMMAND },
      { schemaVersion: 1, type: START_WORLD_CLOCK_COMMAND },
      { schemaVersion: 1, type: TRANSFER_ASSET_COMMAND },
      { schemaVersion: 1, type: TRANSFER_CURRENCY_COMMAND },
      { schemaVersion: 1, type: UNFREEZE_CURRENCY_COMMAND },
      { schemaVersion: 1, type: UNFREEZE_WALLET_COMMAND },
      { schemaVersion: 1, type: WITHDRAW_PROPOSAL_COMMAND },
    ]);
  });

  it('accepts only the strict rename payload and explicit name-bearing entity types', () => {
    const handler = new WorldCommandRegistry().resolve(RENAME_WORLD_ENTITY_COMMAND, 1)!;

    expect(
      handler.payloadValidator.is({
        entityKey: 'district:civic-platform',
        newDisplayName: 'Civic Platform',
      }),
    ).toBe(true);
    expect(
      handler.payloadValidator.is({
        actor: { type: 'system' },
        entityKey: 'district:civic-platform',
        newDisplayName: 'Civic Platform',
      }),
    ).toBe(false);
    expect(RENAMABLE_ENTITY_TYPES).toEqual(
      new Set(['actor_blueprint', 'district', 'institution', 'organization', 'player_character']),
    );
  });
});
