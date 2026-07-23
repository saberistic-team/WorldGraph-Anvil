import {
  MAX_SIMULATION_EVENTS_PER_ADVANCE,
  MAX_SIMULATION_EVENTS_PER_PROCESS,
  MAX_SIMULATION_SCHEDULES_PER_ADVANCE,
  MAX_SIMULATION_SCHEDULES_PER_PROCESS,
  SimulationProcessResultV1Schema,
  createValidator,
  type SimulationProcessResultV1,
} from '@worldgraph/contracts';

import { SimulationDomainError } from './errors.js';

const resultValidator = createValidator<SimulationProcessResultV1>(SimulationProcessResultV1Schema);

export interface SimulationAdvanceBudgetUsageV1 {
  readonly eventCount: number;
  readonly scheduleCount: number;
}

export function initialSimulationAdvanceBudgetUsageV1(): SimulationAdvanceBudgetUsageV1 {
  // Reserve one ordinal for SimulationAdvancedV1 before any due action runs.
  return { eventCount: 1, scheduleCount: 0 };
}

function budgetError(message: string): never {
  throw new SimulationDomainError('SIMULATION_BUDGET_EXCEEDED', message);
}

export function validateProcessResultV1(result: unknown): SimulationProcessResultV1 {
  if (result !== null && typeof result === 'object') {
    const candidate = result as { events?: unknown; schedules?: unknown };
    if (
      Array.isArray(candidate.events) &&
      candidate.events.length > MAX_SIMULATION_EVENTS_PER_PROCESS
    ) {
      budgetError('Process event budget exceeded.');
    }
    if (
      Array.isArray(candidate.schedules) &&
      candidate.schedules.length > MAX_SIMULATION_SCHEDULES_PER_PROCESS
    ) {
      budgetError('Process schedule budget exceeded.');
    }
  }
  if (!resultValidator.is(result)) {
    throw new SimulationDomainError(
      'SIMULATION_HANDLER_FAILED',
      'Process returned an invalid typed result.',
    );
  }
  return result;
}

export function addAdvanceBudgetUsageV1(
  current: SimulationAdvanceBudgetUsageV1,
  result: SimulationProcessResultV1,
): SimulationAdvanceBudgetUsageV1 {
  // Every due action also materializes ScheduledActionExecutedV1, and every
  // returned schedule materializes ScheduledActionCreatedV1.
  const eventCount = current.eventCount + 1 + result.events.length + result.schedules.length;
  const scheduleCount = current.scheduleCount + result.schedules.length;
  if (eventCount > MAX_SIMULATION_EVENTS_PER_ADVANCE) {
    budgetError('Advance event budget exceeded.');
  }
  if (scheduleCount > MAX_SIMULATION_SCHEDULES_PER_ADVANCE) {
    budgetError('Advance schedule budget exceeded.');
  }
  return { eventCount, scheduleCount };
}
