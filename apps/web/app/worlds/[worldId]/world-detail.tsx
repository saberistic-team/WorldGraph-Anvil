'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  AuthenticatedSession,
  Invitation,
  Membership,
  World,
  WorldRole,
} from '@worldgraph/contracts';

import { BrowserApiError, formString, mutateJson, requestJson } from '../../lib/browser-api';

interface WorldDetailProps {
  worldId: string;
}

export function WorldDetail({ worldId }: WorldDetailProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const inviteDialog = useRef<HTMLDialogElement>(null);
  const overrideDialog = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const [tab, setTab] = useState<'overview' | 'members'>('overview');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [overrideTarget, setOverrideTarget] = useState<Membership | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, worldResponse, memberPage] = await Promise.all([
        requestJson<AuthenticatedSession>('/api/v1/auth/me'),
        requestJson<{ world: World }>(`/api/v1/worlds/${worldId}`),
        requestJson<{ items: Membership[] }>(`/api/v1/worlds/${worldId}/memberships`),
      ]);
      setSession(me);
      setWorld(worldResponse.world);
      setMembers(memberPage.items);
      const isPlatformAdmin = me.user.platformRole === 'platform_admin';
      if (
        isPlatformAdmin ||
        (worldResponse.world.role !== null &&
          ['creator', 'administrator'].includes(worldResponse.world.role))
      ) {
        const invitePage = await requestJson<{ items: Invitation[] }>(
          `/api/v1/worlds/${worldId}/invitations`,
        );
        setInvitations(invitePage.items);
      }
      if (worldResponse.world.role === 'creator' || isPlatformAdmin) {
        const auditPage = await requestJson<{ items: Record<string, unknown>[] }>(
          `/api/v1/worlds/${worldId}/authority/audit`,
        );
        setAudit(auditPage.items);
      }
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(`/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}`)}`);
        return;
      }
      setError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'WORLD_UNAVAILABLE: This world could not be loaded.',
      );
    }
  }, [router, worldId]);

  useEffect(() => void load(), [load]);

  function report(cause: unknown) {
    setError(
      cause instanceof BrowserApiError
        ? `${cause.failure.code}: ${cause.failure.message}`
        : 'NETWORK_ERROR: The command could not be completed.',
    );
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!world) return;
    const data = new FormData(event.currentTarget);
    try {
      await mutateJson(`/api/v1/worlds/${worldId}`, 'PATCH', {
        expectedRowVersion: world.rowVersion,
        name: formString(data, 'name'),
      });
      setStatus('World renamed.');
      await load();
    } catch (cause) {
      report(cause);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const response = await mutateJson<{ invitation: Invitation; rawToken: string }>(
        `/api/v1/worlds/${worldId}/invitations`,
        'POST',
        {
          email: formString(data, 'email'),
          expiresIn: 86400,
          role: formString(data, 'role') || 'player',
        },
      );
      const link = `${window.location.origin}/invitations/accept#token=${encodeURIComponent(response.rawToken)}`;
      setInviteLink(link);
      inviteDialog.current?.showModal();
      await load();
    } catch (cause) {
      report(cause);
    }
  }

  async function changeRole(member: Membership, role: Exclude<WorldRole, 'creator'>) {
    if (
      !window.confirm(
        `Change ${member.user.displayName ?? 'this member'} from ${member.role} to ${role}?`,
      )
    )
      return;
    try {
      await mutateJson(`/api/v1/worlds/${worldId}/memberships/${member.user.id}`, 'PATCH', {
        expectedRowVersion: member.rowVersion,
        role,
      });
      setStatus('Membership role changed.');
      await load();
    } catch (cause) {
      report(cause);
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    if (!window.confirm(`Revoke the pending invitation for ${invitation.email}?`)) return;
    try {
      await mutateJson(`/api/v1/worlds/${worldId}/invitations/${invitation.id}/revoke`, 'POST');
      setStatus('Invitation revoked.');
      await load();
    } catch (cause) {
      report(cause);
    }
  }

  async function remove(member: Membership) {
    if (
      !window.confirm(
        `Remove ${member.user.displayName ?? 'this member'} from this world? They will lose access immediately.`,
      )
    )
      return;
    try {
      await mutateJson(`/api/v1/worlds/${worldId}/memberships/${member.user.id}`, 'DELETE', {
        expectedRowVersion: member.rowVersion,
      });
      setStatus('Membership removed.');
      await load();
    } catch (cause) {
      report(cause);
    }
  }

  async function override(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!overrideTarget) return;
    const data = new FormData(event.currentTarget);
    try {
      await mutateJson(`/api/v1/worlds/${worldId}/creator-overrides`, 'POST', {
        action: 'membership.force_demote_administrator',
        confirmation: formString(data, 'confirmation'),
        expectedRowVersion: overrideTarget.rowVersion,
        reason: formString(data, 'reason'),
        targetUserId: overrideTarget.user.id,
      });
      overrideDialog.current?.close();
      setStatus('Creator override applied and immutably audited.');
      await load();
    } catch (cause) {
      report(cause);
    }
  }

  if (!world) {
    return (
      <main className="app-page shell" id="main-content">
        <div aria-busy="true" className="card">
          <div className="skeleton" />
          <div className="skeleton short" />
          {error ? <p role="alert">{error}</p> : null}
        </div>
      </main>
    );
  }

  const isPlatformAdmin = session?.user.platformRole === 'platform_admin';
  const hasCreatorAuthority = world.role === 'creator' || isPlatformAdmin;
  const canAdminister =
    isPlatformAdmin || (world.role !== null && ['creator', 'administrator'].includes(world.role));
  return (
    <main className="app-page shell" id="main-content">
      <header className="app-header">
        <Link className="brand-link" href="/worlds">
          ← All worlds
        </Link>
        <span>{session?.user.displayName ?? session?.user.email}</span>
      </header>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{world.lifecycle} world</p>
          <h1>{world.name}</h1>
          <p className="lede compact">
            {world.slug} · Your role:{' '}
            <strong>{world.role ?? 'platform administrator (no world membership)'}</strong>
          </p>
        </div>
      </div>
      <nav aria-label="World sections" className="tabs">
        <button
          aria-current={tab === 'overview' ? 'page' : undefined}
          onClick={() => setTab('overview')}
          type="button"
        >
          Overview
        </button>
        <button
          aria-current={tab === 'members' ? 'page' : undefined}
          onClick={() => setTab('members')}
          type="button"
        >
          Members
        </button>
      </nav>
      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </div>
      ) : null}
      <p aria-live="polite" className="success-message">
        {status}
      </p>
      {tab === 'overview' ? (
        <section className="detail-grid">
          <article className="card manifest-entry-card">
            <div>
              <p className="eyebrow">Declarative intent</p>
              <h2>Manifest Studio</h2>
              <p>
                Describe, validate, compare, and explicitly approve this world’s immutable
                city-state blueprint. Opening the studio never starts a simulation.
              </p>
            </div>
            <div className="manifest-entry-actions">
              <span
                className={`manifest-state ${world.currentApprovedManifestRevisionId ? 'approved' : 'draft'}`}
              >
                {world.currentApprovedManifestRevisionId
                  ? `Approved · schema v${world.manifestSchemaVersion}`
                  : 'No approved manifest'}
              </span>
              <Link className="button" href={`/worlds/${worldId}/manifest`}>
                Open Manifest Studio
              </Link>
            </div>
          </article>
          <article className="card manifest-entry-card runtime-entry-card">
            <div>
              <p className="eyebrow">Authoritative relational graph</p>
              <h2>WorldGraph</h2>
              <p>
                Inspect the active world design, exact compiler identity, entities, and typed
                relationships without requiring a visual or 3D client.
              </p>
            </div>
            <div className="manifest-entry-actions">
              <span
                className={`manifest-state ${world.lifecycle === 'active' ? 'approved' : 'draft'}`}
              >
                {world.lifecycle === 'active'
                  ? 'Active WorldGraph'
                  : world.lifecycle === 'compiling'
                    ? 'Compilation in progress'
                    : 'Not active'}
              </span>
              {world.lifecycle === 'active' ? (
                <>
                  <Link className="button" href={`/worlds/${worldId}/overview`}>
                    Open World Overview
                  </Link>
                  <Link className="text-link" href={`/worlds/${worldId}/graph`}>
                    Browse graph tables
                  </Link>
                </>
              ) : (
                <Link className="text-link" href={`/worlds/${worldId}/manifest`}>
                  Review compilation eligibility
                </Link>
              )}
            </div>
          </article>
          {world.lifecycle === 'active' ? (
            <article className="card manifest-entry-card runtime-entry-card">
              <div>
                <p className="eyebrow">Integer-tick authority</p>
                <h2>Simulate</h2>
                <p>
                  Inspect the persistent world clock, advance bounded ticks, and schedule ordered
                  world notices. Every accepted control is recorded in History.
                </p>
              </div>
              <div className="manifest-entry-actions">
                <span className="manifest-state approved">Server-authoritative clock</span>
                <Link className="button" href={`/worlds/${worldId}/simulate`}>
                  Open Simulate
                </Link>
              </div>
            </article>
          ) : null}
          {world.lifecycle === 'active' ? (
            <article className="card manifest-entry-card runtime-entry-card">
              <div>
                <p className="eyebrow">Closed-loop virtual value and title</p>
                <h2>Economy and assets</h2>
                <p>
                  Review controlled wallets, immutable postings, current asset title, gifts, and
                  direct offers. Virtual currency has no cash value and cannot be cashed out.
                </p>
              </div>
              <div className="manifest-entry-actions">
                <span className="manifest-state approved">Server-authoritative state</span>
                <Link className="button" href={`/worlds/${worldId}/economy`}>
                  Open Economy
                </Link>
                <Link className="text-link" href={`/worlds/${worldId}/assets`}>
                  Browse assets and offers
                </Link>
              </div>
            </article>
          ) : null}
          <article className="card">
            <h2>World overview</h2>
            <dl className="facts">
              <div>
                <dt>Lifecycle</dt>
                <dd>{world.lifecycle}</dd>
              </div>
              <div>
                <dt>Members</dt>
                <dd>{members.length}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{world.rowVersion}</dd>
              </div>
            </dl>
          </article>
          {canAdminister ? (
            <article className="card">
              <h2>Rename world</h2>
              <form className="form-stack" onSubmit={(event) => void rename(event)}>
                <label>
                  World name
                  <input
                    defaultValue={world.name}
                    maxLength={100}
                    minLength={2}
                    name="name"
                    required
                  />
                </label>
                <button className="button" type="submit">
                  Save name
                </button>
              </form>
            </article>
          ) : null}
          {canAdminister ? (
            <article className="card">
              <h2>Invite a member</h2>
              <p>Invitations can grant player or observer access only.</p>
              <form className="form-stack" onSubmit={(event) => void invite(event)}>
                <label>
                  Email
                  <input name="email" required type="email" />
                </label>
                <label>
                  Role
                  <select name="role">
                    <option value="player">Player</option>
                    <option value="observer">Observer</option>
                  </select>
                </label>
                <button className="button" type="submit">
                  Create invitation
                </button>
              </form>
              <h3>Pending invitations</h3>
              {invitations.filter((item) => item.status === 'pending').length === 0 ? (
                <p className="field-help">No pending invitations.</p>
              ) : (
                <ul className="audit-list">
                  {invitations
                    .filter((item) => item.status === 'pending')
                    .map((item) => (
                      <li key={item.id}>
                        <span>
                          {item.email} · {item.intendedRole}
                        </span>
                        <button
                          className="text-button"
                          onClick={() => void revokeInvitation(item)}
                          type="button"
                        >
                          Revoke…
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </article>
          ) : null}
          {hasCreatorAuthority && audit.length > 0 ? (
            <article className="card">
              <h2>Authority audit</h2>
              <ul className="audit-list">
                {audit.slice(0, 8).map((item) => (
                  <li key={String(item.id)}>
                    <strong>{String(item.action)}</strong>
                    <span>
                      {String(item.outcome)} · {String(item.reasonCode)}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
        </section>
      ) : (
        <section aria-label="World memberships" className="member-list">
          {members.map((member) => {
            const isSelf = member.user.id === session?.user.id;
            return (
              <article className="card member-row" key={member.user.id}>
                <div>
                  <h2>
                    {member.user.displayName ?? 'Unnamed member'} {isSelf ? '(you)' : ''}
                  </h2>
                  <span className={`role-badge role-${member.role}`}>{member.role}</span>
                </div>
                <div className="member-actions">
                  {hasCreatorAuthority && member.role !== 'creator' ? (
                    <select
                      aria-label={`New role for ${member.user.displayName ?? 'member'}`}
                      defaultValue={member.role}
                      onChange={(event) =>
                        void changeRole(member, event.target.value as Exclude<WorldRole, 'creator'>)
                      }
                    >
                      <option value="administrator">Administrator</option>
                      <option value="player">Player</option>
                      <option value="observer">Observer</option>
                    </select>
                  ) : null}
                  {hasCreatorAuthority && member.role === 'administrator' ? (
                    <button
                      className="button danger"
                      onClick={() => {
                        setOverrideTarget(member);
                        overrideDialog.current?.showModal();
                      }}
                      type="button"
                    >
                      Creator override…
                    </button>
                  ) : null}
                  {canAdminister && ['player', 'observer'].includes(member.role) && !isSelf ? (
                    <button
                      className="button secondary"
                      onClick={() => void remove(member)}
                      type="button"
                    >
                      Remove…
                    </button>
                  ) : null}
                  {member.role === 'creator' ? (
                    <span className="field-help">
                      The sole creator cannot be removed or demoted.
                    </span>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      )}
      <dialog className="modal" ref={inviteDialog}>
        <h2>Invitation created</h2>
        <p>This link is shown once. Share it through a trusted channel.</p>
        <label>
          Invitation link
          <input readOnly value={inviteLink} />
        </label>
        <div className="actions">
          <button
            className="button"
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink);
              setStatus('Invitation link copied.');
            }}
            type="button"
          >
            Copy link
          </button>
          <button
            className="button secondary"
            onClick={() => {
              setInviteLink('');
              inviteDialog.current?.close();
            }}
            type="button"
          >
            Done
          </button>
        </div>
      </dialog>
      <dialog className="modal" ref={overrideDialog}>
        <form className="form-stack" onSubmit={(event) => void override(event)}>
          <p className="eyebrow">Exceptional authority</p>
          <h2>Demote administrator with creator override</h2>
          <p>
            This bypasses the ordinary role-change rule and creates a linked, immutable security
            record.
          </p>
          <label>
            Reason
            <textarea maxLength={500} minLength={10} name="reason" required />
          </label>
          <label>
            Type <strong>USE CREATOR OVERRIDE</strong>
            <input autoComplete="off" name="confirmation" pattern="USE CREATOR OVERRIDE" required />
          </label>
          <div className="actions">
            <button className="button danger" type="submit">
              Apply override
            </button>
            <button
              className="button secondary"
              onClick={() => overrideDialog.current?.close()}
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
