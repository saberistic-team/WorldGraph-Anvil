import { describe, expect, it } from 'vitest';

import {
  ACCEPT_ASSET_TRANSFER_OFFER_COMMAND,
  ACCEPT_EMPLOYMENT_CONTRACT_COMMAND,
  ADVANCE_SIMULATION_COMMAND,
  ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND,
  CANCEL_ASSET_TRANSFER_OFFER_COMMAND,
  CANCEL_MARKET_LISTING_COMMAND,
  CANCEL_SCHEDULED_ACTION_COMMAND,
  COMMERCE_PUBLIC_COMMAND_TYPES,
  CONFIGURE_WORLD_CLOCK_COMMAND,
  CONFIGURE_BUSINESS_FACILITY_COMMAND,
  CREATE_ASSET_TRANSFER_OFFER_COMMAND,
  CREATE_BUSINESS_COMMAND,
  CREATE_EMPLOYMENT_CONTRACT_COMMAND,
  CREATE_MARKET_LISTING_COMMAND,
  END_EMPLOYMENT_CONTRACT_COMMAND,
  FREEZE_CURRENCY_COMMAND,
  FREEZE_WALLET_COMMAND,
  INITIALIZE_WORLD_ECONOMY_COMMAND,
  INITIALIZE_WORLD_COMMERCE_COMMAND,
  ISSUE_CURRENCY_COMMAND,
  PAUSE_WORLD_CLOCK_COMMAND,
  PERFORM_JOB_COMMAND,
  PURCHASE_MARKET_LISTING_COMMAND,
  RECONCILE_WORLD_COMMERCE_COMMAND,
  RECONCILE_WORLD_ECONOMY_COMMAND,
  RENAME_WORLD_ENTITY_COMMAND,
  RENAMABLE_ENTITY_TYPES,
  RESOLVE_SIMULATION_FAILURE_COMMAND,
  SCHEDULE_WORLD_NOTICE_COMMAND,
  START_WORLD_CLOCK_COMMAND,
  START_PRODUCTION_RUN_COMMAND,
  TRANSFER_ASSET_COMMAND,
  TRANSFER_CURRENCY_COMMAND,
  UNFREEZE_CURRENCY_COMMAND,
  UNFREEZE_WALLET_COMMAND,
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
    expect(registry.registeredVersions()).toEqual([
      { schemaVersion: 1, type: ACCEPT_ASSET_TRANSFER_OFFER_COMMAND },
      { schemaVersion: 1, type: ACCEPT_EMPLOYMENT_CONTRACT_COMMAND },
      { schemaVersion: 1, type: ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND },
      { schemaVersion: 1, type: ADVANCE_SIMULATION_COMMAND },
      { schemaVersion: 1, type: CANCEL_ASSET_TRANSFER_OFFER_COMMAND },
      { schemaVersion: 1, type: CANCEL_MARKET_LISTING_COMMAND },
      { schemaVersion: 1, type: CANCEL_SCHEDULED_ACTION_COMMAND },
      { schemaVersion: 1, type: CONFIGURE_BUSINESS_FACILITY_COMMAND },
      { schemaVersion: 1, type: CONFIGURE_WORLD_CLOCK_COMMAND },
      { schemaVersion: 1, type: CREATE_ASSET_TRANSFER_OFFER_COMMAND },
      { schemaVersion: 1, type: CREATE_BUSINESS_COMMAND },
      { schemaVersion: 1, type: CREATE_EMPLOYMENT_CONTRACT_COMMAND },
      { schemaVersion: 1, type: CREATE_MARKET_LISTING_COMMAND },
      { schemaVersion: 1, type: END_EMPLOYMENT_CONTRACT_COMMAND },
      { schemaVersion: 1, type: FREEZE_CURRENCY_COMMAND },
      { schemaVersion: 1, type: FREEZE_WALLET_COMMAND },
      { schemaVersion: 1, type: INITIALIZE_WORLD_COMMERCE_COMMAND },
      { schemaVersion: 1, type: INITIALIZE_WORLD_ECONOMY_COMMAND },
      { schemaVersion: 1, type: ISSUE_CURRENCY_COMMAND },
      { schemaVersion: 1, type: PAUSE_WORLD_CLOCK_COMMAND },
      { schemaVersion: 1, type: PERFORM_JOB_COMMAND },
      { schemaVersion: 1, type: PURCHASE_MARKET_LISTING_COMMAND },
      { schemaVersion: 1, type: RECONCILE_WORLD_COMMERCE_COMMAND },
      { schemaVersion: 1, type: RECONCILE_WORLD_ECONOMY_COMMAND },
      { schemaVersion: 1, type: RENAME_WORLD_ENTITY_COMMAND },
      { schemaVersion: 1, type: RESOLVE_SIMULATION_FAILURE_COMMAND },
      { schemaVersion: 1, type: SCHEDULE_WORLD_NOTICE_COMMAND },
      { schemaVersion: 1, type: START_PRODUCTION_RUN_COMMAND },
      { schemaVersion: 1, type: START_WORLD_CLOCK_COMMAND },
      { schemaVersion: 1, type: TRANSFER_ASSET_COMMAND },
      { schemaVersion: 1, type: TRANSFER_CURRENCY_COMMAND },
      { schemaVersion: 1, type: UNFREEZE_CURRENCY_COMMAND },
      { schemaVersion: 1, type: UNFREEZE_WALLET_COMMAND },
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
