'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { COMPILER_CONFIG_SCHEMA_VERSION, COMPILER_VERSION } from '@worldgraph/contracts/versions';
import type {
  CompilerDiagnosticV1,
  GetManifestRevisionResponse,
  StartWorldCompilationResponse,
  World,
  WorldCompilationRunView,
} from '@worldgraph/contracts';

import { BrowserApiError, mutateJson, requestJson } from '../../../lib/browser-api';
import {
  COMPILATION_STAGES,
  compilationCanCancel,
  compilationCanRetry,
  compilationPollDelay,
  compilationStageIndex,
  compilationTerminal,
  compileIneligibleReason,
  humanizeGraphType,
  shortRuntimeHash,
} from '../runtime-model';

interface CompilePanelProps {
  detail: GetManifestRevisionResponse;
  onFailure: (cause: unknown) => void;
  world: World;
  worldId: string;
}

function statusText(run: WorldCompilationRunView): string {
  if (run.status === 'succeeded') return 'World activated from the exact compiled artifact.';
  if (run.status === 'failed') return 'Compilation failed without activating partial world state.';
  if (run.status === 'cancelled') return 'Compilation cancelled before seeding began.';
  return `${humanizeGraphType(run.stage)} is in progress. This durable run survives refresh.`;
}

function diagnosticSourceHref(
  diagnostic: CompilerDiagnosticV1,
  detail: GetManifestRevisionResponse,
  worldId: string,
): string | null {
  const primitive = detail.revision.manifest.primitiveRefs.find(
    (reference) =>
      diagnostic.relatedKeys.includes(reference.key) ||
      diagnostic.relatedKeys.includes(reference.primitiveVersionId),
  );
  if (primitive) {
    return `/primitives/${encodeURIComponent(primitive.key)}/versions/${encodeURIComponent(primitive.version)}`;
  }
  const entityKey = diagnostic.relatedKeys.find((key) =>
    /^[a-z0-9]+(?::[a-z0-9][a-z0-9._-]*)+$/u.test(key),
  );
  if (entityKey) return `/worlds/${worldId}/graph?entity=${encodeURIComponent(entityKey)}`;
  return diagnostic.pointer
    ? `/worlds/${worldId}/manifest?revision=${encodeURIComponent(detail.revision.id)}&focus=${encodeURIComponent(diagnostic.pointer)}`
    : null;
}

function relatedKeyHref(
  detail: GetManifestRevisionResponse,
  key: string,
  worldId: string,
): string | null {
  const primitive = detail.revision.manifest.primitiveRefs.find(
    (reference) => reference.key === key || reference.primitiveVersionId === key,
  );
  if (primitive) {
    return `/primitives/${encodeURIComponent(primitive.key)}/versions/${encodeURIComponent(primitive.version)}`;
  }
  if (/^[a-z0-9]+(?::[a-z0-9][a-z0-9._-]*)+$/u.test(key)) {
    return `/worlds/${worldId}/graph?entity=${encodeURIComponent(key)}`;
  }
  const primitiveCoordinate = key.match(
    /^([a-z][a-z0-9]*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){2,})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u,
  );
  return primitiveCoordinate?.[1] && primitiveCoordinate[2]
    ? `/primitives/${encodeURIComponent(primitiveCoordinate[1])}/versions/${encodeURIComponent(primitiveCoordinate[2])}`
    : null;
}

export function CompilePanel({ detail, onFailure, world, worldId }: CompilePanelProps) {
  const statusRef = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState<WorldCompilationRunView | null>(null);
  const [seed, setSeed] = useState(detail.revision.manifest.seed);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');

  const loadRun = useCallback(
    async (runId: string): Promise<WorldCompilationRunView> => {
      const current = await requestJson<WorldCompilationRunView>(
        `/api/v1/worlds/${worldId}/compilations/${runId}`,
      );
      setRun(current);
      return current;
    },
    [worldId],
  );

  useEffect(() => {
    const runId = new URL(window.location.href).searchParams.get('compilation');
    const recoverCurrent =
      !runId && (world.lifecycle === 'compiling' || world.lifecycle === 'compile_failed');
    if (!runId && !recoverCurrent) return;
    let disposed = false;
    void (
      runId
        ? loadRun(runId)
        : requestJson<WorldCompilationRunView>(
            `/api/v1/worlds/${worldId}/compilations/current`,
          ).then((current) => {
            setRun(current);
            const url = new URL(window.location.href);
            url.searchParams.set('compilation', current.id);
            window.history.replaceState(null, '', url);
            return current;
          })
    ).catch((cause: unknown) => {
      if (disposed) return;
      setLoadError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'COMPILATION_UNAVAILABLE: The durable compilation run could not be loaded.',
      );
    });
    return () => {
      disposed = true;
    };
  }, [loadRun, world.lifecycle, worldId]);

  const activeRunId = run && !compilationTerminal(run) ? run.id : null;
  useEffect(() => {
    if (!activeRunId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollCount = 0;
    const poll = async (): Promise<void> => {
      try {
        const current = await loadRun(activeRunId);
        if (disposed || compilationTerminal(current)) return;
        pollCount += 1;
        timer = setTimeout(
          () => void poll(),
          compilationPollDelay(pollCount, document.visibilityState),
        );
      } catch (cause) {
        if (!disposed) onFailure(cause);
      }
    };
    timer = setTimeout(() => void poll(), compilationPollDelay(0, document.visibilityState));
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeRunId, loadRun, onFailure]);

  const ineligibleReason =
    run?.status === 'succeeded'
      ? 'This exact approved manifest has already activated the authoritative WorldGraph.'
      : compileIneligibleReason({ revision: detail.revision, world });
  const seedValid = /^[A-Za-z0-9._:-]{1,128}$/u.test(seed);
  const startDisabled =
    ineligibleReason !== null ||
    !confirmed ||
    !seedValid ||
    busy !== '' ||
    run?.status === 'failed' ||
    (run !== null && !compilationTerminal(run));

  async function startCompilation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (startDisabled) return;
    setBusy('start');
    setLoadError('');
    try {
      const started = await mutateJson<StartWorldCompilationResponse>(
        `/api/v1/worlds/${worldId}/compilations`,
        'POST',
        {
          expectedManifestHash: detail.revision.contentHash,
          manifestRevisionId: detail.revision.id,
          seed,
        },
      );
      const current = await loadRun(started.runId);
      const url = new URL(window.location.href);
      url.searchParams.set('compilation', current.id);
      window.history.replaceState(null, '', url);
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch (cause) {
      onFailure(cause);
    } finally {
      setBusy('');
    }
  }

  async function cancelCompilation(): Promise<void> {
    if (!run || !compilationCanCancel(run)) return;
    setBusy('cancel');
    try {
      const cancelled = await mutateJson<WorldCompilationRunView>(
        `/api/v1/worlds/${worldId}/compilations/${run.id}/cancel`,
        'POST',
        { expectedRowVersion: run.rowVersion },
      );
      setRun(cancelled);
    } catch (cause) {
      onFailure(cause);
    } finally {
      setBusy('');
    }
  }

  async function retryCompilation(): Promise<void> {
    if (!run || !compilationCanRetry(run)) return;
    setBusy('retry');
    try {
      const started = await mutateJson<StartWorldCompilationResponse>(
        `/api/v1/worlds/${worldId}/compilations/${run.id}/retry`,
        'POST',
        { expectedRowVersion: run.rowVersion },
      );
      const current = await loadRun(started.runId);
      const url = new URL(window.location.href);
      url.searchParams.set('compilation', current.id);
      window.history.replaceState(null, '', url);
    } catch (cause) {
      onFailure(cause);
    } finally {
      setBusy('');
    }
  }

  return (
    <section aria-labelledby="compile-world-heading" className="compile-panel">
      <div className="studio-panel-heading">
        <div>
          <p className="eyebrow">Separate authoritative action</p>
          <h3 id="compile-world-heading">Compile world</h3>
        </div>
        <span className={`run-status ${run?.status ?? 'queued'}`}>
          {run?.status ?? 'Not started'}
        </span>
      </div>
      <p>
        Compilation is deterministic and does not use AI. It resolves this exact approved manifest,
        creates the authoritative relational graph, and activates it only after every invariant
        passes.
      </p>

      <dl className="compile-input-facts">
        <div>
          <dt>Approved revision</dt>
          <dd>{detail.revision.revisionNumber}</dd>
        </div>
        <div>
          <dt>Manifest schema</dt>
          <dd>v{detail.revision.manifestSchemaVersion}</dd>
        </div>
        <div>
          <dt>Compiler</dt>
          <dd>
            {COMPILER_VERSION} · config v{COMPILER_CONFIG_SCHEMA_VERSION}
          </dd>
        </div>
        <div>
          <dt>Manifest hash</dt>
          <dd>
            <code title={detail.revision.contentHash}>
              {shortRuntimeHash(detail.revision.contentHash)}
            </code>
          </dd>
        </div>
      </dl>

      {ineligibleReason ? (
        <div className="denial-panel manifest-denial" role="status">
          <strong>Compilation unavailable</strong>
          <p>{ineligibleReason}</p>
          {String(world.lifecycle) === 'active' || run?.status === 'succeeded' ? (
            <Link className="text-link" href={`/worlds/${worldId}/overview`}>
              Open active World Overview
            </Link>
          ) : null}
        </div>
      ) : (
        <form
          className="form-stack compile-confirmation"
          onSubmit={(event) => void startCompilation(event)}
        >
          <label>
            Deterministic compile seed
            <input
              aria-describedby="compile-seed-help"
              maxLength={128}
              onChange={(event) => {
                setSeed(event.target.value);
                setConfirmed(false);
              }}
              pattern={'(?:[A-Za-z0-9._:]|\\-)+'}
              required
              value={seed}
            />
          </label>
          <p className="field-help" id="compile-seed-help">
            The seed is semantic input. Changing it produces a different compilation identity.
          </p>
          <label className="checkbox-row studio-checkbox compile-exact-confirmation">
            <input
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>
              Compile revision <strong>{detail.revision.revisionNumber}</strong>, hash{' '}
              <code>{shortRuntimeHash(detail.revision.contentHash, 8, 8)}</code>, with seed{' '}
              <code>{seed || '—'}</code>.
            </span>
          </label>
          <button className="button" disabled={startDisabled} type="submit">
            {busy === 'start' ? 'Queueing compilation…' : 'Compile exact approved manifest'}
          </button>
        </form>
      )}

      {loadError ? (
        <div className="error-summary" role="alert">
          {loadError}
        </div>
      ) : null}

      {run ? (
        <section aria-label="Compilation progress" className="compilation-progress-card">
          <div className="generation-heading" ref={statusRef} tabIndex={-1}>
            <div>
              <strong>{statusText(run)}</strong>
              <span>Run {run.id}</span>
            </div>
            <span className={`run-status ${run.status}`}>{run.status}</span>
          </div>
          <progress aria-label="Compilation progress" max={100} value={run.progressPercent} />
          <ol aria-label="Compilation stages" className="compile-stage-list">
            {COMPILATION_STAGES.map((stage) => {
              const currentIndex = compilationStageIndex(run.stage);
              const stageIndex = compilationStageIndex(stage);
              const state =
                run.stage === stage
                  ? 'current'
                  : currentIndex >= 0 && stageIndex < currentIndex
                    ? 'complete'
                    : 'pending';
              return (
                <li
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={state}
                  key={stage}
                >
                  <span aria-hidden="true">{state === 'complete' ? '✓' : stageIndex + 1}</span>
                  {humanizeGraphType(stage)}
                </li>
              );
            })}
          </ol>
          <dl className="compilation-run-facts">
            <div>
              <dt>Input hash</dt>
              <dd>
                <code title={run.inputHash ?? undefined}>{shortRuntimeHash(run.inputHash)}</code>
              </dd>
            </div>
            <div>
              <dt>Compiler</dt>
              <dd>
                {run.compilerVersion} · config v{run.compilerConfigVersion}
              </dd>
            </div>
            <div>
              <dt>Artifact hash</dt>
              <dd>
                <code title={run.artifactHash ?? undefined}>
                  {shortRuntimeHash(run.artifactHash)}
                </code>
              </dd>
            </div>
          </dl>

          {run.diagnostics.length > 0 ? (
            <section
              className="compiler-diagnostics"
              aria-labelledby="compiler-diagnostics-heading"
            >
              <div className="diagnostic-toolbar">
                <h4 id="compiler-diagnostics-heading">Compiler diagnostics</h4>
                <a
                  className="button secondary"
                  download={`world-compilation-${run.id}-diagnostics.json`}
                  href={`/api/v1/worlds/${worldId}/compilations/${run.id}/diagnostics`}
                >
                  Download JSON
                </a>
              </div>
              <ol className="diagnostic-list">
                {run.diagnostics.map((diagnostic, index) => {
                  const href = diagnosticSourceHref(diagnostic, detail, worldId);
                  return (
                    <li
                      className={`diagnostic-${diagnostic.severity}`}
                      key={`${diagnostic.code}:${diagnostic.pointer}:${index}`}
                    >
                      <div>
                        <strong>{diagnostic.code}</strong>
                        <span>{diagnostic.severity}</span>
                        <span>
                          {diagnostic.retryable ? 'retryable' : 'manifest change required'}
                        </span>
                      </div>
                      <p>{diagnostic.message}</p>
                      <code>{diagnostic.pointer || '/'}</code>
                      {href ? (
                        <Link className="text-link" href={href}>
                          Inspect source
                        </Link>
                      ) : null}
                      {diagnostic.relatedKeys.length > 0 ? (
                        <details>
                          <summary>Related logical keys ({diagnostic.relatedKeys.length})</summary>
                          <ul className="related-key-list">
                            {diagnostic.relatedKeys.map((key) => {
                              const relatedHref = relatedKeyHref(detail, key, worldId);
                              return (
                                <li key={key}>
                                  <code>{key}</code>
                                  {relatedHref ? (
                                    <Link className="text-link" href={relatedHref}>
                                      Inspect related source
                                    </Link>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          <div className="actions compilation-actions">
            {compilationCanCancel(run) ? (
              <button
                className="button danger"
                disabled={busy === 'cancel'}
                onClick={() => void cancelCompilation()}
                type="button"
              >
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel before seeding'}
              </button>
            ) : null}
            {run.status === 'running' && !compilationCanCancel(run) ? (
              <span className="field-help">
                Seeding has begun, so cancellation is no longer safe.
              </span>
            ) : null}
            {compilationCanRetry(run) ? (
              <button
                className="button"
                disabled={busy === 'retry'}
                onClick={() => void retryCompilation()}
                type="button"
              >
                {busy === 'retry' ? 'Retrying…' : 'Retry unchanged input'}
              </button>
            ) : null}
            {run.status === 'failed' && !compilationCanRetry(run) ? (
              <span className="field-help">
                Create and approve a corrected manifest revision before compiling again.
              </span>
            ) : null}
            {run.status === 'succeeded' ? (
              <>
                <Link className="button" href={`/worlds/${worldId}/overview`}>
                  Open World Overview
                </Link>
                <a
                  className="button secondary"
                  download={`world-compilation-${run.id}-artifact.json`}
                  href={`/api/v1/worlds/${worldId}/compilations/${run.id}/artifact`}
                >
                  Download canonical artifact
                </a>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}
