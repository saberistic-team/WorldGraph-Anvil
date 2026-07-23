import { describe, expect, it } from 'vitest';

import {
  MAX_SIGNED_MINOR,
  buildEconomyCommand,
  economyErrorMessage,
  formatMinor,
  isEconomyConflict,
  isTickInFuture,
  previewAmount,
  projectedMinor,
  type EconomySummary,
} from './economy-model';

const summary: EconomySummary = {
  capabilities: {
    canAdoptLegacySeed: false,
    canInitialize: false,
    canIssue: true,
    canReconcile: true,
  },
  currentTick: '12',
  designVersion: '3',
  economyHeadVersion: '9',
  featurePolicy: {
    debitsFrozen: false,
    issuanceEnabled: true,
    offersEnabled: true,
    transfersEnabled: true,
  },
  initializedEventId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
  issuanceTarget: {
    currencyCode: 'GCR',
    currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
    currencyVersion: '1',
    currentSupplyMinor: '250000',
    maxSupplyMinor: '100000000',
    minorUnitScale: 2,
    supplyVersion: '4',
    treasuryBalanceMinor: '200000',
    treasuryBalanceVersion: '7',
    treasuryWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
    treasuryWalletVersion: '1',
  },
  projectionChecksum: 'a'.repeat(64),
  reconciliation: {
    lastReconciledAt: '2026-07-21T12:00:00.000Z',
    lastReconciledStateRevision: '8',
    status: 'current',
  },
  seedPlan: { available: true, hash: 'b'.repeat(64), sourceKind: 'compiler_1_1' },
  stateRevision: '12',
  status: 'ready',
  virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
  worldId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
};

describe('economy UI model', () => {
  it('normalizes exact scale-aware decimal input without floating point', () => {
    expect(previewAmount('25', 2)).toEqual({
      ok: true,
      value: { canonical: '25.00', minor: '2500' },
    });
    expect(previewAmount('0.01', 2)).toEqual({
      ok: true,
      value: { canonical: '0.01', minor: '1' },
    });
    expect(previewAmount('1.2', 6)).toEqual({
      ok: true,
      value: { canonical: '1.200000', minor: '1200000' },
    });
  });

  it('rejects ambiguity, excess precision, zero, signs, exponent notation, and overflow', () => {
    for (const input of ['01.00', '-1.00', '+1.00', '1e2', '1,000.00', '0.00']) {
      expect(previewAmount(input, 2).ok, input).toBe(false);
    }
    expect(previewAmount('1.001', 2).ok).toBe(false);
    expect(previewAmount(`${MAX_SIGNED_MINOR + 1n}`, 0).ok).toBe(false);
  });

  it('formats signed minor units and computes explicitly non-authoritative previews exactly', () => {
    expect(formatMinor('123456', 2)).toBe('1,234.56');
    expect(formatMinor('-5', 2)).toBe('-0.05');
    expect(projectedMinor('100', '-25')).toBe('75');
    expect(projectedMinor('10', '-11')).toBeNull();
  });

  it('builds a versioned command envelope with one stable idempotency identity', () => {
    expect(
      buildEconomyCommand(summary, 'TransferCurrencyV1', { amount: '1.00' }, 'command-1'),
    ).toEqual({
      commandId: 'command-1',
      expectedAggregateVersion: '9',
      expectedStateRevision: '12',
      expectedWorldVersion: '3',
      idempotencyKey: 'economy-TransferCurrencyV1-command-1',
      payload: { amount: '1.00' },
      schemaVersion: 1,
      type: 'TransferCurrencyV1',
    });
  });

  it('recognizes conflicts and authoritative future ticks', () => {
    expect(isEconomyConflict('REVISION_CONFLICT')).toBe(true);
    expect(economyErrorMessage('OWNERSHIP_CONFLICT')).toMatch(/Authoritative state changed/u);
    expect(isTickInFuture('13', '12')).toBe(true);
    expect(isTickInFuture('12', '12')).toBe(false);
    expect(isTickInFuture('12.5', '12')).toBe(false);
  });
});
