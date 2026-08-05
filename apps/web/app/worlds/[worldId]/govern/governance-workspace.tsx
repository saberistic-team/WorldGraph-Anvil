'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { BrowserApiError, formString, mutateJson, requestJson } from '../../../lib/browser-api';
import {
  attachGovernanceApproval,
  governanceApprovalReviewCommand,
  officeAppointmentPayload,
  officeRemovalPayload,
  proposalWithdrawalPayload,
  type GovernanceOperatorActorMode,
  type GovernanceSubmitCommand,
} from './governance-command-model';
import {
  actionSummary,
  ballotDisclosureText,
  formatBasisPoints,
  governanceBallotEligibility,
  governanceBallotEligible,
  governanceCapability,
  governanceErrorMessage,
  governanceProjectionStatus,
  humanizeGovernance,
  loadBoundedGovernancePages,
  maximumGovernanceEvaluatedAtTick,
  maximumGovernanceProjectionRevision,
  minimumGovernanceEvaluatedAtTick,
  minimumGovernanceProjectionRevision,
  tickWindowState,
  type GovernSection,
  type GovernanceCandidacyViewV1,
  type GovernanceCharterViewV1,
  type GovernanceClockView,
  type GovernanceElectionResultViewV1,
  type GovernanceElectionViewV1,
  type GovernancePage,
  type GovernanceProposalResultViewV1,
  type GovernanceProposalViewV1,
  type GovernanceRuntimeHead,
  type GovernanceUiCapabilitiesViewV1,
  type GovernanceUiCapabilityDecisionV1,
  type GovernanceWorkspaceData,
} from './governance-model';
import { GovernanceCoherenceBanner } from './governance-coherence-banner';

interface GovernanceWorkspaceProps {
  section: GovernSection;
  worldId: string;
}

type Feedback =
  | { kind: 'idle'; message: '' }
  | { commandId: string; kind: 'pending' | 'success'; message: string }
  | { code?: string; commandId?: string; kind: 'error'; message: string };

interface GovernanceCommandResult {
  commandId: string;
  rejectionCode?: string;
  resultingStateRevision?: string;
  status: 'accepted' | 'failed' | 'received' | 'rejected';
}

interface RecentCredentialProof {
  expiresAt: string;
  proofToken: string;
}

type CommandSubmissionDisposition = 'accepted' | 'known_failure' | 'uncertain';

const emptyData: Omit<
  GovernanceWorkspaceData,
  | 'capabilities'
  | 'charter'
  | 'evaluatedAtTick'
  | 'latestEvaluatedAtTick'
  | 'latestProjectionRevision'
  | 'projectionRevision'
> = {
  audit: [],
  elections: [],
  institutions: [],
  laws: [],
  offices: [],
  proposals: [],
  terms: [],
};

const realtimeEventTypes = [
  'WorldGovernanceInitializedV1',
  'GovernanceSeedPlanAdoptedV1',
  'GovernanceCandidacyChangedV1',
  'GovernanceLifecycleChangedV1',
  'GovernanceResultFinalizedV1',
  'GovernanceLawVersionActivatedV1',
  'GovernanceOfficeTermChangedV1',
  'GovernanceOverrideExecutedV1',
  'GovernanceRepairAppendedV1',
  'ProposalBallotRecordedPublicV1',
  'ProposalBallotRecordedSecretV1',
  'ElectionBallotRecordedPublicV1',
  'ElectionBallotRecordedSecretV1',
] as const;

export function GovernanceWorkspace({ section, worldId }: GovernanceWorkspaceProps) {
  const router = useRouter();
  const errorRef = useRef<HTMLDivElement>(null);
  const projectionRefreshTimer = useRef<number | undefined>(undefined);
  const refreshTimer = useRef<number | undefined>(undefined);
  const [data, setData] = useState<GovernanceWorkspaceData | null>(null);
  const [runtime, setRuntime] = useState<GovernanceRuntimeHead | null>(null);
  const [clock, setClock] = useState<GovernanceClockView | null>(null);
  const [candidacies, setCandidacies] = useState<Record<string, GovernanceCandidacyViewV1[]>>({});
  const [proposalResults, setProposalResults] = useState<
    Record<string, GovernanceProposalResultViewV1>
  >({});
  const [electionResults, setElectionResults] = useState<
    Record<string, GovernanceElectionResultViewV1>
  >({});
  const [receiptMessages, setReceiptMessages] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle', message: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      const base = `/api/v1/worlds/${worldId}/governance`;
      const [
        charter,
        capabilities,
        institutions,
        laws,
        offices,
        terms,
        proposals,
        elections,
        audit,
        head,
        clockView,
      ] = await Promise.all([
        requestJson<GovernanceCharterViewV1>(`${base}/charter`),
        requestJson<GovernanceUiCapabilitiesViewV1>(`${base}/capabilities`),
        governancePage<GovernanceWorkspaceData['institutions'][number]>(worldId, 'institutions'),
        governancePage<GovernanceWorkspaceData['laws'][number]>(worldId, 'laws'),
        governancePage<GovernanceWorkspaceData['offices'][number]>(worldId, 'offices'),
        governancePage<GovernanceWorkspaceData['terms'][number]>(worldId, 'terms'),
        governancePage<GovernanceWorkspaceData['proposals'][number]>(worldId, 'proposals'),
        governancePage<GovernanceWorkspaceData['elections'][number]>(worldId, 'elections'),
        governancePage<GovernanceWorkspaceData['audit'][number]>(worldId, 'audit'),
        requestJson<GovernanceRuntimeHead>(`/api/v1/worlds/${worldId}/runtime-head`),
        requestJson<GovernanceClockView>(`/api/v1/worlds/${worldId}/simulation/clock`),
      ]);
      const governancePages = [institutions, laws, offices, terms, proposals, elections, audit];
      const candidatePages =
        section === 'elections'
          ? await Promise.all(
              elections.items.map(
                async (election) =>
                  [
                    election.electionId,
                    await governancePage<GovernanceCandidacyViewV1>(
                      worldId,
                      `elections/${election.electionId}/candidates`,
                    ),
                  ] as const,
              ),
            )
          : [];
      const allGovernancePages = [...governancePages, ...candidatePages.map(([, page]) => page)];
      const allGovernanceReads = [charter, capabilities, ...allGovernancePages];
      const next: GovernanceWorkspaceData = {
        ...emptyData,
        audit: audit.items,
        capabilities,
        charter,
        elections: elections.items,
        evaluatedAtTick: minimumGovernanceEvaluatedAtTick(allGovernanceReads),
        institutions: institutions.items,
        latestEvaluatedAtTick: maximumGovernanceEvaluatedAtTick(allGovernanceReads),
        laws: laws.items,
        latestProjectionRevision: maximumGovernanceProjectionRevision(allGovernanceReads),
        offices: offices.items,
        projectionRevision: minimumGovernanceProjectionRevision(allGovernanceReads),
        proposals: proposals.items,
        terms: terms.items,
      };
      setData(next);
      setRuntime(head);
      setClock(clockView);
      setCandidacies(
        Object.fromEntries(candidatePages.map(([electionId, page]) => [electionId, page.items])),
      );
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 401) {
        router.replace(
          `/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/govern/${section}`)}`,
        );
        return;
      }
      setError(
        cause instanceof BrowserApiError
          ? `${cause.failure.code}: ${cause.failure.message}`
          : 'GOVERNANCE_UNAVAILABLE: The authoritative governance projection could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [router, section, worldId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const source = new EventSource(`/api/v1/worlds/${worldId}/governance/stream`);
    const refresh = () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void load(), 150);
    };
    for (const eventType of realtimeEventTypes) source.addEventListener(eventType, refresh);
    return () => {
      source.close();
      window.clearTimeout(refreshTimer.current);
      for (const eventType of realtimeEventTypes) source.removeEventListener(eventType, refresh);
    };
  }, [load, worldId]);

  useEffect(() => {
    if (error || feedback.kind === 'error') errorRef.current?.focus();
  }, [error, feedback]);

  const currentTick = clock?.clock.currentTick ?? '0';
  const projectionStatus = governanceProjectionStatus(
    data?.projectionRevision ?? '0',
    data?.latestProjectionRevision ?? data?.projectionRevision ?? '0',
    data?.evaluatedAtTick ?? '0',
    data?.latestEvaluatedAtTick ?? data?.evaluatedAtTick ?? '0',
  );
  const actionsPending = feedback.kind === 'pending' || projectionStatus.catchingUp;
  const operatorVisible = data
    ? (['operator.override', 'operator.repair'] as const).some(
        (capability) => governanceCapability(data.capabilities, capability, worldId)?.allowed,
      )
    : false;

  useEffect(() => {
    window.clearTimeout(projectionRefreshTimer.current);
    if (!projectionStatus.catchingUp) return;
    projectionRefreshTimer.current = window.setTimeout(() => void load(), 500);
    return () => window.clearTimeout(projectionRefreshTimer.current);
  }, [load, projectionStatus.catchingUp]);

  const prepareCommand = useCallback(
    (
      type: string,
      payload: Record<string, unknown>,
      aggregateVersion: string,
    ): GovernanceSubmitCommand | null => {
      if (!runtime || !clock || !data || actionsPending) return null;
      const commandId = crypto.randomUUID();
      const idempotencyKey = crypto.randomUUID();
      return {
        commandId,
        expectedAggregateVersion: aggregateVersion,
        expectedStateRevision: runtime.stateRevision,
        expectedTick: clock.clock.currentTick,
        expectedWorldVersion: runtime.designVersion,
        idempotencyKey,
        payload,
        schemaVersion: 1,
        type,
      };
    },
    [actionsPending, clock, data, runtime],
  );

  const submitCommand = useCallback(
    async (
      command: GovernanceSubmitCommand,
      proofToken?: string,
    ): Promise<CommandSubmissionDisposition> => {
      if (feedback.kind === 'pending') return 'known_failure';
      const { commandId, idempotencyKey, type } = command;
      setFeedback({ commandId, kind: 'pending', message: `${humanizeGovernance(type)} pending…` });
      try {
        const result = await mutateJson<GovernanceCommandResult>(
          `/api/v1/worlds/${worldId}/commands`,
          'POST',
          command,
          idempotencyKey,
          proofToken ? { 'x-recent-credential-proof': proofToken } : {},
        );
        if (result.status !== 'accepted') {
          const code = result.rejectionCode ?? `COMMAND_${result.status.toUpperCase()}`;
          setFeedback({
            code,
            commandId,
            kind: 'error',
            message: governanceErrorMessage(code, `The command ended as ${result.status}.`),
          });
          return 'known_failure';
        }
        setFeedback({
          commandId,
          kind: 'success',
          message: `Accepted at authoritative revision ${result.resultingStateRevision ?? 'pending projection'}.`,
        });
        await load();
        return 'accepted';
      } catch (cause) {
        if (cause instanceof BrowserApiError && cause.status === 401) {
          router.replace(
            `/sign-in?returnTo=${encodeURIComponent(`/worlds/${worldId}/govern/${section}`)}`,
          );
          return 'known_failure';
        }
        const code = cause instanceof BrowserApiError ? cause.failure.code : 'COMMAND_UNAVAILABLE';
        setFeedback({
          code,
          commandId,
          kind: 'error',
          message: governanceErrorMessage(
            code,
            cause instanceof BrowserApiError
              ? cause.failure.message
              : 'The command outcome could not be confirmed. Check its command ID before retrying.',
          ),
        });
        return cause instanceof BrowserApiError && cause.status < 500
          ? 'known_failure'
          : 'uncertain';
      }
    },
    [feedback.kind, load, router, section, worldId],
  );

  const runCommand = useCallback(
    async (type: string, payload: Record<string, unknown>, aggregateVersion: string) => {
      const command = prepareCommand(type, payload, aggregateVersion);
      if (command) await submitCommand(command);
    },
    [prepareCommand, submitCommand],
  );

  const loadProposalEvidence = useCallback(
    async (proposal: GovernanceProposalViewV1) => {
      const base = `/api/v1/worlds/${worldId}/governance/proposals/${proposal.proposalId}`;
      const [receipt, result] = await Promise.all([
        optionalJson<Record<string, unknown>>(`${base}/receipt`),
        optionalJson<GovernanceProposalResultViewV1>(`${base}/result`),
      ]);
      if (receipt) {
        setReceiptMessages((current) => ({
          ...current,
          [proposal.proposalId]: receiptMessage(receipt),
        }));
      }
      if (result) {
        setProposalResults((current) => ({ ...current, [proposal.proposalId]: result }));
      }
    },
    [worldId],
  );

  const loadElectionEvidence = useCallback(
    async (election: GovernanceElectionViewV1) => {
      const base = `/api/v1/worlds/${worldId}/governance/elections/${election.electionId}`;
      const [receipt, result] = await Promise.all([
        optionalJson<Record<string, unknown>>(`${base}/receipt`),
        optionalJson<GovernanceElectionResultViewV1>(`${base}/result`),
      ]);
      if (receipt) {
        setReceiptMessages((current) => ({
          ...current,
          [election.electionId]: receiptMessage(receipt),
        }));
      }
      if (result) {
        setElectionResults((current) => ({ ...current, [election.electionId]: result }));
      }
    },
    [worldId],
  );

  if (loading && !data)
    return (
      <GovernanceShell current={section} worldId={worldId}>
        Loading governance…
      </GovernanceShell>
    );

  if (!data || error) {
    return (
      <GovernanceShell current={section} worldId={worldId}>
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Governance is unavailable</strong>
          <p>{error || 'The world has no explicit governance initialization yet.'}</p>
          <button className="button secondary" onClick={() => void load()} type="button">
            Try again
          </button>
        </div>
      </GovernanceShell>
    );
  }

  return (
    <GovernanceShell current={section} operatorVisible={operatorVisible} worldId={worldId}>
      <header className="govern-heading">
        <div>
          <p className="eyebrow">Schema-defined civic authority</p>
          <h1>{sectionTitle(section)}</h1>
          <p>
            Authoritative tick {currentTick} · projection revision {data.projectionRevision}
          </p>
        </div>
        <span className="govern-status-pill">{humanizeGovernance(data.charter.title)}</span>
      </header>

      <section aria-label="Your governance authority" className="govern-authority-state">
        <strong>{humanizeGovernance(data.capabilities.actor.authorityState)}</strong>
        <span>
          Authority evaluated at tick {data.capabilities.evaluatedAtTick} ·{' '}
          {data.capabilities.actor.actorEntityKey ?? 'no unambiguous world identity'}
        </span>
      </section>

      <GovernanceCoherenceBanner status={projectionStatus} />

      {feedback.kind === 'error' ? (
        <div className="error-summary" ref={errorRef} role="alert" tabIndex={-1}>
          <strong>Action not completed</strong>
          <p>{feedback.message}</p>
          {feedback.commandId ? <code>{feedback.commandId}</code> : null}
        </div>
      ) : null}
      <p aria-atomic="true" aria-live="polite" className="success-message">
        {feedback.kind === 'pending' || feedback.kind === 'success' ? feedback.message : ''}
      </p>

      {section === 'overview' ? (
        <Overview
          currentTick={currentTick}
          data={data}
          pending={actionsPending}
          runCommand={runCommand}
        />
      ) : null}
      {section === 'laws' ? <Laws data={data} currentTick={currentTick} /> : null}
      {section === 'proposals' ? (
        <Proposals
          currentTick={currentTick}
          data={data}
          loadEvidence={loadProposalEvidence}
          pending={actionsPending}
          results={proposalResults}
          receiptMessages={receiptMessages}
          runCommand={runCommand}
        />
      ) : null}
      {section === 'elections' ? (
        <Elections
          candidacies={candidacies}
          currentTick={currentTick}
          data={data}
          loadEvidence={loadElectionEvidence}
          pending={actionsPending}
          receiptMessages={receiptMessages}
          results={electionResults}
          runCommand={runCommand}
        />
      ) : null}
      {section === 'audit' ? <Audit data={data} /> : null}
      {section === 'override' ? (
        operatorVisible ? (
          <OperatorActions
            currentTick={currentTick}
            operatorActorMode={
              data.capabilities.actor.authorityState === 'platform_administrator'
                ? 'administrator'
                : 'creator'
            }
            overrideDecision={governanceCapability(data.capabilities, 'operator.override', worldId)}
            pending={actionsPending}
            prepareCommand={prepareCommand}
            repairDecision={governanceCapability(data.capabilities, 'operator.repair', worldId)}
            submitCommand={submitCommand}
            worldId={worldId}
          />
        ) : (
          <AuthorityNotice
            decision={
              governanceCapability(data.capabilities, 'operator.override', worldId) ??
              governanceCapability(data.capabilities, 'operator.repair', worldId)
            }
            label="Operator actions"
          />
        )
      ) : null}
    </GovernanceShell>
  );
}

function GovernanceShell({
  children,
  current,
  operatorVisible = false,
  worldId,
}: {
  children: ReactNode;
  current: GovernSection;
  operatorVisible?: boolean;
  worldId: string;
}) {
  const areas: Array<[GovernSection, string]> = [
    ['overview', 'Charter & offices'],
    ['laws', 'Laws'],
    ['proposals', 'Proposals'],
    ['elections', 'Elections'],
    ['audit', 'Public audit'],
    ['override', 'Operator actions'],
  ];
  return (
    <main className="app-page shell wide-shell govern-page" id="main-content">
      <header className="app-header runtime-header">
        <Link className="brand" href="/worlds">
          WorldGraph
        </Link>
        <nav aria-label="World sections" className="runtime-nav">
          <Link href={`/worlds/${worldId}/overview`}>Overview</Link>
          <Link href={`/worlds/${worldId}/graph`}>Graph</Link>
          <Link href={`/worlds/${worldId}/simulate`}>Simulate</Link>
          <Link href={`/worlds/${worldId}/history`}>History</Link>
          <Link href={`/worlds/${worldId}/economy`}>Economy</Link>
          <Link aria-current="page" href={`/worlds/${worldId}/govern`}>
            Govern
          </Link>
        </nav>
      </header>
      <nav aria-label="Governance areas" className="govern-nav">
        {areas
          .filter(([area]) => area !== 'override' || operatorVisible)
          .map(([area, label]) => (
            <Link
              aria-current={current === area ? 'page' : undefined}
              href={
                area === 'overview'
                  ? `/worlds/${worldId}/govern`
                  : `/worlds/${worldId}/govern/${area}`
              }
              key={area}
            >
              {label}
            </Link>
          ))}
      </nav>
      {children}
    </main>
  );
}

function Overview({
  currentTick,
  data,
  pending,
  runCommand,
}: {
  currentTick: string;
  data: GovernanceWorkspaceData;
  pending: boolean;
  runCommand: (type: string, payload: Record<string, unknown>, version: string) => Promise<void>;
}) {
  return (
    <div className="govern-grid">
      <section className="card govern-charter-card" aria-labelledby="charter-heading">
        <p className="eyebrow">Governing charter · version {data.charter.version}</p>
        <h2 id="charter-heading">{data.charter.title}</h2>
        <p>{data.charter.summary}</p>
        <dl className="govern-facts">
          <div>
            <dt>Effective</dt>
            <dd>
              Ticks {data.charter.effectiveFromTick}–
              {data.charter.effectiveUntilTick ?? 'open ended'}
            </dd>
          </div>
          <div>
            <dt>Current tick</dt>
            <dd>{currentTick}</dd>
          </div>
          <div>
            <dt>Proposal approval</dt>
            <dd>{formatBasisPoints(data.charter.proposalRules.approvalThresholdBps)}</dd>
          </div>
          <div>
            <dt>Proposal quorum</dt>
            <dd>{formatBasisPoints(data.charter.proposalRules.quorumBps)}</dd>
          </div>
          <div>
            <dt>Proposal phases</dt>
            <dd>
              {data.charter.proposalRules.sponsorshipTicks} sponsorship ·{' '}
              {data.charter.proposalRules.debateTicks} debate ·{' '}
              {data.charter.proposalRules.votingTicks} voting ticks
            </dd>
          </div>
          <div>
            <dt>Checksum</dt>
            <dd>
              <code>{shortHash(data.charter.checksum)}</code>
            </dd>
          </div>
        </dl>
      </section>
      <section className="card" aria-labelledby="institutions-heading">
        <h2 id="institutions-heading">Institutions</h2>
        <ul className="govern-list">
          {data.institutions.map((institution) => (
            <li key={institution.institutionId}>
              <strong>{institution.displayName}</strong>
              <span>
                {humanizeGovernance(institution.institutionType)} ·{' '}
                {humanizeGovernance(institution.status)}
              </span>
              <small>Jurisdiction: {institution.jurisdictionEntityKey}</small>
            </li>
          ))}
          {data.institutions.length === 0 ? <li>No institutions are projected.</li> : null}
        </ul>
      </section>
      <section className="card govern-wide" aria-labelledby="offices-heading">
        <h2 id="offices-heading">Offices and immutable terms</h2>
        <div aria-label="Offices and immutable terms table" className="table-scroll" tabIndex={0}>
          <table className="govern-table">
            <thead>
              <tr>
                <th scope="col">Office</th>
                <th scope="col">Seats</th>
                <th scope="col">Tie rule</th>
                <th scope="col">Current and scheduled terms</th>
                <th scope="col">Authorized actions</th>
              </tr>
            </thead>
            <tbody>
              {data.offices.map((office) => (
                <tr key={office.officeId}>
                  <th scope="row">
                    {office.displayName}
                    <small>{office.stableKey}</small>
                  </th>
                  <td>{office.seats}</td>
                  <td>{humanizeGovernance(office.tieRule)}</td>
                  <td>
                    {data.terms
                      .filter((term) => term.officeId === office.officeId)
                      .map((term) => (
                        <div className="govern-term" key={term.termId}>
                          {term.holderEntityKey} · seat {term.seatIndex + 1} · ticks{' '}
                          {term.startsAtTick}–{term.endsAtTick} · {humanizeGovernance(term.status)}
                          {term.status === 'active' || term.status === 'scheduled' ? (
                            governanceCapability(data.capabilities, 'office.remove', term.termId)
                              ?.allowed ? (
                              <form
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  const form = new FormData(event.currentTarget);
                                  void runCommand(
                                    'RemoveOfficeholderV1',
                                    officeRemovalPayload(
                                      term,
                                      formString(form, 'effectiveAtTick'),
                                      formString(form, 'reason'),
                                    ),
                                    term.aggregateVersion,
                                  );
                                }}
                              >
                                <fieldset disabled={pending}>
                                  <legend>Remove this officeholder</legend>
                                  <label>
                                    Effective tick
                                    <input
                                      defaultValue={currentTick}
                                      min="0"
                                      name="effectiveAtTick"
                                      required
                                      type="number"
                                    />
                                  </label>
                                  <label>
                                    Reason
                                    <input minLength={8} name="reason" required />
                                  </label>
                                  <button className="button secondary" type="submit">
                                    Remove officeholder
                                  </button>
                                </fieldset>
                              </form>
                            ) : (
                              <AuthorityNotice
                                decision={governanceCapability(
                                  data.capabilities,
                                  'office.remove',
                                  term.termId,
                                )}
                                label="Remove officeholder"
                              />
                            )
                          ) : null}
                        </div>
                      ))}
                    {data.terms.every((term) => term.officeId !== office.officeId)
                      ? 'Vacant'
                      : null}
                  </td>
                  <td>
                    {governanceCapability(data.capabilities, 'office.appoint', office.officeId)
                      ?.allowed ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void runCommand(
                            'AppointOfficeholderV1',
                            officeAppointmentPayload(office, {
                              holderEntityKey: formString(form, 'holderEntityKey'),
                              reason: formString(form, 'reason'),
                              seatIndex: formString(form, 'seatIndex'),
                              termEndsAtTick: formString(form, 'termEndsAtTick'),
                              termStartsAtTick: formString(form, 'termStartsAtTick'),
                            }),
                            office.aggregateVersion,
                          );
                        }}
                      >
                        <fieldset disabled={pending}>
                          <legend>Appoint an officeholder</legend>
                          <label>
                            Holder entity key
                            <input
                              name="holderEntityKey"
                              pattern="[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+"
                              required
                            />
                          </label>
                          <label>
                            Seat index
                            <input
                              max={office.seats - 1}
                              min="0"
                              name="seatIndex"
                              required
                              type="number"
                            />
                          </label>
                          <label>
                            Starts tick
                            <input
                              defaultValue={currentTick}
                              min="0"
                              name="termStartsAtTick"
                              required
                              type="number"
                            />
                          </label>
                          <label>
                            Ends tick
                            <input min="1" name="termEndsAtTick" required type="number" />
                          </label>
                          <label>
                            Reason
                            <input minLength={8} name="reason" required />
                          </label>
                          <button type="submit">Appoint officeholder</button>
                        </fieldset>
                      </form>
                    ) : (
                      <AuthorityNotice
                        decision={governanceCapability(
                          data.capabilities,
                          'office.appoint',
                          office.officeId,
                        )}
                        label="Appoint officeholder"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Laws({ data, currentTick }: { data: GovernanceWorkspaceData; currentTick: string }) {
  return (
    <section className="card govern-table-card" aria-labelledby="laws-heading">
      <div className="govern-section-heading">
        <div>
          <h2 id="laws-heading">Versioned laws</h2>
          <p>
            Intervals are authoritative and half-open; historical versions are never edited in
            place.
          </p>
        </div>
        <span>Tick {currentTick}</span>
      </div>
      <div aria-label="Versioned laws table" className="table-scroll" tabIndex={0}>
        <table className="govern-table">
          <thead>
            <tr>
              <th scope="col">Law</th>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Effective interval</th>
              <th scope="col">Summary</th>
            </tr>
          </thead>
          <tbody>
            {data.laws.map((law) => (
              <tr key={`${law.lawId}:${law.lawVersion}`}>
                <th scope="row">
                  {law.title}
                  <small>{law.stableKey}</small>
                </th>
                <td>{law.lawVersion}</td>
                <td>
                  <Status value={law.status} />
                </td>
                <td>
                  [{law.effectiveFromTick}, {law.effectiveUntilTick ?? '∞'})
                </td>
                <td>{law.summary}</td>
              </tr>
            ))}
            {data.laws.length === 0 ? (
              <tr>
                <td colSpan={5}>No law versions have been enacted.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Proposals({
  currentTick,
  data,
  loadEvidence,
  pending,
  receiptMessages,
  results,
  runCommand,
}: {
  currentTick: string;
  data: GovernanceWorkspaceData;
  loadEvidence: (proposal: GovernanceProposalViewV1) => Promise<void>;
  pending: boolean;
  receiptMessages: Record<string, string>;
  results: Record<string, GovernanceProposalResultViewV1>;
  runCommand: (type: string, payload: Record<string, unknown>, version: string) => Promise<void>;
}) {
  const proposalInstitutions = data.institutions.filter(
    (institution) =>
      governanceCapability(data.capabilities, 'proposal.create', institution.institutionId)
        ?.allowed,
  );
  return (
    <div className="govern-stack">
      {proposalInstitutions.length > 0 ? (
        <ProposalCreateForm
          charter={data.charter}
          currentTick={currentTick}
          institutions={proposalInstitutions}
          pending={pending}
          proposalTargets={data.capabilities.proposalTargets}
          runCommand={runCommand}
        />
      ) : (
        <AuthorityNotice
          decision={
            data.institutions[0]
              ? governanceCapability(
                  data.capabilities,
                  'proposal.create',
                  data.institutions[0].institutionId,
                )
              : null
          }
          label="Create proposal"
        />
      )}
      <section aria-labelledby="proposal-list-heading">
        <div className="govern-section-heading">
          <div>
            <h2 id="proposal-list-heading">Proposal lifecycle</h2>
            <p>
              Sponsorship, debate, voting, tally, certification, and enactment remain distinct
              states.
            </p>
          </div>
          <span>{data.proposals.length} proposals</span>
        </div>
        <div className="govern-card-grid">
          {data.proposals.map((proposal) => {
            const windowState = tickWindowState(
              currentTick,
              proposal.votingOpensAtTick,
              proposal.votingClosesAtTick,
            );
            const result = results[proposal.proposalId];
            return (
              <article className="card govern-contest-card" key={proposal.proposalId}>
                <div className="govern-section-heading">
                  <div>
                    <p className="eyebrow">{proposal.proposalId}</p>
                    <h3>{proposal.title}</h3>
                  </div>
                  <Status value={proposal.status} />
                </div>
                <p>{proposal.body}</p>
                <div className="govern-effect">
                  <strong>Typed effect</strong>
                  <span>{actionSummary(proposal.action)}</span>
                </div>
                <dl className="govern-facts compact">
                  <div>
                    <dt>Sponsorship ends</dt>
                    <dd>{proposal.sponsorshipEndsAtTick}</dd>
                  </div>
                  <div>
                    <dt>Debate ends</dt>
                    <dd>{proposal.debateEndsAtTick}</dd>
                  </div>
                  <div>
                    <dt>Voting window</dt>
                    <dd>
                      [{proposal.votingOpensAtTick}, {proposal.votingClosesAtTick}) ·{' '}
                      {humanizeGovernance(windowState)}
                    </dd>
                  </div>
                  <div>
                    <dt>Quorum</dt>
                    <dd>{formatBasisPoints(proposal.quorumBps)}</dd>
                  </div>
                  <div>
                    <dt>Approval</dt>
                    <dd>{formatBasisPoints(proposal.approvalThresholdBps)}</dd>
                  </div>
                  <div>
                    <dt>Turnout</dt>
                    <dd>
                      {proposal.turnoutCount} / {proposal.eligibleCount ?? 'snapshot pending'}
                    </dd>
                  </div>
                </dl>
                {proposal.status === 'passed_but_enactment_failed' ? (
                  <div className="govern-recovery-guidance" role="note">
                    <strong>Vote passed; enactment rolled back atomically</strong>
                    <p>
                      No partial fiscal, law, project, or appointment effect is authoritative.
                      Preserve the certified result and use the linked operator compensation flow
                      only after the target versions, funds, and checksums are corrected.
                    </p>
                  </div>
                ) : null}
                <p className="govern-disclosure">{ballotDisclosureText(proposal.ballotPolicy)}</p>
                <div className="govern-inline-actions">
                  {['draft', 'sponsoring'].includes(proposal.status) &&
                  governanceCapability(data.capabilities, 'proposal.sponsor', proposal.proposalId)
                    ?.allowed ? (
                    <button
                      disabled={pending}
                      onClick={() =>
                        void runCommand(
                          'SponsorProposalV1',
                          {
                            expectedProposalVersion: proposal.aggregateVersion,
                            proposalId: proposal.proposalId,
                          },
                          proposal.aggregateVersion,
                        )
                      }
                      type="button"
                    >
                      Sponsor
                    </button>
                  ) : ['draft', 'sponsoring'].includes(proposal.status) ? (
                    <AuthorityNotice
                      decision={governanceCapability(
                        data.capabilities,
                        'proposal.sponsor',
                        proposal.proposalId,
                      )}
                      label="Sponsor proposal"
                    />
                  ) : null}
                  <button
                    className="button secondary"
                    onClick={() => void loadEvidence(proposal)}
                    type="button"
                  >
                    View my receipt & result
                  </button>
                </div>
                {['draft', 'sponsoring', 'debate', 'scheduled'].includes(proposal.status) &&
                governanceCapability(data.capabilities, 'proposal.withdraw', proposal.proposalId)
                  ?.allowed ? (
                  <form
                    className="govern-inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void runCommand(
                        'WithdrawProposalV1',
                        proposalWithdrawalPayload(proposal, formString(form, 'reason')),
                        proposal.aggregateVersion,
                      );
                    }}
                  >
                    <fieldset disabled={pending}>
                      <legend>Withdraw this proposal</legend>
                      <label>
                        Reason
                        <input minLength={8} name="reason" required />
                      </label>
                      <button className="button secondary" type="submit">
                        Withdraw proposal
                      </button>
                    </fieldset>
                  </form>
                ) : ['draft', 'sponsoring', 'debate', 'scheduled'].includes(proposal.status) ? (
                  <AuthorityNotice
                    decision={governanceCapability(
                      data.capabilities,
                      'proposal.withdraw',
                      proposal.proposalId,
                    )}
                    label="Withdraw proposal"
                  />
                ) : null}
                {proposal.status === 'open' &&
                proposal.eligibilitySnapshotId &&
                governanceCapability(data.capabilities, 'proposal.ballot.cast', proposal.proposalId)
                  ?.allowed &&
                governanceBallotEligible(
                  data.capabilities,
                  'proposal',
                  proposal.proposalId,
                  proposal.eligibilitySnapshotId,
                ) ? (
                  <form
                    className="govern-ballot-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void runCommand(
                        'CastProposalBallotV1',
                        {
                          choice: formString(form, 'choice'),
                          eligibilitySnapshotId: proposal.eligibilitySnapshotId,
                          expectedProposalVersion: proposal.aggregateVersion,
                          proposalId: proposal.proposalId,
                          replaceExisting: form.get('replaceExisting') === 'on',
                        },
                        proposal.aggregateVersion,
                      );
                    }}
                  >
                    <fieldset disabled={pending || windowState !== 'open'}>
                      <legend>Cast ballot</legend>
                      <label>
                        <input defaultChecked name="choice" type="radio" value="yes" /> Yes
                      </label>
                      <label>
                        <input name="choice" type="radio" value="no" /> No
                      </label>
                      <label>
                        <input name="choice" type="radio" value="abstain" /> Abstain
                      </label>
                      {governanceBallotEligibility(
                        data.capabilities,
                        'proposal',
                        proposal.proposalId,
                        proposal.eligibilitySnapshotId,
                      )?.ballotState === 'cast_replaceable' ? (
                        <p>
                          This submission replaces your existing effective ballot.
                          <input name="replaceExisting" type="hidden" value="on" />
                        </p>
                      ) : null}
                      <button type="submit">Submit ballot</button>
                    </fieldset>
                  </form>
                ) : proposal.status === 'open' && proposal.eligibilitySnapshotId ? (
                  <AuthorityNotice
                    decision={governanceCapability(
                      data.capabilities,
                      'proposal.ballot.cast',
                      proposal.proposalId,
                    )}
                    label={
                      governanceBallotEligible(
                        data.capabilities,
                        'proposal',
                        proposal.proposalId,
                        proposal.eligibilitySnapshotId,
                      )
                        ? 'Cast ballot'
                        : 'Cast ballot · not in the frozen eligibility snapshot'
                    }
                  />
                ) : proposal.status === 'open' ? (
                  <p role="status">Eligibility snapshot will appear when voting opens.</p>
                ) : null}
                {receiptMessages[proposal.proposalId] ? (
                  <p className="govern-receipt" role="status">
                    {receiptMessages[proposal.proposalId]}
                  </p>
                ) : null}
                {result ? <ProposalResult result={result} /> : null}
              </article>
            );
          })}
          {data.proposals.length === 0 ? (
            <div className="card empty-state">No proposals have been created.</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ProposalCreateForm({
  charter,
  currentTick,
  institutions,
  pending,
  proposalTargets,
  runCommand,
}: {
  charter: GovernanceCharterViewV1;
  currentTick: string;
  institutions: GovernanceWorkspaceData['institutions'];
  pending: boolean;
  proposalTargets: GovernanceUiCapabilitiesViewV1['proposalTargets'];
  runCommand: (type: string, payload: Record<string, unknown>, version: string) => Promise<void>;
}) {
  const [actionType, setActionType] = useState<'authorize_public_project' | 'update_tax'>(
    'update_tax',
  );
  const [selectedInstitutionId, setSelectedInstitutionId] = useState(
    institutions[0]?.institutionId ?? '',
  );
  const [selectedTaxPolicyId, setSelectedTaxPolicyId] = useState(
    proposalTargets.taxPolicies[0]?.policyId ?? '',
  );
  const [selectedTreasuryWalletId, setSelectedTreasuryWalletId] = useState(
    proposalTargets.treasuries[0]?.treasuryWalletId ?? '',
  );
  const selectedInstitution =
    institutions.find((institution) => institution.institutionId === selectedInstitutionId) ??
    institutions[0];
  const selectedTaxPolicy =
    proposalTargets.taxPolicies.find((target) => target.policyId === selectedTaxPolicyId) ??
    proposalTargets.taxPolicies[0];
  const selectedTreasury =
    proposalTargets.treasuries.find(
      (target) => target.treasuryWalletId === selectedTreasuryWalletId,
    ) ?? proposalTargets.treasuries[0];
  const proposalRules = charter.proposalRules;
  const sponsorshipEndsAtTick = (
    BigInt(currentTick) + BigInt(proposalRules.sponsorshipTicks)
  ).toString();
  const debateEndsAtTick = (
    BigInt(sponsorshipEndsAtTick) + BigInt(proposalRules.debateTicks)
  ).toString();
  const votingOpensAtTick = debateEndsAtTick;
  const votingClosesAtTick = (
    BigInt(votingOpensAtTick) + BigInt(proposalRules.votingTicks)
  ).toString();
  return (
    <details className="card govern-create-card">
      <summary>Create a typed proposal</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const payload = proposalPayload(form, actionType);
          void runCommand('CreateProposalV1', payload, '0');
        }}
      >
        <fieldset disabled={pending}>
          <legend>Proposal record</legend>
          <label>
            Institution
            <select
              name="institutionId"
              onChange={(event) => setSelectedInstitutionId(event.target.value)}
              required
              value={selectedInstitution?.institutionId ?? ''}
            >
              {institutions.map((institution) => (
                <option key={institution.institutionId} value={institution.institutionId}>
                  {institution.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Jurisdiction entity key
            <input
              name="jurisdictionEntityKey"
              pattern="[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+"
              readOnly
              required
              value={selectedInstitution?.jurisdictionEntityKey ?? ''}
            />
          </label>
          <label>
            Proposal key
            <input
              name="proposalKey"
              pattern="[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+"
              required
            />
          </label>
          <label>
            Title
            <input maxLength={160} name="title" required />
          </label>
          <label>
            Public rationale
            <textarea maxLength={10000} name="body" required />
          </label>
        </fieldset>
        <fieldset disabled={pending}>
          <legend>Charter-governed thresholds and exact ticks</legend>
          <p>The active charter fixes these values; they cannot be weakened by a proposer.</p>
          <div className="govern-form-grid">
            <label>
              Sponsorship ends
              <input name="sponsorshipEndsAtTick" readOnly value={sponsorshipEndsAtTick} />
            </label>
            <label>
              Debate ends
              <input name="debateEndsAtTick" readOnly value={debateEndsAtTick} />
            </label>
            <label>
              Voting opens
              <input name="votingOpensAtTick" readOnly value={votingOpensAtTick} />
            </label>
            <label>
              Voting closes
              <input name="votingClosesAtTick" readOnly value={votingClosesAtTick} />
            </label>
            <label>
              Minimum sponsors
              <input name="minimumSponsors" readOnly value={proposalRules.minimumSponsors} />
            </label>
            <label>
              Quorum (basis points)
              <input name="quorumBps" readOnly value={proposalRules.quorumBps} />
            </label>
            <label>
              Approval (basis points)
              <input
                name="approvalThresholdBps"
                readOnly
                value={proposalRules.approvalThresholdBps}
              />
            </label>
            <label>
              Charter version
              <input name="targetCharterVersion" readOnly value={charter.version} />
            </label>
            <label>
              Ballot mode
              <input name="ballotMode" readOnly value={proposalRules.ballotPolicy.ballotMode} />
            </label>
            <label>
              Public disclosure
              <input name="disclosure" readOnly value={proposalRules.ballotPolicy.disclosure} />
            </label>
            <label className="govern-check">
              <input
                checked={proposalRules.ballotPolicy.replacementAllowed}
                disabled
                type="checkbox"
              />{' '}
              Allow replacement
            </label>
            {proposalRules.ballotPolicy.replacementAllowed ? (
              <input name="replacementAllowed" type="hidden" value="on" />
            ) : null}
          </div>
        </fieldset>
        <fieldset disabled={pending}>
          <legend>Allowlisted effect</legend>
          <label>
            Action type
            <select
              onChange={(event) => setActionType(event.target.value as typeof actionType)}
              value={actionType}
            >
              <option value="update_tax">Bounded tax update</option>
              <option value="authorize_public_project">Public project authorization</option>
            </select>
          </label>
          {actionType === 'update_tax' ? (
            <div className="govern-form-grid">
              <label>
                Active tax policy
                <select
                  name="taxPolicyId"
                  onChange={(event) => setSelectedTaxPolicyId(event.target.value)}
                  required
                  value={selectedTaxPolicy?.policyId ?? ''}
                >
                  {proposalTargets.taxPolicies.map((target) => (
                    <option key={target.policyId} value={target.policyId}>
                      {target.policyKey} · {humanizeGovernance(target.taxType)} ·{' '}
                      {target.currentRateBps} bps
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Expected policy version
                <input
                  min="1"
                  name="expectedTaxPolicyVersion"
                  readOnly
                  required
                  type="number"
                  value={selectedTaxPolicy?.expectedPolicyVersion ?? ''}
                />
              </label>
              <label>
                Settlement identity
                <input
                  readOnly
                  value={
                    selectedTaxPolicy
                      ? `${selectedTaxPolicy.treasuryWalletKey} · ${selectedTaxPolicy.currencyCode} (${selectedTaxPolicy.currencyKey})`
                      : 'No active rate-based tax policy is available'
                  }
                />
              </label>
              <label>
                New rate (basis points)
                <input max="10000" min="0" name="newRateBps" required type="number" />
              </label>
              <label>
                Effective tick
                <input name="effectiveFromTick" readOnly value={votingClosesAtTick} />
              </label>
            </div>
          ) : (
            <div className="govern-form-grid">
              <label>
                Project key
                <select name="projectKey" required>
                  {proposalTargets.projectEntities.map((target) => (
                    <option key={target.projectEntityId} value={target.projectKey}>
                      {target.displayName} · {target.projectKey}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Budget key
                <input
                  defaultValue="budget:civic-platform-initiative"
                  name="budgetKey"
                  pattern="[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+"
                  required
                />
              </label>
              <label>
                Active treasury
                <select
                  name="treasuryWalletId"
                  onChange={(event) => setSelectedTreasuryWalletId(event.target.value)}
                  required
                  value={selectedTreasury?.treasuryWalletId ?? ''}
                >
                  {proposalTargets.treasuries.map((target) => (
                    <option key={target.treasuryWalletId} value={target.treasuryWalletId}>
                      {target.treasuryWalletKey} · {target.currencyCode} · spendable{' '}
                      {target.spendableMinor}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Currency ID
                <input
                  name="currencyId"
                  readOnly
                  required
                  value={selectedTreasury?.currencyId ?? ''}
                />
              </label>
              <label>
                Target versions
                <input
                  readOnly
                  value={
                    selectedTreasury
                      ? `wallet v${selectedTreasury.treasuryWalletVersion} · currency v${selectedTreasury.currencyVersion} · ${selectedTreasury.currencyKey}`
                      : 'No active treasury is available'
                  }
                />
              </label>
              <label>
                Amount (minor units)
                <input min="1" name="amountMinor" required type="number" />
              </label>
              <label>
                Effective tick
                <input name="effectiveAtTick" readOnly value={votingClosesAtTick} />
              </label>
              <label className="govern-form-wide">
                Project description
                <textarea maxLength={1000} name="description" required />
              </label>
            </div>
          )}
        </fieldset>
        <button
          disabled={
            pending ||
            (actionType === 'update_tax' && !selectedTaxPolicy) ||
            (actionType === 'authorize_public_project' &&
              (!selectedTreasury || proposalTargets.projectEntities.length === 0))
          }
          type="submit"
        >
          Create proposal
        </button>
      </form>
    </details>
  );
}

function Elections({
  candidacies,
  currentTick,
  data,
  loadEvidence,
  pending,
  receiptMessages,
  results,
  runCommand,
}: {
  candidacies: Record<string, GovernanceCandidacyViewV1[]>;
  currentTick: string;
  data: GovernanceWorkspaceData;
  loadEvidence: (election: GovernanceElectionViewV1) => Promise<void>;
  pending: boolean;
  receiptMessages: Record<string, string>;
  results: Record<string, GovernanceElectionResultViewV1>;
  runCommand: (type: string, payload: Record<string, unknown>, version: string) => Promise<void>;
}) {
  return (
    <section aria-labelledby="elections-heading">
      <div className="govern-section-heading">
        <div>
          <h2 id="elections-heading">Elections and transitions of power</h2>
          <p>
            Plurality contests use frozen eligibility, deterministic tie rules, and immutable
            certification.
          </p>
        </div>
        <span>{data.elections.length} elections</span>
      </div>
      <div className="govern-card-grid">
        {data.elections.map((election) => {
          const candidates = candidacies[election.electionId] ?? [];
          const windowState = tickWindowState(
            currentTick,
            election.votingOpensAtTick,
            election.votingClosesAtTick,
          );
          return (
            <article className="card govern-contest-card" key={election.electionId}>
              <div className="govern-section-heading">
                <div>
                  <p className="eyebrow">{election.electionId}</p>
                  <h3>{election.title}</h3>
                </div>
                <Status value={election.status} />
              </div>
              <dl className="govern-facts compact">
                <div>
                  <dt>Nominations</dt>
                  <dd>
                    [{election.nominationOpensAtTick}, {election.nominationClosesAtTick})
                  </dd>
                </div>
                <div>
                  <dt>Voting</dt>
                  <dd>
                    [{election.votingOpensAtTick}, {election.votingClosesAtTick}) ·{' '}
                    {humanizeGovernance(windowState)}
                  </dd>
                </div>
                <div>
                  <dt>Certification</dt>
                  <dd>{election.certificationAtTick}</dd>
                </div>
                <div>
                  <dt>Term starts</dt>
                  <dd>{election.termStartsAtTick}</dd>
                </div>
                <div>
                  <dt>Quorum</dt>
                  <dd>{formatBasisPoints(election.quorumBps)}</dd>
                </div>
                <div>
                  <dt>Tie rule</dt>
                  <dd>{humanizeGovernance(election.tieRule)}</dd>
                </div>
                <div>
                  <dt>Turnout</dt>
                  <dd>
                    {election.turnoutCount} / {election.eligibleCount ?? 'pending'}
                  </dd>
                </div>
              </dl>
              <p className="govern-disclosure">{ballotDisclosureText(election.ballotPolicy)}</p>
              <h4>Candidates</h4>
              <ul className="govern-list compact">
                {candidates.map((candidate) => (
                  <li key={candidate.candidacyId}>
                    <strong>{candidate.candidateEntityKey}</strong>
                    <span>{humanizeGovernance(candidate.status)}</span>
                    {candidate.status === 'nominated' &&
                    election.status === 'nominations_open' &&
                    candidate.candidateEntityKey === data.capabilities.actor.actorEntityKey ? (
                      governanceCapability(
                        data.capabilities,
                        'candidate.accept',
                        candidate.candidacyId,
                      )?.allowed ? (
                        <button
                          disabled={pending}
                          onClick={() =>
                            void runCommand(
                              'AcceptNominationV1',
                              {
                                candidacyId: candidate.candidacyId,
                                electionId: election.electionId,
                                expectedCandidacyVersion: candidate.aggregateVersion,
                                expectedElectionVersion: election.aggregateVersion,
                              },
                              election.aggregateVersion,
                            )
                          }
                          type="button"
                        >
                          Accept nomination
                        </button>
                      ) : (
                        <AuthorityNotice
                          decision={governanceCapability(
                            data.capabilities,
                            'candidate.accept',
                            candidate.candidacyId,
                          )}
                          label="Accept nomination"
                        />
                      )
                    ) : null}
                  </li>
                ))}
                {candidates.length === 0 ? <li>No candidates yet.</li> : null}
              </ul>
              {election.status === 'nominations_open' &&
              governanceCapability(data.capabilities, 'candidate.nominate', election.electionId)
                ?.allowed ? (
                <form
                  className="govern-inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void runCommand(
                      'NominateCandidateV1',
                      {
                        candidateEntityKey: formString(form, 'candidateEntityKey'),
                        electionId: election.electionId,
                        expectedElectionVersion: election.aggregateVersion,
                        officeId: election.officeId,
                        statement: formString(form, 'statement') || undefined,
                      },
                      election.aggregateVersion,
                    );
                  }}
                >
                  <fieldset disabled={pending}>
                    <legend>Nominate</legend>
                    <label>
                      Candidate entity key
                      <input
                        name="candidateEntityKey"
                        readOnly
                        required
                        value={data.capabilities.actor.actorEntityKey ?? ''}
                      />
                    </label>
                    <label>
                      Statement
                      <input maxLength={1000} name="statement" />
                    </label>
                    <button type="submit">Nominate</button>
                  </fieldset>
                </form>
              ) : election.status === 'nominations_open' ? (
                <AuthorityNotice
                  decision={governanceCapability(
                    data.capabilities,
                    'candidate.nominate',
                    election.electionId,
                  )}
                  label="Nominate candidate"
                />
              ) : null}
              {election.status === 'open' &&
              election.eligibilitySnapshotId &&
              governanceCapability(data.capabilities, 'election.ballot.cast', election.electionId)
                ?.allowed &&
              governanceBallotEligible(
                data.capabilities,
                'election',
                election.electionId,
                election.eligibilitySnapshotId,
              ) ? (
                <form
                  className="govern-ballot-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const candidateKey = formString(form, 'candidateKey');
                    void runCommand(
                      'CastElectionBallotV1',
                      {
                        choice: candidateKey
                          ? { candidateKey, choiceType: 'candidate' }
                          : { choiceType: 'abstain' },
                        electionId: election.electionId,
                        eligibilitySnapshotId: election.eligibilitySnapshotId,
                        expectedElectionVersion: election.aggregateVersion,
                        replaceExisting: form.get('replaceExisting') === 'on',
                      },
                      election.aggregateVersion,
                    );
                  }}
                >
                  <fieldset disabled={pending || windowState !== 'open'}>
                    <legend>Cast election ballot</legend>
                    <label>
                      Selection
                      <select name="candidateKey">
                        <option value="">Abstain</option>
                        {candidates
                          .filter((candidate) => candidate.status === 'accepted')
                          .map((candidate) => (
                            <option
                              key={candidate.candidacyId}
                              value={candidate.candidateEntityKey}
                            >
                              {candidate.candidateEntityKey}
                            </option>
                          ))}
                      </select>
                    </label>
                    {governanceBallotEligibility(
                      data.capabilities,
                      'election',
                      election.electionId,
                      election.eligibilitySnapshotId,
                    )?.ballotState === 'cast_replaceable' ? (
                      <p>
                        This submission replaces your existing effective ballot.
                        <input name="replaceExisting" type="hidden" value="on" />
                      </p>
                    ) : null}
                    <button type="submit">Submit ballot</button>
                  </fieldset>
                </form>
              ) : election.status === 'open' && election.eligibilitySnapshotId ? (
                <AuthorityNotice
                  decision={governanceCapability(
                    data.capabilities,
                    'election.ballot.cast',
                    election.electionId,
                  )}
                  label={
                    governanceBallotEligible(
                      data.capabilities,
                      'election',
                      election.electionId,
                      election.eligibilitySnapshotId,
                    )
                      ? 'Cast election ballot'
                      : 'Cast election ballot · not in the frozen eligibility snapshot'
                  }
                />
              ) : election.status === 'open' ? (
                <p>Eligibility snapshot will appear when voting opens.</p>
              ) : null}
              <button
                className="button secondary"
                onClick={() => void loadEvidence(election)}
                type="button"
              >
                View my receipt & result
              </button>
              {receiptMessages[election.electionId] ? (
                <p className="govern-receipt" role="status">
                  {receiptMessages[election.electionId]}
                </p>
              ) : null}
              {results[election.electionId] ? (
                <ElectionResult result={results[election.electionId]!} />
              ) : null}
            </article>
          );
        })}
        {data.elections.length === 0 ? (
          <div className="card empty-state">No elections are scheduled.</div>
        ) : null}
      </div>
    </section>
  );
}

function Audit({ data }: { data: GovernanceWorkspaceData }) {
  return (
    <section className="card govern-table-card" aria-labelledby="audit-heading">
      <div className="govern-section-heading">
        <div>
          <h2 id="audit-heading">Public governance audit</h2>
          <p>
            Ordinary civic decisions, creator overrides, administrator repairs, and their reasons
            remain visibly distinct.
          </p>
        </div>
      </div>
      <div aria-label="Public governance audit records" className="table-scroll" tabIndex={0}>
        <table className="govern-table">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Actor mode</th>
              <th scope="col">Target</th>
              <th scope="col">Tick</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.audit.map((item) => (
              <tr key={item.auditId}>
                <th scope="row">{humanizeGovernance(item.eventType)}</th>
                <td>
                  <Status value={item.actorMode} />
                </td>
                <td>
                  {humanizeGovernance(item.aggregateType)}
                  <small>{item.aggregateId}</small>
                </td>
                <td>{item.occurredAtTick}</td>
                <td>{item.reason ?? 'Recorded policy evidence'}</td>
              </tr>
            ))}
            {data.audit.length === 0 ? (
              <tr>
                <td colSpan={5}>No governance audit records are visible.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OperatorActions({
  currentTick,
  operatorActorMode,
  overrideDecision,
  pending,
  prepareCommand,
  repairDecision,
  submitCommand,
  worldId,
}: {
  currentTick: string;
  operatorActorMode: GovernanceOperatorActorMode;
  overrideDecision: GovernanceUiCapabilityDecisionV1 | null;
  pending: boolean;
  prepareCommand: (
    type: string,
    payload: Record<string, unknown>,
    version: string,
  ) => GovernanceSubmitCommand | null;
  repairDecision: GovernanceUiCapabilityDecisionV1 | null;
  submitCommand: (
    command: GovernanceSubmitCommand,
    proofToken: string,
  ) => Promise<CommandSubmissionDisposition>;
  worldId: string;
}) {
  const reviewRef = useRef<HTMLElement>(null);
  const retryProofRef = useRef<string | null>(null);
  const stepErrorRef = useRef<HTMLDivElement>(null);
  const [prepared, setPrepared] = useState<PreparedOperatorAction | null>(null);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [stepError, setStepError] = useState('');
  const [uncertainOutcome, setUncertainOutcome] = useState(false);

  useEffect(() => {
    if (prepared) reviewRef.current?.focus();
  }, [prepared]);

  useEffect(() => {
    if (stepError) stepErrorRef.current?.focus();
  }, [stepError]);

  const busy = pending || reauthenticating;
  const approvalReviewCommand = prepared
    ? governanceApprovalReviewCommand(prepared.command, operatorActorMode)
    : null;

  async function reauthenticateAndSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prepared || busy) return;
    const form = event.currentTarget;
    const password = formString(new FormData(form), 'password');
    form.reset();
    retryProofRef.current = null;
    setUncertainOutcome(false);
    setStepError('');
    setReauthenticating(true);
    try {
      const proof = await mutateJson<RecentCredentialProof>('/api/v1/auth/reauthenticate', 'POST', {
        command: prepared.command,
        password,
        worldId,
      });
      retryProofRef.current = proof.proofToken;
      const disposition = await submitCommand(prepared.command, proof.proofToken);
      if (disposition === 'accepted') {
        retryProofRef.current = null;
        setPrepared(null);
      } else if (disposition === 'uncertain') {
        setUncertainOutcome(true);
      } else {
        retryProofRef.current = null;
      }
    } catch (cause) {
      const code =
        cause instanceof BrowserApiError ? cause.failure.code : 'REAUTHENTICATION_FAILED';
      setStepError(
        governanceErrorMessage(
          code,
          cause instanceof BrowserApiError
            ? cause.failure.message
            : 'Password verification could not be completed.',
        ),
      );
    } finally {
      setReauthenticating(false);
    }
  }

  async function retryExactCommand() {
    if (!prepared || !retryProofRef.current || busy) return;
    setUncertainOutcome(false);
    const disposition = await submitCommand(prepared.command, retryProofRef.current);
    if (disposition === 'accepted') {
      retryProofRef.current = null;
      setPrepared(null);
    } else if (disposition === 'uncertain') {
      setUncertainOutcome(true);
    } else {
      retryProofRef.current = null;
    }
  }

  return (
    <div className="govern-stack">
      <section className="govern-override-warning" role="note">
        <strong>Operator power cannot masquerade as civic governance</strong>
        <p>
          These commands are permanently labeled as creator or administrator actions. They require
          an exact confirmation, a durable reason, a review of the frozen command, recent password
          verification, and may require a distinct second approval.
        </p>
      </section>
      {overrideDecision?.allowed ? (
        <form
          className="card govern-operator-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const lawId = formString(form, 'lawId');
            const expectedLawVersion = formString(form, 'expectedLawVersion');
            const effectiveAtTick = formString(form, 'effectiveAtTick');
            const impact = formString(form, 'impact');
            const command = prepareCommand(
              'ExecuteCreatorOverrideV1',
              {
                approvalId: null,
                confirmation: formString(form, 'confirmation'),
                effect: {
                  effectType: 'execute_proposal_action',
                  proposalAction: {
                    actionSchemaVersion: 1,
                    actionType: 'repeal_law',
                    effectiveAtTick,
                    expectedLawVersion,
                    lawId,
                    reason: formString(form, 'lawReason'),
                  },
                },
                impact,
                reason: formString(form, 'reason'),
              },
              '0',
            );
            if (command) {
              retryProofRef.current = null;
              setUncertainOutcome(false);
              setStepError('');
              setPrepared({
                command: freezeCommand(command),
                kind: 'override',
                review: {
                  afterImpact: impact,
                  beforeImpact: `Law ${lawId} version ${expectedLawVersion} remains authoritative before tick ${effectiveAtTick}.`,
                  currentEvidence: `Law version ${expectedLawVersion}`,
                  effectKind: 'Emergency repeal law',
                  effectiveTick: effectiveAtTick,
                  target: `Law ${lawId}`,
                },
              });
            }
          }}
        >
          <fieldset disabled={busy || prepared !== null}>
            <legend>Explicit emergency law override</legend>
            <label>
              Operator reason
              <textarea minLength={8} name="reason" required />
            </label>
            <label>
              Before/after impact
              <textarea maxLength={1000} name="impact" required />
            </label>
            <div className="govern-form-grid">
              <label>
                Law ID
                <input name="lawId" required />
              </label>
              <label>
                Expected law version
                <input min="1" name="expectedLawVersion" required type="number" />
              </label>
              <label>
                Effective tick
                <input min="0" name="effectiveAtTick" required type="number" />
              </label>
              <label>
                Legal repeal reason
                <textarea minLength={8} name="lawReason" required />
              </label>
            </div>
            <label>
              Type the exact confirmation
              <input
                autoComplete="off"
                name="confirmation"
                pattern="EXECUTE EXPLICIT GOVERNANCE OVERRIDE"
                placeholder="EXECUTE EXPLICIT GOVERNANCE OVERRIDE"
                required
              />
            </label>
            <button className="button secondary" type="submit">
              Review override
            </button>
          </fieldset>
        </form>
      ) : (
        <AuthorityNotice decision={overrideDecision} label="Execute governance override" />
      )}
      {repairDecision?.allowed ? (
        <form
          className="card govern-operator-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const sourceResultId = formString(form, 'sourceResultId');
            const expectedCurrentResultChecksum = formString(form, 'expectedCurrentResultChecksum');
            const replacementResultChecksum = formString(form, 'replacementResultChecksum');
            const repairKind = formString(form, 'repairKind');
            const command = prepareCommand(
              'RepairGovernanceResultV1',
              {
                approvalId: null,
                confirmation: formString(form, 'confirmation'),
                expectedCurrentResultChecksum,
                reason: formString(form, 'reason'),
                repairKind,
                replacementResultChecksum,
                sourceResultId,
              },
              '0',
            );
            if (command) {
              retryProofRef.current = null;
              setUncertainOutcome(false);
              setStepError('');
              setPrepared({
                command: freezeCommand(command),
                kind: 'repair',
                review: {
                  afterImpact: `Append replacement checksum ${replacementResultChecksum}.`,
                  beforeImpact: `Preserve source checksum ${expectedCurrentResultChecksum} as immutable evidence.`,
                  currentEvidence: `Source checksum ${expectedCurrentResultChecksum}`,
                  effectKind: humanizeGovernance(repairKind),
                  effectiveTick: currentTick,
                  target: `Result ${sourceResultId}`,
                },
              });
            }
          }}
        >
          <fieldset disabled={busy || prepared !== null}>
            <legend>Append linked result repair</legend>
            <label>
              Repair kind
              <select name="repairKind">
                <option value="proposal_recount">Proposal recount</option>
                <option value="election_recount">Election recount</option>
                <option value="certification_compensation">Certification compensation</option>
              </select>
            </label>
            <label>
              Source result ID
              <input name="sourceResultId" required />
            </label>
            <label>
              Current result checksum
              <input maxLength={64} minLength={64} name="expectedCurrentResultChecksum" required />
            </label>
            <label>
              Replacement result checksum
              <input maxLength={64} minLength={64} name="replacementResultChecksum" required />
            </label>
            <label>
              Audited reason
              <textarea minLength={8} name="reason" required />
            </label>
            <label>
              Type the exact confirmation
              <input
                autoComplete="off"
                name="confirmation"
                pattern="APPEND LINKED GOVERNANCE REPAIR"
                placeholder="APPEND LINKED GOVERNANCE REPAIR"
                required
              />
            </label>
            <button className="button secondary" type="submit">
              Review repair
            </button>
          </fieldset>
        </form>
      ) : (
        <AuthorityNotice decision={repairDecision} label="Append governance repair" />
      )}
      {prepared ? (
        <>
          <section
            aria-labelledby="operator-review-heading"
            className="card govern-operator-review"
            ref={reviewRef}
            tabIndex={-1}
          >
            <p className="eyebrow">Frozen command review</p>
            <h2 id="operator-review-heading">
              Review {prepared.kind === 'override' ? 'creator override' : 'governance repair'}
            </h2>
            <p>
              This text-only preview is the exact command that password verification will bind and
              the server will accept or reject.
            </p>
            <dl className="govern-operator-review-grid">
              <div>
                <dt>Target</dt>
                <dd>{prepared.review.target}</dd>
              </div>
              <div>
                <dt>Current/source evidence</dt>
                <dd>{prepared.review.currentEvidence}</dd>
              </div>
              <div>
                <dt>Effective tick</dt>
                <dd>{prepared.review.effectiveTick}</dd>
              </div>
              <div>
                <dt>Effect kind</dt>
                <dd>{prepared.review.effectKind}</dd>
              </div>
              <div>
                <dt>Before</dt>
                <dd>{prepared.review.beforeImpact}</dd>
              </div>
              <div>
                <dt>After</dt>
                <dd>{prepared.review.afterImpact}</dd>
              </div>
              <div>
                <dt>Command ID</dt>
                <dd>
                  <code>{prepared.command.commandId}</code>
                </dd>
              </div>
            </dl>
          </section>
          {approvalReviewCommand ? (
            <section
              aria-labelledby="second-approval-heading"
              className="card govern-operator-form"
            >
              <p className="eyebrow">Optional two-person control</p>
              <h3 id="second-approval-heading">Bind a distinct reviewer to this exact command</h3>
              <p>
                When the deployment requires a second approval, share this complete command through
                the approved incident channel. The reviewer submits it from their own authenticated
                session to the governance approval endpoint and returns only the approval UUID.
              </p>
              <label>
                Exact command for reviewer approval
                <textarea
                  aria-describedby="second-approval-help"
                  readOnly
                  rows={14}
                  value={JSON.stringify(approvalReviewCommand, null, 2)}
                />
              </label>
              <p id="second-approval-help">
                The reviewer verifies every field and adds their password only in their own request.
                Do not approve a screenshot, summary, or regenerated command.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || !prepared) return;
                  const approvalId = formString(new FormData(event.currentTarget), 'approvalId');
                  try {
                    const command = freezeCommand(
                      attachGovernanceApproval(prepared.command, approvalId),
                    );
                    retryProofRef.current = null;
                    setPrepared({ ...prepared, command });
                    setStepError('');
                    setUncertainOutcome(false);
                    event.currentTarget.reset();
                  } catch {
                    setStepError(
                      'Enter the exact approval UUID returned by the distinct reviewer.',
                    );
                  }
                }}
              >
                <fieldset disabled={busy}>
                  <legend>Attach returned approval</legend>
                  <label>
                    Second approval UUID
                    <input
                      autoComplete="off"
                      maxLength={36}
                      name="approvalId"
                      pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                      required
                    />
                  </label>
                  <button className="button secondary" type="submit">
                    Attach without changing command identity
                  </button>
                </fieldset>
              </form>
              <p aria-live="polite" role="status">
                {typeof prepared.command.payload['approvalId'] === 'string'
                  ? `Approval ${prepared.command.payload['approvalId']} is attached to this frozen command.`
                  : 'No second approval is attached. Leave this empty only when the deployment does not require two-person control.'}
              </p>
            </section>
          ) : null}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              retryProofRef.current = null;
              setPrepared(null);
              setStepError('');
              setUncertainOutcome(false);
            }}
            type="button"
          >
            Change command details
          </button>
          {uncertainOutcome ? (
            <section className="govern-retry-proof" role="status">
              <strong>Command outcome not confirmed</strong>
              <p>
                Retry the exact frozen command with its memory-only proof. No additional password is
                needed, and changed command content will be rejected.
              </p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void retryExactCommand()}
                type="button"
              >
                Retry exact frozen command
              </button>
            </section>
          ) : null}
          {stepError ? (
            <div className="error-summary" ref={stepErrorRef} role="alert" tabIndex={-1}>
              <strong>Operator action not completed</strong>
              <p>{stepError}</p>
            </div>
          ) : null}
          <form
            aria-describedby="operator-password-help"
            className="card govern-operator-form govern-password-step"
            onSubmit={(event) => void reauthenticateAndSubmit(event)}
          >
            <fieldset disabled={busy}>
              <legend>Password reauthentication</legend>
              <p id="operator-password-help">
                Your password is sent only to the isolated verification endpoint. It is cleared
                before the frozen governance command is submitted and is never part of that command.
              </p>
              <label>
                Current password
                <input
                  autoComplete="current-password"
                  maxLength={128}
                  minLength={12}
                  name="password"
                  required
                  type="password"
                />
              </label>
              <button className="danger-button" type="submit">
                {reauthenticating
                  ? 'Verifying password…'
                  : prepared.kind === 'override'
                    ? 'Verify password and execute override'
                    : 'Verify password and append repair'}
              </button>
            </fieldset>
          </form>
        </>
      ) : null}
    </div>
  );
}

interface PreparedOperatorAction {
  command: GovernanceSubmitCommand;
  kind: 'override' | 'repair';
  review: {
    afterImpact: string;
    beforeImpact: string;
    currentEvidence: string;
    effectKind: string;
    effectiveTick: string;
    target: string;
  };
}

function freezeCommand(command: GovernanceSubmitCommand): GovernanceSubmitCommand {
  return deepFreeze(structuredClone(command));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function ProposalResult({ result }: { result: GovernanceProposalResultViewV1 }) {
  return (
    <section className="govern-result" aria-label="Certified proposal result">
      <strong>{humanizeGovernance(result.outcome)}</strong>
      <span>
        Yes {result.yesCount} · No {result.noCount} · Abstain {result.abstainCount}
      </span>
      <small>Checksum {shortHash(result.resultChecksum)}</small>
    </section>
  );
}
function ElectionResult({ result }: { result: GovernanceElectionResultViewV1 }) {
  return (
    <section className="govern-result" aria-label="Certified election result">
      <strong>{humanizeGovernance(result.outcome)}</strong>
      <span>
        {result.winnerCandidateKey
          ? `Winner: ${result.winnerCandidateKey}`
          : 'No officeholder certified'}
      </span>
      {result.candidateTotals.map((candidate) => (
        <small key={candidate.candidateKey}>
          {candidate.candidateKey}: {candidate.voteCount}
        </small>
      ))}
    </section>
  );
}
function AuthorityNotice({
  decision,
  label,
}: {
  decision: GovernanceUiCapabilityDecisionV1 | null;
  label: string;
}) {
  const reasonCode = decision?.allowed
    ? 'BALLOT_INELIGIBLE'
    : (decision?.reasonCode ?? 'CAPABILITY_NOT_PROJECTED');
  return (
    <p className="govern-authority-notice" role="status">
      <strong>{label} unavailable</strong>
      <span>
        {humanizeGovernance(reasonCode)} ·{' '}
        <code>{decision?.ruleId ?? 'governance.ui.default_deny'}</code>
      </span>
    </p>
  );
}
function Status({ value }: { value: string }) {
  return <span className={`govern-status ${statusKind(value)}`}>{humanizeGovernance(value)}</span>;
}

function proposalPayload(
  form: FormData,
  actionType: 'authorize_public_project' | 'update_tax',
): Record<string, unknown> {
  const ballotMode = formString(form, 'ballotMode');
  const action =
    actionType === 'update_tax'
      ? {
          actionSchemaVersion: 1,
          actionType,
          effectiveFromTick: formString(form, 'effectiveFromTick'),
          expectedTaxPolicyVersion: formString(form, 'expectedTaxPolicyVersion'),
          newRateBps: Number(formString(form, 'newRateBps')),
          taxPolicyId: formString(form, 'taxPolicyId'),
        }
      : {
          actionSchemaVersion: 1,
          actionType,
          amountMinor: formString(form, 'amountMinor'),
          budgetKey: formString(form, 'budgetKey'),
          currencyId: formString(form, 'currencyId'),
          description: formString(form, 'description'),
          effectiveAtTick: formString(form, 'effectiveAtTick'),
          projectKey: formString(form, 'projectKey'),
          treasuryWalletId: formString(form, 'treasuryWalletId'),
        };
  return {
    action,
    approvalThresholdBps: Number(formString(form, 'approvalThresholdBps')),
    ballotPolicy:
      ballotMode === 'secret'
        ? {
            ballotMode: 'secret',
            disclosure: 'aggregate_only',
            replacementAllowed: form.get('replacementAllowed') === 'on',
          }
        : {
            ballotMode: 'public',
            disclosure: formString(form, 'disclosure'),
            replacementAllowed: form.get('replacementAllowed') === 'on',
          },
    body: formString(form, 'body'),
    debateEndsAtTick: formString(form, 'debateEndsAtTick'),
    institutionId: formString(form, 'institutionId'),
    jurisdictionEntityKey: formString(form, 'jurisdictionEntityKey'),
    minimumSponsors: Number(formString(form, 'minimumSponsors')),
    proposalKey: formString(form, 'proposalKey'),
    quorumBps: Number(formString(form, 'quorumBps')),
    sponsorshipEndsAtTick: formString(form, 'sponsorshipEndsAtTick'),
    targetCharterVersion: formString(form, 'targetCharterVersion'),
    title: formString(form, 'title'),
    votingClosesAtTick: formString(form, 'votingClosesAtTick'),
    votingOpensAtTick: formString(form, 'votingOpensAtTick'),
  };
}

async function governancePage<T>(worldId: string, resource: string): Promise<GovernancePage<T>> {
  return loadBoundedGovernancePages((cursor) =>
    requestJson<GovernancePage<T>>(
      `/api/v1/worlds/${worldId}/governance/${resource}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  );
}
async function optionalJson<T>(path: string): Promise<T | null> {
  try {
    return await requestJson<T>(path);
  } catch (cause) {
    if (cause instanceof BrowserApiError && cause.status === 404) return null;
    throw cause;
  }
}
function receiptMessage(receipt: Record<string, unknown>): string {
  const secret = receipt.ballotMode === 'secret';
  return `${secret ? 'Secret' : 'Public'} ballot receipt ${String(receipt.receiptHash)} at tick ${String(receipt.castAtTick)}${secret ? '. The selection is intentionally unavailable.' : ` · selection ${JSON.stringify(receipt.choice)}`}`;
}
function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
function statusKind(value: string): string {
  return ['active', 'accepted', 'certified', 'elected', 'enacted', 'open', 'passed'].some((part) =>
    value.includes(part),
  )
    ? 'positive'
    : ['failed', 'rejected', 'removed', 'cancelled', 'override', 'repair'].some((part) =>
          value.includes(part),
        )
      ? 'danger'
      : 'neutral';
}
function sectionTitle(section: GovernSection): string {
  const titles: Record<GovernSection, string> = {
    audit: 'Governance history',
    elections: 'Elections',
    laws: 'Laws',
    overview: 'Charter and institutions',
    override: 'Operator actions',
    proposals: 'Proposals and ballots',
  };
  return titles[section];
}
