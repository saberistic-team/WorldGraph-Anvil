'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { BrowserApiError, mutateJson, requestJson } from '../../lib/browser-api';
import {
  buildEconomyCommand,
  buildCommerceCommand,
  economyErrorMessage,
  humanizeEconomyValue,
  isEconomyConflict,
  type EconomyCommandEnvelope,
  type EconomyCommandResult,
  type EconomyCommandType,
  type EconomySummary,
} from './economy-model';

export function WorldEconomyNav({
  current,
  worldId,
}: {
  current: 'assets' | 'commerce' | 'economy';
  worldId: string;
}) {
  return (
    <nav aria-label="World sections" className="runtime-nav economy-nav">
      <Link href={`/worlds/${worldId}/overview`}>Overview</Link>
      <Link href={`/worlds/${worldId}/graph`}>Graph</Link>
      <Link href={`/worlds/${worldId}/simulate`}>Simulate</Link>
      <Link href={`/worlds/${worldId}/history`}>History</Link>
      <Link href={`/worlds/${worldId}/explore`}>Explore</Link>
      <Link href={`/worlds/${worldId}/govern`}>Govern</Link>
      <Link
        aria-current={current === 'economy' ? 'page' : undefined}
        href={`/worlds/${worldId}/economy`}
      >
        Economy
      </Link>
      <Link
        aria-current={current === 'assets' ? 'page' : undefined}
        href={`/worlds/${worldId}/assets`}
      >
        Assets
      </Link>
      <Link
        aria-current={current === 'commerce' ? 'page' : undefined}
        href={`/worlds/${worldId}/economy/resources`}
      >
        Commerce
      </Link>
    </nav>
  );
}

export function VirtualValueDisclosure() {
  return (
    <aside aria-label="Virtual value boundary" className="virtual-value-disclosure">
      <strong>Virtual world value only</strong>
      <span>No cash value. Cash-out, withdrawal, and exchange for real money are not allowed.</span>
    </aside>
  );
}

export function CopyableId({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="copyable-id">
      <code title={id}>{id}</code>
      <button
        aria-label={`Copy ${label}`}
        className="text-button"
        onClick={() => void copy()}
        type="button"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export function EconomyStateNotices({ summary }: { summary: EconomySummary }) {
  const notices: Array<{ kind: 'danger' | 'warning'; text: string; title: string }> = [];
  if (summary.status === 'reconciling' || summary.reconciliation.status === 'reconciling') {
    notices.push({
      kind: 'warning',
      text: 'A read-only verification is comparing projections with immutable facts. Values remain server-owned while it runs.',
      title: 'Reconciliation is running',
    });
  }
  if (summary.status === 'mismatched' || summary.reconciliation.status === 'mismatched') {
    notices.push({
      kind: 'danger',
      text: 'The authoritative reconciliation found a projection mismatch. Spending actions are unavailable until operators resolve it through append-only repair.',
      title: 'Projection mismatch — actions halted',
    });
  }
  if (summary.featurePolicy.debitsFrozen) {
    notices.push({
      kind: 'warning',
      text: 'New debits are frozen by world policy. Existing balances and immutable history remain visible.',
      title: 'Debits frozen',
    });
  }
  const disabledFeatures = [
    !summary.featurePolicy.transfersEnabled ? 'currency transfers' : null,
    !summary.featurePolicy.offersEnabled ? 'direct offers' : null,
    !summary.featurePolicy.issuanceEnabled ? 'creator issuance' : null,
  ].filter((value): value is string => value !== null);
  if (summary.status !== 'not_initialized' && disabledFeatures.length > 0) {
    notices.push({
      kind: 'warning',
      text: `World policy currently disables ${disabledFeatures.join(', ')}. Read-only balances, title, and immutable history remain available.`,
      title: 'Economy feature gate active',
    });
  }
  return (
    <>
      {notices.map((notice) => (
        <section
          className={`economy-state-banner ${notice.kind}`}
          key={notice.title}
          role={notice.kind === 'danger' ? 'alert' : 'status'}
        >
          <strong>{notice.title}</strong>
          <span>{notice.text}</span>
        </section>
      ))}
    </>
  );
}

type CommandFeedbackState =
  | { kind: 'idle'; message: '' }
  | { commandId: string; kind: 'pending'; message: string }
  | { commandId: string; kind: 'success'; message: string }
  | {
      code?: string;
      commandId?: string;
      kind: 'error';
      message: string;
    }
  | {
      commandId: string;
      envelope: EconomyCommandEnvelope;
      kind: 'uncertain';
      message: string;
    };

function resultFailure(result: Exclude<EconomyCommandResult, { status: 'accepted' }>): {
  code: string;
  message: string;
} {
  const code = result.rejectionCode ?? `COMMAND_${result.status.toUpperCase()}`;
  return {
    code,
    message: economyErrorMessage(code, `The command ended in ${result.status} state.`),
  };
}

export function useEconomyCommand({
  onAccepted,
  returnPath,
  summary,
  worldId,
}: {
  onAccepted: () => Promise<void>;
  returnPath: string;
  summary: EconomySummary | null;
  worldId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<CommandFeedbackState>({ kind: 'idle', message: '' });

  const accept = useCallback(
    async (result: Extract<EconomyCommandResult, { status: 'accepted' }>) => {
      setState({
        commandId: result.commandId,
        kind: 'success',
        message: `Accepted at authoritative state revision ${result.resultingStateRevision}.`,
      });
      await onAccepted();
    },
    [onAccepted],
  );

  const resolveResult = useCallback(
    async (result: EconomyCommandResult, envelope: EconomyCommandEnvelope) => {
      if (result.status === 'accepted') {
        await accept(result);
        return;
      }
      if (result.status === 'received') {
        setState({
          commandId: result.commandId,
          envelope,
          kind: 'uncertain',
          message:
            'The server received this command, but its final outcome is not known here yet. Check authoritative status before retrying.',
        });
        return;
      }
      const failure = resultFailure(result);
      setState({
        code: failure.code,
        commandId: result.commandId,
        kind: 'error',
        message: failure.message,
      });
    },
    [accept],
  );

  const send = useCallback(
    async (envelope: EconomyCommandEnvelope) => {
      setState({
        commandId: envelope.commandId,
        kind: 'pending',
        message: `${humanizeEconomyValue(envelope.type.replace(/V1$/u, ''))} pending…`,
      });
      try {
        const result = await mutateJson<EconomyCommandResult>(
          `/api/v1/worlds/${worldId}/commands`,
          'POST',
          envelope,
          envelope.idempotencyKey,
        );
        await resolveResult(result, envelope);
      } catch (cause) {
        if (cause instanceof BrowserApiError && cause.status === 401) {
          router.replace(`/sign-in?returnTo=${encodeURIComponent(returnPath)}`);
          return;
        }
        if (cause instanceof BrowserApiError && cause.status < 500) {
          const code = cause.failure.code;
          setState({
            code,
            commandId: envelope.commandId,
            kind: 'error',
            message: economyErrorMessage(code, cause.failure.message),
          });
          return;
        }
        try {
          const result = await requestJson<EconomyCommandResult>(
            `/api/v1/commands/${envelope.commandId}`,
          );
          await resolveResult(result, envelope);
        } catch {
          setState({
            commandId: envelope.commandId,
            envelope,
            kind: 'uncertain',
            message:
              'The connection ended before the final result was confirmed. Do not create a new command; check this command ID or retry the same idempotent command.',
          });
        }
      }
    },
    [resolveResult, returnPath, router, worldId],
  );

  const submit = useCallback(
    async (
      type: EconomyCommandType,
      payload: Record<string, unknown>,
      commerceExpansionVersion?: string,
    ) => {
      if (!summary || state.kind === 'pending') return;
      const commandId = crypto.randomUUID();
      await send(
        commerceExpansionVersion
          ? buildCommerceCommand(summary, commerceExpansionVersion, type, payload, commandId)
          : buildEconomyCommand(summary, type, payload, commandId),
      );
    },
    [send, state.kind, summary],
  );

  const check = useCallback(async () => {
    if (state.kind !== 'uncertain') return;
    setState({ commandId: state.commandId, kind: 'pending', message: 'Checking command status…' });
    try {
      const result = await requestJson<EconomyCommandResult>(`/api/v1/commands/${state.commandId}`);
      await resolveResult(result, state.envelope);
    } catch (cause) {
      setState({
        commandId: state.commandId,
        envelope: state.envelope,
        kind: 'uncertain',
        message:
          cause instanceof BrowserApiError && cause.status === 404
            ? 'No durable outcome is visible yet. Retry only with this same command and idempotency identity.'
            : 'Authoritative command status is still unavailable. Keep this command ID before retrying.',
      });
    }
  }, [resolveResult, state]);

  const retry = useCallback(async () => {
    if (state.kind !== 'uncertain') return;
    await send(state.envelope);
  }, [send, state]);

  const reportClientError = useCallback((message: string) => {
    setState({ kind: 'error', message });
  }, []);

  return {
    check,
    pending: state.kind === 'pending',
    reportClientError,
    retry,
    state,
    submit,
  };
}

export function CommandFeedback({
  children,
  check,
  retry,
  state,
}: {
  children?: ReactNode;
  check: () => Promise<void>;
  retry: () => Promise<void>;
  state: CommandFeedbackState;
}) {
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.kind === 'error') errorRef.current?.focus();
  }, [state]);

  return (
    <>
      {state.kind === 'error' ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>
            {state.code && isEconomyConflict(state.code) ? 'State changed' : 'Action not completed'}
          </strong>
          <p>{state.message}</p>
          {state.commandId ? <CopyableId id={state.commandId} label="command ID" /> : null}
        </div>
      ) : null}
      {state.kind === 'uncertain' ? (
        <section className="economy-state-banner warning">
          <strong>Outcome uncertain — do not submit a new command</strong>
          <span role="status">{state.message}</span>
          <CopyableId id={state.commandId} label="uncertain command ID" />
          <span className="economy-inline-actions">
            <button className="button secondary" onClick={() => void check()} type="button">
              Check authoritative status
            </button>
            <button className="button secondary" onClick={() => void retry()} type="button">
              Retry same command safely
            </button>
          </span>
        </section>
      ) : null}
      <p aria-atomic="true" aria-live="polite" className="success-message">
        {state.kind === 'pending' || state.kind === 'success' ? state.message : ''}
      </p>
      {children}
    </>
  );
}
