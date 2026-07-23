import { createHash } from 'node:crypto';

import {
  canonicalJson,
  CommerceProjectionRepairPlanV1Schema,
  createValidator,
  type CommerceProjectionRepairPlanV1,
  type Validator,
} from '@worldgraph/contracts';

export const COMMERCE_PROJECTION_REPAIR_APPROVAL_CONFIRMATION =
  'APPROVE APPEND-ONLY COMMERCE REPAIR';
export const COMMERCE_PROJECTION_REPAIR_EXECUTION_CONFIRMATION =
  'APPLY APPEND-ONLY COMMERCE REPAIR';

const PLAN_LIFETIME_MILLISECONDS = 15 * 60 * 1_000;
const planValidator: Validator<CommerceProjectionRepairPlanV1> =
  createValidator<CommerceProjectionRepairPlanV1>(CommerceProjectionRepairPlanV1Schema);

function fail(message: string): never {
  throw new Error(message);
}

function scaledQuantity(value: string): bigint {
  const [whole, fraction = ''] = value.split('.', 2);
  return BigInt(whole!) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'));
}

export function validateCommerceProjectionRepairReason(value: string): string {
  const characterLength = [...value].length;
  if (
    characterLength < 20 ||
    characterLength > 1_000 ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    })
  ) {
    fail(
      'Commerce projection repair reason must contain 20-1000 Unicode code points without edge ASCII spaces or C0/DEL/C1 controls.',
    );
  }
  return value;
}

export function assertOperatorCommerceProjectionRepairPlan(
  value: unknown,
): CommerceProjectionRepairPlanV1 {
  planValidator.assert(value);
  const plan = value;
  const preparedAt = Date.parse(plan.preparedAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (expiresAt - preparedAt !== PLAN_LIFETIME_MILLISECONDS) {
    fail('Commerce projection repair plan does not have the exact 15-minute review window.');
  }
  validateCommerceProjectionRepairReason(plan.reason);
  if (plan.sourceReconciliationLiveChecksum === plan.sourceReconciliationRebuiltChecksum) {
    fail('Commerce projection repair plan does not bind an actual reconciliation mismatch.');
  }

  const reservedIds = [
    plan.repairPlanId,
    plan.reservedCommandId,
    plan.reservedEventId,
    plan.reservedLedgerEntryId,
    ...plan.items.map((item) => item.repairFactId),
  ];
  if (new Set(reservedIds).size !== reservedIds.length) {
    fail('Commerce projection repair plan reuses a reserved effect identity.');
  }

  for (const [index, item] of plan.items.entries()) {
    if (item.itemOrdinal !== index) {
      fail('Commerce projection repair items are not ordinal-contiguous.');
    }
    if (index > 0 && plan.items[index - 1]!.inventoryId >= item.inventoryId) {
      fail('Commerce projection repair items are not strictly sorted by inventory UUID.');
    }
    const actualQuantity = scaledQuantity(item.actualQuantity);
    const actualReservedQuantity = scaledQuantity(item.actualReservedQuantity);
    const repairedQuantity = scaledQuantity(item.repairedQuantity);
    const repairedReservedQuantity = scaledQuantity(item.repairedReservedQuantity);
    if (actualReservedQuantity > actualQuantity || repairedReservedQuantity > repairedQuantity) {
      fail('Commerce projection repair item violates the inventory reservation bound.');
    }
    const expectedMismatchKinds = [
      ...(actualQuantity === repairedQuantity ? [] : (['quantity'] as const)),
      ...(actualReservedQuantity === repairedReservedQuantity ? [] : (['reservation'] as const)),
    ];
    if (
      expectedMismatchKinds.length === 0 ||
      canonicalJson(expectedMismatchKinds) !== canonicalJson(item.mismatchKinds)
    ) {
      fail('Commerce projection repair item mismatch kinds do not match its exact delta.');
    }
  }

  const { planHash, ...planBody } = plan;
  const computedHash = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'worldgraph.commerce-projection-repair-plan-hash.v1',
        plan: planBody,
      }),
      'utf8',
    )
    .digest('hex');
  if (computedHash !== planHash) {
    fail('Commerce projection repair preparation returned an invalid canonical plan hash.');
  }
  return plan;
}
