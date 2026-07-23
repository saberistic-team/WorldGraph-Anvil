'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { AuthenticatedSession } from '@worldgraph/contracts';

import { BrowserApiError, formString, mutateJson, requestJson } from '../../lib/browser-api';

type State =
  | { kind: 'loading'; message: string }
  | { kind: 'signed-out'; token: string }
  | { kind: 'error'; message: string; token?: string }
  | { kind: 'success'; worldId: string };

export function InvitationAcceptance() {
  const errorRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: 'loading', message: 'Reading invitation…' });

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState({
        kind: 'error',
        message: 'INVITATION_NOT_AVAILABLE: This invitation link is incomplete.',
      });
      return;
    }
    void continueAcceptance(token);
  }, []);

  async function continueAcceptance(token: string) {
    setState({ kind: 'loading', message: 'Checking your account…' });
    try {
      await requestJson<AuthenticatedSession>('/api/v1/auth/me');
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        setState({ kind: 'signed-out', token });
        return;
      }
      setState({ kind: 'error', message: 'The account service is unavailable.', token });
      return;
    }
    try {
      const response = await mutateJson<{ membership: { worldId: string } }>(
        '/api/v1/invitations/accept',
        'POST',
        { rawToken: token },
      );
      setState({ kind: 'success', worldId: response.membership.worldId });
    } catch (cause) {
      setState({
        kind: 'error',
        message:
          cause instanceof BrowserApiError
            ? `${cause.failure.code}: ${cause.failure.message}`
            : 'NETWORK_ERROR: The invitation could not be accepted.',
        token,
      });
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== 'signed-out') return;
    const token = state.token;
    const data = new FormData(event.currentTarget);
    setState({ kind: 'loading', message: 'Signing in…' });
    try {
      await requestJson('/api/v1/auth/login', {
        body: JSON.stringify({
          email: formString(data, 'email'),
          password: formString(data, 'password'),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      await continueAcceptance(token);
    } catch (cause) {
      setState({
        kind: 'error',
        message:
          cause instanceof BrowserApiError
            ? `${cause.failure.code}: ${cause.failure.message}`
            : 'NETWORK_ERROR: Sign-in failed.',
        token,
      });
    }
  }

  return (
    <main className="auth-shell shell" id="main-content">
      <section className="auth-card">
        <Link className="brand-link" href="/">
          WorldGraph / Anvil
        </Link>
        <p className="eyebrow">World invitation</p>
        <h1>Join a society</h1>
        {state.kind === 'loading' ? <p aria-live="polite">{state.message}</p> : null}
        {state.kind === 'signed-out' ? (
          <>
            <p>
              Sign in with the exact email address invited by the world administrator. The
              invitation secret remains only in this page’s memory.
            </p>
            <form
              action="/auth-unavailable"
              className="form-stack"
              method="post"
              onSubmit={(event) => void signIn(event)}
            >
              <label>
                Email
                <input autoComplete="email" name="email" required type="email" />
              </label>
              <label>
                Password
                <input autoComplete="current-password" name="password" required type="password" />
              </label>
              <button className="button" type="submit">
                Sign in and accept
              </button>
              <noscript>
                <p className="field-help">
                  JavaScript is required; credentials were not submitted.
                </p>
              </noscript>
            </form>
          </>
        ) : null}
        {state.kind === 'error' ? (
          <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
            <p>{state.message}</p>
            {state.token ? (
              <button
                className="button secondary"
                onClick={() => void continueAcceptance(state.token!)}
                type="button"
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
        {state.kind === 'success' ? (
          <div className="success-panel" role="status">
            <h2>Invitation accepted</h2>
            <p>Your membership is active.</p>
            <Link className="button" href={`/worlds/${state.worldId}`}>
              Open world
            </Link>
          </div>
        ) : null}
      </section>
    </main>
  );
}
