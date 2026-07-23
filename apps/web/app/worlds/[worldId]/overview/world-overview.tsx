'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GetManifestRevisionResponse, RuntimeSummaryView, World } from '@worldgraph/contracts';

import { BrowserApiError, requestJson } from '../../../lib/browser-api';
import { humanizeGraphType, shortRuntimeHash } from '../runtime-model';

interface WorldOverviewProps {
  worldId: string;
}

function displayTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function WorldOverview({ worldId }: WorldOverviewProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [summary, setSummary] = useState<RuntimeSummaryView | null>(null);
  const [manifestRevisionNumber, setManifestRevisionNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setManifestRevisionNumber(null);
    try {
      const worldResponse = await requestJson<{ world: World }>(`/api/v1/worlds/${worldId}`);
      setWorld(worldResponse.world);
      try {
        const runtime = await requestJson<RuntimeSummaryView>(
          `/api/v1/worlds/${worldId}/runtime-summary`,
        );
        setSummary(runtime);
        try {
          const manifest = await requestJson<GetManifestRevisionResponse>(
            `/api/v1/worlds/${worldId}/manifest-revisions/${runtime.manifestRevisionId}`,
          );
          setManifestRevisionNumber(manifest.revision.revisionNumber);
        } catch {
          setManifestRevisionNumber(null);
        }
      } catch (cause) {
        if (cause instanceof BrowserApiError && cause.status === 401) throw cause;
        setSummary(null);
        setError(
          cause instanceof BrowserApiError
            ? `${cause.failure.code}: ${cause.failure.message}`
            : 'RUNTIME_SUMMARY_UNAVAILABLE: The authoritative runtime summary could not be loaded.',
        );
        requestAnimationFrame(() => errorRef.current?.focus());
      }
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/overview`)}`);
        return;
      }
      setError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'WORLD_UNAVAILABLE: This world could not be loaded.',
      );
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setLoading(false);
    }
  }, [router, worldId]);

  useEffect(() => void load(), [load]);

  if (loading && !world) {
    return (
      <main className="app-page shell wide-shell runtime-page" id="main-content">
        <section aria-busy="true" aria-label="Loading World Overview" className="runtime-loading">
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </section>
      </main>
    );
  }

  return (
    <main className="app-page shell wide-shell runtime-page" id="main-content">
      <header className="app-header runtime-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← {world?.name ?? 'World'}
        </Link>
        <nav aria-label="World runtime sections">
          <Link aria-current="page" className="text-link" href={`/worlds/${worldId}/overview`}>
            Overview
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/graph`}>
            Graph explorer
          </Link>
          <Link className="text-link" href={`/worlds/${worldId}/history`}>
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
          <p className="eyebrow">Authoritative WorldGraph</p>
          <h1>World Overview</h1>
          <p className="lede compact">
            Versioned design identity and persisted graph counts for {world?.name ?? 'this world'}.
          </p>
        </div>
        <span className={`manifest-state ${summary ? 'approved' : 'draft'}`}>
          {summary
            ? humanizeGraphType(summary.lifecycle)
            : humanizeGraphType(String(world?.lifecycle ?? 'unavailable'))}
        </span>
      </div>

      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>World Overview is not ready</strong>
          <p>{error}</p>
          <div className="actions">
            <button className="button secondary" onClick={() => void load()} type="button">
              Try again
            </button>
            <Link className="button secondary" href={`/worlds/${worldId}/manifest`}>
              Return to approved manifest
            </Link>
          </div>
        </div>
      ) : null}

      {summary ? (
        <>
          <section aria-labelledby="world-version-heading" className="runtime-summary-grid">
            <article className="card runtime-identity-card">
              <p className="eyebrow">Active design</p>
              <h2 id="world-version-heading">World version {summary.worldVersionNumber}</h2>
              <dl className="runtime-facts">
                <div>
                  <dt>Active version ID</dt>
                  <dd>
                    <code>{summary.activeWorldVersionId}</code>
                  </dd>
                </div>
                <div>
                  <dt>World schema</dt>
                  <dd>v{summary.worldGraphSchemaVersion}</dd>
                </div>
                <div>
                  <dt>Activated</dt>
                  <dd>{displayTimestamp(summary.activatedAt)}</dd>
                </div>
                <div>
                  <dt>Mutable state revision</dt>
                  <dd>{summary.stateRevision}</dd>
                </div>
              </dl>
            </article>

            <article className="card runtime-count-card">
              <p className="eyebrow">Persisted topology</p>
              <div className="runtime-counts">
                <div>
                  <strong>{summary.entityCount}</strong>
                  <span>entities</span>
                </div>
                <div>
                  <strong>{summary.relationshipCount}</strong>
                  <span>typed relationships</span>
                </div>
                <div>
                  <strong>{summary.controllerCount}</strong>
                  <span>controller bindings</span>
                </div>
              </div>
              <Link className="button" href={`/worlds/${worldId}/graph`}>
                Browse authoritative graph
              </Link>
            </article>
          </section>

          <section
            aria-labelledby="reproducibility-heading"
            className="card runtime-provenance-card"
          >
            <div className="studio-panel-heading">
              <div>
                <p className="eyebrow">Reproducibility identity</p>
                <h2 id="reproducibility-heading">Exact compilation inputs</h2>
              </div>
              <Link
                className="text-link"
                href={`/worlds/${worldId}/manifest?revision=${encodeURIComponent(summary.manifestRevisionId)}`}
              >
                Open exact manifest revision
              </Link>
            </div>
            <dl className="runtime-facts provenance-facts">
              <div>
                <dt>Compiler</dt>
                <dd>
                  {summary.compilerVersion} · config v{summary.compilerConfigVersion}
                </dd>
              </div>
              <div>
                <dt>Manifest</dt>
                <dd>
                  {manifestRevisionNumber === null
                    ? 'Revision ID'
                    : `revision ${manifestRevisionNumber}`}{' '}
                  · schema v{summary.manifestSchemaVersion}
                  <br />
                  <code>{summary.manifestRevisionId}</code>
                </dd>
              </div>
              <div>
                <dt>Seed</dt>
                <dd>
                  <code>{summary.seed}</code>
                </dd>
              </div>
              <div>
                <dt>Manifest hash</dt>
                <dd>
                  <code title={summary.manifestContentHash}>{summary.manifestContentHash}</code>
                </dd>
              </div>
              <div className="full-runtime-fact">
                <dt>Canonical artifact hash</dt>
                <dd>
                  <code title={summary.artifactHash}>{summary.artifactHash}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section className="authority-boundary" aria-labelledby="authority-boundary-heading">
            <div>
              <p className="eyebrow">Authority boundary</p>
              <h2 id="authority-boundary-heading">The graph is authoritative</h2>
            </div>
            <p>
              Entity and relationship rows are the current world design. A future visual or 3D view
              will be a replaceable projection of this data, never a second source of truth.
            </p>
            <code title={summary.artifactHash}>
              Artifact {shortRuntimeHash(summary.artifactHash)}
            </code>
          </section>
        </>
      ) : !loading ? (
        <section className="empty-state runtime-empty">
          <h2>No active WorldGraph yet</h2>
          <p>An approved manifest must be explicitly compiled by the world creator.</p>
          <Link className="button" href={`/worlds/${worldId}/manifest`}>
            Open Manifest Studio
          </Link>
        </section>
      ) : null}
    </main>
  );
}
