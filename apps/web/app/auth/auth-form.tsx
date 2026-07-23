'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { BrowserApiError, formString, requestJson, safeReturnPath } from '../lib/browser-api';

export function AuthForm({ mode, returnTo }: { mode: 'login' | 'register'; returnTo?: string }) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await requestJson(`/api/v1/auth/${mode === 'login' ? 'login' : 'register'}`, {
        body: JSON.stringify({
          ...(mode === 'register' ? { displayName: formString(form, 'displayName') } : {}),
          email: formString(form, 'email'),
          password: formString(form, 'password'),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      router.replace(safeReturnPath(returnTo ?? null));
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'NETWORK_ERROR: The service could not be reached.',
      );
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  const registering = mode === 'register';
  return (
    <main className="auth-shell shell" id="main-content">
      <section className="auth-card" aria-labelledby="auth-heading">
        <Link className="brand-link" href="/">
          WorldGraph / Anvil
        </Link>
        <p className="eyebrow">Closed alpha</p>
        <h1 id="auth-heading">{registering ? 'Create your account' : 'Welcome back'}</h1>
        <p className="lede compact">
          {registering
            ? 'Use an invited development account to begin building a world.'
            : 'Sign in to your worlds and active invitations.'}
        </p>
        {error ? (
          <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
            {error}
          </div>
        ) : null}
        <form
          action="/auth-unavailable"
          className="form-stack"
          method="post"
          onSubmit={(event) => void submit(event)}
        >
          {registering ? (
            <label>
              Display name
              <input autoComplete="name" maxLength={80} name="displayName" required />
            </label>
          ) : null}
          <label>
            Email address
            <input autoComplete="email" maxLength={254} name="email" required type="email" />
          </label>
          <label>
            Password
            <input
              aria-describedby={registering ? 'password-help' : undefined}
              autoComplete={registering ? 'new-password' : 'current-password'}
              maxLength={128}
              minLength={12}
              name="password"
              required
              type="password"
            />
          </label>
          {registering ? (
            <p className="field-help" id="password-help">
              Use 20+ characters, or 12+ with upper/lowercase, a number, and a symbol.
            </p>
          ) : null}
          <button className="button" disabled={busy || !hydrated} type="submit">
            {busy ? 'Working…' : registering ? 'Create account' : 'Sign in'}
          </button>
          <p className="field-help" hidden={hydrated}>
            JavaScript is required; credentials were not submitted.
          </p>
        </form>
        <p className="auth-switch">
          {registering ? 'Already registered?' : 'Need a local alpha account?'}{' '}
          <Link className="text-link" href={registering ? '/sign-in' : '/register'}>
            {registering ? 'Sign in' : 'Register'}
          </Link>
        </p>
      </section>
    </main>
  );
}
