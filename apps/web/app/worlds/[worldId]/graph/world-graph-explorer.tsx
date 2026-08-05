'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  RuntimeSummaryView,
  World,
  WorldCommandResultV1,
  WorldEntityListResponse,
  WorldEntityDetailResponse,
  WorldEntityView,
  WorldNeighborResponse,
  WorldRelationshipListResponse,
} from '@worldgraph/contracts';

import { BrowserApiError, ensureCsrf, requestJson } from '../../../lib/browser-api';
import {
  entityQuery,
  humanizeGraphType,
  relationshipQuery,
  shortRuntimeHash,
} from '../runtime-model';

const PAGE_SIZE = 25;
const RENAMABLE_ENTITY_TYPES = new Set([
  'actor_blueprint',
  'district',
  'institution',
  'organization',
  'player_character',
]);

interface FilterState {
  search: string;
  type: string;
}

interface RelationshipFilterState {
  direction: 'source' | 'target';
  endpoint: string;
  type: string;
}

interface WorldGraphExplorerProps {
  worldId: string;
}

function failureText(cause: unknown, fallback: string): string {
  return cause instanceof BrowserApiError
    ? `${cause.failure.code}: ${cause.failure.message}`
    : fallback;
}

async function submitWorldCommand(
  path: string,
  body: object,
  idempotencyKey: string,
): Promise<WorldCommandResultV1> {
  const csrf = await ensureCsrf();
  const response = await fetch(path, {
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  const payload = (await response.json().catch(() => ({}))) as
    WorldCommandResultV1 | { error?: { code: string; message: string } };
  if ('status' in payload) return payload;
  throw new BrowserApiError(
    payload.error ?? { code: 'REQUEST_FAILED', message: 'The command could not be submitted.' },
    response.status,
  );
}

function entityLabel(entity: WorldEntityView): string {
  for (const key of ['displayName', 'name', 'title', 'label']) {
    const value = entity.state[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return entity.logicalKey;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function downloadJson(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([`${jsonText(value)}\n`], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.download = name;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
}

function RelationshipList({
  direction,
  items,
  onSelect,
}: {
  direction: 'Inbound' | 'Outbound';
  items: WorldNeighborResponse['items'];
  onSelect: (logicalKey: string) => void;
}) {
  return (
    <section aria-labelledby={`neighbors-${direction.toLowerCase()}`} className="neighbor-group">
      <h4 id={`neighbors-${direction.toLowerCase()}`}>
        {direction} <span>{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="field-help">
          No {direction.toLowerCase()} relationships in this bounded page.
        </p>
      ) : (
        <ul>
          {items.map((item) => {
            const relationship = item.relationship;
            const peer = item.neighbor.logicalKey;
            return (
              <li key={relationship.logicalKey}>
                <span className="relationship-direction" aria-hidden="true">
                  {direction === 'Inbound' ? '←' : '→'}
                </span>
                <div>
                  <strong>{humanizeGraphType(relationship.relationshipType)}</strong>
                  <button
                    className="text-button logical-key-button"
                    onClick={() => onSelect(peer)}
                    type="button"
                  >
                    {peer}
                  </button>
                  <details>
                    <summary>Typed attributes</summary>
                    <pre>{jsonText(relationship.attributes)}</pre>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function WorldGraphExplorer({ worldId }: WorldGraphExplorerProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [summary, setSummary] = useState<RuntimeSummaryView | null>(null);
  const [entities, setEntities] = useState<WorldEntityListResponse | null>(null);
  const [relationships, setRelationships] = useState<WorldRelationshipListResponse | null>(null);
  const [entityFilters, setEntityFilters] = useState<FilterState>({ search: '', type: '' });
  const [appliedEntityFilters, setAppliedEntityFilters] = useState<FilterState>({
    search: '',
    type: '',
  });
  const [relationshipFilters, setRelationshipFilters] = useState<RelationshipFilterState>({
    direction: 'source',
    endpoint: '',
    type: '',
  });
  const [appliedRelationshipFilters, setAppliedRelationshipFilters] =
    useState<RelationshipFilterState>({ direction: 'source', endpoint: '', type: '' });
  const [entityCursor, setEntityCursor] = useState<string | null>(null);
  const [relationshipCursor, setRelationshipCursor] = useState<string | null>(null);
  const [entityCursorHistory, setEntityCursorHistory] = useState<(string | null)[]>([]);
  const [relationshipCursorHistory, setRelationshipCursorHistory] = useState<(string | null)[]>([]);
  const [selected, setSelected] = useState<WorldEntityView | null>(null);
  const [detailTarget, setDetailTarget] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<WorldNeighborResponse | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const [loadingEntities, setLoadingEntities] = useState(true);
  const [loadingRelationships, setLoadingRelationships] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');
  const [entityError, setEntityError] = useState('');
  const [relationshipError, setRelationshipError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renamePending, setRenamePending] = useState(false);
  const [renameStatus, setRenameStatus] = useState('');

  const handleUnauthorized = useCallback(
    (cause: unknown): boolean => {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/graph`)}`);
        return true;
      }
      return false;
    },
    [router, worldId],
  );

  const loadContext = useCallback(async () => {
    setLoadingContext(true);
    setError('');
    try {
      const [worldResponse, runtime] = await Promise.all([
        requestJson<{ world: World }>(`/api/v1/worlds/${worldId}`),
        requestJson<RuntimeSummaryView>(`/api/v1/worlds/${worldId}/runtime-summary`),
      ]);
      setWorld(worldResponse.world);
      setSummary(runtime);
    } catch (cause) {
      if (handleUnauthorized(cause)) return;
      setError(failureText(cause, 'WORLDGRAPH_UNAVAILABLE: The active graph could not be loaded.'));
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setLoadingContext(false);
    }
  }, [handleUnauthorized, worldId]);

  const loadEntities = useCallback(
    async (cursor: string | null, filters: FilterState) => {
      setLoadingEntities(true);
      setEntityError('');
      try {
        const query = entityQuery({
          cursor,
          entityType: filters.type,
          limit: PAGE_SIZE,
          search: filters.search,
        });
        setEntities(
          await requestJson<WorldEntityListResponse>(`/api/v1/worlds/${worldId}/entities?${query}`),
        );
      } catch (cause) {
        if (handleUnauthorized(cause)) return;
        setEntities(null);
        setEntityError(
          failureText(cause, 'ENTITY_LIST_UNAVAILABLE: Entities could not be loaded.'),
        );
      } finally {
        setLoadingEntities(false);
      }
    },
    [handleUnauthorized, worldId],
  );

  const loadRelationships = useCallback(
    async (cursor: string | null, filters: RelationshipFilterState) => {
      setLoadingRelationships(true);
      setRelationshipError('');
      try {
        const query = relationshipQuery({
          cursor,
          limit: PAGE_SIZE,
          relationshipType: filters.type,
          ...(filters.direction === 'source'
            ? { sourceLogicalKey: filters.endpoint }
            : { targetLogicalKey: filters.endpoint }),
        });
        setRelationships(
          await requestJson<WorldRelationshipListResponse>(
            `/api/v1/worlds/${worldId}/relationships?${query}`,
          ),
        );
      } catch (cause) {
        if (handleUnauthorized(cause)) return;
        setRelationships(null);
        setRelationshipError(
          failureText(cause, 'RELATIONSHIP_LIST_UNAVAILABLE: Relationships could not be loaded.'),
        );
      } finally {
        setLoadingRelationships(false);
      }
    },
    [handleUnauthorized, worldId],
  );

  const selectEntity = useCallback(
    async (logicalKey: string, updateUrl = true) => {
      setLoadingDetail(true);
      setDetailError('');
      setDetailTarget(logicalKey);
      setSelected(null);
      setNeighbors(null);
      try {
        const encodedKey = encodeURIComponent(logicalKey);
        const [detail, neighborPage] = await Promise.all([
          requestJson<WorldEntityDetailResponse>(
            `/api/v1/worlds/${worldId}/entities/${encodedKey}`,
          ),
          requestJson<WorldNeighborResponse>(
            `/api/v1/worlds/${worldId}/entities/${encodedKey}/neighbors?limit=${PAGE_SIZE}`,
          ),
        ]);
        setSelected(detail.entity);
        setRenameValue(entityLabel(detail.entity));
        setNeighbors(neighborPage);
        if (updateUrl) {
          const url = new URL(window.location.href);
          url.searchParams.set('entity', logicalKey);
          window.history.replaceState(null, '', url);
        }
        requestAnimationFrame(() => detailRef.current?.focus());
      } catch (cause) {
        if (handleUnauthorized(cause)) return;
        setDetailError(
          failureText(cause, 'ENTITY_DETAIL_UNAVAILABLE: Entity details could not be loaded.'),
        );
      } finally {
        setLoadingDetail(false);
      }
    },
    [handleUnauthorized, worldId],
  );

  useEffect(() => {
    void Promise.all([
      loadContext(),
      loadEntities(null, { search: '', type: '' }),
      loadRelationships(null, { direction: 'source', endpoint: '', type: '' }),
    ]).then(() => {
      const logicalKey = new URL(window.location.href).searchParams.get('entity');
      if (logicalKey) void selectEntity(logicalKey, false);
    });
  }, [loadContext, loadEntities, loadRelationships, selectEntity]);

  function applyEntityFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const filters = { search: entityFilters.search.trim(), type: entityFilters.type.trim() };
    setAppliedEntityFilters(filters);
    setEntityCursor(null);
    setEntityCursorHistory([]);
    void loadEntities(null, filters);
  }

  function applyRelationshipFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const filters = {
      direction: relationshipFilters.direction,
      endpoint: relationshipFilters.endpoint.trim(),
      type: relationshipFilters.type.trim(),
    };
    setAppliedRelationshipFilters(filters);
    setRelationshipCursor(null);
    setRelationshipCursorHistory([]);
    void loadRelationships(null, filters);
  }

  function nextEntityPage(): void {
    if (!entities?.nextCursor) return;
    setEntityCursorHistory((current) => [...current, entityCursor]);
    setEntityCursor(entities.nextCursor);
    void loadEntities(entities.nextCursor, appliedEntityFilters);
  }

  function previousEntityPage(): void {
    const previous = entityCursorHistory.at(-1);
    if (previous === undefined) return;
    setEntityCursorHistory((current) => current.slice(0, -1));
    setEntityCursor(previous);
    void loadEntities(previous, appliedEntityFilters);
  }

  function nextRelationshipPage(): void {
    if (!relationships?.nextCursor) return;
    setRelationshipCursorHistory((current) => [...current, relationshipCursor]);
    setRelationshipCursor(relationships.nextCursor);
    void loadRelationships(relationships.nextCursor, appliedRelationshipFilters);
  }

  function previousRelationshipPage(): void {
    const previous = relationshipCursorHistory.at(-1);
    if (previous === undefined) return;
    setRelationshipCursorHistory((current) => current.slice(0, -1));
    setRelationshipCursor(previous);
    void loadRelationships(previous, appliedRelationshipFilters);
  }

  function closeDetail(): void {
    setSelected(null);
    setDetailTarget(null);
    setNeighbors(null);
    setDetailError('');
    setRenameOpen(false);
    setRenameStatus('');
    const url = new URL(window.location.href);
    url.searchParams.delete('entity');
    window.history.replaceState(null, '', url);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected || !summary || renamePending) return;
    const newDisplayName = renameValue.trim();
    if (!newDisplayName) {
      setRenameStatus('Enter a display name before submitting.');
      return;
    }
    const commandId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const body = {
      commandId,
      expectedAggregateVersion: String(selected.rowVersion + 1),
      expectedStateRevision: String(summary.stateRevision),
      expectedWorldVersion: String(summary.worldVersionNumber),
      idempotencyKey,
      payload: { entityKey: selected.logicalKey, newDisplayName },
      schemaVersion: 1,
      type: 'RenameWorldEntityV1',
    };
    setRenamePending(true);
    setRenameStatus('Submitting the authoritative command…');
    try {
      let result: WorldCommandResultV1;
      try {
        result = await submitWorldCommand(
          `/api/v1/worlds/${worldId}/commands`,
          body,
          idempotencyKey,
        );
      } catch (cause) {
        if (cause instanceof BrowserApiError) throw cause;
        setRenameStatus('The network result is uncertain. Looking up the command…');
        await new Promise((resolve) => setTimeout(resolve, 400));
        result = await requestJson<WorldCommandResultV1>(`/api/v1/commands/${commandId}`);
      }
      if (result.status === 'accepted') {
        setRenameStatus(
          `Accepted at state revision ${result.resultingStateRevision ?? '—'}. History will appear after durable outbox delivery.`,
        );
        await Promise.all([
          loadContext(),
          loadEntities(entityCursor, appliedEntityFilters),
          selectEntity(selected.logicalKey, false),
        ]);
        setRenameOpen(false);
      } else if (result.status === 'rejected' && result.rejectionCode === 'REVISION_CONFLICT') {
        setRenameStatus(
          `REVISION_CONFLICT: the world is now at revision ${result.currentStateRevision}. Refresh state before trying again.`,
        );
      } else if (result.status === 'rejected') {
        setRenameStatus(
          `${result.rejectionCode}: The rename was recorded but did not change the entity.`,
        );
      } else {
        setRenameStatus('COMMAND_PENDING: Look up this command before retrying it.');
      }
    } catch (cause) {
      if (handleUnauthorized(cause)) return;
      if (cause instanceof BrowserApiError && cause.failure.code === 'REVISION_CONFLICT') {
        setRenameStatus(
          `REVISION_CONFLICT: ${cause.failure.message} Refresh state before trying again.`,
        );
      } else {
        setRenameStatus(
          failureText(cause, 'COMMAND_RESULT_UNCERTAIN: Look up the command before retrying.'),
        );
      }
    } finally {
      setRenamePending(false);
    }
  }

  return (
    <main className="app-page shell wide-shell runtime-page graph-page" id="main-content">
      <header className="app-header runtime-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← {world?.name ?? 'World'}
        </Link>
        <nav aria-label="World runtime sections">
          <Link className="text-link" href={`/worlds/${worldId}/overview`}>
            Overview
          </Link>
          <Link aria-current="page" className="text-link" href={`/worlds/${worldId}/graph`}>
            Graph explorer
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/manifest`}>
            Manifest provenance
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/history`}>
            History
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/economy`}>
            Economy
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/govern`}>
            Govern
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/assets`}>
            Assets
          </Link>
        </nav>
      </header>

      <div className="page-heading runtime-heading">
        <div>
          <p className="eyebrow">Accessible relational browser</p>
          <h1>WorldGraph Explorer</h1>
          <p className="lede compact">
            Search persisted entities, inspect typed edges, and follow one-hop bounded neighbors.
          </p>
        </div>
        {summary ? (
          <span className="manifest-state approved">
            World version {summary.worldVersionNumber}
          </span>
        ) : null}
      </div>

      <section className="authority-boundary compact-authority" aria-label="Graph authority notice">
        <strong>The relational graph is authoritative.</strong>
        <span>No WebGL or visual projection is required to inspect this world.</span>
        {summary ? (
          <code title={summary.artifactHash}>{shortRuntimeHash(summary.artifactHash)}</code>
        ) : null}
      </section>

      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Graph unavailable</strong>
          <p>{error}</p>
          <button className="button secondary" onClick={() => void loadContext()} type="button">
            Retry summary
          </button>
        </div>
      ) : null}

      {loadingContext ? (
        <p aria-live="polite" className="field-help">
          Loading active version metadata…
        </p>
      ) : null}

      <div className="graph-browser-layout">
        <div className="graph-tables">
          <section aria-labelledby="entities-heading" className="card graph-table-card">
            <div className="graph-section-heading">
              <div>
                <p className="eyebrow">Nodes</p>
                <h2 id="entities-heading">Entities</h2>
              </div>
              <span>{summary?.entityCount ?? '—'} total</span>
            </div>
            <form className="graph-filters" onSubmit={applyEntityFilters}>
              <label>
                Search logical key
                <input
                  maxLength={100}
                  onChange={(event) =>
                    setEntityFilters((current) => ({ ...current, search: event.target.value }))
                  }
                  placeholder="organization:energy-guild"
                  type="search"
                  value={entityFilters.search}
                />
              </label>
              <label>
                Entity type
                <input
                  maxLength={64}
                  onChange={(event) =>
                    setEntityFilters((current) => ({ ...current, type: event.target.value }))
                  }
                  pattern="[a-z][a-z0-9_-]*"
                  placeholder="district"
                  value={entityFilters.type}
                />
              </label>
              <button className="button secondary" disabled={loadingEntities} type="submit">
                Apply entity filters
              </button>
            </form>

            <div className="table-scroll" tabIndex={0}>
              <table className="graph-table">
                <caption>Authoritative entities in the active world version</caption>
                <thead>
                  <tr>
                    <th scope="col">Entity</th>
                    <th scope="col">Type</th>
                    <th scope="col">Schema</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingEntities ? (
                    <tr>
                      <td colSpan={3}>Loading entities…</td>
                    </tr>
                  ) : entityError ? (
                    <tr>
                      <td className="table-error" colSpan={3}>
                        <p>{entityError}</p>
                        <button
                          className="button secondary"
                          onClick={() => void loadEntities(entityCursor, appliedEntityFilters)}
                          type="button"
                        >
                          Retry entities
                        </button>
                      </td>
                    </tr>
                  ) : entities?.items.length === 0 ? (
                    <tr>
                      <td colSpan={3}>No entities match these filters.</td>
                    </tr>
                  ) : (
                    entities?.items.map((entity) => (
                      <tr key={entity.logicalKey}>
                        <th scope="row">
                          <button
                            className="text-button graph-key"
                            onClick={() => void selectEntity(entity.logicalKey)}
                            type="button"
                          >
                            <span>{entityLabel(entity)}</span>
                            <code>{entity.logicalKey}</code>
                          </button>
                        </th>
                        <td>
                          <span className="type-chip">{humanizeGraphType(entity.entityType)}</span>
                        </td>
                        <td>v{entity.entitySchemaVersion}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="pagination graph-pagination" aria-label="Entity pages">
              <button
                className="button secondary"
                disabled={loadingEntities || entityCursorHistory.length === 0}
                onClick={previousEntityPage}
                type="button"
              >
                Previous entities
              </button>
              <span>Page {entityCursorHistory.length + 1}</span>
              <button
                className="button secondary"
                disabled={loadingEntities || !entities?.nextCursor}
                onClick={nextEntityPage}
                type="button"
              >
                Next entities
              </button>
            </div>
          </section>

          <section aria-labelledby="relationships-heading" className="card graph-table-card">
            <div className="graph-section-heading">
              <div>
                <p className="eyebrow">Edges</p>
                <h2 id="relationships-heading">Relationships</h2>
              </div>
              <span>{summary?.relationshipCount ?? '—'} total</span>
            </div>
            <form className="graph-filters" onSubmit={applyRelationshipFilters}>
              <label>
                Endpoint logical key
                <input
                  maxLength={240}
                  onChange={(event) =>
                    setRelationshipFilters((current) => ({
                      ...current,
                      endpoint: event.target.value,
                    }))
                  }
                  pattern="[a-z0-9]+(?::[a-z0-9][a-z0-9._-]*)+"
                  placeholder="district:sky-forge"
                  value={relationshipFilters.endpoint}
                />
              </label>
              <label>
                Endpoint direction
                <select
                  onChange={(event) =>
                    setRelationshipFilters((current) => ({
                      ...current,
                      direction: event.target.value === 'target' ? 'target' : 'source',
                    }))
                  }
                  value={relationshipFilters.direction}
                >
                  <option value="source">Source</option>
                  <option value="target">Target</option>
                </select>
              </label>
              <label>
                Relationship type
                <input
                  maxLength={64}
                  onChange={(event) =>
                    setRelationshipFilters((current) => ({ ...current, type: event.target.value }))
                  }
                  pattern="[a-z][a-z0-9_-]*"
                  placeholder="located_in"
                  value={relationshipFilters.type}
                />
              </label>
              <button className="button secondary" disabled={loadingRelationships} type="submit">
                Apply relationship filters
              </button>
            </form>

            <div className="table-scroll" tabIndex={0}>
              <table className="graph-table relationship-table">
                <caption>Typed relationships in the active world version</caption>
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">Source entity</th>
                    <th scope="col">Target entity</th>
                    <th scope="col">Attributes</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingRelationships ? (
                    <tr>
                      <td colSpan={4}>Loading relationships…</td>
                    </tr>
                  ) : relationshipError ? (
                    <tr>
                      <td className="table-error" colSpan={4}>
                        <p>{relationshipError}</p>
                        <button
                          className="button secondary"
                          onClick={() =>
                            void loadRelationships(relationshipCursor, appliedRelationshipFilters)
                          }
                          type="button"
                        >
                          Retry relationships
                        </button>
                      </td>
                    </tr>
                  ) : relationships?.items.length === 0 ? (
                    <tr>
                      <td colSpan={4}>No relationships match these filters.</td>
                    </tr>
                  ) : (
                    relationships?.items.map((relationship) => (
                      <tr key={relationship.logicalKey}>
                        <th scope="row">
                          <span className="type-chip">
                            {humanizeGraphType(relationship.relationshipType)}
                          </span>
                          <code>{relationship.logicalKey}</code>
                        </th>
                        <td>
                          <button
                            className="text-button logical-key-button"
                            onClick={() => void selectEntity(relationship.sourceLogicalKey)}
                            type="button"
                          >
                            {relationship.sourceLogicalKey}
                          </button>
                        </td>
                        <td>
                          <button
                            className="text-button logical-key-button"
                            onClick={() => void selectEntity(relationship.targetLogicalKey)}
                            type="button"
                          >
                            {relationship.targetLogicalKey}
                          </button>
                        </td>
                        <td>
                          <details>
                            <summary>View</summary>
                            <pre>{jsonText(relationship.attributes)}</pre>
                          </details>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="pagination graph-pagination" aria-label="Relationship pages">
              <button
                className="button secondary"
                disabled={loadingRelationships || relationshipCursorHistory.length === 0}
                onClick={previousRelationshipPage}
                type="button"
              >
                Previous relationships
              </button>
              <span>Page {relationshipCursorHistory.length + 1}</span>
              <button
                className="button secondary"
                disabled={loadingRelationships || !relationships?.nextCursor}
                onClick={nextRelationshipPage}
                type="button"
              >
                Next relationships
              </button>
            </div>
          </section>
        </div>

        <aside aria-label="Selected entity details" className="entity-inspector">
          {loadingDetail ? (
            <div aria-busy="true" className="card">
              <div className="skeleton" />
              <div className="skeleton short" />
            </div>
          ) : detailError ? (
            <div className="error-summary" role="alert">
              <p>{detailError}</p>
              <div className="actions">
                {detailTarget ? (
                  <button
                    className="button secondary"
                    onClick={() => void selectEntity(detailTarget, false)}
                    type="button"
                  >
                    Retry entity
                  </button>
                ) : null}
                <button className="button secondary" onClick={closeDetail} type="button">
                  Close
                </button>
              </div>
            </div>
          ) : selected && neighbors ? (
            <section
              aria-labelledby="selected-entity-heading"
              className="card entity-detail-card"
              ref={detailRef}
              tabIndex={-1}
            >
              <div className="graph-section-heading">
                <div>
                  <p className="eyebrow">Selected entity</p>
                  <h2 id="selected-entity-heading">{entityLabel(selected)}</h2>
                </div>
                <button
                  aria-label="Close entity details"
                  className="text-button"
                  onClick={closeDetail}
                  type="button"
                >
                  Close
                </button>
              </div>
              <code className="entity-logical-key">{selected.logicalKey}</code>
              <dl className="runtime-facts entity-facts">
                <div>
                  <dt>Type</dt>
                  <dd>{humanizeGraphType(selected.entityType)}</dd>
                </div>
                <div>
                  <dt>Schema</dt>
                  <dd>v{selected.entitySchemaVersion}</dd>
                </div>
                <div>
                  <dt>World version</dt>
                  <dd>{neighbors.runtime.worldVersionNumber}</dd>
                </div>
                <div>
                  <dt>State revision</dt>
                  <dd>{neighbors.runtime.stateRevision}</dd>
                </div>
              </dl>
              <details className="json-details">
                <summary>Typed entity state</summary>
                <pre>{jsonText(selected.state)}</pre>
              </details>
              {summary &&
              RENAMABLE_ENTITY_TYPES.has(selected.entityType) &&
              (world?.role === 'creator' || world?.role === 'administrator') ? (
                <section aria-labelledby="rename-entity-heading" className="entity-rename">
                  <div className="graph-section-heading">
                    <div>
                      <p className="eyebrow">Authoritative command</p>
                      <h3 id="rename-entity-heading">Rename entity</h3>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => setRenameOpen((current) => !current)}
                      type="button"
                    >
                      {renameOpen ? 'Cancel' : 'Rename'}
                    </button>
                  </div>
                  {renameOpen ? (
                    <form className="form-stack" onSubmit={(event) => void submitRename(event)}>
                      <label htmlFor="entity-display-name">New display name</label>
                      <input
                        autoComplete="off"
                        id="entity-display-name"
                        maxLength={100}
                        onChange={(event) => setRenameValue(event.target.value)}
                        required
                        value={renameValue}
                      />
                      <p className="field-help">
                        Uses world revision {summary.stateRevision} and entity version{' '}
                        {selected.rowVersion + 1}. Authority is checked by the server.
                      </p>
                      <button className="button" disabled={renamePending} type="submit">
                        {renamePending ? 'Submitting…' : 'Confirm rename'}
                      </button>
                    </form>
                  ) : null}
                  {renameStatus ? (
                    <p aria-live="polite" className="command-status" role="status">
                      {renameStatus}
                    </p>
                  ) : null}
                </section>
              ) : null}
              <button
                className="button secondary"
                onClick={() => downloadJson(`${selected.logicalKey}.json`, selected)}
                type="button"
              >
                Download entity JSON
              </button>

              <div className="neighbor-heading">
                <h3>One-hop neighbors</h3>
                <span>Bounded to {PAGE_SIZE} edges per direction</span>
              </div>
              {neighbors.nextCursor ? (
                <div className="degraded-notice" role="status">
                  This neighborhood is truncated at the server-enforced bound. Refine the graph
                  tables to inspect more edges.
                </div>
              ) : null}
              <RelationshipList
                direction="Inbound"
                items={neighbors.items.filter((item) => item.direction === 'inbound')}
                onSelect={(key) => void selectEntity(key)}
              />
              <RelationshipList
                direction="Outbound"
                items={neighbors.items.filter((item) => item.direction === 'outbound')}
                onSelect={(key) => void selectEntity(key)}
              />
              {summary ? (
                <p className="entity-provenance-link">
                  Provenance:{' '}
                  <Link className="text-link" href={`/worlds/${worldId}/manifest`}>
                    exact approved manifest revision{' '}
                    {shortRuntimeHash(summary.manifestRevisionId, 8, 8)}
                  </Link>
                </p>
              ) : null}
            </section>
          ) : (
            <section className="empty-state inspector-empty">
              <h2>Inspect an entity</h2>
              <p>
                Choose a logical key from either table to inspect typed state and bounded
                inbound/outbound edges.
              </p>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
