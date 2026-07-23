export type EconomyLockKind =
  | 'asset'
  | 'business'
  | 'contract'
  | 'facility'
  | 'inventory'
  | 'listing'
  | 'offer'
  | 'production_run'
  | 'reservation'
  | 'wallet';

export interface EconomyLockTarget {
  id: string;
  kind: EconomyLockKind;
}

const lockRank = {
  listing: 0,
  offer: 1,
  reservation: 2,
  production_run: 3,
  contract: 4,
  business: 5,
  facility: 6,
  inventory: 7,
  asset: 8,
  wallet: 9,
} as const;

export function deterministicEconomyLockOrder(
  targets: readonly EconomyLockTarget[],
): EconomyLockTarget[] {
  const unique = new Map<string, EconomyLockTarget>();
  for (const target of targets) unique.set(`${target.kind}\0${target.id}`, { ...target });
  return [...unique.values()].sort((left, right) => {
    const rank = lockRank[left.kind] - lockRank[right.kind];
    if (rank !== 0) return rank;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function deterministicWalletLockOrder(walletIds: readonly string[]): string[] {
  return [...new Set(walletIds)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
