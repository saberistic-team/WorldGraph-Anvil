'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BrowserApiError, requestJson } from '../../../../lib/browser-api';
import { sanitizedIndexError } from '../../../diagnostics';
import { SafeMarkdown } from '../../../safe-markdown';
import { type PrimitiveDependency, type PrimitiveVersion, unwrapPrimitive } from '../../../types';

interface PrimitiveDetailProps {
  primitiveKey: string;
  version: string;
}

function JsonFact({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <section className="definition-section">
      <h2>{label}</h2>
      <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function DependencyList({ dependencies }: { dependencies: PrimitiveDependency[] }) {
  if (dependencies.length === 0) return <p>No dependencies are required.</p>;
  return (
    <ul className="dependency-tree">
      {dependencies.map((dependency) => (
        <li key={dependency.key}>
          <strong>{dependency.key}</strong>
          <ul>
            <li>Requested range: {dependency.versionRange}</li>
            <li>Required: {dependency.required ? 'yes' : 'no'}</li>
            <li>
              Resolved exact version:{' '}
              {dependency.resolvedVersion ? (
                <Link
                  href={`/primitives/${encodeURIComponent(dependency.key)}/versions/${encodeURIComponent(dependency.resolvedVersion)}`}
                >
                  {dependency.resolvedVersion}
                </Link>
              ) : (
                'not resolved'
              )}
            </li>
            {dependency.resolvedContentHash ? (
              <li>
                Resolved hash: <code>{dependency.resolvedContentHash}</code>
              </li>
            ) : null}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function dependenciesFrom(value: unknown): PrimitiveDependency[] {
  if (Array.isArray(value)) return value as PrimitiveDependency[];
  const envelope = value as { dependencies?: PrimitiveDependency[]; items?: PrimitiveDependency[] };
  return envelope.items ?? envelope.dependencies ?? [];
}

export function PrimitiveDetail({ primitiveKey, version }: PrimitiveDetailProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const [primitive, setPrimitive] = useState<PrimitiveVersion | null>(null);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setError('');
      setPrimitive(null);
      const endpoint = `/api/v1/primitives/${encodeURIComponent(primitiveKey)}/versions/${encodeURIComponent(version)}`;
      try {
        const [detail, dependencyResponse] = await Promise.all([
          requestJson<unknown>(endpoint, { signal }),
          requestJson<unknown>(`${endpoint}/dependencies`, { signal }),
        ]);
        if (signal.aborted) return;
        const loaded = unwrapPrimitive(detail);
        setPrimitive({ ...loaded, dependencies: dependenciesFrom(dependencyResponse) });
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof BrowserApiError && cause.status === 401) {
          router.replace(
            `/sign-in?returnTo=${encodeURIComponent(`/primitives/${primitiveKey}/versions/${version}`)}`,
          );
          return;
        }
        setError(
          cause instanceof BrowserApiError
            ? `${cause.failure.code}: ${cause.failure.message}`
            : 'PRIMITIVE_UNAVAILABLE: This exact primitive version could not be loaded.',
        );
        requestAnimationFrame(() => errorRef.current?.focus());
      }
    },
    [primitiveKey, router, version],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, loadAttempt]);

  return (
    <main className="app-page shell" id="main-content">
      <header className="app-header">
        <Link className="brand-link" href="/primitives">
          ← Primitive catalog
        </Link>
        <nav aria-label="Primitive navigation">
          <Link className="text-link" href="/worlds">
            Worlds
          </Link>
        </nav>
      </header>
      {error ? (
        <section className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <h1>Primitive unavailable</h1>
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
      {!primitive && !error ? (
        <section aria-busy="true" aria-label="Loading primitive" className="detail-loading">
          <div className="skeleton" />
          <div className="skeleton short" />
          <div className="card skeleton-card" />
        </section>
      ) : null}
      {primitive ? (
        <>
          <div className="page-heading primitive-title">
            <div>
              <p className="eyebrow">Exact primitive version</p>
              <h1>{primitive.displayName}</h1>
              <p className="primitive-coordinate">
                <code>{primitive.key}</code>@<strong>{primitive.version}</strong>
              </p>
            </div>
            <div className="status-stack">
              <span className="role-badge">{primitive.kind.replaceAll('_', ' ')}</span>
              <span className="status-text">Lifecycle: {primitive.lifecycle}</span>
              <span className="status-text">
                Index: {primitive.indexState.replaceAll('_', ' ')}
              </span>
              {sanitizedIndexError(primitive.indexErrorCode) ? (
                <span className="index-error">
                  Index issue: {sanitizedIndexError(primitive.indexErrorCode)}
                </span>
              ) : null}
            </div>
          </div>

          <article className="definition-card">
            <section aria-labelledby="documentation-heading" className="definition-section">
              <h2 id="documentation-heading">Documentation</h2>
              <SafeMarkdown>{primitive.documentation}</SafeMarkdown>
            </section>
            <JsonFact label="Parameter schema" value={primitive.parameterSchema} />
            <JsonFact label="Defaults" value={primitive.defaults} />
            <section className="definition-section">
              <h2>Required dependencies</h2>
              <DependencyList dependencies={primitive.dependencies} />
            </section>
            <JsonFact label="Compatibility" value={primitive.compatibility} />
            <section className="definition-section">
              <h2>Behavior and visual hints</h2>
              <dl className="facts primitive-facts">
                <div>
                  <dt>Behavior reference</dt>
                  <dd>{primitive.behaviorRef ?? 'Structural primitive; no behavior reference'}</dd>
                </div>
                <div>
                  <dt>Schema version</dt>
                  <dd>{primitive.primitiveSchemaVersion}</dd>
                </div>
              </dl>
              <pre className="json-view">{JSON.stringify(primitive.visualHints, null, 2)}</pre>
            </section>
            <section className="definition-section">
              <h2>Integrity and provenance</h2>
              <dl className="integrity-list">
                <div>
                  <dt>Canonical content hash</dt>
                  <dd>
                    <code>{primitive.contentHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>Published at</dt>
                  <dd>{primitive.publishedAt ?? 'Not published'}</dd>
                </div>
                {primitive.deprecatedAt ? (
                  <div>
                    <dt>Deprecated at</dt>
                    <dd>{primitive.deprecatedAt}</dd>
                  </div>
                ) : null}
                {primitive.deprecationReason ? (
                  <div>
                    <dt>Deprecation reason</dt>
                    <dd>{primitive.deprecationReason}</dd>
                  </div>
                ) : null}
              </dl>
              <pre className="json-view">{JSON.stringify(primitive.provenance, null, 2)}</pre>
            </section>
          </article>
        </>
      ) : null}
    </main>
  );
}
