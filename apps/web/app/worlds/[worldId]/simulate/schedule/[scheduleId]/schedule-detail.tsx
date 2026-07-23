'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ScheduledActionV1 } from '@worldgraph/contracts';

import { BrowserApiError, requestJson } from '../../../../../lib/browser-api';

export function ScheduledActionDetail({
  scheduleId,
  worldId,
}: {
  scheduleId: string;
  worldId: string;
}) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<ScheduledActionV1 | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setAction(
        await requestJson<ScheduledActionV1>(
          `/api/v1/worlds/${worldId}/simulation/schedule/${scheduleId}`,
        ),
      );
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(
          `/sign-in?returnTo=${encodeURIComponent(
            `/worlds/${worldId}/simulate/schedule/${scheduleId}`,
          )}`,
        );
        return;
      }
      setError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'SIMULATION_UNAVAILABLE: The scheduled action could not be read.',
      );
    }
  }, [router, scheduleId, worldId]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  return (
    <main className="app-page shell runtime-page simulation-page" id="main-content">
      <header className="app-header">
        <Link className="brand-link" href={`/worlds/${worldId}/simulate`}>
          ← Simulate
        </Link>
        <Link
          href={`/worlds/${worldId}/history?targetType=scheduled_action&targetId=${scheduleId}`}
        >
          Related History
        </Link>
      </header>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Durable schedule</p>
          <h1>Scheduled action detail</h1>
          <p className="lede compact">
            This view is membership-scoped and applies notice visibility before returning content.
          </p>
        </div>
      </section>
      {error ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <p>{error}</p>
          <button className="secondary-button" onClick={() => void load()} type="button">
            Retry authoritative read
          </button>
        </div>
      ) : null}
      {!action && !error ? (
        <div aria-busy="true" className="card">
          Loading the authoritative scheduled action…
        </div>
      ) : null}
      {action ? (
        <article className="card">
          <span className="manifest-state draft">{action.status}</span>
          <h2>{action.actionType}</h2>
          <dl className="facts compact-facts">
            <div>
              <dt>Due tick</dt>
              <dd>{action.dueTick}</dd>
            </div>
            <div>
              <dt>Priority / sequence</dt>
              <dd>
                {action.priority} / {action.scheduleSequence}
              </dd>
            </div>
            <div>
              <dt>Process / schema</dt>
              <dd>
                {action.processVersion} / {action.actionSchemaVersion}
              </dd>
            </div>
            <div>
              <dt>Created state revision</dt>
              <dd>{action.createdStateRevision}</dd>
            </div>
            <div>
              <dt>Completed state revision</dt>
              <dd>{action.completedStateRevision ?? 'not terminal'}</dd>
            </div>
            <div>
              <dt>Payload hash</dt>
              <dd className="hash-value">{action.payloadHash}</dd>
            </div>
          </dl>
          {action.actionType === 'EmitWorldNoticeV1' ? (
            <section aria-labelledby="notice-payload-heading" className="review-section">
              <h3 id="notice-payload-heading">Visible notice payload</h3>
              <p>{action.payload.text}</p>
              <p className="compact-note">Visibility: {action.payload.visibility}</p>
            </section>
          ) : (
            <section aria-labelledby="commerce-payload-heading" className="review-section">
              <h3 id="commerce-payload-heading">Scheduled world operation</h3>
              <p className="compact-note">
                This system operation carries only the identifier of its authoritative target.
              </p>
              <dl className="facts compact-facts">
                <div>
                  <dt>Target identifier</dt>
                  <dd>
                    {'productionRunId' in action.payload
                      ? action.payload.productionRunId
                      : 'payrollRecordId' in action.payload
                        ? action.payload.payrollRecordId
                        : 'listingId' in action.payload
                          ? action.payload.listingId
                          : action.payload.taxPolicyId}
                  </dd>
                </div>
              </dl>
            </section>
          )}
        </article>
      ) : null}
    </main>
  );
}
