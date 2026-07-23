'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  ScheduledActionV1,
  SimulationBatchRunV1,
  SimulationFailureV1,
  SimulationWorldTimeV1,
  WorldCommandResultV1,
  WorldSimulationClockV1,
} from '@worldgraph/contracts';

import { BrowserApiError, formString, mutateJson, requestJson } from '../../../lib/browser-api';

interface ClockView {
  aggregateVersion: string;
  backlogCount: number;
  canManage: boolean;
  canSchedule: boolean;
  clock: WorldSimulationClockV1;
  degradedWake: boolean;
  designVersion: string;
  lastBatch: SimulationBatchRunV1 | null;
  nextDueAction: ScheduledActionV1 | null;
  stateRevision: string;
  worldTime: SimulationWorldTimeV1;
}

interface SchedulePage {
  items: ScheduledActionV1[];
  nextCursor: string | null;
}

interface BatchPage {
  failures: SimulationFailureV1[];
  items: SimulationBatchRunV1[];
  nextCursor: string | null;
}

interface WorldSimulationProps {
  worldId: string;
}

type SimulationCommandType =
  | 'ConfigureWorldClockV1'
  | 'StartWorldClockV1'
  | 'PauseWorldClockV1'
  | 'AdvanceSimulationV1'
  | 'ScheduleWorldNoticeV1'
  | 'CancelScheduledActionV1'
  | 'ResolveSimulationFailureV1';

function displayWorldTime(unixMilliseconds: string): string {
  const value = BigInt(unixMilliseconds);
  return value >= -8_640_000_000_000_000n && value <= 8_640_000_000_000_000n
    ? new Date(Number(value)).toISOString()
    : `${unixMilliseconds} ms since the Unix epoch`;
}

export function WorldSimulation({ worldId }: WorldSimulationProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ClockView | null>(null);
  const [schedule, setSchedule] = useState<SchedulePage>({ items: [], nextCursor: null });
  const [batches, setBatches] = useState<BatchPage>({
    failures: [],
    items: [],
    nextCursor: null,
  });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<SimulationCommandType | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [scheduleStatus, setScheduleStatus] = useState('all');

  const load = useCallback(
    async (quiet = false) => {
      try {
        const [clock, schedulePage, batchPage] = await Promise.all([
          requestJson<ClockView>(`/api/v1/worlds/${worldId}/simulation/clock`),
          requestJson<SchedulePage>(`/api/v1/worlds/${worldId}/simulation/schedule?limit=100`),
          requestJson<BatchPage>(`/api/v1/worlds/${worldId}/simulation/batches?limit=20`),
        ]);
        setView(clock);
        setSchedule(schedulePage);
        setBatches(batchPage);
        setPollingStopped(false);
        if (!quiet) setError('');
      } catch (cause) {
        if (cause instanceof BrowserApiError && cause.status === 401) {
          router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/simulate`)}`);
          return;
        }
        if (quiet) {
          setPollingStopped(true);
        } else {
          report(cause);
        }
      }
    },
    [router, worldId],
  );

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (view?.clock.mode !== 'running' || pollingStopped) return;
    const interval = window.setInterval(
      () => void load(true),
      Math.max(1_000, Math.min(5_000, view.clock.configuration.wallCadenceMilliseconds)),
    );
    return () => window.clearInterval(interval);
  }, [load, pollingStopped, view?.clock.configuration.wallCadenceMilliseconds, view?.clock.mode]);

  async function loadSchedulePage(nextStatus: string, cursor?: string) {
    const parameters = new URLSearchParams({ limit: '100' });
    if (nextStatus !== 'all') parameters.set('status', nextStatus);
    if (cursor) parameters.set('cursor', cursor);
    try {
      const page = await requestJson<SchedulePage>(
        `/api/v1/worlds/${worldId}/simulation/schedule?${parameters.toString()}`,
      );
      setSchedule((current) => ({
        items: cursor ? [...current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor,
      }));
      setScheduleStatus(nextStatus);
    } catch (cause) {
      report(cause);
    }
  }

  async function loadMoreBatches() {
    if (!batches.nextCursor) return;
    try {
      const page = await requestJson<BatchPage>(
        `/api/v1/worlds/${worldId}/simulation/batches?limit=20&cursor=${encodeURIComponent(batches.nextCursor)}`,
      );
      setBatches((current) => ({
        failures: page.failures,
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      report(cause);
    }
  }

  function report(cause: unknown) {
    setError(
      cause instanceof BrowserApiError
        ? `${cause.failure.code}: ${cause.failure.message}`
        : 'SIMULATION_UNAVAILABLE: The authoritative simulation request could not be completed.',
    );
  }

  async function resolveAccepted(
    commandId: string,
    request: Promise<WorldCommandResultV1>,
  ): Promise<WorldCommandResultV1> {
    try {
      return await request;
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status < 500) throw cause;
      return requestJson<WorldCommandResultV1>(`/api/v1/commands/${commandId}`);
    }
  }

  async function submit(
    type: SimulationCommandType,
    payload: Record<string, unknown>,
    expectedAggregateVersion = view?.aggregateVersion ?? '0',
  ) {
    if (!view || pending) return;
    const commandId = crypto.randomUUID();
    const idempotencyKey = `simulation-${type}-${commandId}`;
    setPending(type);
    setError('');
    try {
      const result = await resolveAccepted(
        commandId,
        mutateJson<WorldCommandResultV1>(
          `/api/v1/worlds/${worldId}/commands`,
          'POST',
          {
            commandId,
            expectedAggregateVersion,
            expectedStateRevision: view.stateRevision,
            expectedTick: view.clock.currentTick,
            expectedWorldVersion: view.designVersion,
            idempotencyKey,
            payload,
            schemaVersion: 1,
            type,
          },
          idempotencyKey,
        ),
      );
      if (result.status !== 'accepted') {
        throw new Error(`The command ended in ${result.status} state.`);
      }
      setStatus(
        `${type.replace(/V1$/u, '')} accepted at state revision ${result.resultingStateRevision}.`,
      );
      await load();
    } catch (cause) {
      report(cause);
    } finally {
      setPending(null);
    }
  }

  function advance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ticks = Number.parseInt(formString(new FormData(event.currentTarget), 'ticks'), 10);
    if (!Number.isInteger(ticks) || ticks < 1) return;
    if (ticks > 1 && !window.confirm(`Advance exactly ${ticks} authoritative ticks?`)) return;
    void submit('AdvanceSimulationV1', { ticks });
  }

  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view) return;
    const data = new FormData(event.currentTarget);
    void submit('ConfigureWorldClockV1', {
      epoch: formString(data, 'epoch'),
      maxBatch: Number.parseInt(formString(data, 'maxBatch'), 10),
      maxCatchUp: Number.parseInt(formString(data, 'maxCatchUp'), 10),
      wallCadenceMs: Number.parseInt(formString(data, 'wallCadenceMs'), 10),
      worldMillisecondsPerTick: Number.parseInt(formString(data, 'worldMillisecondsPerTick'), 10),
    });
  }

  function createNotice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void submit(
      'ScheduleWorldNoticeV1',
      {
        dueTick: formString(data, 'dueTick'),
        priority: Number.parseInt(formString(data, 'priority'), 10),
        text: formString(data, 'text'),
        visibility: formString(data, 'visibility'),
      },
      '0',
    );
  }

  if (!view) {
    return (
      <main className="app-page shell wide-shell runtime-page simulation-page" id="main-content">
        {error ? (
          <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
            <p>{error}</p>
            <button className="secondary-button" onClick={() => void load()} type="button">
              Retry authoritative read
            </button>
          </div>
        ) : (
          <div aria-busy="true" className="card">
            <p>Loading the authoritative world clock…</p>
            <div className="skeleton" />
            <div className="skeleton short" />
          </div>
        )}
      </main>
    );
  }

  const configuration = view.clock.configuration;
  const errored = view.clock.mode === 'error';
  const running = view.clock.mode === 'running';
  const openFailures = batches.failures.filter((failure) => failure.status === 'open');
  const scheduleItems = schedule.items;
  return (
    <main className="app-page shell wide-shell runtime-page simulation-page" id="main-content">
      <header className="app-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← World workspace
        </Link>
        <nav aria-label="Runtime lenses" className="runtime-nav">
          <Link href={`/worlds/${worldId}/overview`}>Overview</Link>
          <Link href={`/worlds/${worldId}/graph`}>Graph</Link>
          <Link aria-current="page" href={`/worlds/${worldId}/simulate`}>
            Simulate
          </Link>
          <Link href={`/worlds/${worldId}/history`}>History</Link>
          <Link href={`/worlds/${worldId}/economy`}>Economy</Link>
          <Link href={`/worlds/${worldId}/assets`}>Assets</Link>
        </nav>
      </header>

      <section className="page-heading simulation-heading">
        <div>
          <p className="eyebrow">Deterministic simulation</p>
          <h1>World clock and schedule</h1>
          <p className="lede compact">
            PostgreSQL records every accepted tick and scheduled action. Wall time and Redis only
            wake work; they never decide the outcome.
          </p>
        </div>
        <span className={`manifest-state ${running ? 'approved' : 'draft'}`}>
          {view.clock.mode} · tick {view.clock.currentTick}
        </span>
      </section>

      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </div>
      ) : null}
      <p aria-live="polite" className="success-message">
        {pending ? `${pending.replace(/V1$/u, '')} pending…` : status}
      </p>
      {view.degradedWake ? (
        <div className="warning-panel" role="status">
          Automatic wake delivery is degraded. Manual controls remain authoritative and no ticks are
          inferred while delivery is unavailable.
        </div>
      ) : null}
      {pollingStopped ? (
        <div className="warning-panel" role="status">
          <p>
            Continuous polling stopped after a read failure. The values below may be stale; no
            client-side tick was inferred.
          </p>
          <button
            className="secondary-button"
            onClick={() => {
              setPollingStopped(false);
              void load();
            }}
            type="button"
          >
            Resume authoritative polling
          </button>
        </div>
      ) : null}
      {view.backlogCount > configuration.maxCatchUpTicks ? (
        <div className="warning-panel" role="status">
          Catch-up backlog is {view.backlogCount} ticks, above the automatic window of{' '}
          {configuration.maxCatchUpTicks}. Automatic advancement is halted. Pause, review the gap,
          and use explicit bounded advances before restarting the clock.
        </div>
      ) : null}
      {view.clock.mode === 'error' ? (
        <div className="error-summary" role="alert">
          <p>
            The clock auto-paused after a deterministic process failure. Review the failure and
            History before choosing an audited recovery.
          </p>
          {openFailures.length === 0 ? (
            <p>
              No open failure record is currently available. Do not resume until an operator has
              reconciled it.
            </p>
          ) : (
            <ul>
              {openFailures.map((failure) => (
                <li key={failure.id}>
                  <strong>{failure.errorCode}</strong> at tick {failure.tick} after{' '}
                  {failure.attempts} attempts ({failure.processType} {failure.processVersion}).{' '}
                  <Link
                    href={`/worlds/${worldId}/history?targetType=simulation_failure&targetId=${failure.id}`}
                  >
                    History
                  </Link>
                  {view.canManage ? (
                    <span className="simulation-button-row">
                      {failure.scheduleId ? (
                        <button
                          className="secondary-button"
                          disabled={pending !== null}
                          onClick={() => {
                            if (
                              window.confirm('Cancel the failed action and resolve this failure?')
                            ) {
                              void submit(
                                'ResolveSimulationFailureV1',
                                { failureId: failure.id, resolution: 'cancel_action' },
                                failure.aggregateVersion,
                              );
                            }
                          }}
                          type="button"
                        >
                          Cancel failed action
                        </button>
                      ) : null}
                      <button
                        className="secondary-button"
                        disabled={pending !== null}
                        onClick={() =>
                          void submit(
                            'ResolveSimulationFailureV1',
                            { failureId: failure.id, resolution: 'retry_after_repair' },
                            failure.aggregateVersion,
                          )
                        }
                        type="button"
                      >
                        Mark repaired
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <section aria-label="Clock status" className="simulation-summary-grid">
        <article className="card simulation-clock-card">
          <p className="eyebrow">Derived world time</p>
          <strong>{displayWorldTime(view.worldTime.worldTimeUnixMilliseconds)}</strong>
          <dl className="facts compact-facts">
            <div>
              <dt>Current tick</dt>
              <dd>{view.clock.currentTick}</dd>
            </div>
            <div>
              <dt>State revision</dt>
              <dd>{view.stateRevision}</dd>
            </div>
            <div>
              <dt>Clock version</dt>
              <dd>{view.aggregateVersion}</dd>
            </div>
            <div>
              <dt>Backlog</dt>
              <dd>{view.backlogCount}</dd>
            </div>
          </dl>
        </article>
        <article className="card">
          <h2>Configuration</h2>
          <dl className="facts compact-facts">
            <div>
              <dt>Epoch</dt>
              <dd>{configuration.epochAt}</dd>
            </div>
            <div>
              <dt>World ms / tick</dt>
              <dd>{configuration.worldMillisecondsPerTick}</dd>
            </div>
            <div>
              <dt>Wall wake cadence</dt>
              <dd>{configuration.wallCadenceMilliseconds} ms</dd>
            </div>
            <div>
              <dt>Batch / catch-up limits</dt>
              <dd>
                {configuration.maxBatchTicks} / {configuration.maxCatchUpTicks}
              </dd>
            </div>
            <div>
              <dt>PRNG</dt>
              <dd>{configuration.prngAlgorithmVersion}</dd>
            </div>
          </dl>
        </article>
        <article className="card">
          <h2>Next due action</h2>
          {view.nextDueAction ? (
            <dl className="facts compact-facts">
              <div>
                <dt>Tick</dt>
                <dd>{view.nextDueAction.dueTick}</dd>
              </div>
              <div>
                <dt>Priority / sequence</dt>
                <dd>
                  {view.nextDueAction.priority} / {view.nextDueAction.scheduleSequence}
                </dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{view.nextDueAction.actionType}</dd>
              </div>
            </dl>
          ) : (
            <p>No action is scheduled after the current tick.</p>
          )}
        </article>
      </section>

      {view.canManage ? (
        <section aria-labelledby="clock-controls-heading" className="card simulation-controls">
          <div>
            <p className="eyebrow">Creator authority</p>
            <h2 id="clock-controls-heading">Clock controls</h2>
            <p>Each control submits one versioned command against the exact tick and revision.</p>
          </div>
          <div className="simulation-button-row">
            <button
              className="button"
              disabled={pending !== null || running || errored}
              onClick={() => void submit('StartWorldClockV1', {})}
              type="button"
            >
              Start continuous mode
            </button>
            <button
              className="secondary-button"
              disabled={pending !== null || !running}
              onClick={() => void submit('PauseWorldClockV1', {})}
              type="button"
            >
              Pause now
            </button>
            <button
              className="secondary-button"
              disabled={pending !== null || running || errored}
              onClick={() => void submit('AdvanceSimulationV1', { ticks: 1 })}
              type="button"
            >
              Single-step
            </button>
          </div>
          <form className="simulation-inline-form" onSubmit={advance}>
            <label>
              Bounded ticks
              <input
                defaultValue="3"
                max={configuration.maxBatchTicks}
                min="1"
                name="ticks"
                required
                type="number"
              />
            </label>
            <button
              className="button"
              disabled={pending !== null || running || errored}
              type="submit"
            >
              Advance exact range
            </button>
          </form>
          {view.clock.currentTick === '0' && !running && !errored ? (
            <details>
              <summary>Configure tick-zero clock</summary>
              <form className="form-stack simulation-config-form" onSubmit={configure}>
                <label>
                  Epoch (UTC)
                  <input defaultValue={configuration.epochAt} name="epoch" required />
                </label>
                <label>
                  World milliseconds per tick
                  <input
                    defaultValue={configuration.worldMillisecondsPerTick}
                    min="1"
                    name="worldMillisecondsPerTick"
                    required
                    type="number"
                  />
                </label>
                <label>
                  Wall wake cadence (ms)
                  <input
                    defaultValue={configuration.wallCadenceMilliseconds}
                    min="100"
                    name="wallCadenceMs"
                    required
                    type="number"
                  />
                </label>
                <label>
                  Maximum batch ticks
                  <input
                    defaultValue={configuration.maxBatchTicks}
                    max="256"
                    min="1"
                    name="maxBatch"
                    required
                    type="number"
                  />
                </label>
                <label>
                  Maximum catch-up ticks
                  <input
                    defaultValue={configuration.maxCatchUpTicks}
                    max="4096"
                    min="1"
                    name="maxCatchUp"
                    required
                    type="number"
                  />
                </label>
                <button className="button" disabled={pending !== null} type="submit">
                  Save tick-zero configuration
                </button>
              </form>
            </details>
          ) : null}
        </section>
      ) : (
        <section className="card">
          <h2>Read-only simulation</h2>
          <p>
            Your active membership can inspect exact clock and schedule state. Creator controls are
            not available for this role.
          </p>
        </section>
      )}

      {view.canSchedule ? (
        <section aria-labelledby="notice-heading" className="card">
          <h2 id="notice-heading">Schedule a world notice</h2>
          <p>The due tick must be strictly after tick {view.clock.currentTick}.</p>
          <form className="simulation-notice-form" onSubmit={createNotice}>
            <label>
              Due tick
              <input
                defaultValue={(BigInt(view.clock.currentTick) + 1n).toString()}
                min={(BigInt(view.clock.currentTick) + 1n).toString()}
                name="dueTick"
                required
                type="number"
              />
            </label>
            <label>
              Priority (lower runs first)
              <input defaultValue="0" max="1000" min="-1000" name="priority" type="number" />
            </label>
            <label>
              Visibility
              <select defaultValue="member" name="visibility">
                <option value="public">Public</option>
                <option value="member">Members</option>
                <option value="creator">Creator only</option>
              </select>
            </label>
            <label className="simulation-notice-text">
              Notice text
              <textarea maxLength={500} name="text" required rows={3} />
            </label>
            <button className="button" disabled={pending !== null} type="submit">
              Schedule notice
            </button>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="schedule-heading" className="card simulation-table-card">
        <div className="simulation-section-heading">
          <div>
            <p className="eyebrow">Deterministic order</p>
            <h2 id="schedule-heading">Schedule</h2>
          </div>
          <span>{scheduleItems.length} loaded</span>
        </div>
        <div className="simulation-filter-row">
          <label>
            Schedule status
            <select
              onChange={(event) => void loadSchedulePage(event.currentTarget.value)}
              value={scheduleStatus}
            >
              <option value="all">All statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="failed">Failed</option>
            </select>
          </label>
        </div>
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Due tick</th>
                <th scope="col">Priority</th>
                <th scope="col">Sequence</th>
                <th scope="col">Action and links</th>
              </tr>
            </thead>
            <tbody>
              {scheduleItems.length === 0 ? (
                <tr>
                  <td colSpan={5}>No scheduled actions exist yet.</td>
                </tr>
              ) : (
                scheduleItems.map((action) => (
                  <tr key={action.id}>
                    <td>{action.status}</td>
                    <td>{action.dueTick}</td>
                    <td>{action.priority}</td>
                    <td>{action.scheduleSequence}</td>
                    <td>
                      <span>{action.actionType}</span>
                      <Link
                        className="text-link"
                        href={`/worlds/${worldId}/simulate/schedule/${action.id}`}
                      >
                        Details
                      </Link>
                      <Link
                        className="text-link"
                        href={`/worlds/${worldId}/history?targetType=scheduled_action&targetId=${action.id}`}
                      >
                        History
                      </Link>
                      {view.canSchedule && action.status === 'scheduled' ? (
                        <button
                          className="text-button"
                          disabled={pending !== null}
                          onClick={() => {
                            if (
                              window.confirm(`Cancel scheduled action ${action.scheduleSequence}?`)
                            ) {
                              void submit(
                                'CancelScheduledActionV1',
                                { scheduleId: action.id },
                                '1',
                              );
                            }
                          }}
                          type="button"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {schedule.nextCursor ? (
          <button
            className="secondary-button"
            onClick={() => void loadSchedulePage(scheduleStatus, schedule.nextCursor ?? undefined)}
            type="button"
          >
            Load more scheduled actions
          </button>
        ) : null}
      </section>

      <section aria-labelledby="batch-heading" className="card simulation-table-card">
        <div className="simulation-section-heading">
          <div>
            <p className="eyebrow">Operational reproducibility</p>
            <h2 id="batch-heading">Recent batches</h2>
          </div>
          <span>{batches.items.length} loaded</span>
        </div>
        {batches.items.length === 0 ? (
          <p>No simulation batch has run.</p>
        ) : (
          <ul className="simulation-batch-list">
            {batches.items.map((batch) => (
              <li key={batch.id}>
                <strong>
                  ticks {batch.fromTick}–{batch.toTick}
                </strong>
                <span>{batch.status}</span>
                <code>{batch.outcomeHash ?? batch.errorCode ?? 'pending'}</code>
              </li>
            ))}
          </ul>
        )}
        {batches.failures.length > 0 ? (
          <details>
            <summary>{batches.failures.length} recent safe failure records</summary>
            <ul className="simulation-batch-list">
              {batches.failures.map((failure) => (
                <li key={failure.id}>
                  <strong>
                    tick {failure.tick} · {failure.errorCode}
                  </strong>
                  <span>{failure.status}</span>
                  <span>
                    {failure.processType} {failure.processVersion} · {failure.attempts} attempts
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {view.lastBatch?.outcomeHash ? (
          <p className="compact-note">Latest semantic outcome: {view.lastBatch.outcomeHash}</p>
        ) : null}
        {batches.nextCursor ? (
          <button className="secondary-button" onClick={() => void loadMoreBatches()} type="button">
            Load more batches
          </button>
        ) : null}
      </section>
    </main>
  );
}
