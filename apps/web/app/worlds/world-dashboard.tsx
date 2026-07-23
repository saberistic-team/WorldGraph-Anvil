'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type { AuthenticatedSession, World } from '@worldgraph/contracts';

import { BrowserApiError, formString, mutateJson, requestJson } from '../lib/browser-api';

export function WorldDashboard() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [worlds, setWorlds] = useState<World[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [me, page] = await Promise.all([
        requestJson<AuthenticatedSession>('/api/v1/auth/me'),
        requestJson<{ items: World[] }>('/api/v1/worlds'),
      ]);
      setSession(me);
      setWorlds(page.items);
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace('/sign-in?returnTo=%2Fworlds');
        return;
      }
      setError('WORLD_LIST_UNAVAILABLE: Your worlds could not be loaded.');
    }
  }, [router]);

  useEffect(() => void load(), [load]);

  async function createWorld(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await mutateJson<{ world: World }>('/api/v1/worlds', 'POST', {
        name: formString(data, 'name'),
        ...(formString(data, 'slug') ? { slug: formString(data, 'slug') } : {}),
      });
      dialog.current?.close();
      router.push(`/worlds/${result.world.id}`);
    } catch (cause) {
      setError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'NETWORK_ERROR: The world could not be created.',
      );
      dialog.current?.close();
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await mutateJson<void>('/api/v1/auth/logout', 'POST');
    } finally {
      router.replace('/sign-in');
      router.refresh();
    }
  }

  return (
    <main className="app-page shell" id="main-content">
      <header className="app-header">
        <Link className="brand-link" href="/">
          WorldGraph / Anvil
        </Link>
        <nav aria-label="Account">
          <Link className="text-link" href="/primitives">
            Primitive catalog
          </Link>
          {session ? <span>{session.user.displayName ?? session.user.email}</span> : null}
          <button className="text-button" onClick={() => void signOut()} type="button">
            Sign out
          </button>
        </nav>
      </header>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your societies</p>
          <h1>Worlds</h1>
        </div>
        <button className="button" onClick={() => dialog.current?.showModal()} type="button">
          Create world
        </button>
      </div>
      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </div>
      ) : null}
      {worlds === null ? (
        <section aria-busy="true" aria-label="Loading worlds" className="world-grid">
          <div className="card skeleton-card" />
          <div className="card skeleton-card" />
        </section>
      ) : worlds.length === 0 ? (
        <section className="empty-state">
          <h2>Shape your first city-state</h2>
          <p>No worlds are available to this account yet.</p>
          <button className="button" onClick={() => dialog.current?.showModal()} type="button">
            Create your first world
          </button>
        </section>
      ) : (
        <section aria-label="Available worlds" className="world-grid">
          {worlds.map((world) => (
            <article className="card world-card" key={world.id}>
              <span className={`role-badge role-${world.role ?? 'platform-admin'}`}>
                {world.role ?? 'platform administrator'}
              </span>
              <h2>
                <Link href={`/worlds/${world.id}`}>{world.name}</Link>
              </h2>
              <p>
                {world.slug} · {world.lifecycle}
              </p>
            </article>
          ))}
        </section>
      )}
      <dialog className="modal" ref={dialog}>
        <form className="form-stack" onSubmit={(event) => void createWorld(event)}>
          <div>
            <p className="eyebrow">New society</p>
            <h2>Create a world</h2>
          </div>
          <label>
            World name
            <input maxLength={100} minLength={2} name="name" required />
          </label>
          <label>
            Slug <span className="field-help">optional</span>
            <input maxLength={63} minLength={3} name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
          </label>
          <div className="actions">
            <button className="button" disabled={busy} type="submit">
              {busy ? 'Creating…' : 'Create world'}
            </button>
            <button
              className="button secondary"
              onClick={() => dialog.current?.close()}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </main>
  );
}
