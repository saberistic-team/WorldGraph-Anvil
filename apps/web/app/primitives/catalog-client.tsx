'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BrowserApiError, formString, requestJson } from '../lib/browser-api';
import { sanitizedIndexError } from './diagnostics';
import {
  primitiveKinds,
  primitivePath,
  type PrimitiveListItem,
  type RetrievalResponse,
  type RetrievalResult,
} from './types';

export interface PrimitiveFilters {
  cursor: string;
  kind: string;
  query: string;
  tag: string;
}

interface CatalogPage {
  items: PrimitiveListItem[];
  nextCursor: string | null;
}

interface PrimitiveCatalogProps {
  filters: PrimitiveFilters;
}

function filtersHref(filters: PrimitiveFilters, cursor: string | null): string {
  const parameters = new URLSearchParams();
  if (filters.query) parameters.set('q', filters.query);
  if (filters.kind) parameters.set('kind', filters.kind);
  if (filters.tag) parameters.set('tag', filters.tag);
  if (cursor) parameters.set('cursor', cursor);
  const query = parameters.toString();
  return query ? `/primitives?${query}` : '/primitives';
}

function SearchExplanation({ result }: { result: RetrievalResult }) {
  const { reason } = result;
  const channels = [
    reason.lexicalRank === null
      ? null
      : `lexical #${reason.lexicalRank}${reason.lexicalScore === null ? '' : ` (${reason.lexicalScore.toFixed(3)})`}`,
    reason.tagRank === null
      ? null
      : `tag #${reason.tagRank}${reason.tagScore === null ? '' : ` (${reason.tagScore.toFixed(3)})`}`,
    reason.vectorRank === null
      ? null
      : `semantic #${reason.vectorRank}${reason.vectorSimilarity === null ? '' : ` (${reason.vectorSimilarity.toFixed(3)})`}`,
  ].filter((value): value is string => value !== null);
  return (
    <div className="score-reasons">
      <span>
        Rank {result.rank} · score {reason.score.toFixed(4)}
      </span>
      {channels.length > 0 ? <span>Signals: {channels.join(', ')}</span> : null}
      {reason.matchedTerms.length > 0 ? (
        <span>Matched terms: {reason.matchedTerms.join(', ')}</span>
      ) : null}
      {reason.matchedTags.length > 0 ? (
        <span>Matched tags: {reason.matchedTags.join(', ')}</span>
      ) : null}
      <span>
        Index: schema {result.index.indexSchemaVersion}, {result.index.status.replaceAll('_', ' ')}
        {result.index.provider ? ` via ${result.index.provider}` : ' · lexical/tag only'}
      </span>
      {sanitizedIndexError(result.index.lastErrorCode) ? (
        <span>Index issue: {sanitizedIndexError(result.index.lastErrorCode)}</span>
      ) : null}
    </div>
  );
}

function PrimitiveCard({
  item,
  result,
}: {
  item: PrimitiveListItem;
  result?: RetrievalResult | undefined;
}) {
  return (
    <article className="card primitive-card">
      <div className="primitive-card-heading">
        <span className="role-badge">{item.kind.replaceAll('_', ' ')}</span>
        <span className="status-text">{item.lifecycle}</span>
      </div>
      <h2>
        <Link href={primitivePath(item)}>{item.displayName}</Link>
      </h2>
      <p className="primitive-coordinate">
        <code>{item.key}</code>@<strong>{item.version}</strong>
      </p>
      {item.tags.length > 0 ? (
        <ul aria-label="Primitive tags" className="tag-list">
          {item.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      ) : null}
      {result ? <SearchExplanation result={result} /> : null}
      <p className="field-help">
        Index: {item.indexState.replaceAll('_', ' ')} · Hash {item.contentHash.slice(0, 12)}…
      </p>
      {sanitizedIndexError(item.indexErrorCode) ? (
        <p className="index-error">Index issue: {sanitizedIndexError(item.indexErrorCode)}</p>
      ) : null}
    </article>
  );
}

export function PrimitiveCatalog({ filters }: PrimitiveCatalogProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);
  const [items, setItems] = useState<PrimitiveListItem[] | null>(null);
  const [results, setResults] = useState<RetrievalResult[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [provider, setProvider] = useState<RetrievalResponse['provider'] | null>(null);
  const [warnings, setWarnings] = useState<Array<{ code: string; message: string }>>([]);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal, sequence: number) => {
      const isCurrent = () => !signal.aborted && sequence === requestSequence.current;
      setError('');
      setItems(null);
      setResults(null);
      setProvider(null);
      setWarnings([]);
      setNextCursor(null);
      try {
        if (filters.query) {
          const response = await requestJson<RetrievalResponse>('/api/v1/primitive-retrievals', {
            body: JSON.stringify({
              ...(filters.kind ? { kinds: [filters.kind] } : {}),
              limit: 20,
              query: filters.query,
              ...(filters.tag ? { tags: [filters.tag] } : {}),
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
            signal,
          });
          if (!isCurrent()) return;
          setResults(response.results);
          setItems(response.results.map((result) => result.primitive));
          setProvider(response.provider);
          setWarnings(response.warnings ?? []);
          setNextCursor(null);
        } else {
          const parameters = new URLSearchParams({ lifecycle: 'published', limit: '8' });
          if (filters.kind) parameters.set('kinds', filters.kind);
          if (filters.tag) parameters.set('tags', filters.tag);
          if (filters.cursor) parameters.set('cursor', filters.cursor);
          const response = await requestJson<CatalogPage>(`/api/v1/primitives?${parameters}`, {
            signal,
          });
          if (!isCurrent()) return;
          setItems(response.items);
          setNextCursor(response.nextCursor);
          setWarnings([]);
        }
      } catch (cause) {
        if (!isCurrent()) return;
        if (cause instanceof BrowserApiError && cause.status === 401) {
          router.replace(`/sign-in?returnTo=${encodeURIComponent(filtersHref(filters, null))}`);
          return;
        }
        if (cause instanceof BrowserApiError && cause.failure.code === 'NO_COMPATIBLE_PRIMITIVES') {
          setItems([]);
          setResults([]);
          return;
        }
        setError(
          cause instanceof BrowserApiError
            ? `${cause.failure.code}: ${cause.failure.message}`
            : 'CATALOG_UNAVAILABLE: The primitive catalog could not be loaded.',
        );
        requestAnimationFrame(() => errorRef.current?.focus());
      }
    },
    [filters, router],
  );

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    void load(controller.signal, sequence);
    return () => controller.abort();
  }, [load, loadAttempt]);

  return (
    <main className="app-page shell" id="main-content">
      <header className="app-header catalog-header">
        <Link className="brand-link" href="/worlds">
          WorldGraph / Anvil
        </Link>
        <nav aria-label="Catalog navigation">
          <Link className="text-link" href="/worlds">
            Worlds
          </Link>
          <Link className="text-link" href="/admin/primitives">
            Registry admin
          </Link>
        </nav>
      </header>

      <div className="page-heading">
        <div>
          <p className="eyebrow">Immutable building blocks</p>
          <h1>World primitives</h1>
          <p className="lede compact">
            Search reviewed, exact-version mechanics and structures for a city-state design.
          </p>
        </div>
      </div>

      <form
        action="/primitives"
        className="catalog-filters"
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          router.push(
            filtersHref(
              {
                cursor: '',
                kind: formString(data, 'kind').trim(),
                query: formString(data, 'q').trim(),
                tag: formString(data, 'tag').trim(),
              },
              null,
            ),
          );
        }}
        role="search"
      >
        <label className="catalog-query">
          Search the catalog
          <input
            defaultValue={filters.query}
            maxLength={500}
            name="q"
            placeholder="guild-led floating city with closed-loop credits"
            type="search"
          />
        </label>
        <label>
          Kind
          <select defaultValue={filters.kind} name="kind">
            <option value="">All kinds</option>
            {primitiveKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <input defaultValue={filters.tag} maxLength={64} name="tag" placeholder="city-state" />
        </label>
        <div className="filter-actions">
          <button className="button" type="submit">
            Apply
          </button>
          <Link className="button secondary" href="/primitives">
            Clear
          </Link>
        </div>
      </form>

      {provider && !provider.semanticAvailable ? (
        <div className="degraded-notice" role="status">
          <strong>Semantic ranking unavailable.</strong> Results use deterministic lexical and tag
          ranking. {provider.degradedReason ? `Reason: ${provider.degradedReason}.` : null}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <ul aria-label="Retrieval warnings" className="warning-list">
          {warnings.map((warning) => (
            <li key={warning.code}>
              {warning.message} ({warning.code})
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <section className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <h2>Catalog unavailable</h2>
          <p>{error}</p>
          <button
            className="button secondary"
            onClick={() => setLoadAttempt((n) => n + 1)}
            type="button"
          >
            Retry loading
          </button>
        </section>
      ) : null}

      {items === null && !error ? (
        <section aria-busy="true" aria-label="Loading primitives" className="primitive-grid">
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </section>
      ) : items?.length === 0 ? (
        <section className="empty-state">
          <h2>No matching primitives</h2>
          <p>Try fewer filters, a broader query, or clear the search to browse every kind.</p>
          <Link className="button" href="/primitives">
            Browse all primitives
          </Link>
        </section>
      ) : items ? (
        <section aria-label="Primitive results" className="primitive-grid">
          {items.map((item, index) => (
            <PrimitiveCard item={item} key={item.id} result={results?.[index]} />
          ))}
        </section>
      ) : null}

      {nextCursor || filters.cursor ? (
        <nav aria-label="Catalog pagination" className="pagination">
          {filters.cursor ? (
            <Link className="button secondary" href={filtersHref(filters, null)}>
              First page
            </Link>
          ) : null}
          {nextCursor ? (
            <Link className="button secondary" href={filtersHref(filters, nextCursor)}>
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}
