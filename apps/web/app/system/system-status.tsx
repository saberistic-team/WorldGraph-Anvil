'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComponentStatus, ReadyResponse, SystemInfo } from '@worldgraph/contracts';

interface ApiError {
  error?: {
    code?: string;
    details?: { components?: ComponentStatus[] };
    message?: string;
    requestId?: string;
  };
}

type ViewState =
  | { kind: 'loading' }
  | {
      checkedAt?: string;
      components: ComponentStatus[];
      code: string;
      info?: SystemInfo;
      kind: 'degraded';
    }
  | { info: SystemInfo; kind: 'healthy'; ready: ReadyResponse };

export function SystemStatus() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [smokeToken, setSmokeToken] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [smokeMessage, setSmokeMessage] = useState('');
  const retryRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (returnFocus = false) => {
    setState({ kind: 'loading' });
    try {
      const [infoResponse, readyResponse] = await Promise.all([
        fetch('/api/system/info', { cache: 'no-store' }),
        fetch('/api/system/ready', { cache: 'no-store' }),
      ]);
      const info = infoResponse.ok ? ((await infoResponse.json()) as SystemInfo) : undefined;
      if (readyResponse.ok && info) {
        setState({ info, kind: 'healthy', ready: (await readyResponse.json()) as ReadyResponse });
      } else {
        const error = (await readyResponse.json().catch(() => ({}))) as ApiError;
        setState({
          components: error.error?.details?.components ?? [],
          code: error.error?.code ?? 'API_UNAVAILABLE',
          ...(info ? { info } : {}),
          kind: 'degraded',
        });
      }
    } catch {
      setState({ components: [], code: 'API_UNAVAILABLE', kind: 'degraded' });
    } finally {
      if (returnFocus) requestAnimationFrame(() => retryRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitSmoke(): Promise<void> {
    if (!confirmed || !smokeToken) return;
    const idempotencyKey = crypto.randomUUID();
    setSmokeMessage('Submitting smoke job…');
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
        const response = await fetch('/api/system/smoke', {
          body: '{}',
          headers: {
            authorization: `Bearer ${smokeToken}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          method: 'POST',
        });
        const body = (await response.json().catch(() => ({}))) as {
          jobId?: string;
          status?: 'completed' | 'queued';
        } & ApiError;
        if (!response.ok) {
          setSmokeMessage(
            `${body.error?.code ?? 'SMOKE_FAILED'}: ${body.error?.message ?? 'Request failed.'}`,
          );
          return;
        }
        if (body.status === 'completed') {
          setSmokeMessage(`Smoke job completed: ${body.jobId ?? 'completed'}`);
          setSmokeToken('');
          setConfirmed(false);
          return;
        }
        setSmokeMessage(`Smoke job queued: ${body.jobId ?? 'queued'}; checking completion…`);
      }
      setSmokeMessage('Smoke job remains queued. Check worker readiness and retry with a new job.');
    } catch {
      setSmokeMessage('SMOKE_NETWORK_ERROR: The operational check could not reach the API.');
    }
  }

  if (state.kind === 'loading') {
    return (
      <section aria-busy="true" aria-live="polite" className="status-panel">
        <h2>Checking dependencies</h2>
        <div className="skeleton" />
        <div className="skeleton short" />
      </section>
    );
  }

  const components = state.kind === 'healthy' ? state.ready.components : state.components;
  const info = state.info;
  return (
    <section aria-live="polite" className="status-panel">
      <div className="status-heading">
        <div>
          <p className={`status-label ${state.kind}`}>
            {state.kind === 'healthy' ? 'Ready' : 'Unavailable'}
          </p>
          <h2>
            {state.kind === 'healthy'
              ? 'All required components are healthy'
              : 'The system is not ready'}
          </h2>
        </div>
        <button
          className="button secondary"
          onClick={() => void load(true)}
          ref={retryRef}
          type="button"
        >
          Retry checks
        </button>
      </div>
      {state.kind === 'degraded' ? <p className="error-code">Error code: {state.code}</p> : null}
      {components.length === 0 ? (
        <p>No component details are available. Retry after the API has recovered.</p>
      ) : (
        <ul className="component-list">
          {components.map((component) => (
            <li key={component.name}>
              <span className="component-name">{component.name}</span>
              <span className={`component-state ${component.status}`}>
                {component.status.replace('_', ' ')}
                {component.code ? ` — ${component.code}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {state.kind === 'healthy' ? (
        <p className="timestamp">Checked {new Date(state.ready.checkedAt).toLocaleString()}</p>
      ) : null}

      {info ? (
        <dl className="version-grid">
          <div>
            <dt>Product</dt>
            <dd>
              {info.name} / {info.codename}
            </dd>
          </div>
          <div>
            <dt>API build</dt>
            <dd>{info.build.api}</dd>
          </div>
          <div>
            <dt>API contract</dt>
            <dd>{info.versions.api}</dd>
          </div>
          <div>
            <dt>Runtime schema</dt>
            <dd>{info.versions.runtimeSchema}</dd>
          </div>
        </dl>
      ) : null}

      {info?.features.operationalSmoke ? (
        <details className="smoke-panel">
          <summary>Run operational smoke job</summary>
          <p>
            This bounded job verifies API → Redis queue → worker delivery. It changes no world
            state.
          </p>
          <label htmlFor="operations-token">Operations token</label>
          <input
            id="operations-token"
            onChange={(event) => setSmokeToken(event.target.value)}
            type="password"
            value={smokeToken}
          />
          <label className="checkbox-row">
            <input
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            I understand this invokes an operational check.
          </label>
          <button
            className="button"
            disabled={!confirmed || !smokeToken}
            onClick={() => void submitSmoke()}
            type="button"
          >
            Submit smoke job
          </button>
          <p aria-live="polite">{smokeMessage}</p>
        </details>
      ) : null}
    </section>
  );
}
