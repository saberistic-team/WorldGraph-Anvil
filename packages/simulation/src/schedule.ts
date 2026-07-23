import type { ScheduledActionStatus, ScheduledActionV1 } from '@worldgraph/contracts';

import { parseNonNegativeInt64V1, parsePositiveInt64V1 } from './arithmetic.js';
import { SimulationDomainError } from './errors.js';

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareScheduledActionsV1(
  left: Pick<ScheduledActionV1, 'dueTick' | 'id' | 'priority' | 'scheduleSequence'>,
  right: Pick<ScheduledActionV1, 'dueTick' | 'id' | 'priority' | 'scheduleSequence'>,
): number {
  const tickOrder = compareBigInt(
    parseNonNegativeInt64V1(left.dueTick, 'due tick'),
    parseNonNegativeInt64V1(right.dueTick, 'due tick'),
  );
  if (tickOrder !== 0) return tickOrder;
  if (left.priority !== right.priority) return left.priority < right.priority ? -1 : 1;
  const sequenceOrder = compareBigInt(
    parsePositiveInt64V1(left.scheduleSequence, 'schedule sequence'),
    parsePositiveInt64V1(right.scheduleSequence, 'schedule sequence'),
  );
  if (sequenceOrder !== 0) return sequenceOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function orderScheduledActionsV1<T extends ScheduledActionV1>(actions: readonly T[]): T[] {
  return [...actions].sort(compareScheduledActionsV1);
}

export function assertFutureScheduleV1(currentTick: string, dueTick: string): void {
  if (
    parseNonNegativeInt64V1(dueTick, 'due tick') <=
    parseNonNegativeInt64V1(currentTick, 'current tick')
  ) {
    throw new SimulationDomainError(
      'SCHEDULE_IN_PAST',
      'A scheduled action must target a future tick.',
    );
  }
}

export function isScheduledActionDueV1(
  action: Pick<ScheduledActionV1, 'dueTick' | 'status'>,
  tick: string,
): boolean {
  return (
    action.status === 'scheduled' &&
    parseNonNegativeInt64V1(action.dueTick, 'due tick') <= parseNonNegativeInt64V1(tick, 'tick')
  );
}

export function assertScheduledActionTransitionV1(
  current: ScheduledActionStatus,
  target: ScheduledActionStatus,
): void {
  const targetIsTerminal = target === 'completed' || target === 'cancelled' || target === 'failed';
  if (current !== 'scheduled' || !targetIsTerminal) {
    throw new SimulationDomainError(
      'SCHEDULE_ALREADY_TERMINAL',
      'A scheduled action can enter one terminal state exactly once.',
    );
  }
}
