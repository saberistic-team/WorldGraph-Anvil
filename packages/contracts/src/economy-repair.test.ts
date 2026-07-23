import { describe, expect, it } from 'vitest';

import {
  EconomyCommandRequestV1Schema,
  EconomyRepairApprovalRequestV1Schema,
  EconomyRepairApprovalV1Schema,
  EconomyRepairDeltaV1Schema,
  EconomyRepairPlanBodyV1Schema,
  EconomyRepairPlanV1Schema,
  PublicEconomyCommandRequestV1Schema,
  RepairWorldEconomyV1Schema,
} from './economy.js';
import { DomainEventEnvelopeV1Schema, WorldEconomyRepairedEventV1Schema } from './ledger.js';
import { createValidator } from './validation.js';

const id = (value: number): string => `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;
const hash = (value: string): string => value.repeat(64);

const financialDelta = {
  compensationTransactionId: id(11),
  currencyId: id(12),
  postings: [
    {
      balanceAfterMinor: '1000',
      balanceBeforeMinor: '700',
      balanceVersionAfter: '3',
      balanceVersionBefore: '2',
      compensationSignedAmountMinor: '300',
      sourcePostingOrdinal: 0,
      sourceSignedAmountMinor: '-300',
      walletId: id(14),
    },
    {
      balanceAfterMinor: '1000',
      balanceBeforeMinor: '1300',
      balanceVersionAfter: '5',
      balanceVersionBefore: '4',
      compensationSignedAmountMinor: '-300',
      sourcePostingOrdinal: 1,
      sourceSignedAmountMinor: '300',
      walletId: id(15),
    },
  ],
  reversalOfTransactionId: id(13),
  supply: {
    compensationSupplyDeltaMinor: '0',
    currencyId: id(12),
    sourceSupplyDeltaMinor: '0',
    supplyAfterMinor: '2000',
    supplyBeforeMinor: '2000',
    supplyVersionAfter: '4',
    supplyVersionBefore: '4',
  },
} as const;

const titleDelta = {
  assetId: id(16),
  compensationTransferId: id(17),
  fromOwnerEntityId: id(18),
  ownershipVersionAfter: '3',
  ownershipVersionBefore: '2',
  reversalOfTransferId: id(20),
  toOwnerEntityId: id(19),
} as const;

const deltas = {
  reverse_asset_purchase: {
    financialDelta,
    repairKind: 'reverse_asset_purchase',
    titleDelta,
  },
  reverse_asset_transfer: {
    financialDelta: null,
    repairKind: 'reverse_asset_transfer',
    titleDelta,
  },
  reverse_financial_transaction: {
    financialDelta,
    repairKind: 'reverse_financial_transaction',
    titleDelta: null,
  },
} as const;

function planBody(delta: (typeof deltas)[keyof typeof deltas]) {
  return {
    delta,
    domain: 'worldgraph.economy-repair-plan.v1',
    expiresAt: '2026-07-23T12:00:00.000Z',
    incidentReason: 'Duplicate transfer escaped idempotency enforcement.',
    pitrNotUsedReason: 'The approved recovery objective cannot tolerate a world rollback.',
    preparedAt: '2026-07-22T12:00:00.000Z',
    preparedByUserId: id(21),
    reasonCode: 'DUPLICATE_EFFECT',
    repairKind: delta.repairKind,
    repairPlanId: id(22),
    repairPlanSchemaVersion: 1,
    reservedCommandId: id(23),
    sourceCommandId: id(24),
    sourceEconomyChecksum: hash('a'),
    sourceEconomyHeadVersion: '9',
    sourceEventSequence: '81',
    sourceReconciliationRunId: id(25),
    sourceStateRevision: '47',
    sourceWorldVersion: '3',
    worldId: id(26),
  } as const;
}

function repairEvent(delta: (typeof deltas)[keyof typeof deltas]): Record<string, unknown> {
  return {
    aggregateId: id(26),
    aggregateType: 'world_economy',
    aggregateVersion: '10',
    commandId: id(23),
    eventHash: hash('b'),
    eventId: id(27),
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: 'WorldEconomyRepairedV1',
    metadata: {
      actor: { actorId: id(28), actorType: 'platform_admin' },
      authorizationRuleId: 'operations.economy.repair.execute',
      causationId: id(24),
      commandSchemaVersion: 1,
      commandType: 'RepairWorldEconomyV1',
      correlationId: id(23),
      overrideId: id(29),
      payloadClassification: 'private',
    },
    occurredAt: '2026-07-22T12:01:00.000Z',
    payload: {
      compensationTransactionId: delta.financialDelta?.compensationTransactionId ?? null,
      compensationTransferId: delta.titleDelta?.compensationTransferId ?? null,
      reasonCode: 'DUPLICATE_EFFECT',
      repairKind: delta.repairKind,
      repairPlanHash: hash('c'),
      repairPlanId: id(22),
      sourceCommandId: id(24),
    },
    recordedAt: '2026-07-22T12:01:00.000Z',
    resultingStateRevision: '48',
    worldEventSequence: '82',
    worldId: id(26),
  };
}

describe('append-only economy repair contracts', () => {
  it('admits RepairWorldEconomyV1 only through the internal command union', () => {
    const command = {
      commandId: id(23),
      expectedAggregateVersion: '9',
      expectedStateRevision: '47',
      expectedWorldVersion: '3',
      idempotencyKey: 'economy-repair-command-0001',
      payload: {
        confirmation: 'APPLY APPEND-ONLY ECONOMY REPAIR',
        repairPlanHash: hash('c'),
        repairPlanId: id(22),
        sourceCommandId: id(24),
      },
      schemaVersion: 1,
      type: 'RepairWorldEconomyV1',
    };

    expect(createValidator(RepairWorldEconomyV1Schema).is(command)).toBe(true);
    expect(createValidator(EconomyCommandRequestV1Schema).is(command)).toBe(true);
    expect(createValidator(PublicEconomyCommandRequestV1Schema).is(command)).toBe(false);
    expect(
      createValidator(RepairWorldEconomyV1Schema).is({
        ...command,
        payload: { ...command.payload, delta: financialDelta },
      }),
    ).toBe(false);
    expect(
      createValidator(RepairWorldEconomyV1Schema).is({
        ...command,
        payload: { ...command.payload, confirmation: 'yes' },
      }),
    ).toBe(false);
  });

  it('accepts exactly the three source-reversal delta variants', () => {
    const validator = createValidator(EconomyRepairDeltaV1Schema);
    for (const delta of Object.values(deltas)) expect(validator.is(delta)).toBe(true);

    expect(
      validator.is({
        ...deltas.reverse_financial_transaction,
        titleDelta,
      }),
    ).toBe(false);
    expect(
      validator.is({
        ...deltas.reverse_asset_transfer,
        financialDelta,
      }),
    ).toBe(false);
    expect(
      validator.is({
        ...deltas.reverse_asset_purchase,
        arbitraryBalanceMinor: '999999',
      }),
    ).toBe(false);
  });

  it('validates bounded plan bodies, sealed plans, and authority-specific approvals', () => {
    const body = planBody(deltas.reverse_asset_purchase);
    expect(createValidator(EconomyRepairPlanBodyV1Schema).is(body)).toBe(true);
    expect(createValidator(EconomyRepairPlanV1Schema).is({ ...body, planHash: hash('d') })).toBe(
      true,
    );
    expect(
      createValidator(EconomyRepairPlanBodyV1Schema).is({
        ...body,
        expiresAt: '2026-07-23T12:00:00Z',
      }),
    ).toBe(false);
    expect(
      createValidator(EconomyRepairPlanBodyV1Schema).is({ ...body, requestedDelta: '10' }),
    ).toBe(false);

    const request = {
      approvalId: id(30),
      authorityKind: 'creator',
      confirmation: 'APPROVE APPEND-ONLY ECONOMY REPAIR',
      planHash: hash('d'),
    };
    expect(createValidator(EconomyRepairApprovalRequestV1Schema).is(request)).toBe(true);
    expect(
      createValidator(EconomyRepairApprovalRequestV1Schema).is({
        ...request,
        confirmation: 'approve',
      }),
    ).toBe(false);

    const approvalBase = {
      approvalId: id(30),
      approvedAt: '2026-07-22T12:00:30.000Z',
      approverUserId: id(31),
      planHash: hash('d'),
      repairPlanId: id(22),
      worldId: id(26),
    };
    const approvalValidator = createValidator(EconomyRepairApprovalV1Schema);
    expect(
      approvalValidator.is({
        ...approvalBase,
        authorityKind: 'creator',
        creatorOverrideId: id(32),
      }),
    ).toBe(true);
    expect(
      approvalValidator.is({
        ...approvalBase,
        authorityKind: 'platform_admin',
        creatorOverrideId: null,
      }),
    ).toBe(true);
    expect(
      approvalValidator.is({
        ...approvalBase,
        authorityKind: 'platform_admin',
        creatorOverrideId: id(32),
      }),
    ).toBe(false);
  });

  it('enforces repair reasons by Unicode code point without normalizing operator evidence', () => {
    const validator = createValidator(EconomyRepairPlanBodyV1Schema);
    const body = planBody(deltas.reverse_asset_purchase);

    expect(validator.is({ ...body, incidentReason: '😀'.repeat(300) })).toBe(true);
    expect(validator.is({ ...body, incidentReason: '😀'.repeat(501) })).toBe(false);

    for (const incidentReason of [
      ' leading ASCII space',
      'trailing ASCII space ',
      'embedded C0\u001fcontrol',
      'embedded DEL\u007fcontrol',
      'embedded C1\u0085control',
    ]) {
      expect(validator.is({ ...body, incidentReason })).toBe(false);
    }

    expect(validator.is({ ...body, incidentReason: '\u00a0nonbreaking edge space\u00a0' })).toBe(
      true,
    );
  });

  it('binds compensation identifiers to the event variant and keeps the event private', () => {
    const eventValidator = createValidator(WorldEconomyRepairedEventV1Schema);
    const envelopeValidator = createValidator(DomainEventEnvelopeV1Schema);
    for (const delta of Object.values(deltas)) {
      const event = repairEvent(delta);
      expect(eventValidator.is(event)).toBe(true);
      expect(envelopeValidator.is(event)).toBe(true);
    }

    const financialEvent = repairEvent(deltas.reverse_financial_transaction);
    expect(
      eventValidator.is({
        ...financialEvent,
        payload: {
          ...(financialEvent.payload as Record<string, unknown>),
          compensationTransactionId: null,
        },
      }),
    ).toBe(false);
    for (const metadata of [
      {
        ...(financialEvent.metadata as Record<string, unknown>),
        authorizationRuleId: 'operations.economy.repair.approve',
      },
      { ...(financialEvent.metadata as Record<string, unknown>), causationId: null },
      { ...(financialEvent.metadata as Record<string, unknown>), overrideId: null },
    ]) {
      expect(eventValidator.is({ ...financialEvent, metadata })).toBe(false);
    }
    expect(
      eventValidator.is({
        ...financialEvent,
        metadata: {
          ...(financialEvent.metadata as Record<string, unknown>),
          payloadClassification: 'member',
        },
      }),
    ).toBe(false);
    expect(
      eventValidator.is({
        ...financialEvent,
        payload: {
          ...(financialEvent.payload as Record<string, unknown>),
          amountMinor: '300',
        },
      }),
    ).toBe(false);
  });
});
