'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import type {
  ApproveManifestRevisionResponse,
  AuthenticatedSession,
  CreateManifestRevisionResponse,
  GetManifestRevisionResponse,
  ManifestDiagnostic,
  ManifestGenerationRunView,
  ManifestRevisionDiffView,
  ManifestRevisionListResponse,
  ManifestRevisionSummary,
  ManifestSuggestedFix,
  ManifestValidationReportView,
  PrimitiveListItem,
  PrimitiveListResponse,
  StartManifestGenerationResponse,
  World,
  WorldCompilationRunView,
  WorldManifestV1,
} from '@worldgraph/contracts';

import { BrowserApiError, mutateJson, requestJson } from '../../../lib/browser-api';
import { CompilePanel } from './compile-panel';
import {
  STUDIO_STAGES,
  approvalReady,
  canonicalManifestJson,
  diagnosticFieldId,
  generationRunForRevision,
  generationStatus,
  manifestEditAllowed,
  nextStage,
  pollDelay,
  replacePrimitivePin,
  sourceOffset,
  stageAvailable,
  stageLabel,
  warningCodes,
  type StudioStage,
} from './studio-model';

interface ManifestStudioProps {
  worldId: string;
}

type SeverityFilter = 'all' | ManifestDiagnostic['severity'];

function friendlyFailure(cause: unknown): string {
  if (cause instanceof BrowserApiError) return `${cause.failure.code}: ${cause.failure.message}`;
  return 'NETWORK_ERROR: The Manifest Studio could not complete that action.';
}

function diagnosticsFromFailure(cause: unknown): ManifestDiagnostic[] {
  if (!(cause instanceof BrowserApiError)) return [];
  const diagnostics = cause.failure.details?.diagnostics;
  if (Array.isArray(diagnostics)) {
    return diagnostics.filter((value): value is ManifestDiagnostic => {
      if (!value || typeof value !== 'object') return false;
      const item = value as Record<string, unknown>;
      return (
        typeof item.code === 'string' &&
        Array.isArray(item.fixes) &&
        typeof item.message === 'string' &&
        typeof item.pointer === 'string' &&
        Array.isArray(item.relatedPointers) &&
        ['error', 'warning', 'info'].includes(String(item.severity))
      );
    });
  }

  const issues = cause.failure.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((value): ManifestDiagnostic[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.code !== 'string' ||
      typeof item.message !== 'string' ||
      typeof item.pointer !== 'string'
    ) {
      return [];
    }
    const line = typeof item.line === 'number' && item.line >= 1 ? item.line : 1;
    const column = typeof item.column === 'number' && item.column >= 1 ? item.column : 1;
    return [
      {
        code: item.code,
        fixes: [],
        location: { column, endColumn: null, endLine: null, line },
        message: item.message,
        pointer: item.pointer,
        relatedPointers: [],
        severity: 'error',
      },
    ];
  });
}

function fixLabel(fix: ManifestSuggestedFix): string {
  if (fix.kind === 'select-primitive') return `Select a published ${fix.primitiveKind} primitive`;
  if (fix.kind === 'remove') return 'Remove this value';
  return `${fix.kind === 'add' ? 'Add' : 'Replace'} this value`;
}

function semanticPath(pointer: string): string {
  if (!pointer) return 'Entire manifest';
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~').replaceAll('-', ' '))
    .join(' › ');
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function terminal(status: ManifestGenerationRunView['status']): boolean {
  return ['cancelled', 'failed', 'succeeded'].includes(status);
}

function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ManifestStudio({ worldId }: ManifestStudioProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const primitivePickerRef = useRef<HTMLSelectElement>(null);
  const yamlRef = useRef<HTMLTextAreaElement>(null);
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [revisions, setRevisions] = useState<ManifestRevisionSummary[] | null>(null);
  const [detail, setDetail] = useState<GetManifestRevisionResponse | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [run, setRun] = useState<ManifestGenerationRunView | null>(null);
  const [stage, setStage] = useState<StudioStage>('describe');
  const [prompt, setPrompt] = useState(
    'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.',
  );
  const [seed, setSeed] = useState('');
  const [regenerateAsChild, setRegenerateAsChild] = useState(true);
  const [yaml, setYaml] = useState('');
  const [dirty, setDirty] = useState(false);
  const [createChildMode, setCreateChildMode] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [ephemeralDiagnostics, setEphemeralDiagnostics] = useState<ManifestDiagnostic[]>([]);
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [compareRevisionId, setCompareRevisionId] = useState('');
  const [diff, setDiff] = useState<ManifestRevisionDiffView | null>(null);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState<Set<string>>(new Set());
  const [confirmationName, setConfirmationName] = useState('');
  const [pickerTargetRef, setPickerTargetRef] = useState('');
  const [pickerOptions, setPickerOptions] = useState<PrimitiveListItem[] | null>(null);
  const [pickerSelectionId, setPickerSelectionId] = useState('');

  const showError = useCallback((cause: unknown) => {
    setError(friendlyFailure(cause));
    setEphemeralDiagnostics(diagnosticsFromFailure(cause));
    requestAnimationFrame(() => errorRef.current?.focus());
  }, []);

  const loadDetail = useCallback(
    async (revisionId: string): Promise<GetManifestRevisionResponse> => {
      const response = await requestJson<GetManifestRevisionResponse>(
        `/api/v1/worlds/${worldId}/manifest-revisions/${revisionId}`,
      );
      const revisionRun = response.revision.generationRunId
        ? await requestJson<ManifestGenerationRunView>(
            `/api/v1/manifest-generations/${response.revision.generationRunId}`,
          )
        : null;
      setSelectedRevisionId(revisionId);
      setDetail(response);
      setRun(revisionRun);
      setYaml(response.yaml);
      setDirty(false);
      setCreateChildMode(false);
      setEphemeralDiagnostics([]);
      setAcknowledgedWarnings(new Set());
      setConfirmationName('');
      setDiff(null);
      setCompareRevisionId(response.revision.parentRevisionId ?? '');
      setPickerTargetRef('');
      setPickerOptions(null);
      setPickerSelectionId('');
      return response;
    },
    [worldId],
  );

  const refreshRevisions = useCallback(
    async (preferredRevisionId?: string | null): Promise<ManifestRevisionSummary[]> => {
      const page = await requestJson<ManifestRevisionListResponse>(
        `/api/v1/worlds/${worldId}/manifest-revisions?limit=100`,
      );
      setRevisions(page.items);
      const candidate =
        preferredRevisionId && page.items.some((item) => item.id === preferredRevisionId)
          ? preferredRevisionId
          : page.items[0]?.id;
      if (candidate) await loadDetail(candidate);
      else {
        setDetail(null);
        setSelectedRevisionId(null);
        setYaml('');
      }
      return page.items;
    },
    [loadDetail, worldId],
  );

  const loadStudio = useCallback(async () => {
    setError('');
    try {
      const [me, worldResponse] = await Promise.all([
        requestJson<AuthenticatedSession>('/api/v1/auth/me'),
        requestJson<{ world: World }>(`/api/v1/worlds/${worldId}`),
      ]);
      setSession(me);
      setWorld(worldResponse.world);
      const pageUrl = new URL(window.location.href);
      const requestedRevisionId = pageUrl.searchParams.get('revision');
      const compilationRunId = pageUrl.searchParams.get('compilation');
      const compilationRun = compilationRunId
        ? await requestJson<WorldCompilationRunView>(
            `/api/v1/worlds/${worldId}/compilations/${compilationRunId}`,
          )
        : null;
      await refreshRevisions(compilationRun?.manifestRevisionId ?? requestedRevisionId);
      const focusPointer = pageUrl.searchParams.get('focus');
      if (requestedRevisionId && focusPointer !== null) {
        setStage('draft');
        requestAnimationFrame(() =>
          document.getElementById(diagnosticFieldId(focusPointer))?.focus(),
        );
      }
      if (compilationRun) setStage('approve');
      const runId = pageUrl.searchParams.get('run');
      if (runId) {
        const recovered = await requestJson<ManifestGenerationRunView>(
          `/api/v1/manifest-generations/${runId}`,
        );
        setRun(recovered);
        setStatus(generationStatus(recovered));
        if (recovered.outputRevisionId) {
          await refreshRevisions(recovered.outputRevisionId);
          setStage('draft');
        }
      }
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/manifest`)}`);
        return;
      }
      showError(cause);
    }
  }, [refreshRevisions, router, showError, worldId]);

  useEffect(() => void loadStudio(), [loadStudio]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  useEffect(() => {
    if (pickerOptions && pickerOptions.length > 0) primitivePickerRef.current?.focus();
  }, [pickerOptions]);

  const activeRunId = run && !terminal(run.status) ? run.id : null;

  useEffect(() => {
    if (!activeRunId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollCount = 0;
    const poll = async (): Promise<void> => {
      try {
        const current = await requestJson<ManifestGenerationRunView>(
          `/api/v1/manifest-generations/${activeRunId}`,
        );
        if (disposed) return;
        setRun(current);
        setStatus(generationStatus(current));
        if (current.status === 'succeeded' && current.outputRevisionId) {
          await refreshRevisions(current.outputRevisionId);
          setStage('draft');
          return;
        }
        if (terminal(current.status)) return;
        pollCount += 1;
        timer = setTimeout(() => void poll(), pollDelay(pollCount, document.visibilityState));
      } catch (cause) {
        if (!disposed) showError(cause);
      }
    };
    timer = setTimeout(() => void poll(), pollDelay(0, document.visibilityState));
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeRunId, refreshRevisions, showError]);

  const canEdit = manifestEditAllowed(world);
  const report = detail?.report ?? null;
  const allDiagnostics = report?.diagnostics ?? ephemeralDiagnostics;
  const filteredDiagnostics = allDiagnostics.filter(
    (diagnostic) => severity === 'all' || diagnostic.severity === severity,
  );
  const requiredWarnings = warningCodes(report?.diagnostics ?? []);
  const generationDisabled = error.startsWith('MANIFEST_GENERATION_DISABLED:');
  const isApprovalReady = approvalReady({
    acknowledgedCodes: acknowledgedWarnings,
    confirmationName,
    detail,
    world,
  });
  const selectedRevision = detail?.revision ?? null;
  const reviewRun = generationRunForRevision(run, detail);
  const editorReadOnly =
    !canEdit || (selectedRevision?.approvalStatus === 'approved' && !createChildMode);
  const pickerTarget = detail?.revision.manifest.primitiveRefs.find(
    (primitive) => primitive.ref === pickerTargetRef,
  );
  const pickerSelection = pickerOptions?.find((option) => option.id === pickerSelectionId);

  async function startGeneration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    setBusy('generate');
    setError('');
    setEphemeralDiagnostics([]);
    try {
      const body =
        regenerateAsChild && selectedRevision
          ? {
              expectedParentContentHash: selectedRevision.contentHash,
              parentRevisionId: selectedRevision.id,
              prompt,
              ...(seed ? { seed } : {}),
            }
          : { prompt, ...(seed ? { seed } : {}) };
      const started = await mutateJson<StartManifestGenerationResponse>(
        `/api/v1/worlds/${worldId}/manifest-generations`,
        'POST',
        body,
      );
      const current = await requestJson<ManifestGenerationRunView>(
        `/api/v1/manifest-generations/${started.runId}`,
      );
      setRun(current);
      setStatus(generationStatus(current));
      const url = new URL(window.location.href);
      url.searchParams.set('run', started.runId);
      window.history.replaceState(null, '', url);
      if (current.status === 'succeeded' && current.outputRevisionId) {
        await refreshRevisions(current.outputRevisionId);
        setStage('draft');
      }
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy('');
    }
  }

  async function cancelGeneration() {
    if (!run || terminal(run.status)) return;
    setBusy('cancel');
    try {
      const cancelled = await mutateJson<ManifestGenerationRunView>(
        `/api/v1/manifest-generations/${run.id}/cancel`,
        'POST',
        { expectedRowVersion: run.rowVersion },
      );
      setRun(cancelled);
      setStatus(generationStatus(cancelled));
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy('');
    }
  }

  async function createChild(
    format: 'json' | 'yaml',
    jsonOrYaml: string | WorldManifestV1,
  ): Promise<void> {
    if (!selectedRevision || !canEdit) return;
    setBusy('save');
    setError('');
    setEphemeralDiagnostics([]);
    try {
      const created = await mutateJson<CreateManifestRevisionResponse>(
        `/api/v1/worlds/${worldId}/manifest-revisions`,
        'POST',
        {
          baseRevisionId: selectedRevision.id,
          expectedHash: selectedRevision.contentHash,
          format,
          jsonOrYaml,
        },
      );
      await refreshRevisions(created.revision.id);
      setStatus(`Revision ${created.revision.revisionNumber} created as an immutable child.`);
      setStage('validate');
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy('');
    }
  }

  async function saveYaml(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createChild('yaml', yaml);
  }

  async function saveStructured(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const data = new FormData(event.currentTarget);
    const manifest = structuredClone(detail.revision.manifest);
    const name = data.get('name');
    const description = data.get('description');
    const visualDirection = data.get('visualDirection');
    if (typeof name === 'string') manifest.metadata.name = name;
    if (typeof description === 'string') manifest.metadata.description = description;
    if (typeof visualDirection === 'string') manifest.visual.direction = visualDirection;
    await createChild('json', manifest);
  }

  async function openPrimitivePicker(
    primitive: WorldManifestV1['primitiveRefs'][number],
  ): Promise<void> {
    setPickerTargetRef(primitive.ref);
    setPickerOptions(null);
    setPickerSelectionId('');
    setBusy('picker');
    setError('');
    try {
      const query = new URLSearchParams({
        kinds: primitive.kind,
        lifecycle: 'published',
        limit: '100',
      });
      const response = await requestJson<PrimitiveListResponse>(`/api/v1/primitives?${query}`);
      const options = response.items.filter(
        (candidate) => candidate.kind === primitive.kind && candidate.lifecycle === 'published',
      );
      setPickerOptions(options);
      setPickerSelectionId(
        options.some((candidate) => candidate.id === primitive.primitiveVersionId)
          ? primitive.primitiveVersionId
          : (options[0]?.id ?? ''),
      );
    } catch (cause) {
      setPickerOptions([]);
      showError(cause);
    } finally {
      setBusy('');
    }
  }

  async function applyPrimitivePin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!detail || !pickerSelection || !pickerTarget) return;
    const manifest = replacePrimitivePin(
      detail.revision.manifest,
      pickerTarget.ref,
      pickerSelection,
    );
    await createChild('json', manifest);
  }

  async function validateRevision() {
    if (!selectedRevision) return;
    setBusy('validate');
    setError('');
    try {
      const response = await mutateJson<{ report: ManifestValidationReportView }>(
        `/api/v1/worlds/${worldId}/manifest-revisions/${selectedRevision.id}/validate`,
        'POST',
        { expectedContentHash: selectedRevision.contentHash },
      );
      setDetail((current) => (current ? { ...current, report: response.report } : current));
      setStatus(
        response.report.valid
          ? 'Validation passed. Review every warning before approval.'
          : 'Validation found blocking errors. The revision was not changed.',
      );
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy('');
    }
  }

  async function loadDiff(cursor?: string) {
    if (!selectedRevision || !compareRevisionId) return;
    const continuing = cursor !== undefined;
    setBusy(continuing ? 'diff-more' : 'diff');
    setError('');
    try {
      const query = new URLSearchParams({
        fromRevisionId: compareRevisionId,
        limit: '100',
        toRevisionId: selectedRevision.id,
      });
      if (cursor) query.set('cursor', cursor);
      const page = await requestJson<ManifestRevisionDiffView>(
        `/api/v1/worlds/${worldId}/manifest-revisions/diff?${query.toString()}`,
      );
      setDiff((current) =>
        continuing &&
        current?.fromRevisionId === page.fromRevisionId &&
        current.toRevisionId === page.toRevisionId
          ? { ...page, entries: [...current.entries, ...page.entries] }
          : page,
      );
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy('');
    }
  }

  async function approveRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRevision || !world || !isApprovalReady) return;
    setBusy('approve');
    setError('');
    try {
      const approved = await mutateJson<ApproveManifestRevisionResponse>(
        `/api/v1/worlds/${worldId}/manifest-revisions/${selectedRevision.id}/approve`,
        'POST',
        {
          acknowledgedWarningCodes: [...acknowledgedWarnings].sort(),
          confirmationName,
          expectedContentHash: selectedRevision.contentHash,
          expectedWorldVersion: world.rowVersion,
        },
      );
      const worldResponse = await requestJson<{ world: World }>(`/api/v1/worlds/${worldId}`);
      setWorld(worldResponse.world);
      await refreshRevisions(approved.revisionId);
      setStatus('Manifest approved. This revision is now read-only; no runtime state was created.');
      setStage('approve');
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy('');
    }
  }

  async function chooseRevision(revisionId: string) {
    if (revisionId === selectedRevisionId) return;
    if (dirty && !window.confirm('Discard the unsaved YAML changes and open another revision?')) {
      return;
    }
    try {
      await loadDetail(revisionId);
    } catch (cause) {
      showError(cause);
    }
  }

  function focusDiagnostic(diagnostic: ManifestDiagnostic) {
    setStage('draft');
    requestAnimationFrame(() => {
      const targetId = diagnosticFieldId(diagnostic.pointer);
      const target = document.getElementById(targetId);
      target?.focus();
      if (targetId === 'manifest-yaml-editor' && yamlRef.current) {
        const offset = sourceOffset(yaml, diagnostic.location);
        yamlRef.current.setSelectionRange(offset, offset);
      }
    });
  }

  function handleStageKey(event: KeyboardEvent<HTMLButtonElement>, current: StudioStage) {
    let direction: 'end' | 'home' | 'next' | 'previous' | null = null;
    if (event.key === 'ArrowRight') direction = 'next';
    if (event.key === 'ArrowLeft') direction = 'previous';
    if (event.key === 'Home') direction = 'home';
    if (event.key === 'End') direction = 'end';
    if (!direction) return;
    event.preventDefault();
    const target = nextStage(current, direction, detail);
    setStage(target);
    requestAnimationFrame(() => document.getElementById(`manifest-tab-${target}`)?.focus());
  }

  if (!world || revisions === null) {
    return (
      <main className="app-page shell wide-shell" id="main-content">
        <header className="app-header">
          <Link className="brand-link" href={`/worlds/${worldId}`}>
            ← World
          </Link>
        </header>
        <section aria-busy="true" aria-label="Loading Manifest Studio" className="studio-loading">
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </section>
        {error ? (
          <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
            {error}
            <button className="button secondary" onClick={() => void loadStudio()} type="button">
              Try again
            </button>
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <main className="app-page shell wide-shell manifest-studio" id="main-content">
      <header className="app-header catalog-header">
        <Link className="brand-link" href={`/worlds/${worldId}`}>
          ← {world.name}
        </Link>
        <nav aria-label="Manifest resources">
          <Link className="text-link" href="/primitives">
            Primitive catalog
          </Link>
          <span>{session?.user.displayName ?? session?.user.email}</span>
        </nav>
      </header>

      <div className="page-heading manifest-heading">
        <div>
          <p className="eyebrow">Declarative intent · schema v1</p>
          <h1>Manifest Studio</h1>
          <p className="lede compact">
            Describe, inspect, validate, and explicitly approve the city-state blueprint. Nothing
            here creates runtime entities or starts simulation.
          </p>
        </div>
        <span
          className={`manifest-state ${world.currentApprovedManifestRevisionId ? 'approved' : 'draft'}`}
        >
          {world.currentApprovedManifestRevisionId ? 'Manifest approved' : 'No approved manifest'}
        </span>
      </div>

      <nav aria-label="Manifest stages" className="studio-stage-tabs" role="tablist">
        {STUDIO_STAGES.map((item, index) => {
          const available = stageAvailable(item, detail);
          return (
            <button
              aria-controls={`manifest-panel-${item}`}
              aria-selected={stage === item}
              disabled={!available}
              id={`manifest-tab-${item}`}
              key={item}
              onClick={() => setStage(item)}
              onKeyDown={(event) => handleStageKey(event, item)}
              role="tab"
              tabIndex={stage === item ? 0 : -1}
              type="button"
            >
              <span>{index + 1}</span>
              {stageLabel(item)}
            </button>
          );
        })}
      </nav>

      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Action needed</strong>
          <p>{error}</p>
          {error.includes('STALE') || error.includes('CONFLICT') ? (
            <button className="button secondary" onClick={() => void loadStudio()} type="button">
              Reload current state
            </button>
          ) : null}
        </div>
      ) : null}
      <p aria-atomic="true" aria-live="polite" className="studio-live-status">
        {status}
      </p>

      <div className="studio-layout">
        <aside aria-label="Manifest version history" className="studio-history">
          <div className="studio-history-heading">
            <h2>Versions</h2>
            <span>{revisions.length}</span>
          </div>
          {revisions.length === 0 ? (
            <p className="field-help">Your first generated or edited draft will appear here.</p>
          ) : (
            <ol className="revision-list">
              {revisions.map((revision) => (
                <li key={revision.id}>
                  <button
                    aria-current={selectedRevisionId === revision.id ? 'true' : undefined}
                    onClick={() => void chooseRevision(revision.id)}
                    type="button"
                  >
                    <span>
                      Revision {revision.revisionNumber}
                      <small>{revision.source}</small>
                    </span>
                    <span className={`revision-status ${revision.approvalStatus}`}>
                      {revision.approvalStatus}
                    </span>
                    <code>{shortHash(revision.contentHash)}</code>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>

        <div className="studio-workspace">
          {stage === 'describe' ? (
            <section
              aria-labelledby="manifest-tab-describe"
              className="studio-panel"
              id="manifest-panel-describe"
              role="tabpanel"
            >
              <div className="studio-panel-heading">
                <div>
                  <p className="eyebrow">Start with intent</p>
                  <h2>Describe the city-state</h2>
                </div>
                <span className="privacy-chip">Prompt retained for a limited period</span>
              </div>
              <p className="field-help">
                Generation uses exact published primitive versions. Provider output is constrained,
                locally validated, and replaced by a deterministic fallback when unavailable.
              </p>
              {generationDisabled ? (
                <div className="degraded-notice" role="status">
                  Generation is disabled in this deployment, so no provider request or fallback run
                  was queued. Existing revisions remain available for review; ask an operator to
                  enable manifest generation before creating a new draft.
                </div>
              ) : null}
              <form
                className="form-stack studio-describe-form"
                onSubmit={(event) => void startGeneration(event)}
              >
                <label>
                  Short description
                  <textarea
                    aria-describedby="prompt-help prompt-count"
                    maxLength={2_000}
                    minLength={10}
                    onChange={(event) => setPrompt(event.target.value)}
                    required
                    rows={7}
                    value={prompt}
                  />
                </label>
                <div className="field-meta">
                  <span id="prompt-help">Do not include secrets or personal data.</span>
                  <span id="prompt-count">{prompt.length} / 2,000</span>
                </div>
                <label>
                  Reproducible seed <span className="field-help">optional</span>
                  <input
                    maxLength={128}
                    onChange={(event) => setSeed(event.target.value)}
                    pattern="[A-Za-z0-9._:-]+"
                    placeholder="Derived automatically when blank"
                    value={seed}
                  />
                </label>
                {selectedRevision ? (
                  <label className="checkbox-row studio-checkbox">
                    <input
                      checked={regenerateAsChild}
                      onChange={(event) => setRegenerateAsChild(event.target.checked)}
                      type="checkbox"
                    />
                    Create the result as a child of revision {selectedRevision.revisionNumber}
                  </label>
                ) : null}
                <div className="actions">
                  <button
                    className="button"
                    disabled={
                      !canEdit || generationDisabled || busy !== '' || prompt.trim().length < 10
                    }
                    type="submit"
                  >
                    {busy === 'generate'
                      ? 'Queueing…'
                      : selectedRevision
                        ? 'Regenerate draft'
                        : 'Generate draft'}
                  </button>
                  {!canEdit ? (
                    <span className="field-help">Your role can review but cannot generate.</span>
                  ) : null}
                </div>
              </form>

              {run ? (
                <section aria-label="Generation progress" className="generation-card">
                  <div className="generation-heading">
                    <div>
                      <strong>{generationStatus(run)}</strong>
                      <span>
                        {run.provider ?? 'Provider pending'} · {run.model ?? 'Model pending'}
                      </span>
                    </div>
                    <span className={`run-status ${run.status}`}>{run.status}</span>
                  </div>
                  <progress
                    aria-label="Generation progress"
                    max={100}
                    value={run.progressPercent}
                  />
                  <dl className="generation-facts">
                    <div>
                      <dt>Stage</dt>
                      <dd>{run.stage}</dd>
                    </div>
                    <div>
                      <dt>Repairs</dt>
                      <dd>{run.repairAttempts} / 2</dd>
                    </div>
                    <div>
                      <dt>Provider calls</dt>
                      <dd>{run.providerCallCount}</dd>
                    </div>
                    <div>
                      <dt>Mode</dt>
                      <dd>{run.outcome?.mode ?? 'pending'}</dd>
                    </div>
                  </dl>
                  {run.outcome?.mode === 'fallback' ? (
                    <div className="degraded-notice">
                      The provider was unavailable or unsuitable, so the reviewed deterministic
                      city-state template produced this draft. Its limitations remain visible in
                      Review.
                    </div>
                  ) : null}
                  {!terminal(run.status) && canEdit ? (
                    <button
                      className="button secondary"
                      disabled={busy === 'cancel'}
                      onClick={() => void cancelGeneration()}
                      type="button"
                    >
                      {busy === 'cancel' ? 'Cancelling…' : 'Cancel generation'}
                    </button>
                  ) : null}
                </section>
              ) : null}
            </section>
          ) : null}

          {stage === 'draft' && detail ? (
            <section
              aria-labelledby="manifest-tab-draft"
              className="studio-panel"
              id="manifest-panel-draft"
              role="tabpanel"
            >
              <div className="studio-panel-heading">
                <div>
                  <p className="eyebrow">Revision {detail.revision.revisionNumber}</p>
                  <h2>Inspect and edit the draft</h2>
                </div>
                <span className={`revision-status ${detail.revision.approvalStatus}`}>
                  {detail.revision.approvalStatus}
                </span>
              </div>
              <div className="immutable-notice">
                Saving always creates an immutable child revision. Existing content and provenance
                are never overwritten.
              </div>

              <details className="structured-editor" open>
                <summary>Essential fields</summary>
                <form className="form-stack" onSubmit={(event) => void saveStructured(event)}>
                  <label>
                    Manifest name
                    <input
                      defaultValue={detail.revision.manifest.metadata.name}
                      disabled={editorReadOnly}
                      id="manifest-name"
                      maxLength={100}
                      minLength={2}
                      name="name"
                      required
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      defaultValue={detail.revision.manifest.metadata.description}
                      disabled={editorReadOnly}
                      id="manifest-description"
                      maxLength={1_000}
                      name="description"
                      required
                    />
                  </label>
                  <label>
                    Visual direction
                    <textarea
                      defaultValue={detail.revision.manifest.visual.direction}
                      disabled={editorReadOnly}
                      id="manifest-visual-direction"
                      maxLength={500}
                      name="visualDirection"
                      required
                    />
                  </label>
                  {!editorReadOnly ? (
                    <button className="button" disabled={busy === 'save'} type="submit">
                      Save essential fields as child
                    </button>
                  ) : null}
                </form>
              </details>

              <div className="blueprint-summary">
                <article>
                  <strong>{detail.revision.manifest.districts.length}</strong>
                  <span>districts</span>
                </article>
                <article>
                  <strong>{detail.revision.manifest.institutions.length}</strong>
                  <span>institutions</span>
                </article>
                <article>
                  <strong>{detail.revision.manifest.organizations.length}</strong>
                  <span>organizations</span>
                </article>
                <article>
                  <strong>{detail.revision.manifest.actors.length}</strong>
                  <span>actor blueprints</span>
                </article>
              </div>

              <details className="primitive-pins">
                <summary>
                  Exact primitive selections ({detail.revision.manifest.primitiveRefs.length})
                </summary>
                <div className="pin-table" role="list">
                  {detail.revision.manifest.primitiveRefs.map((primitive) => (
                    <div key={primitive.ref} role="listitem">
                      <span>
                        <strong>{primitive.ref}</strong>
                        <small>{primitive.kind.replaceAll('_', ' ')}</small>
                      </span>
                      <Link
                        className="text-link"
                        href={`/primitives/${encodeURIComponent(primitive.key)}/versions/${encodeURIComponent(primitive.version)}`}
                      >
                        {primitive.key}@{primitive.version}
                      </Link>
                      <code title={primitive.contentHash}>{shortHash(primitive.contentHash)}</code>
                      {!editorReadOnly ? (
                        <button
                          className="text-button"
                          disabled={busy !== ''}
                          onClick={() => void openPrimitivePicker(primitive)}
                          type="button"
                        >
                          Change exact version…
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </details>

              {pickerTarget ? (
                <form
                  className="primitive-picker"
                  onSubmit={(event) => void applyPrimitivePin(event)}
                >
                  <div className="studio-panel-heading">
                    <div>
                      <p className="eyebrow">Exact-version replacement</p>
                      <h3>Change {pickerTarget.ref}</h3>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => {
                        setPickerTargetRef('');
                        setPickerOptions(null);
                        setPickerSelectionId('');
                      }}
                      type="button"
                    >
                      Close picker
                    </button>
                  </div>
                  <p>
                    Only published <strong>{pickerTarget.kind.replaceAll('_', ' ')}</strong>{' '}
                    primitives are eligible. Existing parameters are preserved visibly; validation
                    will flag any incompatibility instead of changing them silently.
                  </p>
                  {pickerOptions === null ? (
                    <p aria-live="polite" className="field-help">
                      Loading published exact versions…
                    </p>
                  ) : pickerOptions.length === 0 ? (
                    <div className="empty-state compact-empty">
                      No published replacements of this primitive kind are available.
                    </div>
                  ) : (
                    <>
                      <label htmlFor="manifest-primitive-picker">
                        Published replacement
                        <select
                          id="manifest-primitive-picker"
                          onChange={(event) => setPickerSelectionId(event.target.value)}
                          ref={primitivePickerRef}
                          value={pickerSelectionId}
                        >
                          {pickerOptions.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.displayName} · {candidate.key}@{candidate.version}
                            </option>
                          ))}
                        </select>
                      </label>
                      {pickerSelection ? (
                        <div className="picker-selection">
                          <Link
                            className="text-link"
                            href={`/primitives/${encodeURIComponent(pickerSelection.key)}/versions/${encodeURIComponent(pickerSelection.version)}`}
                          >
                            Inspect {pickerSelection.key}@{pickerSelection.version}
                          </Link>
                          <code title={pickerSelection.contentHash}>
                            {shortHash(pickerSelection.contentHash)}
                          </code>
                        </div>
                      ) : null}
                      <button
                        className="button"
                        disabled={
                          !pickerSelection ||
                          pickerSelection.id === pickerTarget.primitiveVersionId ||
                          busy === 'save'
                        }
                        type="submit"
                      >
                        Create child with this exact pin
                      </button>
                    </>
                  )}
                </form>
              ) : null}

              {editorReadOnly ? (
                <div className="approved-readonly">
                  <strong>This approved revision is read-only.</strong>
                  <p>Create a child to propose changes without altering the approved version.</p>
                  {canEdit ? (
                    <button
                      className="button"
                      onClick={() => setCreateChildMode(true)}
                      type="button"
                    >
                      Create editable child
                    </button>
                  ) : null}
                </div>
              ) : (
                <form className="yaml-form" onSubmit={(event) => void saveYaml(event)}>
                  <label htmlFor="manifest-yaml-editor">
                    Safe YAML
                    <span>
                      Aliases, tags, merge keys, duplicate keys, URLs, and executable content are
                      rejected.
                    </span>
                  </label>
                  <textarea
                    aria-describedby="yaml-help"
                    id="manifest-yaml-editor"
                    maxLength={131_072}
                    onChange={(event) => {
                      setYaml(event.target.value);
                      setDirty(true);
                    }}
                    ref={yamlRef}
                    rows={28}
                    spellCheck={false}
                    value={yaml}
                  />
                  <div className="field-meta" id="yaml-help">
                    <span>{dirty ? 'Unsaved changes' : 'Matches the selected revision'}</span>
                    <span>
                      {new TextEncoder().encode(yaml).byteLength.toLocaleString()} / 131,072 bytes
                    </span>
                  </div>
                  <button className="button" disabled={!dirty || busy === 'save'} type="submit">
                    {busy === 'save' ? 'Creating child…' : 'Create child revision from YAML'}
                  </button>
                </form>
              )}
            </section>
          ) : null}

          {stage === 'validate' && detail ? (
            <section
              aria-labelledby="manifest-tab-validate"
              className="studio-panel"
              id="manifest-panel-validate"
              role="tabpanel"
            >
              <div className="studio-panel-heading">
                <div>
                  <p className="eyebrow">Layered checks</p>
                  <h2>Validate this exact revision</h2>
                </div>
                {report ? (
                  <span className={`validation-state ${report.valid ? 'valid' : 'invalid'}`}>
                    {report.valid ? 'Valid' : 'Blocked'}
                  </span>
                ) : (
                  <span className="validation-state pending">Not validated</span>
                )}
              </div>
              <p>
                Validation checks schema, exact primitive pins and parameters, dependency and
                compatibility closure, critical mechanics, local references, and district
                connectivity. It never changes the manifest silently.
              </p>
              <button
                className="button"
                disabled={!canEdit || busy === 'validate'}
                onClick={() => void validateRevision()}
                type="button"
              >
                {busy === 'validate'
                  ? 'Validating…'
                  : report
                    ? 'Validate again'
                    : 'Validate revision'}
              </button>

              {allDiagnostics.length > 0 ? (
                <div className="diagnostics-panel">
                  <div className="diagnostic-toolbar">
                    <h3>{allDiagnostics.length} diagnostics</h3>
                    <label>
                      Show
                      <select
                        onChange={(event) => setSeverity(event.target.value as SeverityFilter)}
                        value={severity}
                      >
                        <option value="all">All severities</option>
                        <option value="error">Errors</option>
                        <option value="warning">Warnings</option>
                        <option value="info">Information</option>
                      </select>
                    </label>
                  </div>
                  <ol className="diagnostic-list">
                    {filteredDiagnostics.map((diagnostic, index) => (
                      <li
                        className={`diagnostic-${diagnostic.severity}`}
                        key={`${diagnostic.code}-${diagnostic.pointer}-${index}`}
                      >
                        <div>
                          <span>{diagnostic.severity}</span>
                          <strong>{diagnostic.code}</strong>
                        </div>
                        <p>{diagnostic.message}</p>
                        <small>
                          {semanticPath(diagnostic.pointer)}
                          {diagnostic.location
                            ? ` · line ${diagnostic.location.line}, column ${diagnostic.location.column}`
                            : ''}
                        </small>
                        {diagnostic.fixes.length > 0 ? (
                          <ul className="fix-list">
                            {diagnostic.fixes.map((fix, fixIndex) => (
                              <li key={`${fix.kind}-${fixIndex}`}>
                                {fixLabel(fix)} — {fix.rationale}
                                {fix.kind === 'select-primitive' ? (
                                  <Link
                                    className="text-link"
                                    href={`/primitives?kinds=${fix.primitiveKind}`}
                                  >
                                    Open exact-version picker
                                  </Link>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <button
                          className="text-button"
                          onClick={() => focusDiagnostic(diagnostic)}
                          type="button"
                        >
                          Focus in editor
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : report ? (
                <div className="success-panel compact-success">
                  <h3>No validation diagnostics</h3>
                  <p>This exact content hash is ready for review.</p>
                </div>
              ) : (
                <div className="empty-state compact-empty">
                  <p>No validation report exists for this revision yet.</p>
                </div>
              )}
            </section>
          ) : null}

          {stage === 'review' && detail ? (
            <section
              aria-labelledby="manifest-tab-review"
              className="studio-panel"
              id="manifest-panel-review"
              role="tabpanel"
            >
              <div className="studio-panel-heading">
                <div>
                  <p className="eyebrow">Human review</p>
                  <h2>Understand what will be approved</h2>
                </div>
                <div className="download-actions">
                  <button
                    className="button secondary"
                    onClick={() =>
                      download(
                        `${world.slug}-manifest-r${detail.revision.revisionNumber}.json`,
                        canonicalManifestJson(detail.revision.manifest),
                        'application/json',
                      )
                    }
                    type="button"
                  >
                    Download JSON
                  </button>
                  <button
                    className="button secondary"
                    onClick={() =>
                      download(
                        `${world.slug}-manifest-r${detail.revision.revisionNumber}.yaml`,
                        detail.yaml,
                        'application/yaml',
                      )
                    }
                    type="button"
                  >
                    Download YAML
                  </button>
                </div>
              </div>

              <section className="review-section">
                <h3>Assumptions</h3>
                <ul>
                  {detail.revision.manifest.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </section>

              {reviewRun?.outcome ? (
                <div className="review-grid">
                  <section className="review-section">
                    <h3>Generation warnings</h3>
                    {reviewRun.outcome.warnings.length === 0 ? (
                      <p>No generation warnings.</p>
                    ) : (
                      <ul className="warning-list">
                        {reviewRun.outcome.warnings.map((warning) => (
                          <li key={`${warning.code}-${warning.pointer}`}>
                            <strong>{warning.code}</strong> — {warning.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section className="review-section">
                    <h3>Unresolved questions</h3>
                    {reviewRun.outcome.unresolvedQuestions.length === 0 ? (
                      <p>No unresolved generation questions.</p>
                    ) : (
                      <ul>
                        {reviewRun.outcome.unresolvedQuestions.map((question) => (
                          <li key={question}>{question}</li>
                        ))}
                      </ul>
                    )}
                  </section>
                  {reviewRun.outcome.suggestedFixes.length > 0 ? (
                    <section className="review-section full-span">
                      <h3>Suggested fixes</h3>
                      <ul>
                        {reviewRun.outcome.suggestedFixes.map((fix, index) => (
                          <li key={`${fix.kind}-${fix.pointer}-${index}`}>
                            {fixLabel(fix)} at {semanticPath(fix.pointer)} — {fix.rationale}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              ) : null}

              <details className="provenance-panel">
                <summary>Field provenance ({detail.provenance.entries.length})</summary>
                <ul>
                  {detail.provenance.entries.map((entry, index) => (
                    <li key={`${entry.pointer}-${entry.sourceType}-${entry.sourceRef}-${index}`}>
                      <span className="role-badge">{entry.sourceType}</span>
                      <span>{semanticPath(entry.pointer)}</span>
                      <code>{entry.sourceRef}</code>
                      <code title={entry.sourceHash}>{shortHash(entry.sourceHash)}</code>
                    </li>
                  ))}
                </ul>
              </details>

              <section className="review-section diff-section">
                <h3>Revision comparison</h3>
                {revisions.length < 2 ? (
                  <p className="field-help">Create another revision to compare changes.</p>
                ) : (
                  <div className="diff-controls">
                    <label>
                      Compare from
                      <select
                        onChange={(event) => {
                          setCompareRevisionId(event.target.value);
                          setDiff(null);
                        }}
                        value={compareRevisionId}
                      >
                        <option value="">Choose a revision</option>
                        {revisions
                          .filter((revision) => revision.id !== detail.revision.id)
                          .map((revision) => (
                            <option key={revision.id} value={revision.id}>
                              Revision {revision.revisionNumber} · {revision.approvalStatus}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      className="button secondary"
                      disabled={!compareRevisionId || busy === 'diff'}
                      onClick={() => void loadDiff()}
                      type="button"
                    >
                      {busy === 'diff' ? 'Comparing…' : 'Compare'}
                    </button>
                  </div>
                )}
                {diff ? (
                  <div className="diff-results">
                    <div className="diff-counts">
                      <span>+{diff.counts.added} added</span>
                      <span>~{diff.counts.changed} changed</span>
                      <span>−{diff.counts.removed} removed</span>
                    </div>
                    {diff.entries.length === 0 ? (
                      <p>The canonical documents are identical.</p>
                    ) : (
                      <ol>
                        {diff.entries.map((entry, index) => (
                          <li key={`${entry.kind}-${entry.pointer}-${index}`}>
                            <span className={`diff-kind ${entry.kind}`}>{entry.kind}</span>
                            <strong>{semanticPath(entry.pointer)}</strong>
                            {'before' in entry ? (
                              <code>Before: {JSON.stringify(entry.before)}</code>
                            ) : null}
                            {'after' in entry ? (
                              <code>After: {JSON.stringify(entry.after)}</code>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    )}
                    {diff.nextCursor ? (
                      <button
                        className="button secondary diff-load-more"
                        disabled={busy === 'diff-more'}
                        onClick={() => void loadDiff(diff.nextCursor ?? undefined)}
                        type="button"
                      >
                        {busy === 'diff-more' ? 'Loading more…' : 'Load more changes'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </section>
          ) : null}

          {stage === 'approve' && detail ? (
            <section
              aria-labelledby="manifest-tab-approve"
              className="studio-panel approval-panel"
              id="manifest-panel-approve"
              role="tabpanel"
            >
              <div className="studio-panel-heading">
                <div>
                  <p className="eyebrow">Explicit creator decision</p>
                  <h2>
                    {detail.revision.approvalStatus === 'approved'
                      ? 'Approved manifest'
                      : 'Approve this revision'}
                  </h2>
                </div>
                <span className={`revision-status ${detail.revision.approvalStatus}`}>
                  {detail.revision.approvalStatus}
                </span>
              </div>
              <dl className="approval-facts">
                <div>
                  <dt>Revision</dt>
                  <dd>{detail.revision.revisionNumber}</dd>
                </div>
                <div>
                  <dt>Schema</dt>
                  <dd>WorldManifest v{detail.revision.manifestSchemaVersion}</dd>
                </div>
                <div>
                  <dt>Content hash</dt>
                  <dd>
                    <code>{detail.revision.contentHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>Validation</dt>
                  <dd>{report?.valid ? 'Valid' : 'Not ready'}</dd>
                </div>
              </dl>

              {detail.revision.approvalStatus === 'approved' ? (
                <div className="approved-readonly">
                  <h3>Declarative intent approved</h3>
                  <p>
                    This canonical content, hash, and provenance are immutable. Runtime compilation
                    is a separate creator action and never occurs automatically on approval.
                  </p>
                  {canEdit ? (
                    <button
                      className="button"
                      onClick={() => {
                        setCreateChildMode(true);
                        setStage('draft');
                      }}
                      type="button"
                    >
                      Create child revision
                    </button>
                  ) : null}
                  <CompilePanel
                    detail={detail}
                    key={detail.revision.id}
                    onFailure={showError}
                    world={world}
                    worldId={worldId}
                  />
                </div>
              ) : world.role !== 'creator' ? (
                <div className="denial-panel manifest-denial">
                  <h3>Creator approval required</h3>
                  <p>
                    Administrators may generate, edit, and validate manifests. Only the world
                    creator can approve declarative intent.
                  </p>
                </div>
              ) : !report?.valid ? (
                <div className="error-summary">
                  This exact revision must have a current, fully valid report before approval.
                  <button
                    className="text-button"
                    onClick={() => setStage('validate')}
                    type="button"
                  >
                    Go to validation
                  </button>
                </div>
              ) : (
                <form
                  className="form-stack approval-form"
                  onSubmit={(event) => void approveRevision(event)}
                >
                  {requiredWarnings.length > 0 ? (
                    <fieldset>
                      <legend>Acknowledge every current warning</legend>
                      {requiredWarnings.map((code) => (
                        <label className="checkbox-row studio-checkbox" key={code}>
                          <input
                            checked={acknowledgedWarnings.has(code)}
                            onChange={(event) => {
                              setAcknowledgedWarnings((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(code);
                                else next.delete(code);
                                return next;
                              });
                            }}
                            type="checkbox"
                          />
                          <span>
                            <strong>{code}</strong> — I reviewed this warning.
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <p className="success-message">
                      There are no validation warnings to acknowledge.
                    </p>
                  )}
                  <label>
                    Type <strong>{world.name}</strong> to confirm
                    <input
                      autoComplete="off"
                      onChange={(event) => setConfirmationName(event.target.value)}
                      required
                      value={confirmationName}
                    />
                  </label>
                  <div className="approval-warning">
                    Approval makes this revision the world’s current immutable manifest. It still
                    does not compile, activate, or simulate the world.
                  </div>
                  <button
                    className="button"
                    disabled={!isApprovalReady || busy === 'approve'}
                    type="submit"
                  >
                    {busy === 'approve' ? 'Approving…' : 'Approve exact revision'}
                  </button>
                </form>
              )}
            </section>
          ) : null}

          {stage !== 'describe' && !detail ? (
            <section className="empty-state studio-panel">
              <h2>No manifest revision yet</h2>
              <p>Describe this city-state to generate the first bounded draft.</p>
              <button className="button" onClick={() => setStage('describe')} type="button">
                Start describing
              </button>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
