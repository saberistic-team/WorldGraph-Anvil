'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type { World, WorldHistoryEntryV1 } from '@worldgraph/contracts';

import { BrowserApiError, requestJson } from '../../../lib/browser-api';

interface HistoryPage {
  items: WorldHistoryEntryV1[];
  nextCursor: string | null;
}

interface HistoryDetail {
  command: {
    authorizationRuleId: string | null;
    commandId: string;
    commandType: string;
    expectedAggregateVersion: string | null;
    expectedStateRevision: string;
    expectedWorldVersion: string;
    overrideId: string | null;
    status: string;
  } | null;
  entry: WorldHistoryEntryV1;
  event: { eventId: string; eventType: string } | null;
  projection: { resultingStateRevision: string | null };
}

interface HistoryFilters {
  actor: string;
  entity: string;
  event: string;
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function labelFromKey(value: string): string {
  return value
    .replace(/^history\./u, '')
    .replace(/V[0-9]+$/u, '')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/[._-]+/gu, ' ')
    .replace(/^./u, (character) => character.toUpperCase());
}

function badge(entry: WorldHistoryEntryV1): string {
  if (entry.summaryArgs.overrideUsed === true) return 'Creator override';
  if (entry.actor.actorType === 'system') return 'System';
  if (entry.actor.actorType === 'ai') return 'AI actor';
  if (entry.category === 'repair') return 'Repair';
  return entry.actor.actorType === 'platform_admin' ? 'Platform administrator' : 'Member';
}

function historyQuery(filters: HistoryFilters, cursor: string | null): string {
  const query = new URLSearchParams({ limit: '25' });
  if (filters.actor) query.set('actorId', filters.actor);
  if (filters.entity) query.set('targetId', filters.entity);
  if (filters.event) query.set('eventType', filters.event);
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}

export function WorldHistory({ worldId }: { worldId: string }) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [filters, setFilters] = useState<HistoryFilters>({ actor: '', entity: '', event: '' });
  const [appliedFilters, setAppliedFilters] = useState<HistoryFilters>({
    actor: '',
    entity: '',
    event: '',
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');

  const handleUnauthorized = useCallback(
    (cause: unknown): boolean => {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/history`)}`);
        return true;
      }
      return false;
    },
    [router, worldId],
  );

  const load = useCallback(
    async (nextCursor: string | null, nextFilters: HistoryFilters) => {
      setLoading(true);
      setError('');
      try {
        const [worldResponse, history] = await Promise.all([
          requestJson<{ world: World }>(`/api/v1/worlds/${worldId}`),
          requestJson<HistoryPage>(
            `/api/v1/worlds/${worldId}/history?${historyQuery(nextFilters, nextCursor)}`,
          ),
        ]);
        setWorld(worldResponse.world);
        setPage(history);
      } catch (cause) {
        if (handleUnauthorized(cause)) return;
        setPage(null);
        setError(
          cause instanceof BrowserApiError
            ? `${cause.failure.code}: ${cause.failure.message}`
            : 'HISTORY_UNAVAILABLE: World history could not be loaded.',
        );
        requestAnimationFrame(() => errorRef.current?.focus());
      } finally {
        setLoading(false);
      }
    },
    [handleUnauthorized, worldId],
  );

  useEffect(() => void load(null, { actor: '', entity: '', event: '' }), [load]);

  async function openDetail(sequence: string): Promise<void> {
    setDetailLoading(true);
    setDetailError('');
    try {
      const response = await requestJson<HistoryDetail>(
        `/api/v1/worlds/${worldId}/history/${sequence}`,
      );
      setDetail(response);
      requestAnimationFrame(() => detailRef.current?.focus());
    } catch (cause) {
      if (handleUnauthorized(cause)) return;
      setDetail(null);
      setDetailError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'HISTORY_DETAIL_UNAVAILABLE: This entry could not be loaded.',
      );
    } finally {
      setDetailLoading(false);
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = {
      actor: filters.actor.trim(),
      entity: filters.entity.trim(),
      event: filters.event.trim(),
    };
    setAppliedFilters(normalized);
    setCursor(null);
    setCursorHistory([]);
    setDetail(null);
    void load(null, normalized);
  }

  function nextPage(): void {
    if (!page?.nextCursor) return;
    setCursorHistory((current) => [...current, cursor]);
    setCursor(page.nextCursor);
    void load(page.nextCursor, appliedFilters);
  }

  function previousPage(): void {
    const previous = cursorHistory.at(-1);
    if (previous === undefined) return;
    setCursorHistory((current) => current.slice(0, -1));
    setCursor(previous);
    void load(previous, appliedFilters);
  }

  return (
    <main className="app-page shell wide-shell runtime-page history-page" id="main-content">
      <header className="app-header runtime-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← {world?.name ?? 'World'}
        </Link>
        <nav aria-label="World runtime sections">
          <Link className="text-link" href={`/worlds/${worldId}/overview`}>
            Overview
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/graph`}>
            Graph explorer
          </Link>
          <Link aria-current="page" className="text-link" href={`/worlds/${worldId}/history`}>
            History
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/economy`}>
            Economy
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/assets`}>
            Assets
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/manifest`}>
            Manifest provenance
          </Link>
        </nav>
      </header>

      <div className="page-heading runtime-heading">
        <div>
          <p className="eyebrow">Tamper-evident timeline</p>
          <h1>World History</h1>
          <p className="lede compact">
            Recorded commands and facts, ordered by this world’s ledger. Hidden entries are never
            counted or hinted.
          </p>
        </div>
      </div>

      <form className="card history-filters" onSubmit={applyFilters}>
        <label>
          Actor ID
          <input
            maxLength={80}
            onChange={(event) =>
              setFilters((current) => ({ ...current, actor: event.target.value }))
            }
            value={filters.actor}
          />
        </label>
        <label>
          Entity key
          <input
            maxLength={240}
            onChange={(event) =>
              setFilters((current) => ({ ...current, entity: event.target.value }))
            }
            value={filters.entity}
          />
        </label>
        <label>
          Event type
          <input
            maxLength={120}
            onChange={(event) =>
              setFilters((current) => ({ ...current, event: event.target.value }))
            }
            value={filters.event}
          />
        </label>
        <button className="button" disabled={loading} type="submit">
          Apply filters
        </button>
      </form>

      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>History is unavailable</strong>
          <p>{error}</p>
          <button
            className="button secondary"
            onClick={() => void load(cursor, appliedFilters)}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}

      <div className="history-layout">
        <section
          aria-busy={loading}
          aria-label="World history entries"
          className="card history-list-card"
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Ledger</th>
                  <th scope="col">When</th>
                  <th scope="col">Fact</th>
                  <th scope="col">Actor</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5}>Loading visible history…</td>
                  </tr>
                ) : page?.items.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No visible history matches these filters.</td>
                  </tr>
                ) : (
                  page?.items.map((entry) => (
                    <tr key={entry.ledgerSequence}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => void openDetail(entry.ledgerSequence)}
                          type="button"
                        >
                          #{entry.ledgerSequence}
                        </button>
                      </td>
                      <td>{displayTime(entry.occurredAt)}</td>
                      <th scope="row">
                        <button
                          className="text-button history-title"
                          onClick={() => void openDetail(entry.ledgerSequence)}
                          type="button"
                        >
                          {labelFromKey(entry.titleKey)}
                        </button>
                        {entry.targetId ? <code>{entry.targetId}</code> : null}
                      </th>
                      <td>
                        <span className={`history-badge ${entry.actor.actorType}`}>
                          {badge(entry)}
                        </span>
                      </td>
                      <td>r{entry.resultingStateRevision}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="pagination" aria-label="History pages">
            <button
              className="button secondary"
              disabled={loading || cursorHistory.length === 0}
              onClick={previousPage}
              type="button"
            >
              Newer
            </button>
            <span>Page {cursorHistory.length + 1}</span>
            <button
              className="button secondary"
              disabled={loading || !page?.nextCursor}
              onClick={nextPage}
              type="button"
            >
              Older
            </button>
          </div>
        </section>

        <aside aria-label="History entry detail" className="history-detail">
          {detailLoading ? (
            <section aria-busy="true" className="card">
              <div className="skeleton" />
              <div className="skeleton short" />
            </section>
          ) : detailError ? (
            <div className="error-summary" role="alert">
              {detailError}
            </div>
          ) : detail ? (
            <section className="card" ref={detailRef} tabIndex={-1}>
              <div className="graph-section-heading">
                <div>
                  <p className="eyebrow">Ledger #{detail.entry.ledgerSequence}</p>
                  <h2>{labelFromKey(detail.entry.titleKey)}</h2>
                </div>
                <button className="text-button" onClick={() => setDetail(null)} type="button">
                  Close
                </button>
              </div>
              <dl className="runtime-facts">
                <div>
                  <dt>Requested command</dt>
                  <dd>
                    {detail.command?.commandType ?? 'Genesis/system fact'}
                    {detail.command?.commandId ? (
                      <>
                        <br />
                        <code>{detail.command.commandId}</code>
                      </>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Authorization / result</dt>
                  <dd>
                    {detail.command?.status ?? 'accepted'} ·{' '}
                    {detail.command?.authorizationRuleId ?? 'system genesis'}
                    {detail.command?.overrideId ? ' · creator override' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Resulting events</dt>
                  <dd>{detail.event?.eventType ?? labelFromKey(detail.entry.titleKey)}</dd>
                </div>
                <div>
                  <dt>Projection consequence</dt>
                  <dd>
                    World state advanced to revision{' '}
                    {detail.projection.resultingStateRevision ??
                      detail.entry.resultingStateRevision ??
                      '—'}
                    .
                  </dd>
                </div>
                <div>
                  <dt>Design / revision context</dt>
                  <dd>
                    Design v{detail.command?.expectedWorldVersion ?? '—'} · expected state r
                    {detail.command?.expectedStateRevision ?? '—'} · aggregate v
                    {detail.command?.expectedAggregateVersion ?? '—'}
                    <br />
                    Ledger #{detail.entry.ledgerSequence} · resulting state r
                    {detail.entry.resultingStateRevision ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt>Correlation</dt>
                  <dd>
                    <code>{detail.entry.correlationId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>
                    {detail.entry.targetType ?? 'world'}
                    <br />
                    {detail.entry.targetType === 'world_entity' && detail.entry.targetId ? (
                      <Link
                        className="text-link"
                        href={`/worlds/${worldId}/graph?entity=${encodeURIComponent(detail.entry.targetId)}`}
                      >
                        <code>{detail.entry.targetId}</code>
                      </Link>
                    ) : (
                      <code>{detail.entry.targetId ?? detail.entry.worldId}</code>
                    )}
                  </dd>
                </div>
              </dl>
            </section>
          ) : (
            <section className="empty-state">
              <h2>Inspect a ledger entry</h2>
              <p>
                Choose a visible row to inspect its command, authorization, events, and projected
                consequence.
              </p>
            </section>
          )}
        </aside>
      </div>
      <div aria-live="polite" className="sr-only">
        {loading ? 'Loading history' : `${page?.items.length ?? 0} history entries loaded`}
      </div>
    </main>
  );
}
