import { createHash } from 'node:crypto';

import {
  ErrorCodes,
  canonicalJson,
  type EconomyReconciliationDocumentV1,
} from '@worldgraph/contracts';

import { assertBalancedTransaction, type EconomyPosting } from './accounting.js';
import { assertInt64, assertNonNegativeInt64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

export interface AccountingJournalFact {
  currencyKey: string;
  postings: readonly EconomyPosting[];
  sequence: bigint;
  supplyDeltaMinor: bigint;
  transactionId: string;
}

export interface OwnershipJournalFact {
  assetKey: string;
  ownerEntityLogicalKey: string;
  ownershipVersion: bigint;
  sequence: bigint;
}

export interface RebuiltEconomyState {
  assetOwners: ReadonlyMap<string, { ownerEntityLogicalKey: string; ownershipVersion: bigint }>;
  currencySupply: ReadonlyMap<string, bigint>;
  walletBalances: ReadonlyMap<string, bigint>;
}

export interface EconomyProjectionSnapshot {
  assetOwners: ReadonlyMap<string, { ownerEntityLogicalKey: string; ownershipVersion: bigint }>;
  currencySupply: ReadonlyMap<string, bigint>;
  walletBalances: ReadonlyMap<string, bigint>;
}

export interface EconomyReconciliationMismatch {
  actual: string | null;
  expected: string | null;
  key: string;
  kind: 'asset_ownership' | 'currency_supply' | 'wallet_balance';
}

function sequenceOrder<T extends { sequence: bigint }>(facts: readonly T[]): T[] {
  return [...facts].sort((left, right) =>
    left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0,
  );
}

export function rebuildEconomyState(input: {
  accountingFacts: readonly AccountingJournalFact[];
  ownershipFacts: readonly OwnershipJournalFact[];
}): RebuiltEconomyState {
  const walletBalances = new Map<string, bigint>();
  const currencySupply = new Map<string, bigint>();
  const assetOwners = new Map<
    string,
    { ownerEntityLogicalKey: string; ownershipVersion: bigint }
  >();
  const sequences = new Set<string>();
  for (const fact of sequenceOrder(input.accountingFacts)) {
    const sequenceKey = `accounting:${fact.sequence.toString()}`;
    if (sequences.has(sequenceKey)) {
      throw new EconomyDomainError(
        ErrorCodes.accountingUnbalanced,
        'Accounting journal sequence is duplicated.',
      );
    }
    sequences.add(sequenceKey);
    assertBalancedTransaction({ postings: fact.postings, supplyDeltaMinor: fact.supplyDeltaMinor });
    for (const posting of fact.postings) {
      const next = assertInt64(
        (walletBalances.get(posting.walletId) ?? 0n) + posting.signedAmountMinor,
      );
      walletBalances.set(posting.walletId, assertNonNegativeInt64(next));
    }
    const supply = assertInt64(
      (currencySupply.get(fact.currencyKey) ?? 0n) + fact.supplyDeltaMinor,
    );
    currencySupply.set(fact.currencyKey, assertNonNegativeInt64(supply));
  }
  for (const fact of sequenceOrder(input.ownershipFacts)) {
    const current = assetOwners.get(fact.assetKey);
    if (current !== undefined && fact.ownershipVersion !== current.ownershipVersion + 1n) {
      throw new EconomyDomainError(
        ErrorCodes.ownershipConflict,
        'Ownership journal versions must be contiguous.',
      );
    }
    if (current === undefined && fact.ownershipVersion !== 1n) {
      throw new EconomyDomainError(
        ErrorCodes.ownershipConflict,
        'Initial ownership journal version must be one.',
      );
    }
    assetOwners.set(fact.assetKey, {
      ownerEntityLogicalKey: fact.ownerEntityLogicalKey,
      ownershipVersion: fact.ownershipVersion,
    });
  }
  return { assetOwners, currencySupply, walletBalances };
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function economyReconciliationDocumentV1(
  state: EconomyProjectionSnapshot,
): EconomyReconciliationDocumentV1 {
  return {
    domain: 'worldgraph.economy-reconciliation.v1' as const,
    economyReconciliationSchemaVersion: 1,
    ownership: sortedEntries(state.assetOwners).map(([assetKey, ownership]) => ({
      assetKey,
      ownerEntityLogicalKey: ownership.ownerEntityLogicalKey,
      ownershipVersion: ownership.ownershipVersion.toString(),
    })),
    supply: sortedEntries(state.currencySupply).map(([currencyKey, currentSupplyMinor]) => ({
      currencyKey,
      currentSupplyMinor: currentSupplyMinor.toString(),
    })),
    wallets: sortedEntries(state.walletBalances).map(([walletId, availableMinor]) => ({
      availableMinor: availableMinor.toString(),
      walletId,
    })),
  };
}

export function economyReconciliationChecksumV1(state: EconomyProjectionSnapshot): string {
  return createHash('sha256')
    .update(canonicalJson(economyReconciliationDocumentV1(state)), 'utf8')
    .digest('hex');
}

/** @deprecated Use the explicitly versioned reconciliation checksum. */
export function economyStateChecksum(state: EconomyProjectionSnapshot): string {
  return economyReconciliationChecksumV1(state);
}

function compareBigintMaps(
  kind: 'currency_supply' | 'wallet_balance',
  expected: ReadonlyMap<string, bigint>,
  actual: ReadonlyMap<string, bigint>,
): EconomyReconciliationMismatch[] {
  const keys = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  return keys.flatMap((key) => {
    const expectedValue = expected.get(key);
    const actualValue = actual.get(key);
    return expectedValue === actualValue
      ? []
      : [
          {
            actual: actualValue?.toString() ?? null,
            expected: expectedValue?.toString() ?? null,
            key,
            kind,
          },
        ];
  });
}

export function reconcileEconomyState(
  rebuilt: RebuiltEconomyState,
  projection: EconomyProjectionSnapshot,
): { checksum: string; mismatches: EconomyReconciliationMismatch[] } {
  const mismatches = [
    ...compareBigintMaps('wallet_balance', rebuilt.walletBalances, projection.walletBalances),
    ...compareBigintMaps('currency_supply', rebuilt.currencySupply, projection.currencySupply),
  ];
  const keys = [
    ...new Set([...rebuilt.assetOwners.keys(), ...projection.assetOwners.keys()]),
  ].sort();
  for (const key of keys) {
    const expected = rebuilt.assetOwners.get(key);
    const actual = projection.assetOwners.get(key);
    if (
      expected?.ownerEntityLogicalKey !== actual?.ownerEntityLogicalKey ||
      expected?.ownershipVersion !== actual?.ownershipVersion
    ) {
      mismatches.push({
        actual:
          actual === undefined
            ? null
            : `${actual.ownerEntityLogicalKey}@${actual.ownershipVersion.toString()}`,
        expected:
          expected === undefined
            ? null
            : `${expected.ownerEntityLogicalKey}@${expected.ownershipVersion.toString()}`,
        key,
        kind: 'asset_ownership',
      });
    }
  }
  return { checksum: economyReconciliationChecksumV1(rebuilt), mismatches };
}
