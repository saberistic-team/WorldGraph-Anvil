import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ErrorCodes, canonicalJson } from '@worldgraph/contracts';

import {
  EconomyDomainError,
  assertBalancedTransaction,
  assertInventoryState,
  assertProductionRunTransition,
  availableInventory,
  consumeReservedInventory,
  createTransferDecision,
  creditInventory,
  decideAssetGift,
  decideJobPerformance,
  decideListingTerminal,
  decideMarketPurchase,
  decideProductionCompletion,
  decideProductionReservation,
  projectAccountingDecision,
  releaseInventoryReservation,
  reserveInventory,
  type AssetDecisionState,
  type EmploymentContractState,
  type InventoryState,
  type MarketListingState,
  type ProductionRecipeVersionState,
  type RecipeResourceAmount,
  type TaxPolicyState,
} from './index.js';

const initialCurrencySupply = 30_000n;
const initialResourceQuantity = 100n;

function nextRandom(state: bigint): bigint {
  return (state * 48_271n) % 2_147_483_647n;
}

function expectDomainCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(EconomyDomainError);
    expect((error as EconomyDomainError).code).toBe(code);
  }
}

const salesTax: TaxPolicyState = {
  basisPoints: 250,
  collectionMode: 'added_to_payer',
  fixedMinor: null,
  id: 'tax:sales:invariant',
  roundingMode: 'floor',
  status: 'active',
  taxType: 'sales',
  treasuryWalletId: 'wallet:treasury',
};

const payrollTax: TaxPolicyState = {
  basisPoints: 500,
  collectionMode: 'withheld_from_recipient',
  fixedMinor: null,
  id: 'tax:payroll:invariant',
  roundingMode: 'floor',
  status: 'active',
  taxType: 'payroll',
  treasuryWalletId: 'wallet:treasury',
};

const productionRecipe: ProductionRecipeVersionState = {
  durationTicks: 3n,
  inputs: [
    { quantityAtoms: 2n, resourceTypeId: 'resource:ore' },
    { quantityAtoms: 1n, resourceTypeId: 'resource:energy' },
  ],
  outputs: [{ quantityAtoms: 1n, resourceTypeId: 'resource:part' }],
  recipeId: 'recipe:harbor-part',
  version: 1,
};

const employmentContract: EmploymentContractState = {
  activeFromTick: 0n,
  activeUntilTick: 1_000n,
  cooldownTicks: 2n,
  employerWalletId: 'wallet:seller',
  id: 'employment:invariant',
  maxPerformancesPerPeriod: 3,
  periodTicks: 10n,
  rowVersion: 1n,
  status: 'active',
  wageMinor: 400n,
  workerWalletId: 'wallet:buyer',
};

interface PendingProductionRun {
  dueTick: bigint;
  id: string;
  inputs: readonly RecipeResourceAmount[];
  outputs: readonly RecipeResourceAmount[];
  runQuantity: bigint;
  status: 'ready' | 'completed';
}

type JobDecision = ReturnType<typeof decideJobPerformance>;

interface PendingPayroll {
  decision: JobDecision;
  dueTick: bigint;
  id: string;
  workId: string;
}

function deterministicScheduleEvidence(seed: bigint): {
  eventChecksum: string;
  stateChecksum: string;
} {
  let random = nextRandom(seed);
  const offeredAtoms = (random % 8n) + 2n;
  random = nextRandom(random);
  const purchasedAtoms = (random % offeredAtoms) + 1n;
  random = nextRandom(random);
  const unitPriceMinor = (random % 200n) + 1n;
  let sellerInventory: InventoryState = {
    id: 'inventory:seller',
    quantityAtoms: 20n,
    reservedAtoms: 0n,
    rowVersion: 1n,
  };
  let buyerInventory: InventoryState = {
    id: 'inventory:buyer',
    quantityAtoms: 0n,
    reservedAtoms: 0n,
    rowVersion: 1n,
  };
  const reserved = reserveInventory(sellerInventory, offeredAtoms, sellerInventory.rowVersion);
  sellerInventory = { id: sellerInventory.id, ...reserved };
  const listing: MarketListingState = {
    currencyId: 'currency:gcr',
    expiresAtTick: 100n,
    id: 'listing:deterministic',
    quantityScale: 0,
    remainingAtoms: offeredAtoms,
    rowVersion: 1n,
    sellerEntityId: 'organization:seller',
    sellerWalletId: 'wallet:seller',
    status: 'open',
    unitPriceMinor,
    worldId: 'world:deterministic',
  };
  const purchase = decideMarketPurchase({
    buyerEntityId: 'character:buyer',
    buyerWalletId: 'wallet:buyer',
    currentTick: 12n,
    expectedListingVersion: listing.rowVersion,
    listing,
    quantityAtoms: purchasedAtoms,
    taxPolicy: salesTax,
  });
  const projected = projectAccountingDecision({
    currentBalances: new Map([
      ['wallet:buyer', 10_000n],
      ['wallet:seller', 0n],
      ['wallet:treasury', 0n],
    ]),
    currentSupplyMinor: 10_000n,
    decision: purchase.settlement,
    maxSupplyMinor: 10_000n,
  });
  const debited = consumeReservedInventory(
    sellerInventory,
    purchasedAtoms,
    sellerInventory.rowVersion,
  );
  const credited = creditInventory(buyerInventory, purchasedAtoms, buyerInventory.rowVersion);
  sellerInventory = { id: sellerInventory.id, ...debited };
  buyerInventory = { id: buyerInventory.id, ...credited };
  const events = [
    {
      offeredAtoms: offeredAtoms.toString(),
      type: 'MarketListingCreatedV1',
      unitPriceMinor: unitPriceMinor.toString(),
    },
    {
      grossMinor: purchase.grossMinor.toString(),
      purchasedAtoms: purchasedAtoms.toString(),
      taxMinor: (purchase.tax?.amountMinor ?? 0n).toString(),
      type: 'MarketTradeCompletedV1',
    },
    {
      remainingAtoms: purchase.remainingAtoms.toString(),
      status: purchase.status,
      type:
        purchase.status === 'filled' ? 'MarketListingFilledV1' : 'MarketListingPartiallyFilledV1',
    },
  ];
  const state = {
    balances: [...projected.balances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([walletId, balanceMinor]) => ({ balanceMinor: balanceMinor.toString(), walletId })),
    buyerInventory: {
      quantityAtoms: buyerInventory.quantityAtoms.toString(),
      reservedAtoms: buyerInventory.reservedAtoms.toString(),
      rowVersion: buyerInventory.rowVersion.toString(),
    },
    listing: {
      remainingAtoms: purchase.remainingAtoms.toString(),
      rowVersion: purchase.listingVersion.toString(),
      status: purchase.status,
    },
    sellerInventory: {
      quantityAtoms: sellerInventory.quantityAtoms.toString(),
      reservedAtoms: sellerInventory.reservedAtoms.toString(),
      rowVersion: sellerInventory.rowVersion.toString(),
    },
  };
  return {
    eventChecksum: createHash('sha256').update(canonicalJson(events), 'utf8').digest('hex'),
    stateChecksum: createHash('sha256').update(canonicalJson(state), 'utf8').digest('hex'),
  };
}

describe('mixed commerce command invariants', () => {
  it('replays the same seeded economic schedule to identical event and state checksums', () => {
    const first = deterministicScheduleEvidence(0x5eedn);
    const replay = deterministicScheduleEvidence(0x5eedn);
    expect(replay).toEqual(first);
    expect(first.eventChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.stateChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(deterministicScheduleEvidence(0x5eeen)).not.toEqual(first);
  });

  it('preserves money, recipe, payroll, reservation, and ownership invariants across 500 sequences', () => {
    for (let sequence = 0; sequence < 500; sequence += 1) {
      let random = BigInt(sequence + 1);
      let tick = 1n;
      let listingOrdinal = 0;
      let productionRunOrdinal = 0;
      let workOrdinal = 0;
      let balances = new Map<string, bigint>([
        ['wallet:buyer', 10_000n],
        ['wallet:seller', 10_000n],
        ['wallet:treasury', 10_000n],
      ]);
      let sellerInventory: InventoryState = {
        id: 'inventory:seller',
        quantityAtoms: initialResourceQuantity,
        reservedAtoms: 0n,
        rowVersion: 1n,
      };
      let buyerInventory: InventoryState = {
        id: 'inventory:buyer',
        quantityAtoms: 0n,
        reservedAtoms: 0n,
        rowVersion: 1n,
      };
      let listing: MarketListingState | null = null;
      let asset: AssetDecisionState = {
        active: true,
        controlledByActor: true,
        id: 'asset:workshop',
        ownerEntityLogicalKey: 'organization:a',
        ownershipVersion: 1n,
        transferable: true,
        worldId: 'world:invariant',
      };
      const productionInventories = new Map<string, InventoryState>([
        [
          'resource:ore',
          {
            id: 'inventory:production:ore',
            quantityAtoms: 80n,
            reservedAtoms: 0n,
            rowVersion: 1n,
          },
        ],
        [
          'resource:energy',
          {
            id: 'inventory:production:energy',
            quantityAtoms: 40n,
            reservedAtoms: 0n,
            rowVersion: 1n,
          },
        ],
        [
          'resource:part',
          {
            id: 'inventory:production:part',
            quantityAtoms: 0n,
            reservedAtoms: 0n,
            rowVersion: 1n,
          },
        ],
      ]);
      const initialProductionQuantities = new Map(
        [...productionInventories.entries()].map(([resourceTypeId, inventory]) => [
          resourceTypeId,
          inventory.quantityAtoms,
        ]),
      );
      const consumedProductionInputs = new Map<string, bigint>();
      const creditedProductionOutputs = new Map<string, bigint>();
      const productionRuns: PendingProductionRun[] = [];
      const workRecords = new Map<string, { payrollId: string }>();
      const payrollSchedules = new Map<string, PendingPayroll>();
      const payrollTerminalStatus = new Map<string, 'paid' | 'failed'>();
      const payrollTerminalEffects = new Map<string, number>();
      const payrollRewardApplications = new Map<string, number>();
      const paidRewards = new Set<string>();
      const performancesByPeriod = new Map<string, number>();
      let lastPerformedTick: bigint | null = null;
      let lastWorkId: string | null = null;

      const settlePayrollOnce = (payrollId: string): void => {
        const payroll = payrollSchedules.get(payrollId);
        expect(payroll).toBeDefined();
        if (!payroll || payroll.dueTick > tick || payrollTerminalStatus.has(payrollId)) return;

        payrollTerminalEffects.set(payrollId, (payrollTerminalEffects.get(payrollId) ?? 0) + 1);
        try {
          const projected = projectAccountingDecision({
            currentBalances: balances,
            currentSupplyMinor: initialCurrencySupply,
            decision: payroll.decision.settlement,
            maxSupplyMinor: initialCurrencySupply,
          });
          balances = new Map(projected.balances);
          payrollTerminalStatus.set(payrollId, 'paid');
          payrollRewardApplications.set(
            payrollId,
            (payrollRewardApplications.get(payrollId) ?? 0) + 1,
          );
          paidRewards.add(payrollId);
        } catch (error) {
          expect(error).toBeInstanceOf(EconomyDomainError);
          expect((error as EconomyDomainError).code).toBe(ErrorCodes.insufficientFunds);
          payrollTerminalStatus.set(payrollId, 'failed');
        }
      };

      const scheduleWorkOnce = (workId: string): boolean => {
        if (workRecords.has(workId)) return false;
        const periodKey = (tick / employmentContract.periodTicks).toString();
        const performancesInPeriod = performancesByPeriod.get(periodKey) ?? 0;
        let decision: JobDecision;
        try {
          decision = decideJobPerformance({
            contract: employmentContract,
            currentTick: tick,
            lastPerformedTick,
            performancesInPeriod,
            taxPolicy: payrollTax,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(EconomyDomainError);
          expect([ErrorCodes.jobCapExceeded, ErrorCodes.jobCooldown]).toContain(
            (error as EconomyDomainError).code,
          );
          return false;
        }

        expect(assertBalancedTransaction(decision.settlement)).toBe(decision.settlement);
        expect(decision.grossMinor).toBe(employmentContract.wageMinor);
        expect(decision.tax?.amountMinor).toBe(20n);
        expect(decision.netMinor).toBe(380n);
        expect(decision.settlement.postings).toEqual([
          { signedAmountMinor: 380n, walletId: 'wallet:buyer' },
          { signedAmountMinor: -400n, walletId: 'wallet:seller' },
          { signedAmountMinor: 20n, walletId: 'wallet:treasury' },
        ]);

        const payrollId = `payroll:${workId}`;
        workRecords.set(workId, { payrollId });
        payrollSchedules.set(payrollId, {
          decision,
          dueTick: tick + 1n,
          id: payrollId,
          workId,
        });
        performancesByPeriod.set(periodKey, performancesInPeriod + 1);
        lastPerformedTick = tick;
        lastWorkId = workId;
        return true;
      };

      for (let command = 0; command < 40; command += 1) {
        for (const run of productionRuns) {
          if (run.status !== 'ready' || run.dueTick > tick) continue;
          expect(
            decideProductionCompletion({
              currentTick: tick,
              dueTick: run.dueTick,
              status: run.status,
            }),
          ).toEqual({ status: 'completed' });
          assertProductionRunTransition(run.status, 'completed');
          for (const requirement of run.inputs) {
            const before = productionInventories.get(requirement.resourceTypeId);
            expect(before).toBeDefined();
            if (!before) continue;
            const after = consumeReservedInventory(
              before,
              requirement.quantityAtoms,
              before.rowVersion,
            );
            expect(before.quantityAtoms - after.quantityAtoms).toBe(requirement.quantityAtoms);
            expect(before.reservedAtoms - after.reservedAtoms).toBe(requirement.quantityAtoms);
            productionInventories.set(requirement.resourceTypeId, { id: before.id, ...after });
            consumedProductionInputs.set(
              requirement.resourceTypeId,
              (consumedProductionInputs.get(requirement.resourceTypeId) ?? 0n) +
                requirement.quantityAtoms,
            );
          }
          for (const output of run.outputs) {
            const before = productionInventories.get(output.resourceTypeId);
            expect(before).toBeDefined();
            if (!before) continue;
            const after = creditInventory(before, output.quantityAtoms, before.rowVersion);
            expect(after.quantityAtoms - before.quantityAtoms).toBe(output.quantityAtoms);
            expect(after.reservedAtoms).toBe(before.reservedAtoms);
            productionInventories.set(output.resourceTypeId, { id: before.id, ...after });
            creditedProductionOutputs.set(
              output.resourceTypeId,
              (creditedProductionOutputs.get(output.resourceTypeId) ?? 0n) + output.quantityAtoms,
            );
          }
          run.status = 'completed';
        }

        for (const payroll of payrollSchedules.values()) {
          if (payroll.dueTick > tick || payrollTerminalStatus.has(payroll.id)) continue;
          settlePayrollOnce(payroll.id);
          const balancesAfterFirstAttempt = new Map(balances);
          settlePayrollOnce(payroll.id);
          expect(balances).toEqual(balancesAfterFirstAttempt);
        }

        random = nextRandom(random);
        const operation =
          command === 0 ? 7 : command === 1 ? 8 : command === 2 ? 9 : Number(random % 10n);
        random = nextRandom(random);

        if (operation === 0) {
          const walletIds = ['wallet:buyer', 'wallet:seller', 'wallet:treasury'] as const;
          const sourceIndex = Number(random % 3n);
          const destinationIndex = (sourceIndex + 1 + Number((random / 3n) % 2n)) % 3;
          const amountMinor = (random % 2_000n) + 1n;
          const decision = createTransferDecision(
            walletIds[sourceIndex]!,
            walletIds[destinationIndex]!,
            amountMinor,
          );
          assertBalancedTransaction(decision);
          try {
            const projected = projectAccountingDecision({
              currentBalances: balances,
              currentSupplyMinor: initialCurrencySupply,
              decision,
              maxSupplyMinor: initialCurrencySupply,
            });
            balances = new Map(projected.balances);
          } catch (error) {
            expect(error).toBeInstanceOf(EconomyDomainError);
            expect((error as EconomyDomainError).code).toBe(ErrorCodes.insufficientFunds);
          }
        } else if (operation === 1 && listing?.status !== 'open') {
          const available = availableInventory(sellerInventory);
          if (available > 0n) {
            const quantityAtoms = (random % available) + 1n;
            const reserved = reserveInventory(
              sellerInventory,
              quantityAtoms,
              sellerInventory.rowVersion,
            );
            sellerInventory = { id: sellerInventory.id, ...reserved };
            listingOrdinal += 1;
            listing = {
              currencyId: 'currency:gcr',
              expiresAtTick: tick + 1_000n,
              id: `listing:${listingOrdinal}`,
              quantityScale: 0,
              remainingAtoms: quantityAtoms,
              rowVersion: 1n,
              sellerEntityId: 'organization:seller',
              sellerWalletId: 'wallet:seller',
              status: 'open',
              unitPriceMinor: (random % 250n) + 1n,
              worldId: 'world:invariant',
            };
          }
        } else if (operation === 2 && listing?.status === 'open') {
          const activeListing: MarketListingState = listing;
          const quantityAtoms = (random % activeListing.remainingAtoms) + 1n;
          const purchase = decideMarketPurchase({
            buyerEntityId: 'character:buyer',
            buyerWalletId: 'wallet:buyer',
            currentTick: tick,
            expectedListingVersion: activeListing.rowVersion,
            listing: activeListing,
            quantityAtoms,
            taxPolicy: salesTax,
          });
          try {
            const projected = projectAccountingDecision({
              currentBalances: balances,
              currentSupplyMinor: initialCurrencySupply,
              decision: purchase.settlement,
              maxSupplyMinor: initialCurrencySupply,
            });
            const debited = consumeReservedInventory(
              sellerInventory,
              quantityAtoms,
              sellerInventory.rowVersion,
            );
            const credited = creditInventory(
              buyerInventory,
              quantityAtoms,
              buyerInventory.rowVersion,
            );
            balances = new Map(projected.balances);
            sellerInventory = { id: sellerInventory.id, ...debited };
            buyerInventory = { id: buyerInventory.id, ...credited };
            listing = {
              ...activeListing,
              remainingAtoms: purchase.remainingAtoms,
              rowVersion: purchase.listingVersion,
              status: purchase.status,
            };
          } catch (error) {
            expect(error).toBeInstanceOf(EconomyDomainError);
            expect((error as EconomyDomainError).code).toBe(ErrorCodes.insufficientFunds);
          }
        } else if (operation === 3 && listing?.status === 'open') {
          const activeListing: MarketListingState = listing;
          const terminal = decideListingTerminal({
            currentTick: tick,
            expectedVersion: activeListing.rowVersion,
            listing: activeListing,
            target: 'cancelled',
          });
          const released = releaseInventoryReservation(
            sellerInventory,
            terminal.releasedAtoms,
            sellerInventory.rowVersion,
          );
          sellerInventory = { id: sellerInventory.id, ...released };
          listing = {
            ...activeListing,
            rowVersion: terminal.rowVersion,
            status: terminal.status,
          };
        } else if (operation === 4) {
          const available = availableInventory(sellerInventory);
          if (available > 0n) {
            const quantityAtoms = (random % available) + 1n;
            const reserved = {
              id: sellerInventory.id,
              ...reserveInventory(sellerInventory, quantityAtoms, sellerInventory.rowVersion),
            };
            const consumed = consumeReservedInventory(reserved, quantityAtoms, reserved.rowVersion);
            const credited = creditInventory(
              buyerInventory,
              quantityAtoms,
              buyerInventory.rowVersion,
            );
            sellerInventory = { id: sellerInventory.id, ...consumed };
            buyerInventory = { id: buyerInventory.id, ...credited };
          }
        } else if (operation === 5) {
          const recipients = ['organization:a', 'organization:b', 'organization:c'] as const;
          const currentIndex = recipients.indexOf(
            asset.ownerEntityLogicalKey as (typeof recipients)[number],
          );
          const recipient = recipients[(currentIndex + 1 + Number(random % 2n)) % 3]!;
          const ownership = decideAssetGift({
            asset,
            expectedOwnershipVersion: asset.ownershipVersion,
            recipientEntityLogicalKey: recipient,
          });
          asset = {
            ...asset,
            ownerEntityLogicalKey: ownership.toOwnerEntityLogicalKey,
            ownershipVersion: ownership.ownershipVersion,
          };
        } else if (operation === 6) {
          expectDomainCode(
            () => reserveInventory(sellerInventory, 1n, sellerInventory.rowVersion - 1n),
            ErrorCodes.staleVersion,
          );
          expectDomainCode(
            () =>
              decideAssetGift({
                asset,
                expectedOwnershipVersion: asset.ownershipVersion - 1n,
                recipientEntityLogicalKey:
                  asset.ownerEntityLogicalKey === 'organization:a'
                    ? 'organization:b'
                    : 'organization:a',
              }),
            ErrorCodes.ownershipConflict,
          );
        } else if (operation === 7) {
          const ore = productionInventories.get('resource:ore')!;
          const energy = productionInventories.get('resource:energy')!;
          const maxRunQuantity =
            availableInventory(ore) / 2n < availableInventory(energy)
              ? availableInventory(ore) / 2n
              : availableInventory(energy);
          if (maxRunQuantity > 0n) {
            const boundedMax = maxRunQuantity < 3n ? maxRunQuantity : 3n;
            const runQuantity = (random % boundedMax) + 1n;
            const decision = decideProductionReservation({
              currentTick: tick,
              inputInventories: productionInventories,
              recipe: productionRecipe,
              runQuantity,
            });
            expect(decision.inputs).toEqual([
              { quantityAtoms: 2n * runQuantity, resourceTypeId: 'resource:ore' },
              { quantityAtoms: runQuantity, resourceTypeId: 'resource:energy' },
            ]);
            expect(decision.outputs).toEqual([
              { quantityAtoms: runQuantity, resourceTypeId: 'resource:part' },
            ]);
            expect(decision.dueTick).toBe(tick + productionRecipe.durationTicks);
            assertProductionRunTransition('scheduled', 'reserving');
            assertProductionRunTransition('reserving', decision.status);
            for (const requirement of decision.inputs) {
              const before = productionInventories.get(requirement.resourceTypeId)!;
              const reserved = reserveInventory(
                before,
                requirement.quantityAtoms,
                before.rowVersion,
              );
              expect(reserved.quantityAtoms).toBe(before.quantityAtoms);
              expect(reserved.reservedAtoms - before.reservedAtoms).toBe(requirement.quantityAtoms);
              productionInventories.set(requirement.resourceTypeId, {
                id: before.id,
                ...reserved,
              });
            }
            productionRunOrdinal += 1;
            productionRuns.push({
              dueTick: decision.dueTick,
              id: `production:${productionRunOrdinal}`,
              inputs: decision.inputs,
              outputs: decision.outputs,
              runQuantity,
              status: decision.status,
            });
          }
        } else if (operation === 8) {
          workOrdinal += 1;
          scheduleWorkOnce(`work:${sequence}:${workOrdinal}`);
        } else if (operation === 9 && lastWorkId !== null) {
          const workCount = workRecords.size;
          const payrollCount = payrollSchedules.size;
          expect(scheduleWorkOnce(lastWorkId)).toBe(false);
          expect(workRecords.size).toBe(workCount);
          expect(payrollSchedules.size).toBe(payrollCount);
          const payrollId = workRecords.get(lastWorkId)!.payrollId;
          const balancesBeforeRewardRetry = new Map(balances);
          settlePayrollOnce(payrollId);
          expect(balances).toEqual(balancesBeforeRewardRetry);
        }

        tick += 1n;
        expect([...balances.values()].reduce((total, value) => total + value, 0n)).toBe(
          initialCurrencySupply,
        );
        for (const balance of balances.values()) expect(balance).toBeGreaterThanOrEqual(0n);
        expect(assertInventoryState(sellerInventory)).toBe(sellerInventory);
        expect(assertInventoryState(buyerInventory)).toBe(buyerInventory);
        expect(sellerInventory.quantityAtoms + buyerInventory.quantityAtoms).toBe(
          initialResourceQuantity,
        );
        expect(sellerInventory.reservedAtoms).toBe(
          listing?.status === 'open' ? listing.remainingAtoms : 0n,
        );
        for (const [resourceTypeId, inventory] of productionInventories) {
          expect(assertInventoryState(inventory)).toBe(inventory);
          const expectedReserved = productionRuns
            .filter((run) => run.status === 'ready')
            .flatMap((run) => run.inputs)
            .filter((input) => input.resourceTypeId === resourceTypeId)
            .reduce((total, input) => total + input.quantityAtoms, 0n);
          expect(inventory.reservedAtoms).toBe(expectedReserved);
          expect(inventory.quantityAtoms).toBe(
            initialProductionQuantities.get(resourceTypeId)! -
              (consumedProductionInputs.get(resourceTypeId) ?? 0n) +
              (creditedProductionOutputs.get(resourceTypeId) ?? 0n),
          );
        }
        for (const run of productionRuns) {
          expect(run.inputs).toEqual([
            { quantityAtoms: 2n * run.runQuantity, resourceTypeId: 'resource:ore' },
            { quantityAtoms: run.runQuantity, resourceTypeId: 'resource:energy' },
          ]);
          expect(run.outputs).toEqual([
            { quantityAtoms: run.runQuantity, resourceTypeId: 'resource:part' },
          ]);
        }
        expect(payrollSchedules.size).toBe(workRecords.size);
        for (const [workId, work] of workRecords) {
          const payroll = payrollSchedules.get(work.payrollId);
          expect(payroll?.workId).toBe(workId);
          const terminalStatus = payrollTerminalStatus.get(work.payrollId);
          expect(payrollTerminalEffects.get(work.payrollId) ?? 0).toBe(
            terminalStatus === undefined ? 0 : 1,
          );
          expect(payrollRewardApplications.get(work.payrollId) ?? 0).toBe(
            terminalStatus === 'paid' ? 1 : 0,
          );
          expect(paidRewards.has(work.payrollId)).toBe(terminalStatus === 'paid');
        }
        expect(['organization:a', 'organization:b', 'organization:c']).toContain(
          asset.ownerEntityLogicalKey,
        );
        expect(asset.ownershipVersion).toBeGreaterThanOrEqual(1n);
      }
    }
  });
});
