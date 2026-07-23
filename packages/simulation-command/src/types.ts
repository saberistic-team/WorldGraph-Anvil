import type {
  AdvanceSimulationCommandV1,
  IdGenerator,
  ScheduledActionType,
} from '@worldgraph/contracts';

export const SIMULATION_WORKER_ACTOR_ID = 'worldgraph:simulation-worker' as const;
export const SIMULATION_WORKER_AUTHORIZATION_RULE_ID = 'system.simulation.worker.advance' as const;

export interface FencedSimulationAdvanceRequest {
  command: AdvanceSimulationCommandV1;
  leaseFencingToken: string;
  leaseOwner: string;
  worldId: string;
}

export type FencedSimulationAdvanceResult =
  | { resultingTick: string; status: 'advanced' }
  | { status: 'clock_not_running' | 'conflict' | 'fenced' | 'not_due' };

interface SimulationFailureContextBaseV1 {
  errorCode: string;
  tick: string;
}

export type SimulationFailureContextV1 = SimulationFailureContextBaseV1 &
  (
    | {
        processType: ScheduledActionType;
        processVersion: '1.0.0';
        scheduleId: string | null;
      }
    | {
        processType: 'WorldClockV1';
        processVersion: '1.0.0';
        scheduleId: null;
      }
  );

/**
 * Bounded, payload-free facts returned to an observability observer only after
 * an authoritative advance commits. They are deliberately not part of the
 * command response or durable outcome bytes.
 */
export interface SimulationProcessExecutionTelemetryV1 {
  eventCount: number;
  processType: ScheduledActionType;
  processVersion: '1.0.0';
  proposedScheduleCount: number;
  tick: string;
}

export interface SimulationAdvanceTelemetryV1 {
  executions: readonly SimulationProcessExecutionTelemetryV1[];
  fromTick: string;
  tickCount: number;
  toTick: string;
}

export interface SimulationCommandObserver {
  onAdvanceCommitted(summary: SimulationAdvanceTelemetryV1): Promise<void> | void;
}

export interface FencedSimulationAutoPauseRequest {
  attempts: number;
  failedCommand: AdvanceSimulationCommandV1;
  failure: SimulationFailureContextV1;
  leaseFencingToken: string;
  leaseOwner: string;
  worldId: string;
}

export type FencedSimulationAutoPauseResult =
  | { failureId: string; status: 'auto_paused' }
  | { status: 'clock_not_running' | 'conflict' | 'fenced' };

/**
 * PostgreSQL is the authority behind this port. Implementations must verify
 * the exact owner/fencing epoch in the same transaction as the command write.
 */
export interface SimulationAdvanceCommandPort {
  advance(request: FencedSimulationAdvanceRequest): Promise<FencedSimulationAdvanceResult>;
  recordFailureAndAutoPause(
    request: FencedSimulationAutoPauseRequest,
  ): Promise<FencedSimulationAutoPauseResult>;
}

export interface PostgresSimulationAdvanceCommandOptions {
  ids: IdGenerator;
  maximumSerializationAttempts?: number;
  observer?: SimulationCommandObserver;
  retryDelay?: (attempt: number) => Promise<void>;
}
