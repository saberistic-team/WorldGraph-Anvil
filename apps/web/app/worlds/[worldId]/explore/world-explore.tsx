'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { mutateJson, requestJson } from '../../../lib/browser-api';

type Feature = {
  entityLogicalKey: string | null;
  geometryKind: 'polygon' | 'linestring' | 'point';
  layer: string;
  properties: { archetype?: string; zoning?: string };
  ringOrPath: Array<{ xMilli: number; yMilli: number }>;
  stableKey: string;
};

type Snapshot = {
  etag: string;
  features: Feature[];
  geographyVersion: string;
  stateRevision: string;
};

type ScenePlan = {
  checksum: string;
  geographyVersion: string;
  plan: {
    nodes: Array<{
      archetype: string;
      entityLogicalKey: string;
      layer: string;
      materialToken: string;
      provenance: { sourceStableKey: string };
      transform: { xMilli: number; yMilli: number; zMilli: number; yawMilliDegrees: number };
    }>;
  };
  status: 'published';
};

const ExploreCanvas = dynamic(
  () => import('./explore-canvas').then((module) => module.ExploreCanvas),
  {
    ssr: false,
    loading: () => <p role="status">Loading WebGL scene…</p>,
  },
);

export function WorldExplore({ worldId }: { worldId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scenePlan, setScenePlan] = useState<ScenePlan | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webglEnabled, setWebglEnabled] = useState(true);
  const [contextLost, setContextLost] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const nextSnapshot = await requestJson<Snapshot>(
        `/api/v1/worlds/${worldId}/geography?minXMilli=-50000&minYMilli=-50000&maxXMilli=50000&maxYMilli=50000`,
      );
      setSnapshot(nextSnapshot);
      try {
        const nextPlan = await requestJson<ScenePlan>(
          `/api/v1/worlds/${worldId}/visual-scene-plan`,
        );
        setScenePlan(nextPlan);
      } catch {
        setScenePlan(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load geography.');
    } finally {
      setBusy(false);
    }
  }, [worldId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => snapshot?.features.find((feature) => feature.stableKey === selectedKey) ?? null,
    [selectedKey, snapshot],
  );

  async function initializeGeography() {
    setBusy(true);
    setError(null);
    try {
      await mutateJson(`/api/v1/worlds/${worldId}/geography/initialize`, 'POST');
      await mutateJson(`/api/v1/worlds/${worldId}/geography/visual-scene-plan`, 'POST');
      await load();
    } catch (initError) {
      setError(initError instanceof Error ? initError.message : 'Unable to initialize geography.');
      setBusy(false);
    }
  }

  return (
    <main className="page-shell" id="main-content">
      <header className="page-header">
        <div>
          <p className="eyebrow">Explore</p>
          <h1>City geography</h1>
          <p>
            Authoritative PostGIS features with a replaceable WebGL lens. Selection reads server
            facts only.
          </p>
        </div>
        <nav aria-label="World lenses" className="inline-nav">
          <Link href={`/worlds/${worldId}`}>Overview</Link>
          <Link href={`/worlds/${worldId}/graph`}>Graph</Link>
          <Link href={`/worlds/${worldId}/economy`}>Economy</Link>
          <Link href={`/worlds/${worldId}/govern`}>Govern</Link>
          <Link aria-current="page" href={`/worlds/${worldId}/explore`}>
            Explore
          </Link>
        </nav>
      </header>

      <section className="panel-stack" aria-live="polite">
        <div className="toolbar">
          <button type="button" className="button" disabled={busy} onClick={() => void load()}>
            Refresh
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void initializeGeography()}
          >
            Initialize geography + scene plan
          </button>
          <label>
            <input
              type="checkbox"
              checked={webglEnabled && !contextLost}
              onChange={(event) => {
                setWebglEnabled(event.target.checked);
                if (event.target.checked) setContextLost(false);
              }}
            />{' '}
            Enable WebGL
          </label>
          {snapshot ? (
            <p className="meta">
              Geography v{snapshot.geographyVersion} · revision {snapshot.stateRevision}
              {scenePlan ? ` · scene ${scenePlan.checksum.slice(0, 12)}` : ' · scene not published'}
            </p>
          ) : null}
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {busy && !snapshot ? <p role="status">Loading geography…</p> : null}
      </section>

      <div className="explore-layout">
        <section aria-label="Accessible object list and map" className="panel">
          <h2>2D list / map</h2>
          {!snapshot || snapshot.features.length === 0 ? (
            <p>No geography features yet. Initialize from the native compiler seed plan.</p>
          ) : (
            <ul className="object-list">
              {snapshot.features.map((feature) => (
                <li key={feature.stableKey}>
                  <button
                    type="button"
                    className={selectedKey === feature.stableKey ? 'selected' : undefined}
                    onClick={() => setSelectedKey(feature.stableKey)}
                  >
                    <span>{feature.layer}</span> {feature.stableKey}
                    {feature.properties.archetype
                      ? ` · ${feature.properties.archetype}`
                      : feature.properties.zoning
                        ? ` · ${feature.properties.zoning}`
                        : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {snapshot ? (
            <svg
              viewBox="-50 -50 100 100"
              role="img"
              aria-label="Schematic city map in milli-kilometers"
              className="schematic-map"
            >
              {snapshot.features
                .filter((feature) => feature.layer === 'district')
                .map((feature) => {
                  const points = feature.ringOrPath
                    .map((point) => `${point.xMilli / 1000},${-point.yMilli / 1000}`)
                    .join(' ');
                  return (
                    <polygon
                      key={feature.stableKey}
                      points={points}
                      className={selectedKey === feature.stableKey ? 'selected' : undefined}
                      onClick={() => setSelectedKey(feature.stableKey)}
                    />
                  );
                })}
              {snapshot.features
                .filter((feature) => feature.layer === 'building' || feature.layer === 'spawn')
                .map((feature) => {
                  const point = feature.ringOrPath[0];
                  if (!point) return null;
                  return (
                    <circle
                      key={feature.stableKey}
                      cx={point.xMilli / 1000}
                      cy={-point.yMilli / 1000}
                      r={feature.layer === 'spawn' ? 1.2 : 1.8}
                      className={selectedKey === feature.stableKey ? 'selected' : undefined}
                      onClick={() => setSelectedKey(feature.stableKey)}
                    />
                  );
                })}
            </svg>
          ) : null}
        </section>

        <section aria-label="WebGL explore canvas" className="panel">
          <h2>WebGL lens</h2>
          {webglEnabled && !contextLost && scenePlan ? (
            <ExploreCanvas
              nodes={scenePlan.plan.nodes}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onContextLost={() => setContextLost(true)}
            />
          ) : (
            <p role="status">
              {contextLost
                ? 'WebGL context was lost. The list/map inspector remains available.'
                : 'WebGL is disabled or the scene plan is unpublished. Use the accessible list/map.'}
            </p>
          )}
        </section>

        <aside aria-label="Selection inspector" className="panel">
          <h2>Inspector</h2>
          {!selected ? (
            <p>Select a district, building, or spawn to inspect authoritative identity.</p>
          ) : (
            <dl>
              <div>
                <dt>Stable key</dt>
                <dd>{selected.stableKey}</dd>
              </div>
              <div>
                <dt>Layer</dt>
                <dd>{selected.layer}</dd>
              </div>
              <div>
                <dt>Entity</dt>
                <dd>
                  {selected.entityLogicalKey ? (
                    <Link
                      href={`/worlds/${worldId}/graph?entity=${encodeURIComponent(selected.entityLogicalKey)}`}
                    >
                      {selected.entityLogicalKey}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Presentation</dt>
                <dd>{selected.properties.archetype ?? selected.properties.zoning ?? 'n/a'}</dd>
              </div>
            </dl>
          )}
        </aside>
      </div>
    </main>
  );
}
