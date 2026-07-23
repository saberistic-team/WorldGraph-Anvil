import { readFile } from 'node:fs/promises';

import { metrics, type Meter } from '@opentelemetry/api';
import { createLogger } from '@worldgraph/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DueSimulationWorld,
  SimulationAdvanceCandidate,
  SimulationLease,
  SimulationLeaseRepository,
} from './simulation-repository.js';
import {
  SimulationCoordinator,
  SimulationRunner,
  createProductionSimulationWorkerMetrics,
  createSimulationCommandObserver,
  type FencedSimulationAdvanceRequest,
  type FencedSimulationAdvanceResult,
  type FencedSimulationAutoPauseRequest,
  type FencedSimulationAutoPauseResult,
  type SimulationAdvanceCommandPort,
  type SimulationWorkerMetrics,
  type SimulationWorkerSpan,
  type SimulationWorkerTracing,
} from './simulation-worker.js';

const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'simulation-worker-test',
});
const worldA = '078f0000-0000-7000-8000-000000000001';
const worldB = '078f0000-0000-7000-8000-000000000002';
const commandId = '078f0000-0000-7000-8000-000000000003';

function due(worldId: string, offsetMilliseconds = 0): DueSimulationWorld {
  return { nextDueAt: new Date(1_753_142_400_000 + offsetMilliseconds), worldId };
}

function candidate(worldId: string): SimulationAdvanceCandidate {
  return {
    backlogTicks: 4,
    expectedAggregateVersion: '3',
    expectedStateRevision: '8',
    expectedTick: '12',
    expectedWorldVersion: '2',
    ticks: 2,
    worldId,
  };
}

function lease(worldId: string, token = '1'): SimulationLease {
  return {
    fencingToken: token,
    leaseOwner: 'simulation-worker-a',
    leasedUntil: new Date('2026-07-22T00:00:30.000Z'),
    worldId,
  };
}

class FakeRepository implements SimulationLeaseRepository {
  public acquired = true;
  public current = true;
  public dueWorlds: DueSimulationWorld[] = [];
  public releaseResult = true;
  public renewed = true;
  public readonly calls: string[] = [];
  public readonly candidates = new Map<string, SimulationAdvanceCandidate | null>();

  public async acquireLease(worldId: string): Promise<SimulationLease | null> {
    this.calls.push(`acquire:${worldId}`);
    return this.acquired ? lease(worldId, worldId === worldA ? '1' : '2') : null;
  }

  public async discoverDueWorlds(): Promise<DueSimulationWorld[]> {
    this.calls.push('discover');
    return this.dueWorlds;
  }

  public async isLeaseCurrent(value: SimulationLease): Promise<boolean> {
    this.calls.push(`current:${value.worldId}:${value.fencingToken}`);
    return this.current;
  }

  public async loadAdvanceCandidate(
    value: SimulationLease,
  ): Promise<SimulationAdvanceCandidate | null> {
    this.calls.push(`candidate:${value.worldId}:${value.fencingToken}`);
    return this.candidates.has(value.worldId)
      ? (this.candidates.get(value.worldId) ?? null)
      : candidate(value.worldId);
  }

  public async releaseLease(value: SimulationLease): Promise<boolean> {
    this.calls.push(`release:${value.worldId}:${value.fencingToken}`);
    return this.releaseResult;
  }

  public async renewLease(value: SimulationLease): Promise<SimulationLease | null> {
    this.calls.push(`renew:${value.worldId}:${value.fencingToken}`);
    return this.renewed
      ? { ...value, leasedUntil: new Date(value.leasedUntil.getTime() + 30_000) }
      : null;
  }
}

class FakeCommands implements SimulationAdvanceCommandPort {
  public readonly autoPauseRequests: FencedSimulationAutoPauseRequest[] = [];
  public readonly autoPauseResponses: Array<FencedSimulationAutoPauseResult | Error> = [];
  public readonly requests: FencedSimulationAdvanceRequest[] = [];
  public readonly responses: Array<FencedSimulationAdvanceResult | Error> = [];

  public async advance(
    request: FencedSimulationAdvanceRequest,
  ): Promise<FencedSimulationAdvanceResult> {
    this.requests.push(request);
    const response = this.responses.shift() ?? { resultingTick: '14', status: 'advanced' };
    if (response instanceof Error) throw response;
    return response;
  }

  public async recordFailureAndAutoPause(
    request: FencedSimulationAutoPauseRequest,
  ): Promise<FencedSimulationAutoPauseResult> {
    this.autoPauseRequests.push(request);
    const response = this.autoPauseResponses.shift() ?? {
      failureId: '078f0000-0000-7000-8000-000000000004',
      status: 'auto_paused',
    };
    if (response instanceof Error) throw response;
    return response;
  }
}

class FakeMetrics implements SimulationWorkerMetrics {
  public readonly advancedTicks: number[] = [];
  public readonly backlogTicks: number[] = [];
  public readonly batchTicks: number[] = [];
  public readonly commands: Array<[string, number, string]> = [];
  public readonly discoveries: number[] = [];
  public readonly dueLag: number[] = [];
  public readonly fencingLosses: string[] = [];
  public readonly leases: Array<[string, number, string]> = [];
  public readonly processExecutions: Array<[string, string]> = [];
  public readonly processFailures: Array<[string, string, string]> = [];
  public readonly queueWakeAge: number[] = [];
  public readonly reconciliations: Array<[number, string]> = [];
  public readonly retries: string[] = [];
  public readonly runs: string[] = [];
  public readonly wakeAvailability: boolean[] = [];

  public recordAdvancedTicks(ticks: number): void {
    this.advancedTicks.push(ticks);
  }
  public recordBacklogTicks(ticks: number): void {
    this.backlogTicks.push(ticks);
  }
  public recordBatchTicks(ticks: number): void {
    this.batchTicks.push(ticks);
  }
  public recordCommand(operation: string, milliseconds: number, outcome: string): void {
    this.commands.push([operation, milliseconds, outcome]);
  }
  public recordDiscovery(worldCount: number): void {
    this.discoveries.push(worldCount);
  }
  public recordDueLag(milliseconds: number): void {
    this.dueLag.push(milliseconds);
  }
  public recordFencingLoss(stage: string): void {
    this.fencingLosses.push(stage);
  }
  public recordLease(stage: string, milliseconds: number, outcome: string): void {
    this.leases.push([stage, milliseconds, outcome]);
  }
  public recordProcessExecution(processType: string, processVersion: string): void {
    this.processExecutions.push([processType, processVersion]);
  }
  public recordProcessFailure(code: string, processType: string, processVersion: string): void {
    this.processFailures.push([code, processType, processVersion]);
  }
  public recordQueueWakeAge(milliseconds: number): void {
    this.queueWakeAge.push(milliseconds);
  }
  public recordReconciliation(milliseconds: number, outcome: string): void {
    this.reconciliations.push([milliseconds, outcome]);
  }
  public recordRetry(code: string): void {
    this.retries.push(code);
  }
  public recordRun(outcome: string): void {
    this.runs.push(outcome);
  }
  public recordWakeAvailability(available: boolean): void {
    this.wakeAvailability.push(available);
  }
}

class FakeTracing implements SimulationWorkerTracing {
  public readonly spans: Array<{
    attributes: Record<string, boolean | number | string>;
    name: string;
  }> = [];

  public recordSpan(
    name: string,
    attributes: Readonly<Record<string, boolean | number | string>>,
  ): void {
    this.spans.push({ attributes: { ...attributes }, name });
  }

  public async withSpan<T>(
    name: string,
    attributes: Readonly<Record<string, boolean | number | string>>,
    operation: (span: SimulationWorkerSpan) => Promise<T>,
  ): Promise<T> {
    const recorded = { attributes: { ...attributes }, name };
    this.spans.push(recorded);
    return operation({
      setAttribute: (key, value) => {
        recorded.attributes[key] = value;
      },
      setAttributes: (values) => {
        Object.assign(recorded.attributes, values);
      },
    });
  }
}

function runner(
  repository: FakeRepository,
  commands: FakeCommands,
  overrides: Partial<ConstructorParameters<typeof SimulationRunner>[4]> = {},
): SimulationRunner {
  return new SimulationRunner(repository, commands, 'simulation-worker-a', logger, {
    ids: { next: () => commandId },
    wait: async () => undefined,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('production simulation metrics', () => {
  it('creates the documented instruments and uses only bounded labels', () => {
    const add = vi.fn();
    const record = vi.fn();
    const counters: string[] = [];
    const gauges: string[] = [];
    const histograms: string[] = [];
    vi.spyOn(metrics, 'getMeter').mockReturnValue({
      createCounter: (name: string) => {
        counters.push(name);
        return { add };
      },
      createGauge: (name: string) => {
        gauges.push(name);
        return { record };
      },
      createHistogram: (name: string) => {
        histograms.push(name);
        return { record };
      },
    } as unknown as Meter);

    const production = createProductionSimulationWorkerMetrics();
    production.recordCommand('advance', 12, 'advanced');
    production.recordLease('acquire', 3, 'contended');
    production.recordFencingLoss('renew');
    production.recordProcessExecution('EmitWorldNoticeV1', '1.0.0');
    production.recordProcessFailure('SIMULATION_HANDLER_FAILED', 'EmitWorldNoticeV1', '1.0.0');
    production.recordWakeAvailability(true);

    expect(counters).toEqual([
      'worldgraph_simulation_ticks_total',
      'worldgraph_simulation_lease_contention_total',
      'worldgraph_simulation_fencing_loss_total',
      'worldgraph_simulation_process_executions_total',
      'worldgraph_simulation_process_failures_total',
      'worldgraph_simulation_retry_total',
      'worldgraph_simulation_run_total',
    ]);
    expect(histograms).toEqual([
      'worldgraph_simulation_due_worlds',
      'worldgraph_simulation_due_lag_ms',
      'worldgraph_simulation_batch_ticks',
      'worldgraph_simulation_backlog_ticks',
      'worldgraph_simulation_command_duration_ms',
      'worldgraph_simulation_lease_duration_ms',
      'worldgraph_simulation_queue_wake_age_ms',
      'worldgraph_simulation_reconciliation_duration_ms',
    ]);
    expect(gauges).toEqual(['worldgraph_simulation_wake_available']);
    for (const call of [...add.mock.calls, ...record.mock.calls]) {
      expect(JSON.stringify(call[1] ?? {})).not.toContain(worldA);
    }
  });

  it('keeps alert and dashboard queries on emitted or explicitly external instruments', async () => {
    const artifacts = await Promise.all([
      readFile(new URL('../../../deploy/alerts/simulation-v1.rules.yml', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../deploy/dashboards/simulation-v1.grafana.json', import.meta.url),
        'utf8',
      ),
    ]);
    const referenced = new Set(
      artifacts
        .flatMap((artifact) => artifact.match(/worldgraph_simulation_[a-z0-9_]+/gu) ?? [])
        .map((name) => name.replace(/_(?:bucket|count|sum)$/u, '')),
    );
    const emittedOrExternal = new Set([
      'worldgraph_simulation_backlog_ticks',
      'worldgraph_simulation_backlog_ticks_max',
      'worldgraph_simulation_batch_ticks',
      'worldgraph_simulation_command_duration_ms',
      'worldgraph_simulation_due_lag_ms',
      'worldgraph_simulation_due_schedule_lag_ticks_max',
      'worldgraph_simulation_due_worlds',
      'worldgraph_simulation_fencing_loss_total',
      'worldgraph_simulation_lease_contention_total',
      'worldgraph_simulation_lease_duration_ms',
      'worldgraph_simulation_outcome_mismatch_total',
      'worldgraph_simulation_process_executions_total',
      'worldgraph_simulation_process_failures_total',
      'worldgraph_simulation_queue_wake_age_ms',
      'worldgraph_simulation_reconciliation_duration_ms',
      'worldgraph_simulation_retry_total',
      'worldgraph_simulation_run_total',
      'worldgraph_simulation_running_stalled_worlds',
      'worldgraph_simulation_ticks_total',
      'worldgraph_simulation_wake_available',
    ]);

    expect([...referenced].filter((name) => !emittedOrExternal.has(name))).toEqual([]);
    const external = new Set([
      'worldgraph_simulation_backlog_ticks_max',
      'worldgraph_simulation_due_schedule_lag_ticks_max',
      'worldgraph_simulation_outcome_mismatch_total',
      'worldgraph_simulation_running_stalled_worlds',
    ]);
    const alertBlocks = artifacts[0].split(/(?= {6}- alert:)/u).slice(1);
    expect(alertBlocks.length).toBeGreaterThan(0);
    for (const block of alertBlocks) {
      const blockMetrics = new Set(
        (block.match(/worldgraph_simulation_[a-z0-9_]+/gu) ?? []).map((name) =>
          name.replace(/_(?:bucket|count|sum)$/u, ''),
        ),
      );
      const source = [...blockMetrics].some((name) => external.has(name))
        ? 'postgresql_reconciliation_exporter'
        : 'simulation_worker_otlp';
      expect(block).toContain(`metric_source: ${source}`);
    }
  });
});

describe('fenced continuous simulation runner', () => {
  it('reports idle from PostgreSQL discovery without calling the command port', async () => {
    const repository = new FakeRepository();
    const commands = new FakeCommands();
    const metrics = new FakeMetrics();

    await expect(runner(repository, commands, { metrics }).reconcile()).resolves.toEqual([
      { attempts: 0, outcome: 'idle', worldId: null },
    ]);
    expect(repository.calls).toEqual(['discover']);
    expect(commands.requests).toEqual([]);
    expect(metrics.discoveries).toEqual([0]);
  });

  it('preserves deterministic discovery order and submits typed system commands under each lease', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldB), due(worldA, 1)];
    const commands = new FakeCommands();

    await expect(runner(repository, commands).reconcile()).resolves.toEqual([
      { attempts: 1, outcome: 'advanced', worldId: worldB },
      { attempts: 1, outcome: 'advanced', worldId: worldA },
    ]);
    expect(commands.requests.map((request) => request.worldId)).toEqual([worldB, worldA]);
    expect(commands.requests[0]).toEqual({
      command: {
        commandId,
        expectedAggregateVersion: '3',
        expectedStateRevision: '8',
        expectedTick: '12',
        expectedWorldVersion: '2',
        idempotencyKey: 'simulation-auto.12.8.2',
        payload: { ticks: 2 },
        schemaVersion: 1,
        type: 'AdvanceSimulationV1',
      },
      leaseFencingToken: '2',
      leaseOwner: 'simulation-worker-a',
      worldId: worldB,
    });
    expect(repository.calls).toEqual([
      'discover',
      `acquire:${worldB}`,
      `candidate:${worldB}:2`,
      `release:${worldB}:2`,
      `acquire:${worldA}`,
      `candidate:${worldA}:1`,
      `release:${worldA}:1`,
    ]);
  });

  it('emits bounded reconciliation, lease, backlog, command and tick telemetry', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const metrics = new FakeMetrics();
    const tracing = new FakeTracing();
    let monotonic = 0;

    await expect(
      runner(repository, new FakeCommands(), {
        metrics,
        monotonicNow: () => monotonic++,
        tracing,
      }).reconcile(),
    ).resolves.toEqual([{ attempts: 1, outcome: 'advanced', worldId: worldA }]);

    expect(metrics.backlogTicks).toEqual([4]);
    expect(metrics.batchTicks).toEqual([2]);
    expect(metrics.advancedTicks).toEqual([2]);
    expect(metrics.commands).toEqual([['advance', 1, 'advanced']]);
    expect(metrics.leases.map(([stage, , outcome]) => [stage, outcome])).toEqual([
      ['acquire', 'acquired'],
      ['release', 'released'],
      ['hold', 'released'],
    ]);
    expect(metrics.reconciliations).toEqual([[9, 'succeeded']]);
    expect(tracing.spans.map(({ name }) => name)).toEqual([
      'simulation.reconcile',
      'simulation.lease.acquire',
      'simulation.lease.hold',
      'simulation.command.advance',
      'simulation.lease.release',
    ]);
    expect(tracing.spans[3]?.attributes).toMatchObject({
      'simulation.batch.tick_count': 2,
      'simulation.command.outcome': 'advanced',
      'simulation.tick.from': '12',
      'simulation.tick.to': '14',
    });
  });

  it('cannot advance when PostgreSQL reports a busy lease', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    repository.acquired = false;
    const commands = new FakeCommands();

    await expect(runner(repository, commands).reconcile()).resolves.toEqual([
      { attempts: 0, outcome: 'busy', worldId: worldA },
    ]);
    expect(commands.requests).toEqual([]);
    expect(repository.calls).toEqual(['discover', `acquire:${worldA}`]);
  });

  it('distinguishes a stale fencing epoch from a current lease with no remaining due tick', async () => {
    const staleRepository = new FakeRepository();
    staleRepository.dueWorlds = [due(worldA)];
    staleRepository.candidates.set(worldA, null);
    staleRepository.current = false;
    await expect(runner(staleRepository, new FakeCommands()).reconcile()).resolves.toEqual([
      { attempts: 0, outcome: 'fenced', worldId: worldA },
    ]);

    const currentRepository = new FakeRepository();
    currentRepository.dueWorlds = [due(worldA)];
    currentRepository.candidates.set(worldA, null);
    await expect(runner(currentRepository, new FakeCommands()).reconcile()).resolves.toEqual([
      { attempts: 0, outcome: 'not_due', worldId: worldA },
    ]);
  });

  it('retries transient uncertainty with bounded exponential backoff and the same command identity', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    commands.responses.push(
      Object.assign(new Error('temporary'), { code: 'DATABASE_UNAVAILABLE' }),
      Object.assign(new Error('temporary'), { code: 'DATABASE_UNAVAILABLE' }),
      { resultingTick: '14', status: 'advanced' },
    );
    const waits: number[] = [];
    const metrics = new FakeMetrics();

    await expect(
      runner(repository, commands, {
        maximumAttempts: 3,
        metrics,
        retryBaseMs: 100,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }).reconcile(),
    ).resolves.toEqual([{ attempts: 3, outcome: 'advanced', worldId: worldA }]);
    expect(waits).toEqual([100, 200]);
    expect(commands.requests).toHaveLength(3);
    expect(commands.requests.map((request) => request.command.commandId)).toEqual([
      commandId,
      commandId,
      commandId,
    ]);
    expect(repository.calls.filter((call) => call.startsWith('renew:'))).toHaveLength(2);
    expect(metrics.retries).toEqual(['DATABASE_UNAVAILABLE', 'DATABASE_UNAVAILABLE']);
  });

  it('stops retries when the lease cannot be renewed and never submits under a stale token', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    repository.renewed = false;
    const commands = new FakeCommands();
    commands.responses.push(Object.assign(new Error('temporary'), { code: 'QUERY_TIMEOUT' }));

    await expect(runner(repository, commands).reconcile()).resolves.toEqual([
      { attempts: 1, outcome: 'fenced', worldId: worldA },
    ]);
    expect(commands.requests).toHaveLength(1);
    expect(repository.calls).toContain(`renew:${worldA}:1`);
  });

  it('caps failures at the configured attempt budget', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    commands.responses.push(new Error('one'), new Error('two'), new Error('three'));
    const waits: number[] = [];

    await expect(
      runner(repository, commands, {
        maximumAttempts: 3,
        retryBaseMs: 100,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }).reconcile(),
    ).resolves.toEqual([{ attempts: 3, outcome: 'failed', worldId: worldA }]);
    expect(commands.requests).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
  });

  it('durably auto-pauses only after bounded deterministic process retries', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    const processFailure = () =>
      Object.assign(new Error('deterministic handler failed'), {
        code: 'SIMULATION_HANDLER_FAILED',
        failure: {
          errorCode: 'SIMULATION_HANDLER_FAILED',
          processType: 'EmitWorldNoticeV1',
          processVersion: '1.0.0',
          scheduleId: '078f0000-0000-7000-8000-000000000005',
          tick: '13',
        },
      });
    commands.responses.push(processFailure(), processFailure(), processFailure());

    const metrics = new FakeMetrics();
    const tracing = new FakeTracing();
    await expect(
      runner(repository, commands, { maximumAttempts: 3, metrics, tracing }).reconcile(),
    ).resolves.toEqual([{ attempts: 3, outcome: 'auto_paused', worldId: worldA }]);
    expect(commands.autoPauseRequests).toHaveLength(1);
    expect(commands.autoPauseRequests[0]).toMatchObject({
      attempts: 3,
      failedCommand: { commandId, expectedTick: '12' },
      failure: {
        errorCode: 'SIMULATION_HANDLER_FAILED',
        scheduleId: '078f0000-0000-7000-8000-000000000005',
        tick: '13',
      },
      leaseFencingToken: '1',
    });
    expect(metrics.processFailures).toEqual([
      ['SIMULATION_HANDLER_FAILED', 'EmitWorldNoticeV1', '1.0.0'],
    ]);
    expect(
      tracing.spans.find(({ name }) => name === 'simulation.process.failure')?.attributes,
    ).toMatchObject({
      'simulation.command.attempts': 3,
      'simulation.command.outcome': 'auto_paused',
      'simulation.error.code': 'SIMULATION_HANDLER_FAILED',
      'simulation.process.type': 'EmitWorldNoticeV1',
      'simulation.process.version': '1.0.0',
      'simulation.tick': '13',
    });
  });

  it('auto-pauses bounded world-clock exhaustion without reporting a process failure', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    const clockFailure = () =>
      Object.assign(new Error('world time exhausted'), {
        code: 'SIMULATION_INTEGER_OVERFLOW',
        failure: {
          errorCode: 'SIMULATION_INTEGER_OVERFLOW',
          processType: 'WorldClockV1',
          processVersion: '1.0.0',
          scheduleId: null,
          tick: '14',
        },
      });
    commands.responses.push(clockFailure(), clockFailure(), clockFailure());

    const metrics = new FakeMetrics();
    const tracing = new FakeTracing();
    await expect(
      runner(repository, commands, { maximumAttempts: 3, metrics, tracing }).reconcile(),
    ).resolves.toEqual([{ attempts: 3, outcome: 'auto_paused', worldId: worldA }]);
    expect(commands.requests).toHaveLength(3);
    expect(commands.autoPauseRequests).toHaveLength(1);
    expect(commands.autoPauseRequests[0]?.failure).toEqual({
      errorCode: 'SIMULATION_INTEGER_OVERFLOW',
      processType: 'WorldClockV1',
      processVersion: '1.0.0',
      scheduleId: null,
      tick: '14',
    });
    expect(metrics.retries).toEqual(['SIMULATION_INTEGER_OVERFLOW', 'SIMULATION_INTEGER_OVERFLOW']);
    expect(metrics.processFailures).toEqual([]);
    expect(tracing.spans.some(({ name }) => name === 'simulation.process.failure')).toBe(false);
    expect(
      tracing.spans.find(({ name }) => name === 'simulation.clock.failure')?.attributes,
    ).toMatchObject({
      'simulation.command.attempts': 3,
      'simulation.command.outcome': 'auto_paused',
      'simulation.error.code': 'SIMULATION_INTEGER_OVERFLOW',
      'simulation.failure.source.type': 'WorldClockV1',
      'simulation.failure.source.version': '1.0.0',
      'simulation.tick': '14',
    });
  });

  it('records payload-free retrospective spans only for committed process summaries', async () => {
    const metrics = new FakeMetrics();
    const tracing = new FakeTracing();
    const observer = createSimulationCommandObserver(metrics, tracing);

    await observer.onAdvanceCommitted({
      executions: [
        {
          eventCount: 1,
          processType: 'EmitWorldNoticeV1',
          processVersion: '1.0.0',
          proposedScheduleCount: 0,
          tick: '13',
        },
      ],
      fromTick: '12',
      tickCount: 2,
      toTick: '14',
    });

    expect(metrics.processExecutions).toEqual([['EmitWorldNoticeV1', '1.0.0']]);
    expect(tracing.spans).toEqual([
      {
        attributes: {
          'simulation.process.event_count': 1,
          'simulation.process.proposed_schedule_count': 0,
          'simulation.process.type': 'EmitWorldNoticeV1',
          'simulation.process.version': '1.0.0',
          'simulation.tick': '13',
        },
        name: 'simulation.process.execute',
      },
    ]);
  });

  it('never fabricates a simulation failure for infrastructure exhaustion', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    commands.responses.push(
      Object.assign(new Error('database down'), { code: 'DATABASE_UNAVAILABLE' }),
    );

    await expect(runner(repository, commands, { maximumAttempts: 1 }).reconcile()).resolves.toEqual(
      [{ attempts: 1, outcome: 'failed', worldId: worldA }],
    );
    expect(commands.autoPauseRequests).toEqual([]);
  });

  it('fails closed when the command adapter reports an impossible resulting tick', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    commands.responses.push({ resultingTick: '15', status: 'advanced' });

    await expect(runner(repository, commands, { maximumAttempts: 1 }).reconcile()).resolves.toEqual(
      [{ attempts: 1, outcome: 'failed', worldId: worldA }],
    );
  });

  it('honors the command transaction fencing result without retrying', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    commands.responses.push({ status: 'fenced' });

    await expect(runner(repository, commands).reconcile()).resolves.toEqual([
      { attempts: 1, outcome: 'fenced', worldId: worldA },
    ]);
    expect(commands.requests).toHaveLength(1);
  });

  it.each([
    ['clock_not_running', 'not_running'],
    ['conflict', 'conflict'],
    ['not_due', 'not_due'],
  ] as const)('maps authoritative %s without retrying', async (status, outcome) => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    const commands = new FakeCommands();
    commands.responses.push({ status });

    await expect(runner(repository, commands).reconcile()).resolves.toEqual([
      { attempts: 1, outcome, worldId: worldA },
    ]);
    expect(commands.requests).toHaveLength(1);
  });

  it('does not turn a committed advance into failure when best-effort release loses the epoch', async () => {
    const repository = new FakeRepository();
    repository.dueWorlds = [due(worldA)];
    repository.releaseResult = false;

    await expect(runner(repository, new FakeCommands()).reconcile()).resolves.toEqual([
      { attempts: 1, outcome: 'advanced', worldId: worldA },
    ]);
  });
});

describe('simulation reconciliation coordinator', () => {
  it('coalesces overlapping wake hints and paces sequential PostgreSQL reconciliation', async () => {
    let release!: () => void;
    const reconcile = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    let now = 0;
    const coordinator = new SimulationCoordinator({ reconcile }, logger, {
      monotonicNow: () => now,
      reconciliationIntervalMs: 100,
    });

    const first = coordinator.wake();
    expect(coordinator.wake()).toBe(first);
    release();
    await first;
    expect(await coordinator.wake()).toEqual([]);
    now = 100;
    const second = coordinator.wake();
    release();
    await second;
    expect(reconcile).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it('stops automatic reconciliation during Redis loss and resumes from PostgreSQL on recovery', async () => {
    vi.useFakeTimers();
    let now = 0;
    let redisReady = true;
    const reconcile = vi.fn().mockResolvedValue([]);
    const metrics = new FakeMetrics();
    const tracing = new FakeTracing();
    const coordinator = new SimulationCoordinator({ reconcile }, logger, {
      isAutomationAvailable: () => redisReady,
      metrics,
      monotonicNow: () => now,
      reconciliationIntervalMs: 100,
      tracing,
    });

    coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    now = 100;
    redisReady = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(1);
    now = 200;
    redisReady = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(metrics.wakeAvailability).toEqual([true, false, true]);
    expect(
      tracing.spans.map(({ attributes, name }) => [name, attributes['simulation.wake.outcome']]),
    ).toEqual([
      ['simulation.wake', 'reconcile'],
      ['simulation.wake', 'degraded'],
      ['simulation.wake', 'reconcile'],
    ]);
    await coordinator.stop();
  });
});
