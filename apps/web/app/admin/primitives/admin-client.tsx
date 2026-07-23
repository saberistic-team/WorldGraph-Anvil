'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type { AuthenticatedSession } from '@worldgraph/contracts';

import { BrowserApiError, mutateJson, requestJson } from '../../lib/browser-api';
import { sanitizedIndexError } from '../../primitives/diagnostics';
import {
  adminPrimitivePath,
  primitiveKinds,
  type PrimitiveIndexState,
  type PrimitiveKind,
  type PrimitiveListItem,
  type PrimitiveVersion,
  type ValidationIssue,
  unwrapPrimitive,
} from '../../primitives/types';
import { fieldId } from './validation-focus';

interface CatalogPage {
  items: PrimitiveListItem[];
  nextCursor: string | null;
}

interface DraftValidationReport {
  contentHash: string | null;
  issues: ValidationIssue[];
  valid: boolean;
}

interface DependencyEditor {
  key: string;
  parameterMapping: string;
  required: boolean;
  versionRange: string;
}

interface EditorState {
  behaviorRef: string;
  compatibility: string;
  defaults: string;
  dependencies: DependencyEditor[];
  displayName: string;
  documentation: string;
  key: string;
  kind: PrimitiveKind;
  parameterSchema: string;
  provenance: string;
  tags: string;
  version: string;
  visualHints: string;
}

const blankEditor: EditorState = {
  behaviorRef: '',
  compatibility: '{}',
  defaults: '{}',
  dependencies: [],
  displayName: '',
  documentation: '',
  key: '',
  kind: 'government',
  parameterSchema: '{\n  "type": "object",\n  "additionalProperties": false\n}',
  provenance: '{\n  "source": "platform-admin"\n}',
  tags: '',
  version: '1.0.0',
  visualHints: '{}',
};

function pretty(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function editorFrom(primitive: PrimitiveVersion): EditorState {
  return {
    behaviorRef: primitive.behaviorRef ?? '',
    compatibility: pretty(primitive.compatibility),
    defaults: pretty(primitive.defaults),
    dependencies: primitive.dependencies.map((dependency) => ({
      key: dependency.key,
      parameterMapping: pretty(dependency.parameterMapping),
      required: dependency.required,
      versionRange: dependency.versionRange,
    })),
    displayName: primitive.displayName,
    documentation: primitive.documentation,
    key: primitive.key,
    kind: primitive.kind,
    parameterSchema: pretty(primitive.parameterSchema),
    provenance: pretty(primitive.provenance),
    tags: primitive.tags.join(', '),
    version: primitive.version,
    visualHints: pretty(primitive.visualHints),
  };
}

function jsonObject(
  value: string,
  pointer: string,
  issues: ValidationIssue[],
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      issues.push({ code: 'EXPECTED_OBJECT', message: 'Enter a JSON object.', pointer });
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    issues.push({ code: 'INVALID_JSON', message: 'Enter valid JSON.', pointer });
    return {};
  }
}

function buildDraft(editor: EditorState): {
  issues: ValidationIssue[];
  payload: Record<string, unknown>;
} {
  const issues: ValidationIssue[] = [];
  if (!editor.key.trim())
    issues.push({ code: 'REQUIRED', message: 'Stable key is required.', pointer: '/key' });
  if (!editor.version.trim())
    issues.push({ code: 'REQUIRED', message: 'Version is required.', pointer: '/version' });
  if (!editor.displayName.trim())
    issues.push({
      code: 'REQUIRED',
      message: 'Display name is required.',
      pointer: '/displayName',
    });
  if (!editor.documentation.trim())
    issues.push({
      code: 'REQUIRED',
      message: 'Documentation is required.',
      pointer: '/documentation',
    });
  const seenDependencies = new Set<string>();
  const dependencies = editor.dependencies.map((dependency, index) => {
    if (!dependency.key.trim()) {
      issues.push({
        code: 'REQUIRED',
        message: 'Dependency key is required.',
        pointer: `/dependencies/${index}/key`,
      });
    } else if (seenDependencies.has(dependency.key.trim())) {
      issues.push({
        code: 'DUPLICATE_DEPENDENCY',
        message: 'Each dependency key can appear only once.',
        pointer: `/dependencies/${index}/key`,
      });
    }
    seenDependencies.add(dependency.key.trim());
    if (!dependency.versionRange.trim()) {
      issues.push({
        code: 'REQUIRED',
        message: 'Dependency version range is required.',
        pointer: `/dependencies/${index}/versionRange`,
      });
    }
    return {
      key: dependency.key.trim(),
      parameterMapping: jsonObject(
        dependency.parameterMapping,
        `/dependencies/${index}/parameterMapping`,
        issues,
      ),
      required: dependency.required,
      versionRange: dependency.versionRange.trim(),
    };
  });
  return {
    issues,
    payload: {
      behaviorRef: editor.behaviorRef.trim() || null,
      compatibility: jsonObject(editor.compatibility, '/compatibility', issues),
      defaults: jsonObject(editor.defaults, '/defaults', issues),
      dependencies,
      displayName: editor.displayName.trim(),
      documentation: editor.documentation.trim(),
      key: editor.key.trim(),
      kind: editor.kind,
      parameterSchema: jsonObject(editor.parameterSchema, '/parameterSchema', issues),
      primitiveSchemaVersion: 1,
      provenance: jsonObject(editor.provenance, '/provenance', issues),
      tags: editor.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      version: editor.version.trim(),
      visualHints: jsonObject(editor.visualHints, '/visualHints', issues),
    },
  };
}

function issuesFrom(cause: BrowserApiError): ValidationIssue[] {
  const details = cause.failure.details;
  if (!details) return [];
  const candidates = [details.issues, details.validationIssues];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (issue): issue is ValidationIssue =>
          typeof issue === 'object' &&
          issue !== null &&
          'code' in issue &&
          'message' in issue &&
          'pointer' in issue,
      );
    }
  }
  return [];
}

function commandSummary(
  response: unknown,
  fallback: PrimitiveListItem | null,
): PrimitiveListItem | null {
  const envelope = response as { primitive?: PrimitiveListItem };
  const candidate = envelope.primitive ?? (response as PrimitiveListItem);
  return candidate && typeof candidate === 'object' && typeof candidate.key === 'string'
    ? candidate
    : fallback;
}

async function fetchExactPrimitive(item: Pick<PrimitiveListItem, 'key' | 'version'>) {
  const response = await requestJson<unknown>(
    `/api/v1/primitives/${encodeURIComponent(item.key)}/versions/${encodeURIComponent(item.version)}`,
  );
  return unwrapPrimitive(response);
}

const MAX_ADMIN_CATALOG_PAGES = 20;

async function fetchLifecycle(
  lifecycle: 'deprecated' | 'draft' | 'published',
  signal?: AbortSignal,
): Promise<PrimitiveListItem[]> {
  const items: PrimitiveListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_ADMIN_CATALOG_PAGES; pageNumber += 1) {
    const parameters = new URLSearchParams({ lifecycle, limit: '50' });
    if (cursor) parameters.set('cursor', cursor);
    const page = await requestJson<CatalogPage>(`/api/v1/primitives?${parameters}`, {
      ...(signal ? { signal } : {}),
    });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('CATALOG_CURSOR_REPEATED');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('CATALOG_PAGE_LIMIT_EXCEEDED');
}

async function fetchAdminCatalog(signal?: AbortSignal) {
  const [drafts, published, deprecated] = await Promise.all([
    fetchLifecycle('draft', signal),
    fetchLifecycle('published', signal),
    fetchLifecycle('deprecated', signal),
  ]);
  const catalog = [...drafts, ...published, ...deprecated].filter(
    (item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index,
  );
  return { catalog, published };
}

export function PrimitiveAdmin() {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const publishDialog = useRef<HTMLDialogElement>(null);
  const loadSequence = useRef(0);
  const selectedRequest = useRef<AbortController | null>(null);
  const commandKeys = useRef(new Map<string, string>());
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [catalog, setCatalog] = useState<PrimitiveListItem[]>([]);
  const [published, setPublished] = useState<PrimitiveListItem[]>([]);
  const [current, setCurrent] = useState<PrimitiveVersion | null>(null);
  const [editor, setEditor] = useState<EditorState>(blankEditor);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [deprecationReason, setDeprecationReason] = useState('');
  const [validation, setValidation] = useState<DraftValidationReport | null>(null);

  const commandKey = useCallback((operation: string): string => {
    const existing = commandKeys.current.get(operation);
    if (existing) return existing;
    const created = crypto.randomUUID();
    commandKeys.current.set(operation, created);
    return created;
  }, []);

  const refreshCatalog = useCallback(async () => {
    const next = await fetchAdminCatalog();
    setCatalog(next.catalog);
    setPublished(next.published);
  }, []);

  const load = useCallback(
    async (signal: AbortSignal, sequence: number) => {
      const isCurrent = () => !signal.aborted && sequence === loadSequence.current;
      setAuthorized(null);
      setError('');
      setCatalog([]);
      setPublished([]);
      try {
        const session = await requestJson<AuthenticatedSession>('/api/v1/auth/me', { signal });
        if (!isCurrent()) return;
        if (session.user.platformRole !== 'platform_admin') {
          setAuthorized(false);
          return;
        }
        const next = await fetchAdminCatalog(signal);
        if (!isCurrent()) return;
        setCatalog(next.catalog);
        setPublished(next.published);
        setAuthorized(true);
      } catch (cause) {
        if (!isCurrent()) return;
        if (cause instanceof BrowserApiError && cause.status === 401) {
          router.replace('/sign-in?returnTo=%2Fadmin%2Fprimitives');
          return;
        }
        setError(
          cause instanceof BrowserApiError
            ? `${cause.failure.code}: ${cause.failure.message}`
            : 'ADMIN_UNAVAILABLE: Registry administration could not be loaded.',
        );
        requestAnimationFrame(() => errorRef.current?.focus());
      }
    },
    [router],
  );

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++loadSequence.current;
    void load(controller.signal, sequence);
    return () => {
      controller.abort();
      selectedRequest.current?.abort();
    };
  }, [load, loadAttempt]);

  function report(cause: unknown) {
    const apiIssues = cause instanceof BrowserApiError ? issuesFrom(cause) : [];
    setIssues(apiIssues);
    setError(
      cause instanceof BrowserApiError
        ? `${cause.failure.code}: ${cause.failure.message}`
        : 'NETWORK_ERROR: The registry command could not be completed.',
    );
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  function focusValidationIssue(pointer: string) {
    const target = document.getElementById(fieldId(pointer));
    if (target instanceof HTMLElement) {
      target.focus();
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }

  function openPublishDialog() {
    setPublishConfirmed(false);
    requestAnimationFrame(() => publishDialog.current?.showModal());
  }

  function changed(next: EditorState) {
    commandKeys.current.clear();
    setEditor(next);
    setIssues([]);
    setError('');
    setStatus('');
    setValidation(null);
  }

  function startNew() {
    selectedRequest.current?.abort();
    setCurrent(null);
    setDeprecationReason('');
    changed({ ...blankEditor, dependencies: [] });
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>('#primitive-key')?.focus(),
    );
  }

  async function selectPrimitive(item: PrimitiveListItem) {
    selectedRequest.current?.abort();
    const controller = new AbortController();
    selectedRequest.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await requestJson<unknown>(
        `/api/v1/primitives/${encodeURIComponent(item.key)}/versions/${encodeURIComponent(item.version)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || selectedRequest.current !== controller) return;
      const primitive = unwrapPrimitive(response);
      setCurrent(primitive);
      setEditor(editorFrom(primitive));
      setDeprecationReason('');
      setIssues([]);
      setStatus('');
      setValidation(null);
      commandKeys.current.clear();
    } catch (cause) {
      if (controller.signal.aborted) return;
      report(cause);
    } finally {
      if (selectedRequest.current === controller) {
        selectedRequest.current = null;
        setBusy(false);
      }
    }
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = buildDraft(editor);
    setIssues(draft.issues);
    setError('');
    if (draft.issues.length > 0) {
      setError('VALIDATION_FAILED: Correct the fields listed below.');
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setBusy(true);
    const isCorrection = current?.lifecycle === 'draft';
    const operation = isCorrection ? `correct:${current.id}` : 'create';
    const endpoint = isCorrection
      ? `${adminPrimitivePath(current)}/draft`
      : '/api/v1/admin/primitives/drafts';
    try {
      const response = await mutateJson<unknown>(
        endpoint,
        isCorrection ? 'PUT' : 'POST',
        isCorrection
          ? { draft: draft.payload, expectedRowVersion: current.rowVersion }
          : draft.payload,
        commandKey(operation),
      );
      const responseValidation = (response as { validation?: DraftValidationReport }).validation;
      setValidation(responseValidation ?? null);
      const summary = commandSummary(response, current);
      if (summary) {
        const primitive = await fetchExactPrimitive(summary);
        setCurrent(primitive);
        setEditor(editorFrom(primitive));
      }
      setStatus(isCorrection ? 'Draft corrected.' : 'Draft created.');
      commandKeys.current.delete(operation);
      await refreshCatalog();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!current || current.lifecycle !== 'draft' || !publishConfirmed) return;
    setBusy(true);
    setError('');
    try {
      const response = await mutateJson<unknown>(
        `${adminPrimitivePath(current)}/publish`,
        'POST',
        { expectedRowVersion: current.rowVersion },
        commandKey(`publish:${current.id}:${current.rowVersion}`),
      );
      const summary = commandSummary(response, current);
      if (summary) {
        const primitive = await fetchExactPrimitive(summary);
        setCurrent(primitive);
        setEditor(editorFrom(primitive));
      }
      publishDialog.current?.close();
      setStatus('Version published. Its semantic definition is now immutable.');
      await refreshCatalog();
    } catch (cause) {
      publishDialog.current?.close();
      report(cause);
    } finally {
      setBusy(false);
      setPublishConfirmed(false);
    }
  }

  async function deprecate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current || current.lifecycle !== 'published') return;
    setBusy(true);
    setError('');
    try {
      const response = await mutateJson<unknown>(
        `${adminPrimitivePath(current)}/deprecate`,
        'POST',
        { expectedRowVersion: current.rowVersion, reason: deprecationReason.trim() },
        commandKey(`deprecate:${current.id}:${current.rowVersion}`),
      );
      const summary = commandSummary(response, current);
      if (summary) setCurrent(await fetchExactPrimitive(summary));
      setStatus('Version deprecated. Existing exact-version references remain unchanged.');
      await refreshCatalog();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }

  async function reindex() {
    if (!current || current.lifecycle === 'draft') return;
    setBusy(true);
    setError('');
    const operation = `reindex:${current.id}:${current.contentHash}`;
    try {
      const response = await mutateJson<unknown>(
        `${adminPrimitivePath(current)}/reindex`,
        'POST',
        { expectedRowVersion: current.rowVersion },
        commandKey(operation),
      );
      const index = (
        response as {
          index?: { lastErrorCode?: string | null; status?: PrimitiveIndexState };
        }
      ).index;
      if (index?.status) {
        setCurrent({
          ...current,
          indexErrorCode: index.lastErrorCode ?? null,
          indexState: index.status,
        });
      }
      setStatus('Reindex request accepted. Repeating this command is safe and idempotent.');
      commandKeys.current.delete(operation);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }

  if (authorized === null) {
    return (
      <main className="app-page shell" id="main-content">
        <header className="app-header">
          <Link className="brand-link" href="/primitives">
            ← Primitive catalog
          </Link>
        </header>
        {error ? (
          <section className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
            <h1>Registry administration unavailable</h1>
            <p>{error}</p>
            <button
              className="button secondary"
              onClick={() => setLoadAttempt((n) => n + 1)}
              type="button"
            >
              Retry authorization
            </button>
          </section>
        ) : (
          <section aria-busy="true" aria-label="Checking registry authorization" className="card">
            <div className="skeleton" />
            <div className="skeleton short" />
          </section>
        )}
      </main>
    );
  }

  if (authorized === false) {
    return (
      <main className="app-page shell" id="main-content">
        <header className="app-header">
          <Link className="brand-link" href="/primitives">
            ← Primitive catalog
          </Link>
        </header>
        <section className="denial-panel">
          <p className="eyebrow">Platform administrators only</p>
          <h1>Access denied</h1>
          <p>
            Your account can browse published primitives but cannot view drafts or mutate the
            registry.
          </p>
          <Link className="button" href="/primitives">
            Return to catalog
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="app-page shell wide-shell" id="main-content">
      <header className="app-header catalog-header">
        <Link className="brand-link" href="/primitives">
          ← Primitive catalog
        </Link>
        <span className="role-badge">Platform administrator</span>
      </header>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Protected registry workflow</p>
          <h1>Primitive administration</h1>
          <p className="lede compact">
            Draft, validate, publish, deprecate, and reindex exact versions.
          </p>
        </div>
        <button className="button" disabled={busy} onClick={startNew} type="button">
          New draft
        </button>
      </div>

      {error ? (
        <section className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <h2>Command needs attention</h2>
          <p>{error}</p>
          {issues.length > 0 ? (
            <ul>
              {issues.map((issue, index) => (
                <li key={`${issue.pointer}-${issue.code}-${index}`}>
                  <a
                    href={`#${fieldId(issue.pointer)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      focusValidationIssue(issue.pointer);
                    }}
                  >
                    <code>{issue.pointer || '/'}</code>: {issue.message} ({issue.code})
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <p aria-live="polite" className="success-message">
        {status}
      </p>

      <div className="admin-registry-layout">
        <aside className="registry-sidebar" aria-label="Registry versions">
          <h2>Registry versions</h2>
          {catalog.length === 0 ? (
            <p className="field-help">No versions loaded. Create the first draft.</p>
          ) : (
            <ul className="registry-version-list">
              {catalog.map((item) => (
                <li key={item.id}>
                  <button
                    aria-current={current?.id === item.id ? 'true' : undefined}
                    disabled={busy}
                    onClick={() => void selectPrimitive(item)}
                    type="button"
                  >
                    <strong>{item.displayName}</strong>
                    <span>
                      {item.version} · {item.lifecycle}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section
          aria-labelledby="editor-heading"
          className="registry-editor"
          id="primitive-editor"
          tabIndex={-1}
        >
          <div className="editor-heading">
            <div>
              <p className="eyebrow">{current ? current.lifecycle : 'new'} version</p>
              <h2 id="editor-heading">
                {current ? current.displayName : 'Create primitive draft'}
              </h2>
            </div>
            {current ? <span className="status-text">Row version {current.rowVersion}</span> : null}
          </div>

          {current && current.lifecycle !== 'draft' ? (
            <div className="immutable-notice" role="status">
              <strong>Semantic definition locked.</strong> Published content, tags, and dependencies
              cannot be edited. Create a new SemVer to make a correction.
            </div>
          ) : null}

          {validation ? (
            <section aria-live="polite" className="validation-report">
              <h3>Draft validation {validation.valid ? 'passed' : 'needs attention'}</h3>
              <p>
                Canonical content hash:{' '}
                {validation.contentHash ? <code>{validation.contentHash}</code> : 'not available'}
              </p>
              {validation.issues.length > 0 ? (
                <ul>
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.pointer}-${issue.code}-${index}`}>
                      <a
                        href={`#${fieldId(issue.pointer)}`}
                        onClick={(event) => {
                          event.preventDefault();
                          focusValidationIssue(issue.pointer);
                        }}
                      >
                        <code>{issue.pointer || '/'}</code>: {issue.message} ({issue.code})
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No schema or content validation issues were found.</p>
              )}
            </section>
          ) : null}

          <form
            className="primitive-editor-form"
            noValidate
            onSubmit={(event) => void saveDraft(event)}
          >
            <fieldset disabled={busy || (current !== null && current.lifecycle !== 'draft')}>
              <legend>Identity and documentation</legend>
              <div className="editor-grid">
                <label>
                  Stable key
                  <input
                    id="primitive-key"
                    maxLength={160}
                    onChange={(event) => changed({ ...editor, key: event.target.value })}
                    required
                    value={editor.key}
                  />
                </label>
                <label>
                  Semantic version
                  <input
                    id="primitive-version"
                    maxLength={64}
                    onChange={(event) => changed({ ...editor, version: event.target.value })}
                    required
                    value={editor.version}
                  />
                </label>
                <label>
                  Display name
                  <input
                    id="primitive-displayName"
                    maxLength={120}
                    onChange={(event) => changed({ ...editor, displayName: event.target.value })}
                    required
                    value={editor.displayName}
                  />
                </label>
                <label>
                  Kind
                  <select
                    id="primitive-kind"
                    onChange={(event) =>
                      changed({ ...editor, kind: event.target.value as PrimitiveKind })
                    }
                    value={editor.kind}
                  >
                    {primitiveKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="full-span">
                  Tags <span className="field-help">comma separated</span>
                  <input
                    id="primitive-tags"
                    onChange={(event) => changed({ ...editor, tags: event.target.value })}
                    value={editor.tags}
                  />
                </label>
                <label className="full-span">
                  Documentation (safe Markdown)
                  <textarea
                    id="primitive-documentation"
                    onChange={(event) => changed({ ...editor, documentation: event.target.value })}
                    required
                    rows={8}
                    value={editor.documentation}
                  />
                </label>
              </div>
            </fieldset>

            <fieldset disabled={busy || (current !== null && current.lifecycle !== 'draft')}>
              <legend>Schema-backed definition</legend>
              <div className="editor-grid json-editor-grid">
                {(
                  [
                    ['parameterSchema', 'Parameter schema'],
                    ['defaults', 'Defaults'],
                    ['compatibility', 'Compatibility'],
                    ['visualHints', 'Visual hints'],
                    ['provenance', 'Provenance'],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field}>
                    {label} (JSON)
                    <textarea
                      id={`primitive-${field}`}
                      onChange={(event) => changed({ ...editor, [field]: event.target.value })}
                      rows={8}
                      spellCheck={false}
                      value={editor[field]}
                    />
                  </label>
                ))}
                <label>
                  Behavior reference <span className="field-help">allowlisted or blank</span>
                  <input
                    id="primitive-behaviorRef"
                    onChange={(event) => changed({ ...editor, behaviorRef: event.target.value })}
                    value={editor.behaviorRef}
                  />
                </label>
              </div>
            </fieldset>

            <fieldset disabled={busy || (current !== null && current.lifecycle !== 'draft')}>
              <legend>Required dependencies</legend>
              <p className="field-help">
                Pick a stable key and declare a range. Publication resolves and records one exact
                compatible version.
              </p>
              <datalist id="published-primitive-keys">
                {[...new Set(published.map((item) => item.key))].map((key) => (
                  <option key={key} value={key} />
                ))}
              </datalist>
              <div className="dependency-editors">
                {editor.dependencies.map((dependency, index) => (
                  <div className="dependency-editor" key={`${index}-${dependency.key}`}>
                    <label>
                      Dependency key
                      <input
                        id={`dependency-${index}-key`}
                        list="published-primitive-keys"
                        onChange={(event) => {
                          const dependencies = [...editor.dependencies];
                          dependencies[index] = { ...dependency, key: event.target.value };
                          changed({ ...editor, dependencies });
                        }}
                        required
                        value={dependency.key}
                      />
                    </label>
                    <label>
                      Version range
                      <input
                        id={`dependency-${index}-versionRange`}
                        onChange={(event) => {
                          const dependencies = [...editor.dependencies];
                          dependencies[index] = { ...dependency, versionRange: event.target.value };
                          changed({ ...editor, dependencies });
                        }}
                        required
                        value={dependency.versionRange}
                      />
                    </label>
                    <label className="checkbox-row compact-checkbox">
                      <input
                        checked={dependency.required}
                        id={`dependency-${index}-required`}
                        onChange={(event) => {
                          const dependencies = [...editor.dependencies];
                          dependencies[index] = { ...dependency, required: event.target.checked };
                          changed({ ...editor, dependencies });
                        }}
                        type="checkbox"
                      />
                      Required
                    </label>
                    <label className="full-span">
                      Parameter mapping (JSON)
                      <textarea
                        id={`dependency-${index}-parameterMapping`}
                        onChange={(event) => {
                          const dependencies = [...editor.dependencies];
                          dependencies[index] = {
                            ...dependency,
                            parameterMapping: event.target.value,
                          };
                          changed({ ...editor, dependencies });
                        }}
                        rows={3}
                        spellCheck={false}
                        value={dependency.parameterMapping}
                      />
                    </label>
                    <button
                      className="text-button danger-text"
                      onClick={() =>
                        changed({
                          ...editor,
                          dependencies: editor.dependencies.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                      type="button"
                    >
                      Remove dependency
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="button secondary"
                onClick={() =>
                  changed({
                    ...editor,
                    dependencies: [
                      ...editor.dependencies,
                      { key: '', parameterMapping: '{}', required: true, versionRange: '^1.0.0' },
                    ],
                  })
                }
                type="button"
              >
                Add dependency
              </button>
            </fieldset>

            {current === null || current.lifecycle === 'draft' ? (
              <div className="actions sticky-actions">
                <button className="button" disabled={busy} type="submit">
                  {busy ? 'Saving…' : current ? 'Correct draft' : 'Create draft'}
                </button>
                {current?.lifecycle === 'draft' ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={openPublishDialog}
                    type="button"
                  >
                    Review and publish…
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>

          {current && current.lifecycle !== 'draft' ? (
            <section className="post-publish-actions" aria-label="Published version operations">
              <div className="card">
                <h3>Index state: {current.indexState.replaceAll('_', ' ')}</h3>
                {sanitizedIndexError(current.indexErrorCode) ? (
                  <p className="index-error">
                    Index issue: {sanitizedIndexError(current.indexErrorCode)}
                  </p>
                ) : null}
                <p>
                  Reindexing replaces derived search data only; it never mutates registry truth.
                </p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void reindex()}
                  type="button"
                >
                  Request reindex
                </button>
              </div>
              {current.lifecycle === 'published' ? (
                <form className="card form-stack" onSubmit={(event) => void deprecate(event)}>
                  <h3>Deprecate version</h3>
                  <label>
                    Deprecation reason
                    <textarea
                      minLength={10}
                      onChange={(event) => {
                        commandKeys.current.delete(`deprecate:${current.id}:${current.rowVersion}`);
                        setDeprecationReason(event.target.value);
                      }}
                      required
                      value={deprecationReason}
                    />
                  </label>
                  <button className="button danger" disabled={busy} type="submit">
                    Deprecate exact version
                  </button>
                </form>
              ) : null}
              {current.lifecycle === 'deprecated' ? (
                <div className="card">
                  <h3>Deprecated exact version</h3>
                  <p>{current.deprecationReason ?? 'No deprecation reason was recorded.'}</p>
                  <p className="field-help">Deprecated at {current.deprecatedAt ?? 'unknown'}</p>
                </div>
              ) : null}
            </section>
          ) : null}
        </section>
      </div>

      <dialog
        aria-describedby="publish-description"
        aria-labelledby="publish-title"
        className="modal"
        onCancel={() => setPublishConfirmed(false)}
        onClose={() => setPublishConfirmed(false)}
        ref={publishDialog}
      >
        <div>
          <p className="eyebrow">Irreversible semantic lock</p>
          <h2 id="publish-title">
            Publish {current?.key}@{current?.version}?
          </h2>
          <p id="publish-description">
            Publication pins validated dependencies and the canonical content hash. The definition,
            tags, and dependencies cannot be changed or deleted afterward; corrections require a new
            semantic version.
          </p>
          <label className="checkbox-row">
            <input
              autoFocus
              checked={publishConfirmed}
              onChange={(event) => setPublishConfirmed(event.target.checked)}
              type="checkbox"
            />
            I understand this exact version becomes immutable.
          </label>
          <div className="actions">
            <button
              className="button"
              disabled={!publishConfirmed || busy}
              onClick={() => void publish()}
              type="button"
            >
              {busy ? 'Publishing…' : 'Publish immutable version'}
            </button>
            <button
              className="button secondary"
              onClick={() => publishDialog.current?.close()}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      </dialog>
    </main>
  );
}
