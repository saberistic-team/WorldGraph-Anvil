import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';

import {
  PublicGovernanceCommandRequestV1Schema,
  createValidator,
  type GovernanceAuditViewV1,
  type GovernanceCandidacyViewV1,
  type GovernanceCharterViewV1,
  type GovernanceElectionReceiptViewV1,
  type GovernanceElectionResultViewV1,
  type GovernanceElectionViewV1,
  type GovernanceInstitutionViewV1,
  type GovernanceLawViewV1,
  type GovernanceOfficeTermViewV1,
  type GovernanceOfficeViewV1,
  type GovernanceProposalReceiptViewV1,
  type GovernanceProposalResultViewV1,
  type GovernanceProposalViewV1,
  type GovernanceUiCapabilitiesViewV1,
} from '../../packages/contracts/src/index.js';

const worldId = uuid(1);
const charterId = uuid(2);
const institutionId = uuid(3);
const officeId = uuid(4);
const termId = uuid(5);
const openProposalId = uuid(6);
const certifiedProposalId = uuid(7);
const proposalSnapshotId = uuid(8);
const nominationElectionId = uuid(9);
const openElectionId = uuid(10);
const certifiedElectionId = uuid(11);
const openElectionSnapshotId = uuid(12);
const certifiedElectionSnapshotId = uuid(13);
const nominationAliceCandidacyId = uuid(14);
const nominationBobCandidacyId = uuid(15);
const openAliceCandidacyId = uuid(16);
const openBobCandidacyId = uuid(17);
const certifiedAliceCandidacyId = uuid(18);
const certifiedBobCandidacyId = uuid(19);
const certifiedProposalResultId = uuid(20);
const electionResultId = uuid(21);
const lawId = uuid(22);
const taxPolicyId = uuid(23);
const treasuryWalletId = uuid(24);
const currencyId = uuid(25);
const overrideApprovalId = uuid(26);
const overrideAuditId = uuid(27);
const repairAuditId = uuid(28);
const certifiedProposalSnapshotId = uuid(29);
const projectEntityId = uuid(34);
const repairApprovalId = uuid(39);
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const csrfToken = 'g'.repeat(43);
const recentCredentialProof = 'r'.repeat(43);

const commandValidator = createValidator(PublicGovernanceCommandRequestV1Schema);

const charter: GovernanceCharterViewV1 = {
  aggregateVersion: '1',
  charterId,
  checksum: hashA,
  citizenEligibilityPolicy: {
    kind: 'any',
    operands: [
      { kind: 'membership_role', role: 'creator' },
      { kind: 'membership_role', role: 'player' },
    ],
  },
  evaluatedAtTick: '50',
  effectiveFromTick: '0',
  effectiveUntilTick: null,
  projectionRevision: '41',
  proposalRules: {
    approvalThresholdBps: 5_001,
    ballotPolicy: {
      ballotMode: 'public',
      disclosure: 'choice_totals',
      replacementAllowed: true,
    },
    debateTicks: '2',
    minimumSponsors: 0,
    quorumBps: 5_000,
    sponsorshipTicks: '2',
    votingTicks: '5',
  },
  stableKey: 'charter:harbor-city',
  summary:
    'A finite charter for citizen proposals, scoped council powers, public funds, and deterministic elections.',
  title: 'Harbor City Civic Charter',
  version: '1',
  worldId,
};

const institution: GovernanceInstitutionViewV1 = {
  aggregateVersion: '2',
  displayName: 'Guild Council',
  institutionId,
  institutionType: 'council',
  jurisdictionEntityKey: 'district:civic-platform',
  stableKey: 'institution:guild-council',
  status: 'active',
  worldId,
};

const law: GovernanceLawViewV1 = {
  aggregateVersion: '2',
  effectiveFromTick: '10',
  effectiveUntilTick: null,
  lawId,
  lawVersion: '2',
  stableKey: 'law:harbor-services',
  status: 'active',
  summary: 'Funds bounded public services through the enacted tax policy.',
  title: 'Harbor Services Act',
  worldId,
};

const office: GovernanceOfficeViewV1 = {
  aggregateVersion: '4',
  displayName: 'Treasurer',
  institutionId,
  officeId,
  seats: 1,
  stableKey: 'office:guild-council:treasurer',
  termDurationTicks: '48',
  tieRule: 'vacancy',
  worldId,
};

const certifiedTerm: GovernanceOfficeTermViewV1 = {
  aggregateVersion: '1',
  endsAtTick: '76',
  holderEntityKey: 'character:alice',
  officeId,
  seatIndex: 0,
  sourceId: electionResultId,
  sourceType: 'election',
  startsAtTick: '28',
  status: 'active',
  termId,
  worldId,
};

const openProposal: GovernanceProposalViewV1 = {
  action: {
    actionSchemaVersion: 1,
    actionType: 'update_tax',
    effectiveFromTick: '60',
    expectedTaxPolicyVersion: '2',
    newRateBps: 275,
    taxPolicyId,
  },
  aggregateVersion: '5',
  approvalThresholdBps: 5001,
  ballotPolicy: {
    ballotMode: 'public',
    disclosure: 'choice_totals',
    replacementAllowed: true,
  },
  body: 'A bounded public levy update for the next service interval.',
  debateEndsAtTick: '40',
  eligibleCount: 3,
  eligibilitySnapshotId: proposalSnapshotId,
  institutionId,
  proposalId: openProposalId,
  quorumBps: 5000,
  sponsorshipEndsAtTick: '36',
  status: 'open',
  title: 'Harbor Levy Update',
  turnoutCount: 2,
  votingClosesAtTick: '60',
  votingOpensAtTick: '40',
  worldId,
};

const certifiedProposal: GovernanceProposalViewV1 = {
  action: {
    actionSchemaVersion: 1,
    actionType: 'authorize_public_project',
    amountMinor: '25000',
    budgetKey: 'budget:storm-shelter',
    currencyId,
    description: 'Reserve treasury funds for a public storm shelter.',
    effectiveAtTick: '40',
    projectKey: 'project:storm-shelter',
    treasuryWalletId,
  },
  aggregateVersion: '7',
  approvalThresholdBps: 5001,
  ballotPolicy: {
    ballotMode: 'public',
    disclosure: 'choice_totals',
    replacementAllowed: true,
  },
  body: 'Authorize a treasury-backed shelter without exposing individual votes.',
  debateEndsAtTick: '35',
  eligibleCount: 3,
  eligibilitySnapshotId: certifiedProposalSnapshotId,
  institutionId,
  proposalId: certifiedProposalId,
  quorumBps: 5000,
  sponsorshipEndsAtTick: '31',
  status: 'enacted',
  title: 'Storm Shelter Fund',
  turnoutCount: 3,
  votingClosesAtTick: '40',
  votingOpensAtTick: '35',
  worldId,
};

const secretBallotPolicy = {
  ballotMode: 'secret' as const,
  disclosure: 'aggregate_only' as const,
  replacementAllowed: false,
};

const nominationElection: GovernanceElectionViewV1 = {
  aggregateVersion: '1',
  ballotPolicy: secretBallotPolicy,
  certificationAtTick: '72',
  electionId: nominationElectionId,
  eligibleCount: null,
  eligibilitySnapshotId: null,
  nominationClosesAtTick: '60',
  nominationOpensAtTick: '48',
  officeId,
  quorumBps: 5000,
  status: 'nominations_open',
  termStartsAtTick: '72',
  tieRule: 'vacancy',
  title: 'Treasurer Election · Nominations',
  turnoutCount: 0,
  votingClosesAtTick: '72',
  votingOpensAtTick: '60',
  worldId,
};

const openElection: GovernanceElectionViewV1 = {
  aggregateVersion: '2',
  ballotPolicy: secretBallotPolicy,
  certificationAtTick: '60',
  electionId: openElectionId,
  eligibleCount: 3,
  eligibilitySnapshotId: openElectionSnapshotId,
  nominationClosesAtTick: '40',
  nominationOpensAtTick: '28',
  officeId,
  quorumBps: 5000,
  status: 'open',
  termStartsAtTick: '60',
  tieRule: 'vacancy',
  title: 'Treasurer Election · Voting',
  turnoutCount: 2,
  votingClosesAtTick: '60',
  votingOpensAtTick: '40',
  worldId,
};

const certifiedElection: GovernanceElectionViewV1 = {
  aggregateVersion: '4',
  ballotPolicy: {
    ...secretBallotPolicy,
  },
  certificationAtTick: '28',
  electionId: certifiedElectionId,
  eligibleCount: 3,
  eligibilitySnapshotId: certifiedElectionSnapshotId,
  nominationClosesAtTick: '16',
  nominationOpensAtTick: '4',
  officeId,
  quorumBps: 5000,
  status: 'certified',
  termStartsAtTick: '28',
  tieRule: 'vacancy',
  title: 'Treasurer Election · Certified',
  turnoutCount: 3,
  votingClosesAtTick: '28',
  votingOpensAtTick: '16',
  worldId,
};

const nominationCandidacies: GovernanceCandidacyViewV1[] = [
  {
    aggregateVersion: '1',
    candidacyId: nominationAliceCandidacyId,
    candidateEntityKey: 'character:alice',
    electionId: nominationElectionId,
    status: 'nominated',
  },
  {
    aggregateVersion: '2',
    candidacyId: nominationBobCandidacyId,
    candidateEntityKey: 'character:bob',
    electionId: nominationElectionId,
    status: 'accepted',
  },
];

const openElectionCandidacies: GovernanceCandidacyViewV1[] = [
  {
    aggregateVersion: '2',
    candidacyId: openAliceCandidacyId,
    candidateEntityKey: 'character:alice',
    electionId: openElectionId,
    status: 'accepted',
  },
  {
    aggregateVersion: '2',
    candidacyId: openBobCandidacyId,
    candidateEntityKey: 'character:bob',
    electionId: openElectionId,
    status: 'accepted',
  },
];

const certifiedElectionCandidacies: GovernanceCandidacyViewV1[] = [
  {
    aggregateVersion: '2',
    candidacyId: certifiedAliceCandidacyId,
    candidateEntityKey: 'character:alice',
    electionId: certifiedElectionId,
    status: 'accepted',
  },
  {
    aggregateVersion: '2',
    candidacyId: certifiedBobCandidacyId,
    candidateEntityKey: 'character:bob',
    electionId: certifiedElectionId,
    status: 'accepted',
  },
];

const certifiedProposalResult: GovernanceProposalResultViewV1 = {
  abstainCount: 0,
  certified: true,
  eligibleCount: 3,
  inputChecksum: hashA,
  noCount: 1,
  outcome: 'passed',
  proposalId: certifiedProposalId,
  resultChecksum: hashB,
  resultId: certifiedProposalResultId,
  turnoutCount: 3,
  yesCount: 2,
};

const electionResult: GovernanceElectionResultViewV1 = {
  abstainCount: 0,
  candidateTotals: [
    { candidateKey: 'character:alice', voteCount: 2 },
    { candidateKey: 'character:bob', voteCount: 1 },
  ],
  certified: true,
  electionId: certifiedElectionId,
  eligibleCount: 3,
  inputChecksum: hashB,
  outcome: 'elected',
  resultChecksum: hashC,
  resultId: electionResultId,
  tiedCandidateKeys: [],
  turnoutCount: 3,
  winnerCandidateKey: 'character:alice',
};

const publicProposalReceipt: GovernanceProposalReceiptViewV1 = {
  ballotMode: 'public',
  castAtTick: '50',
  choice: 'yes',
  proposalId: openProposalId,
  receiptHash: hashA,
};

const secretElectionReceipt: GovernanceElectionReceiptViewV1 = {
  ballotMode: 'secret',
  castAtTick: '50',
  electionId: openElectionId,
  receiptHash: hashB,
};

const audit: GovernanceAuditViewV1[] = [
  {
    actorMode: 'creator',
    aggregateId: lawId,
    aggregateType: 'law',
    auditId: overrideAuditId,
    eventType: 'governance.override',
    occurredAtTick: '48',
    reason: 'Emergency repeal remained explicitly labeled.',
  },
  {
    actorMode: 'administrator',
    aggregateId: certifiedProposalResultId,
    aggregateType: 'proposal_result',
    auditId: repairAuditId,
    eventType: 'governance.repair',
    occurredAtTick: '49',
    reason: 'Linked recount retained the original result.',
  },
];

type Account = 'alice' | 'bob' | 'cora' | 'creator';

interface GovernanceMockOptions {
  ambiguousOnceType?: string;
  capabilityProjectionRevision?: string;
  denyType?: string;
  projectionRevision?: string;
  proposalTitle?: string;
  runtimeStateRevision?: string;
}

interface GovernanceMockState {
  commands: Array<Record<string, unknown>>;
  methodsAndPaths: string[];
  reauthentications: Array<Record<string, unknown>>;
  secretResponses: object[];
  sessionHeaders: string[];
}

interface GovernanceSession {
  context: BrowserContext;
  page: Page;
  state: GovernanceMockState;
}

function uuid(value: number): string {
  return `018f8652-3cb6-7d52-904b-${value.toString(16).padStart(12, '0')}`;
}

function json(route: Route, body: object, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function governancePage(items: readonly object[], projectionRevision = '41') {
  return {
    items,
    page: { evaluatedAtTick: '50', nextCursor: null, projectionRevision },
  };
}

function governanceCapabilities(
  account: Account,
  options: GovernanceMockOptions,
): GovernanceUiCapabilitiesViewV1 {
  const actorEntityKey = `character:${account}`;
  const decisions: GovernanceUiCapabilitiesViewV1['decisions'] = [
    {
      allowed: true,
      capability: 'proposal.create',
      reasonCode: 'ALLOWED',
      resourceId: institutionId,
      resourceType: 'institution',
      ruleId: 'charter.proposal.create',
    },
    {
      allowed: true,
      capability: 'proposal.ballot.cast',
      reasonCode: 'ALLOWED',
      resourceId: openProposalId,
      resourceType: 'proposal',
      ruleId: 'charter.proposal.ballot.cast',
    },
    {
      allowed: true,
      capability: 'candidate.nominate',
      reasonCode: 'ALLOWED',
      resourceId: nominationElectionId,
      resourceType: 'election',
      ruleId: 'charter.candidate.nominate',
    },
    {
      allowed: account === 'alice',
      capability: 'candidate.accept',
      reasonCode: account === 'alice' ? 'ALLOWED' : 'CANDIDATE_IDENTITY_REQUIRED',
      resourceId: nominationAliceCandidacyId,
      resourceType: 'candidacy',
      ruleId: 'charter.candidate.accept',
    },
    {
      allowed: true,
      capability: 'election.ballot.cast',
      reasonCode: 'ALLOWED',
      resourceId: openElectionId,
      resourceType: 'election',
      ruleId: 'charter.election.ballot.cast',
    },
    {
      allowed: true,
      capability: 'office.appoint',
      reasonCode: 'ALLOWED',
      resourceId: officeId,
      resourceType: 'office',
      ruleId: 'charter.office.appoint',
    },
    {
      allowed: true,
      capability: 'office.remove',
      reasonCode: 'ALLOWED',
      resourceId: termId,
      resourceType: 'office_term',
      ruleId: 'charter.office.remove',
    },
    {
      allowed: account === 'creator',
      capability: 'operator.override',
      reasonCode: account === 'creator' ? 'ALLOWED' : 'CREATOR_REQUIRED',
      resourceId: worldId,
      resourceType: 'world',
      ruleId: 'platform.operator.override',
    },
    {
      allowed: account === 'creator',
      capability: 'operator.repair',
      reasonCode: account === 'creator' ? 'ALLOWED' : 'CREATOR_REQUIRED',
      resourceId: worldId,
      resourceType: 'world',
      ruleId: 'platform.operator.repair',
    },
  ];

  return {
    actor: {
      actorEntityId: uuid(
        account === 'creator' ? 38 : account === 'alice' ? 35 : account === 'bob' ? 36 : 37,
      ),
      actorEntityKey,
      authorityState: account === 'creator' ? 'creator' : 'player',
      membershipRole: account === 'creator' ? 'creator' : 'player',
      platformRole: 'user',
    },
    ballotEligibility: [
      {
        ballotState: account === 'alice' ? 'cast_replaceable' : 'not_cast',
        eligible: true,
        snapshotId: proposalSnapshotId,
        targetId: openProposalId,
        targetType: 'proposal',
      },
      {
        ballotState: 'not_cast',
        eligible: true,
        snapshotId: openElectionSnapshotId,
        targetId: openElectionId,
        targetType: 'election',
      },
    ],
    contractVersion: 1,
    decisions,
    evaluatedAtTick: '50',
    projectionRevision: options.capabilityProjectionRevision ?? options.projectionRevision ?? '41',
    proposalTargets: {
      projectEntities: [
        {
          displayName: 'Civic Platform',
          projectEntityId,
          projectKey: 'project:storm-shelter',
        },
      ],
      taxPolicies: [
        {
          currentRateBps: 275,
          currencyCode: 'GCR',
          currencyId,
          currencyKey: 'currency:gold-civic-reserve',
          expectedPolicyVersion: '2',
          policyId: taxPolicyId,
          policyKey: 'tax:harbor-sales',
          taxType: 'sales',
          treasuryWalletId,
          treasuryWalletKey: 'wallet:treasury:gcr',
        },
      ],
      treasuries: [
        {
          currencyCode: 'GCR',
          currencyId,
          currencyKey: 'currency:gold-civic-reserve',
          currencyVersion: '1',
          spendableMinor: '100000',
          treasuryWalletId,
          treasuryWalletKey: 'wallet:treasury:gcr',
          treasuryWalletVersion: '1',
        },
      ],
    },
    worldId,
  };
}

async function mockGovernance(
  page: Page,
  account: Account,
  options: GovernanceMockOptions = {},
): Promise<GovernanceMockState> {
  const state: GovernanceMockState = {
    commands: [],
    methodsAndPaths: [],
    reauthentications: [],
    secretResponses: [],
    sessionHeaders: [],
  };
  const base = `/api/v1/worlds/${worldId}/governance`;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const cookie = request.headers().cookie ?? '';
    expect(cookie, `${method} ${path} must carry its isolated account session`).toContain(
      `worldgraph_session=${account}-session`,
    );
    state.methodsAndPaths.push(`${method} ${path}`);
    state.sessionHeaders.push(cookie);

    if (path === `${base}/stream`) {
      expect(method).toBe('GET');
      return route.fulfill({ contentType: 'text/event-stream', status: 204 });
    }
    if (path === '/api/v1/auth/csrf') {
      expect(method).toBe('POST');
      return json(route, { csrfToken });
    }
    if (path === '/api/v1/auth/reauthenticate') {
      expect(method).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      const body = JSON.parse(request.postData() ?? '{}') as {
        command?: Record<string, unknown>;
        password?: unknown;
        worldId?: unknown;
      };
      expect(body.password).toBe('Correct horse battery staple');
      expect(body.worldId).toBe(worldId);
      expect(
        commandValidator.issues({ ...body.command, actorMode: 'creator' }),
        `Invalid privileged command reauthentication: ${JSON.stringify(body.command)}`,
      ).toEqual([]);
      state.reauthentications.push(body);
      return json(route, {
        expiresAt: '2026-08-03T12:05:00.000Z',
        proofToken: recentCredentialProof,
      });
    }
    if (path === `/api/v1/worlds/${worldId}/runtime-head`) {
      expect(method).toBe('GET');
      return json(route, {
        activeWorldVersionId: uuid(30),
        designVersion: '4',
        stateRevision: options.runtimeStateRevision ?? '41',
      });
    }
    if (path === `/api/v1/worlds/${worldId}/simulation/clock`) {
      expect(method).toBe('GET');
      return json(route, {
        aggregateVersion: '5',
        clock: { currentTick: '50' },
        designVersion: '4',
        stateRevision: options.runtimeStateRevision ?? '41',
      });
    }
    if (path === `${base}/charter`) {
      expect(method).toBe('GET');
      return json(route, charter);
    }
    if (path === `${base}/capabilities`) {
      expect(method).toBe('GET');
      return json(route, governanceCapabilities(account, options));
    }
    const pages = new Map<string, readonly object[]>([
      [`${base}/institutions`, [institution]],
      [`${base}/laws`, [law]],
      [`${base}/offices`, [office]],
      [`${base}/terms`, [certifiedTerm]],
      [
        `${base}/proposals`,
        [
          options.proposalTitle ? { ...openProposal, title: options.proposalTitle } : openProposal,
          certifiedProposal,
        ],
      ],
      [`${base}/elections`, [nominationElection, openElection, certifiedElection]],
      [`${base}/audit`, audit],
      [`${base}/elections/${nominationElectionId}/candidates`, nominationCandidacies],
      [`${base}/elections/${openElectionId}/candidates`, openElectionCandidacies],
      [`${base}/elections/${certifiedElectionId}/candidates`, certifiedElectionCandidacies],
    ]);
    const items = pages.get(path);
    if (items) {
      expect(method).toBe('GET');
      return json(route, governancePage(items, options.projectionRevision));
    }
    if (path === `${base}/proposals/${openProposalId}/receipt`) {
      expect(method).toBe('GET');
      return json(route, publicProposalReceipt);
    }
    if (path === `${base}/proposals/${certifiedProposalId}/result`) {
      expect(method).toBe('GET');
      return json(route, certifiedProposalResult);
    }
    if (path === `${base}/elections/${openElectionId}/receipt`) {
      expect(method).toBe('GET');
      state.secretResponses.push(secretElectionReceipt);
      return json(route, secretElectionReceipt);
    }
    if (path === `${base}/elections/${certifiedElectionId}/result`) {
      expect(method).toBe('GET');
      return json(route, electionResult);
    }
    if (path === `/api/v1/worlds/${worldId}/commands`) {
      expect(method).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      expect(request.headers()['idempotency-key']).toBe(body.idempotencyKey);
      const actorMode =
        body.type === 'ExecuteCreatorOverrideV1' || body.type === 'RepairGovernanceResultV1'
          ? 'creator'
          : 'in_world';
      if (actorMode === 'creator') {
        expect(request.headers()['x-recent-credential-proof']).toBe(recentCredentialProof);
        expect(state.reauthentications.at(-1)?.command).toEqual(body);
      } else {
        expect(request.headers()['x-recent-credential-proof']).toBeUndefined();
      }
      expect(JSON.stringify(body)).not.toContain('Correct horse battery staple');
      expect(
        commandValidator.issues({ ...body, actorMode }),
        `Invalid governance command: ${JSON.stringify(body)}`,
      ).toEqual([]);
      state.commands.push(body);
      if (
        body.type === options.ambiguousOnceType &&
        state.commands.filter((command) => command.type === body.type).length === 1
      ) {
        return json(
          route,
          {
            error: {
              code: 'UPSTREAM_UNAVAILABLE',
              message: 'The upstream response was lost after command dispatch.',
              requestId: uuid(33),
            },
          },
          502,
        );
      }
      if (body.type === options.denyType) {
        return json(
          route,
          {
            error: {
              code: 'AUTHORIZATION_DENIED',
              message: 'This account lacks the required civic authority.',
              requestId: uuid(31),
            },
          },
          403,
        );
      }
      return json(route, {
        commandId: body.commandId,
        eventIds: [uuid(32)],
        eventSequenceRange: { from: '42', to: '42' },
        ledgerSequenceRange: { from: '60', to: '61' },
        resultingStateRevision: '42',
        schemaVersion: 1,
        status: 'accepted',
      });
    }

    return json(
      route,
      { error: { code: 'NOT_FOUND', message: `${method} ${path} not mocked` } },
      404,
    );
  });
  return state;
}

async function addAccountCookie(page: Page, baseURL: string, account: Account) {
  await page.context().addCookies([
    {
      name: 'worldgraph_session',
      url: baseURL,
      value: `${account}-session`,
    },
  ]);
}

async function createGovernanceSession(
  browser: Browser,
  baseURL: string,
  account: Account,
  mobile: boolean,
  options: GovernanceMockOptions = {},
): Promise<GovernanceSession> {
  const context = await browser.newContext({
    baseURL,
    viewport: mobile ? { height: 720, width: 320 } : { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await addAccountCookie(page, baseURL, account);
  return { context, page, state: await mockGovernance(page, account, options) };
}

function proposalCard(page: Page, title: string) {
  return page.locator('article').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
}

async function expectAccessibleAndContained(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test('three isolated accounts exercise public, secret, and denied civic ballots', async ({
  baseURL,
  browser,
}, testInfo) => {
  expect(baseURL).toBeTruthy();
  const mobile = testInfo.project.name === 'mobile-320';
  const [alice, bob, cora] = await Promise.all([
    createGovernanceSession(browser, baseURL!, 'alice', mobile),
    createGovernanceSession(browser, baseURL!, 'bob', mobile),
    createGovernanceSession(browser, baseURL!, 'cora', mobile, {
      denyType: 'CastProposalBallotV1',
    }),
  ]);
  try {
    await Promise.all(
      [alice, cora].map((session) => session.page.goto(`/worlds/${worldId}/govern/proposals`)),
    );
    await bob.page.goto(`/worlds/${worldId}/govern/elections`);
    await Promise.all(
      [alice, cora].map((session) =>
        expect(
          session.page.getByRole('heading', { level: 1, name: 'Proposals and ballots' }),
        ).toBeVisible(),
      ),
    );
    await expect(bob.page.getByRole('heading', { level: 1, name: 'Elections' })).toBeVisible();

    const publicCard = proposalCard(alice.page, openProposal.title);
    await expect(publicCard.getByRole('button', { name: 'Sponsor' })).toHaveCount(0);
    await publicCard.getByLabel('Yes').check();
    await expect(
      publicCard.getByText('This submission replaces your existing effective ballot.'),
    ).toBeVisible();
    await publicCard.getByRole('button', { name: 'Submit ballot' }).focus();
    await alice.page.keyboard.press('Enter');
    await expect.poll(() => alice.state.commands.length).toBe(1);
    expect(alice.state.commands[0]).toMatchObject({
      expectedAggregateVersion: openProposal.aggregateVersion,
      expectedStateRevision: '41',
      expectedTick: '50',
      expectedWorldVersion: '4',
      payload: {
        choice: 'yes',
        eligibilitySnapshotId: proposalSnapshotId,
        expectedProposalVersion: openProposal.aggregateVersion,
        proposalId: openProposalId,
        replaceExisting: true,
      },
      schemaVersion: 1,
      type: 'CastProposalBallotV1',
    });
    await publicCard.getByRole('button', { name: 'View my receipt & result' }).click();
    await expect(publicCard.getByText(/Public ballot receipt/u)).toContainText('selection "yes"');
    await expect(publicCard.getByLabel('Certified proposal result')).toHaveCount(0);
    const certifiedProposalCard = proposalCard(alice.page, certifiedProposal.title);
    await expect(certifiedProposalCard.getByRole('button', { name: 'Sponsor' })).toHaveCount(0);
    await expect(certifiedProposalCard.getByRole('button', { name: 'Submit ballot' })).toHaveCount(
      0,
    );
    await certifiedProposalCard.getByRole('button', { name: 'View my receipt & result' }).click();
    await expect(certifiedProposalCard.getByLabel('Certified proposal result')).toContainText(
      'Yes 2',
    );

    const secretCard = proposalCard(bob.page, openElection.title);
    await expect(secretCard.getByRole('button', { name: 'Nominate', exact: true })).toHaveCount(0);
    await secretCard.getByLabel('Selection').selectOption('character:alice');
    await secretCard.getByRole('button', { name: 'Submit ballot' }).focus();
    await bob.page.keyboard.press('Enter');
    await expect.poll(() => bob.state.commands.length).toBe(1);
    expect(bob.state.commands[0]).toMatchObject({
      expectedAggregateVersion: openElection.aggregateVersion,
      payload: {
        choice: { candidateKey: 'character:alice', choiceType: 'candidate' },
        electionId: openElectionId,
        eligibilitySnapshotId: openElectionSnapshotId,
        expectedElectionVersion: openElection.aggregateVersion,
        replaceExisting: false,
      },
      type: 'CastElectionBallotV1',
    });
    await secretCard.getByRole('button', { name: 'View my receipt & result' }).click();
    await expect(secretCard.getByText(/Secret ballot receipt/u)).toContainText(
      'The selection is intentionally unavailable.',
    );
    await expect(secretCard.getByLabel('Certified election result')).toHaveCount(0);
    expect(bob.state.secretResponses).toEqual([secretElectionReceipt]);
    expect(bob.state.secretResponses[0]).not.toHaveProperty('choice');
    expect(JSON.stringify(bob.state.secretResponses)).not.toMatch(/voter|selection/iu);

    const deniedCard = proposalCard(cora.page, openProposal.title);
    await deniedCard.getByLabel('Yes').check();
    await deniedCard.getByRole('button', { name: 'Submit ballot' }).focus();
    await cora.page.keyboard.press('Enter');
    await expect.poll(() => cora.state.commands.length).toBe(1);
    expect(cora.state.commands[0]).toMatchObject({
      payload: {
        choice: 'yes',
        eligibilitySnapshotId: proposalSnapshotId,
        expectedProposalVersion: openProposal.aggregateVersion,
        proposalId: openProposalId,
        replaceExisting: false,
      },
      type: 'CastProposalBallotV1',
    });
    const denial = cora.page.locator('.error-summary[role="alert"]');
    await expect(denial).toBeFocused();
    await expect(denial).toContainText(
      'Your current civic or operator authority does not permit this action.',
    );

    for (const session of [alice, bob, cora]) {
      expect(session.state.sessionHeaders.length).toBeGreaterThan(0);
      expect(
        session.state.sessionHeaders.every((header) =>
          header.includes(
            `worldgraph_session=${session === alice ? 'alice' : session === bob ? 'bob' : 'cora'}-session`,
          ),
        ),
      ).toBe(true);
      await expectAccessibleAndContained(session.page);
    }
  } finally {
    await Promise.allSettled([alice.context.close(), bob.context.close(), cora.context.close()]);
  }
});

test('pauses civic actions for mixed governance snapshots and renders hostile text inertly', async ({
  baseURL,
  page,
}) => {
  expect(baseURL).toBeTruthy();
  const hostileTitle = '<script>window.__worldgraphGovernanceInjected=true</script> Harbor levy';
  await addAccountCookie(page, baseURL!, 'alice');
  await mockGovernance(page, 'alice', {
    capabilityProjectionRevision: '44',
    projectionRevision: '41',
    proposalTitle: hostileTitle,
    runtimeStateRevision: '44',
  });
  await page.goto(`/worlds/${worldId}/govern/proposals`);

  await expect(page.getByText('projection revision 41', { exact: false })).toBeVisible();
  const lag = page.getByRole('status');
  await expect(lag).toContainText('Governance views are not coherent');
  await expect(lag).toContainText('Loaded governance reads span 3 revisions');
  await expect(page.getByRole('heading', { name: hostileTitle, exact: true })).toBeVisible();
  await expect(page.locator('article script')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __worldgraphGovernanceInjected?: boolean })
          .__worldgraphGovernanceInjected,
    ),
  ).toBeUndefined();
  await expect(
    proposalCard(page, hostileTitle).getByRole('button', { name: 'Submit ballot' }),
  ).toBeDisabled();
  await expectAccessibleAndContained(page);
});

test('election nomination, ballot, result, and certified term remain keyboard-readable', async ({
  baseURL,
  page,
}) => {
  expect(baseURL).toBeTruthy();
  await addAccountCookie(page, baseURL!, 'alice');
  const state = await mockGovernance(page, 'alice');
  await page.goto(`/worlds/${worldId}/govern/elections`);

  await expect(page.getByRole('heading', { level: 1, name: 'Elections' })).toBeVisible();
  const nominationCard = proposalCard(page, nominationElection.title);
  await expect(
    nominationCard.locator('ul').getByText('character:alice', { exact: true }),
  ).toBeVisible();
  await expect(
    nominationCard.locator('ul').getByText('character:bob', { exact: true }),
  ).toBeVisible();

  await expect(nominationCard.getByLabel('Candidate entity key')).toHaveValue('character:alice');
  await nominationCard.getByLabel('Statement').fill('A transparent civic platform.');
  await nominationCard.getByRole('button', { name: 'Nominate', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(1);
  expect(state.commands[0]).toMatchObject({
    payload: {
      candidateEntityKey: 'character:alice',
      electionId: nominationElectionId,
      expectedElectionVersion: nominationElection.aggregateVersion,
      officeId,
      statement: 'A transparent civic platform.',
    },
    type: 'NominateCandidateV1',
  });

  await nominationCard.getByRole('button', { name: 'Accept nomination' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toMatchObject({
    payload: {
      candidacyId: nominationAliceCandidacyId,
      electionId: nominationElectionId,
      expectedCandidacyVersion: '1',
      expectedElectionVersion: nominationElection.aggregateVersion,
    },
    type: 'AcceptNominationV1',
  });
  await expect(nominationCard.getByRole('button', { name: 'Submit ballot' })).toHaveCount(0);

  const openElectionCard = proposalCard(page, openElection.title);
  await expect(openElectionCard.getByRole('button', { name: 'Nominate', exact: true })).toHaveCount(
    0,
  );
  await expect(openElectionCard.getByRole('button', { name: 'Accept nomination' })).toHaveCount(0);
  await openElectionCard.getByLabel('Selection').selectOption('character:alice');
  await openElectionCard.getByRole('button', { name: 'Submit ballot' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(3);
  expect(state.commands[2]).toMatchObject({
    payload: {
      choice: { candidateKey: 'character:alice', choiceType: 'candidate' },
      electionId: openElectionId,
      eligibilitySnapshotId: openElectionSnapshotId,
      expectedElectionVersion: openElection.aggregateVersion,
      replaceExisting: false,
    },
    type: 'CastElectionBallotV1',
  });

  await openElectionCard.getByRole('button', { name: 'View my receipt & result' }).focus();
  await page.keyboard.press('Enter');
  await expect(openElectionCard.getByText(/Secret ballot receipt/u)).toContainText(
    'The selection is intentionally unavailable.',
  );
  await expect(openElectionCard.getByLabel('Certified election result')).toHaveCount(0);

  const certifiedElectionCard = proposalCard(page, certifiedElection.title);
  await expect(
    certifiedElectionCard.getByRole('button', { name: 'Nominate', exact: true }),
  ).toHaveCount(0);
  await expect(
    certifiedElectionCard.getByRole('button', { name: 'Accept nomination' }),
  ).toHaveCount(0);
  await expect(certifiedElectionCard.getByRole('button', { name: 'Submit ballot' })).toHaveCount(0);
  await certifiedElectionCard.getByRole('button', { name: 'View my receipt & result' }).focus();
  await page.keyboard.press('Enter');
  const result = certifiedElectionCard.getByLabel('Certified election result');
  await expect(result).toContainText('Winner: character:alice');
  await expect(result).toContainText('character:alice: 2');

  await page.getByRole('link', { name: 'Charter & offices' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Charter and institutions' }),
  ).toBeVisible();
  await expect(page.getByText(/character:alice · seat 1 · ticks 28–76 · Active/u)).toBeVisible();
  await expect(page.getByText('Remove this officeholder')).toBeVisible();
  await expectAccessibleAndContained(page);
});

test('typed proposal effects and explicit operator records remain permanently distinct', async ({
  baseURL,
  page,
}) => {
  expect(baseURL).toBeTruthy();
  await addAccountCookie(page, baseURL!, 'creator');
  const state = await mockGovernance(page, 'creator');
  await page.goto(`/worlds/${worldId}/govern/proposals`);

  const creator = page.locator('details').filter({ hasText: 'Create a typed proposal' });
  await creator.locator('summary').focus();
  await page.keyboard.press('Enter');
  await creator.getByLabel('Proposal key').fill('proposal:levy-adjustment');
  await creator.getByLabel('Title').fill('Adjust harbor levy');
  await creator
    .getByLabel('Public rationale')
    .fill('Keep the service levy within its bounded rate.');
  await creator.getByLabel('Active tax policy').selectOption(taxPolicyId);
  await expect(creator.getByLabel('Expected policy version')).toHaveValue('2');
  await creator.getByLabel('New rate (basis points)').fill('300');
  await creator.getByRole('button', { name: 'Create proposal' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(1);
  expect(state.commands[0]).toMatchObject({
    expectedAggregateVersion: '0',
    payload: {
      action: {
        actionSchemaVersion: 1,
        actionType: 'update_tax',
        effectiveFromTick: '59',
        expectedTaxPolicyVersion: '2',
        newRateBps: 300,
        taxPolicyId,
      },
      approvalThresholdBps: 5001,
      ballotPolicy: {
        ballotMode: 'public',
        disclosure: 'choice_totals',
        replacementAllowed: true,
      },
      debateEndsAtTick: '54',
      institutionId,
      jurisdictionEntityKey: 'district:civic-platform',
      minimumSponsors: 0,
      proposalKey: 'proposal:levy-adjustment',
      quorumBps: 5000,
      sponsorshipEndsAtTick: '52',
      targetCharterVersion: '1',
      votingClosesAtTick: '59',
      votingOpensAtTick: '54',
    },
    type: 'CreateProposalV1',
  });

  await creator.getByLabel('Proposal key').fill('proposal:storm-shelter');
  await creator.getByLabel('Title').fill('Build public storm shelter');
  await creator
    .getByLabel('Public rationale')
    .fill('Authorize an exact treasury amount for a bounded public project.');
  await creator.getByLabel('Action type').selectOption('authorize_public_project');
  await creator.getByLabel('Project key').selectOption('project:storm-shelter');
  await creator.getByLabel('Budget key').fill('budget:storm-shelter');
  await creator.getByLabel('Active treasury').selectOption(treasuryWalletId);
  await expect(creator.getByLabel('Currency ID')).toHaveValue(currencyId);
  await creator.getByLabel('Amount (minor units)').fill('25000');
  await creator
    .getByLabel('Project description')
    .fill('Construct and equip the public storm shelter.');
  await creator.getByRole('button', { name: 'Create proposal' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toMatchObject({
    payload: {
      action: {
        actionSchemaVersion: 1,
        actionType: 'authorize_public_project',
        amountMinor: '25000',
        budgetKey: 'budget:storm-shelter',
        currencyId,
        description: 'Construct and equip the public storm shelter.',
        effectiveAtTick: '59',
        projectKey: 'project:storm-shelter',
        treasuryWalletId,
      },
      approvalThresholdBps: 5001,
      ballotPolicy: {
        ballotMode: 'public',
        disclosure: 'choice_totals',
        replacementAllowed: true,
      },
      debateEndsAtTick: '54',
      institutionId,
      jurisdictionEntityKey: 'district:civic-platform',
      minimumSponsors: 0,
      proposalKey: 'proposal:storm-shelter',
      quorumBps: 5000,
      sponsorshipEndsAtTick: '52',
      targetCharterVersion: '1',
      votingClosesAtTick: '59',
      votingOpensAtTick: '54',
    },
    type: 'CreateProposalV1',
  });

  await page.getByRole('link', { name: 'Operator actions' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Operator power cannot masquerade as civic governance'),
  ).toBeVisible();

  const override = page.locator('form').filter({ hasText: 'Explicit emergency law override' });
  await override.getByLabel('Operator reason').fill('Immediate public safety conflict.');
  await override.getByLabel('Before/after impact').fill('The law becomes repealed at tick 50.');
  await override.getByLabel('Law ID').fill(lawId);
  await override.getByLabel('Expected law version').fill('2');
  await override.getByLabel('Effective tick').fill('50');
  await override.getByLabel('Legal repeal reason').fill('Emergency authority is narrowly invoked.');
  await override
    .getByLabel('Type the exact confirmation')
    .fill('EXECUTE EXPLICIT GOVERNANCE OVERRIDE');
  await override.getByRole('button', { name: 'Review override' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(2);
  const overrideReview = page.getByRole('region', { name: 'Review creator override' });
  await expect(overrideReview).toBeFocused();
  await expect(overrideReview).toContainText(`Law ${lawId}`);
  await expect(overrideReview).toContainText('Law version 2');
  await expect(overrideReview).toContainText('Effective tick');
  await expect(overrideReview).toContainText('Emergency repeal law');
  await expect(overrideReview).toContainText('The law becomes repealed at tick 50.');
  await page.getByLabel('Second approval UUID').fill(overrideApprovalId);
  await page.getByRole('button', { name: 'Attach without changing command identity' }).click();
  const overridePassword = page.locator('form').filter({ hasText: 'Password reauthentication' });
  await overridePassword.getByLabel('Current password').fill('Correct horse battery staple');
  await overridePassword
    .getByRole('button', { name: 'Verify password and execute override' })
    .focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(3);
  expect(state.commands[2]).toMatchObject({
    payload: {
      approvalId: overrideApprovalId,
      confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
      effect: {
        effectType: 'execute_proposal_action',
        proposalAction: {
          actionSchemaVersion: 1,
          actionType: 'repeal_law',
          effectiveAtTick: '50',
          expectedLawVersion: '2',
          lawId,
          reason: 'Emergency authority is narrowly invoked.',
        },
      },
      impact: 'The law becomes repealed at tick 50.',
      reason: 'Immediate public safety conflict.',
    },
    type: 'ExecuteCreatorOverrideV1',
  });
  expect(state.reauthentications[0]).toMatchObject({
    command: state.commands[2],
    password: 'Correct horse battery staple',
    worldId,
  });
  expect(JSON.stringify(state.commands[2])).not.toContain('Correct horse battery staple');

  const repair = page.locator('form').filter({ hasText: 'Append linked result repair' });
  await repair.getByLabel('Repair kind').selectOption('proposal_recount');
  await repair.getByLabel('Source result ID').fill(certifiedProposalResultId);
  await repair.getByLabel('Current result checksum').fill(hashB);
  await repair.getByLabel('Replacement result checksum').fill(hashC);
  await repair
    .getByLabel('Audited reason')
    .fill('A deterministic recount confirms the linked result.');
  await repair.getByLabel('Type the exact confirmation').fill('APPEND LINKED GOVERNANCE REPAIR');
  await repair.getByRole('button', { name: 'Review repair' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(3);
  const repairReview = page.getByRole('region', { name: 'Review governance repair' });
  await expect(repairReview).toBeFocused();
  await expect(repairReview).toContainText(certifiedProposalResultId);
  await expect(repairReview).toContainText(hashB);
  await expect(repairReview).toContainText(hashC);
  await page.getByLabel('Second approval UUID').fill(repairApprovalId);
  await page.getByRole('button', { name: 'Attach without changing command identity' }).click();
  await expectAccessibleAndContained(page);
  const repairPassword = page.locator('form').filter({ hasText: 'Password reauthentication' });
  await repairPassword.getByLabel('Current password').fill('Correct horse battery staple');
  await repairPassword.getByRole('button', { name: 'Verify password and append repair' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.commands.length).toBe(4);
  expect(state.commands[3]).toMatchObject({
    payload: {
      approvalId: repairApprovalId,
      confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
      expectedCurrentResultChecksum: hashB,
      reason: 'A deterministic recount confirms the linked result.',
      repairKind: 'proposal_recount',
      replacementResultChecksum: hashC,
      sourceResultId: certifiedProposalResultId,
    },
    type: 'RepairGovernanceResultV1',
  });
  expect(state.reauthentications[1]).toMatchObject({
    command: state.commands[3],
    password: 'Correct horse battery staple',
    worldId,
  });
  expect(JSON.stringify(state.commands[3])).not.toContain('Correct horse battery staple');
  expect(state.commands[2]?.type).not.toBe(state.commands[3]?.type);

  await page.getByRole('link', { name: 'Public audit' }).focus();
  await page.keyboard.press('Enter');
  const overrideRow = page.getByRole('row').filter({ hasText: 'Governance Override' });
  const repairRow = page.getByRole('row').filter({ hasText: 'Governance Repair' });
  await expect(overrideRow).toContainText('Creator');
  await expect(overrideRow).toContainText('Emergency repeal remained explicitly labeled.');
  await expect(repairRow).toContainText('Administrator');
  await expect(repairRow).toContainText('Linked recount retained the original result.');
  await expectAccessibleAndContained(page);
});

test('an ambiguous gateway failure preserves the proof for one exact frozen retry', async ({
  baseURL,
  page,
}) => {
  expect(baseURL).toBeTruthy();
  await addAccountCookie(page, baseURL!, 'creator');
  const state = await mockGovernance(page, 'creator', {
    ambiguousOnceType: 'ExecuteCreatorOverrideV1',
  });
  await page.goto(`/worlds/${worldId}/govern/override`);

  const override = page.locator('form').filter({ hasText: 'Explicit emergency law override' });
  await override.getByLabel('Operator reason').fill('Immediate public safety conflict.');
  await override.getByLabel('Before/after impact').fill('The law becomes repealed at tick 50.');
  await override.getByLabel('Law ID').fill(lawId);
  await override.getByLabel('Expected law version').fill('2');
  await override.getByLabel('Effective tick').fill('50');
  await override.getByLabel('Legal repeal reason').fill('Emergency authority is narrowly invoked.');
  await override
    .getByLabel('Type the exact confirmation')
    .fill('EXECUTE EXPLICIT GOVERNANCE OVERRIDE');
  await override.getByRole('button', { name: 'Review override' }).click();

  await page.getByLabel('Second approval UUID').fill(overrideApprovalId);
  await page.getByRole('button', { name: 'Attach without changing command identity' }).click();

  const password = page.locator('form').filter({ hasText: 'Password reauthentication' });
  await password.getByLabel('Current password').fill('Correct horse battery staple');
  await password.getByRole('button', { name: 'Verify password and execute override' }).click();

  await expect.poll(() => state.commands.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Retry exact frozen command' })).toBeVisible();
  expect(state.reauthentications).toHaveLength(1);
  const frozenCommand = structuredClone(state.commands[0]);

  await page.getByRole('button', { name: 'Retry exact frozen command' }).click();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toEqual(frozenCommand);
  expect(state.reauthentications).toHaveLength(1);
  await expect(page.getByText(/Accepted at authoritative revision 42/u)).toBeVisible();
  await expectAccessibleAndContained(page);
});
