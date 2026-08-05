import { describe, expect, it } from 'vitest';

import type { GovernanceCommandRequestV1, GovernanceSeedPlanV1 } from '@worldgraph/contracts';
import { governanceSeedPlanHashV1 } from '@worldgraph/governance';

import { dispatchGovernanceHandler } from './handlers.js';
import { governanceTwoPersonApprovalBindingHashV1 } from './approval.js';
import {
  sha256Hex,
  type GovernanceHandlerContext,
  type WorldTransactionContext,
} from './internal.js';
import {
  DEFAULT_GOVERNANCE_COMMAND_POLICY,
  PostgresGovernanceCommandExecutor,
  governanceCommandPayloadHashV1,
  governanceCommandPrivateRequestHashV1,
  governanceCommandRequestHashV1,
  governanceCommandStoredPayloadV1,
  governanceProjectionChecksumV1,
} from './postgres.js';
import { governanceRecentCredentialCommandHashV1 } from './recent-credential.js';
import {
  governanceScheduleCommandType,
  governanceScheduleIdempotencyKey,
  governanceScheduleOccurrenceKey,
} from './schedule.js';
import type {
  GovernanceCommandExecutionInput,
  GovernanceSqlClient,
  GovernanceSqlExecutor,
  GovernanceSqlResult,
} from './types.js';

const hash = 'a'.repeat(64);
const worldId = uuid(1);
const actorEntityId = uuid(2);
const proposalId = uuid(3);
const contestId = uuid(4);
const snapshotId = uuid(5);
const institutionId = uuid(16);
const jurisdictionEntityId = uuid(17);
const officeId = uuid(18);
const officeSeatId = uuid(19);

function uuid(value: number): string {
  return `018f8652-3cb6-7d52-904b-${value.toString(16).padStart(12, '0')}`;
}

function command<T extends GovernanceCommandRequestV1['type']>(
  type: T,
  actorMode: Extract<GovernanceCommandRequestV1, { type: T }>['actorMode'],
  payload: Extract<GovernanceCommandRequestV1, { type: T }>['payload'],
): Extract<GovernanceCommandRequestV1, { type: T }> {
  return {
    actorMode,
    commandId: uuid(10),
    expectedAggregateVersion: '1',
    expectedStateRevision: '4',
    expectedTick: '10',
    expectedWorldVersion: '1',
    idempotencyKey: 'governance-test-0001',
    payload,
    schemaVersion: 1,
    type,
  } as Extract<GovernanceCommandRequestV1, { type: T }>;
}

function publicInput(
  value: GovernanceCommandRequestV1,
  overrides: Partial<GovernanceCommandExecutionInput> = {},
): GovernanceCommandExecutionInput {
  return {
    actor: { actorEntityId, actorId: uuid(6), actorType: 'user' },
    authorization: {
      actionCode: 'governance.participate',
      allowed: true,
      context: {},
      reasonCode: 'ALLOWED',
      resourceId: proposalId,
      resourceType: 'proposal',
      ruleId: 'governance.compiled_policy.v1',
    },
    causationId: null,
    command: value,
    correlationId: uuid(7),
    worldId,
    ...overrides,
  };
}

function internalInput(
  value: GovernanceCommandRequestV1,
  overrides: Partial<GovernanceCommandExecutionInput> = {},
): GovernanceCommandExecutionInput {
  return publicInput(value, {
    actor: { actorEntityId: null, actorId: 'governance-scheduler', actorType: 'system' },
    causationId: uuid(8),
    scheduler: {
      completedEventId: uuid(8),
      dueTick: '5',
      occurrenceKey: 'governance:proposal:open:5',
      scheduledActionId: uuid(9),
    },
    ...overrides,
  });
}

const world: WorldTransactionContext = {
  active_world_version_id: uuid(20),
  anchor_artifact_hash: Buffer.from(hash, 'hex'),
  current_tick: '10',
  design_version: '1',
  governance_checksum: Buffer.from(hash, 'hex'),
  governance_row_version: '1',
  governance_seed_plan_hash: Buffer.from(hash, 'hex'),
  last_entry_hash: Buffer.from(hash, 'hex'),
  lifecycle: 'active',
  next_event_sequence: '7',
  next_ledger_sequence: '9',
  recorded_at: new Date('2026-08-03T00:00:00.000Z'),
  state_revision: '4',
};

type SqlResponder = (
  text: string,
  values: readonly unknown[],
) => GovernanceSqlResult<unknown> | Promise<GovernanceSqlResult<unknown>>;

class ScriptedSql implements GovernanceSqlExecutor {
  public readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  public constructor(private readonly responder: SqlResponder) {}

  public async query<TRow = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<GovernanceSqlResult<TRow>> {
    this.calls.push({ text, values });
    return (await this.responder(text, values)) as GovernanceSqlResult<TRow>;
  }
}

function row<TRow>(...rows: TRow[]): GovernanceSqlResult<TRow> {
  return { rowCount: rows.length, rows };
}

function ids(start = 100): { next(): string } {
  let next = start;
  return { next: () => uuid(next++) };
}

function handlerContext(
  value: GovernanceCommandRequestV1,
  client: GovernanceSqlExecutor,
  overrides: Partial<GovernanceHandlerContext> = {},
): GovernanceHandlerContext {
  const input = value.actorMode === 'system' ? internalInput(value) : publicInput(value);
  return {
    additionalEvents: [],
    client,
    command: value,
    eventId: uuid(30),
    eventLedgerEntryId: uuid(31),
    ids: ids(),
    input,
    policy: DEFAULT_GOVERNANCE_COMMAND_POLICY,
    resultingStateRevision: '5',
    world,
    ...overrides,
  };
}

function proposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aggregate_version: '1',
    allow_ballot_replacement: true,
    ballot_disclosure: 'aggregate_only',
    ballot_mode: 'secret',
    contest_id: contestId,
    contest_version: '1',
    debate_closes_tick: '4',
    minimum_sponsors: 0,
    proposal_id: proposalId,
    proposer_entity_id: actorEntityId,
    quorum_numerator: 0,
    sponsorship_closes_tick: '3',
    status: 'open',
    threshold_numerator: 5_001,
    title: 'Harbor rule',
    voting_closes_tick: '9',
    voting_opens_tick: '5',
    ...overrides,
  };
}

function electionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aggregate_version: '1',
    allow_ballot_replacement: false,
    ballot_disclosure: 'aggregate_only',
    ballot_mode: 'secret',
    certification_tick: '9',
    contest_id: contestId,
    contest_version: '1',
    election_id: uuid(52),
    election_kind: 'regular',
    election_rule_snapshot: {
      ballotPolicy: {
        ballotMode: 'secret',
        disclosure: 'aggregate_only',
        replacementAllowed: false,
      },
      electionCadenceTicks: '100',
      eligibilityPolicy: { kind: 'membership_role', role: 'player' },
      officeKey: 'office:council-speaker',
      seatIndex: 0,
      transitionDelayTicks: '0',
    },
    institution_id: institutionId,
    nomination_closes_tick: '4',
    nomination_opens_tick: '0',
    office_id: officeId,
    quorum_numerator: 0,
    seat_id: officeSeatId,
    status: 'tallied',
    term_starts_tick: '9',
    tie_rule: 'stable_key',
    voting_closes_tick: '9',
    voting_opens_tick: '4',
    ...overrides,
  };
}

function twoSeatSeedPlan(): GovernanceSeedPlanV1 {
  const eligibilityPolicy = { kind: 'membership_role' as const, role: 'player' };
  return {
    charter: {
      citizenEligibilityPolicy: eligibilityPolicy,
      effectiveFromTick: '0',
      effectiveUntilTick: null,
      proposalRules: {
        approvalThresholdBps: 5_001,
        ballotPolicy: {
          ballotMode: 'public',
          disclosure: 'choice_totals',
          replacementAllowed: true,
        },
        debateTicks: '5',
        minimumSponsors: 1,
        quorumBps: 5_000,
        sponsorshipTicks: '5',
        votingTicks: '5',
      },
      stableKey: 'charter:harbor-city',
      summary: 'The founding civic charter.',
      title: 'Harbor City Charter',
    },
    governanceSeedPlanSchemaVersion: 1,
    initialLaws: [],
    institutions: [
      {
        displayName: 'Guild Council',
        institutionType: 'council',
        jurisdictionEntityKey: 'jurisdiction:harbor-city',
        powers: [
          {
            action: 'governance.propose',
            policy: eligibilityPolicy,
            resourceType: 'proposal',
          },
        ],
        stableKey: 'institution:guild-council',
        worldEntityKey: 'entity:guild-council',
      },
    ],
    offices: [
      {
        ballotPolicy: {
          ballotMode: 'secret',
          disclosure: 'aggregate_only',
          replacementAllowed: false,
        },
        displayName: 'Council Speaker',
        electionCadenceTicks: '100',
        eligibilityPolicy,
        institutionKey: 'institution:guild-council',
        powers: [
          {
            action: 'governance.enact',
            delegatedOrganizationEntityKeys: [],
            policy: { kind: 'actor_mode', mode: 'in_world' },
            resourceType: 'proposal',
          },
        ],
        seats: 2,
        stableKey: 'office:council-speaker',
        termDurationTicks: '100',
        tieRule: 'vacancy',
        transitionDelayTicks: '1',
      },
    ],
  };
}

type CreateProposalCommand = Extract<GovernanceCommandRequestV1, { type: 'CreateProposalV1' }>;
type CreateProposalPayload = CreateProposalCommand['payload'];

function charterProposalRules(
  overrides: Partial<GovernanceSeedPlanV1['charter']['proposalRules']> = {},
): GovernanceSeedPlanV1['charter']['proposalRules'] {
  const base = twoSeatSeedPlan().charter.proposalRules;
  return { ...base, ...overrides };
}

function createProposalValue(payloadOverrides: Partial<CreateProposalPayload> = {}) {
  const rules = charterProposalRules();
  const value = command('CreateProposalV1', 'in_world', {
    action: {
      actionSchemaVersion: 1,
      actionType: 'create_law',
      effectiveFromTick: '25',
      effectiveUntilTick: null,
      lawKey: 'law:charter-bound-proposal',
      policy: { kind: 'membership_role', role: 'player' },
      summary: 'Proves proposal creation is bound to the active charter.',
      targetCharterVersion: '1',
      title: 'Charter-bound proposal law',
    },
    approvalThresholdBps: rules.approvalThresholdBps,
    ballotPolicy: rules.ballotPolicy,
    body: 'The command must exactly match the active constitutional rules.',
    debateEndsAtTick: '20',
    institutionId,
    jurisdictionEntityKey: 'jurisdiction:harbor-city',
    minimumSponsors: rules.minimumSponsors,
    proposalKey: 'proposal:charter-bound',
    quorumBps: rules.quorumBps,
    sponsorshipEndsAtTick: '15',
    targetCharterVersion: '1',
    title: 'Charter-bound proposal',
    votingClosesAtTick: '25',
    votingOpensAtTick: '20',
    ...payloadOverrides,
  });
  return { ...value, expectedAggregateVersion: '0' } as CreateProposalCommand;
}

function activeInstitutionPolicy(
  proposalRules: GovernanceSeedPlanV1['charter']['proposalRules'] = charterProposalRules(),
) {
  return {
    charter_version: '1',
    jurisdiction_entity_id: jurisdictionEntityId,
    jurisdiction_entity_key: 'jurisdiction:harbor-city',
    proposal_rules: proposalRules,
  };
}

function proposalAuthorization(
  overrides: Partial<GovernanceCommandExecutionInput['authorization']> = {},
): GovernanceCommandExecutionInput['authorization'] {
  return {
    actionCode: 'governance.proposal.create',
    allowed: true,
    context: {
      policyActionCode: 'governance.propose',
      policyResourceType: 'proposal',
    },
    reasonCode: 'POLICY_ALLOWED',
    resourceId: institutionId,
    resourceType: 'institution',
    ruleId: 'governance.compiled_policy.v1',
    ...overrides,
  };
}

function proposalCreationContext(
  value: CreateProposalCommand,
  client: GovernanceSqlExecutor,
): GovernanceHandlerContext {
  return handlerContext(value, client, {
    input: publicInput(value, {
      authorization: proposalAuthorization(),
    }),
  });
}

describe('governance command boundaries', () => {
  it('binds the governance checkpoint to every ordered event hash', () => {
    const input = {
      eventHashes: [hash, 'b'.repeat(64)],
      previousChecksum: 'c'.repeat(64),
      resultingStateRevision: '5',
      worldId,
    };
    const first = governanceProjectionChecksumV1(input);
    expect(governanceProjectionChecksumV1(structuredClone(input))).toEqual(first);
    expect(
      governanceProjectionChecksumV1({
        ...input,
        eventHashes: [...input.eventHashes].reverse(),
      }),
    ).not.toEqual(first);
    expect(
      governanceProjectionChecksumV1({ ...input, eventHashes: [input.eventHashes.at(-1)!] }),
    ).not.toEqual(first);
  });

  it('hashes only semantic request fields and strips ballot choices from storage', () => {
    const cast = command('CastProposalBallotV1', 'in_world', {
      choice: 'yes',
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    const first = publicInput(cast);
    const second = publicInput(
      { ...cast, commandId: uuid(11), idempotencyKey: 'governance-test-0002' },
      {
        actor: { actorEntityId: uuid(12), actorId: uuid(13), actorType: 'user' },
        authorization: { ...first.authorization, context: { ignored: true } },
        causationId: uuid(14),
        correlationId: uuid(15),
      },
    );
    expect(governanceCommandRequestHashV1(first)).toEqual(governanceCommandRequestHashV1(second));
    expect(governanceCommandStoredPayloadV1(first)).toEqual({
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    expect(
      governanceCommandRequestHashV1({
        ...second,
        command: { ...cast, payload: { ...cast.payload, replaceExisting: true } },
      }),
    ).not.toEqual(governanceCommandRequestHashV1(first));
    const secretHashKey = 'test-only-governance-hmac-key-32-characters';
    const noVote = publicInput({ ...cast, payload: { ...cast.payload, choice: 'no' } });
    expect(governanceCommandPrivateRequestHashV1(first, secretHashKey)).not.toEqual(
      governanceCommandPrivateRequestHashV1(noVote, secretHashKey),
    );
    expect(governanceCommandPrivateRequestHashV1(first, secretHashKey)).not.toEqual(
      governanceCommandRequestHashV1(first),
    );
    expect(governanceCommandPayloadHashV1(first, secretHashKey)).not.toEqual(
      governanceCommandPayloadHashV1(first),
    );
  });

  it('keeps public and internal dispatch surfaces disjoint', async () => {
    let connections = 0;
    const pool = {
      connect: async (): Promise<GovernanceSqlClient> => {
        connections += 1;
        throw new Error('must not connect');
      },
    };
    const executor = new PostgresGovernanceCommandExecutor(pool, { ids: ids() });
    const open = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    const sponsor = command('SponsorProposalV1', 'in_world', {
      expectedProposalVersion: '1',
      proposalId,
    });
    await expect(executor.executePublic(internalInput(open) as never)).rejects.toMatchObject({
      code: 'COMMAND_TYPE_DISABLED',
    });
    await expect(executor.executeInternal(publicInput(sponsor) as never)).rejects.toMatchObject({
      code: 'COMMAND_TYPE_DISABLED',
    });
    expect(connections).toBe(0);
  });

  it('lets an actorless denied in-world request reach the durable rejection boundary', async () => {
    let connections = 0;
    const executor = new PostgresGovernanceCommandExecutor(
      {
        connect: async () => {
          connections += 1;
          throw new Error('durable denial boundary reached');
        },
      },
      { ids: ids() },
    );
    const sponsor = command('SponsorProposalV1', 'in_world', {
      expectedProposalVersion: '1',
      proposalId,
    });
    const denied = publicInput(sponsor, {
      actor: { actorEntityId: null, actorId: uuid(6), actorType: 'user' },
      authorization: {
        actionCode: 'governance.proposal.sponsor',
        allowed: false,
        context: {},
        reasonCode: 'WORLD_NOT_VISIBLE',
        resourceId: proposalId,
        resourceType: 'proposal',
        ruleId: 'world.visibility.required',
      },
    });

    await expect(executor.executePublic(denied as never)).rejects.toThrow(
      'durable denial boundary reached',
    );
    expect(connections).toBe(1);
  });

  it('rejects an actorless allowed in-world request before database use', async () => {
    let connections = 0;
    const executor = new PostgresGovernanceCommandExecutor(
      {
        connect: async () => {
          connections += 1;
          throw new Error('must not connect');
        },
      },
      { ids: ids() },
    );
    const sponsor = command('SponsorProposalV1', 'in_world', {
      expectedProposalVersion: '1',
      proposalId,
    });
    const forgedAllow = publicInput(sponsor, {
      actor: { actorEntityId: null, actorId: uuid(6), actorType: 'user' },
    });

    await expect(executor.executePublic(forgedAllow as never)).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(connections).toBe(0);
  });

  it('fails closed before database use when ballot hash keying is unavailable', async () => {
    let connections = 0;
    const executor = new PostgresGovernanceCommandExecutor(
      {
        connect: async () => {
          connections += 1;
          throw new Error('must not connect');
        },
      },
      { ids: ids() },
    );
    const cast = command('CastProposalBallotV1', 'in_world', {
      choice: 'yes',
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    await expect(executor.executePublic(publicInput(cast) as never)).rejects.toThrow(
      'GOVERNANCE_COMMAND_SECRET_HASH_KEY_REQUIRED',
    );
    expect(connections).toBe(0);
  });

  it('builds deterministic scheduler identities and command mappings', () => {
    const identity = {
      dueTick: '42',
      targetId: proposalId,
      targetKind: 'proposal' as const,
      transitionKind: 'close_tally' as const,
      worldId,
    };
    expect(governanceScheduleOccurrenceKey(identity)).toBe(
      `governance:proposal:${proposalId}:close_tally:42`,
    );
    expect(governanceScheduleCommandType('proposal', 'close_tally')).toBe(
      'CloseAndTallyProposalV1',
    );
    expect(governanceScheduleIdempotencyKey('CloseAndTallyProposalV1', identity)).toMatch(
      /^governance-schedule-v1\.[a-f0-9]{64}$/u,
    );
  });
});

describe('governance handler invariants', () => {
  it('materializes one election, contest, and ordered schedule set per office seat', async () => {
    const plan = twoSeatSeedPlan();
    const seedPlanHash = governanceSeedPlanHashV1(plan);
    const value = command('InitializeWorldGovernanceV1', 'creator', {
      compiledWorldVersionId: world.active_world_version_id,
      seedPlanHash,
    });
    let scheduleSequence = 0;
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:initialize:head-check')) return row();
      if (text.includes('governance:initialize:load-seed')) {
        return row({ canonical_plan: plan, plan_hash: Buffer.from(seedPlanHash, 'hex') });
      }
      if (text.includes('governance:entity:resolve-id')) return row({ id: uuid(92) });
      if (text.includes('governance:schedule:allocate')) {
        scheduleSequence += 1;
        return row({ sequence: String(scheduleSequence) });
      }
      return { rowCount: 1, rows: [] };
    });
    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));
    const elections = sql.calls.filter((call) => call.text.includes('governance:seed:election */'));
    const contests = sql.calls.filter((call) =>
      call.text.includes('governance:seed:election-contest */'),
    );
    const schedules = sql.calls.filter((call) => call.text.includes('governance:schedule:create'));
    expect(outcome.responseDetails).toMatchObject({ electionCount: 2, officeCount: 1 });
    expect(elections).toHaveLength(2);
    expect(contests).toHaveLength(2);
    expect(new Set(elections.map((call) => call.values[0])).size).toBe(2);
    expect(new Set(elections.map((call) => call.values[4])).size).toBe(2);
    expect(
      elections.map(
        (call) =>
          (JSON.parse(String(call.values[16])) as { electionCadenceTicks?: unknown })
            .electionCadenceTicks,
      ),
    ).toEqual(['100', '100']);
    expect(schedules.map((call) => call.values[4])).toEqual([
      'OpenElectionV1',
      'CloseAndTallyElectionV1',
      'CertifyElectionV1',
      'OpenElectionV1',
      'CloseAndTallyElectionV1',
      'CertifyElectionV1',
    ]);
    expect(schedules.map((call) => call.values[3])).toEqual(['35', '60', '61', '35', '60', '61']);
  });

  it('derives a zero-sponsor proposal as debate from its exact active charter', async () => {
    const rules = charterProposalRules({ minimumSponsors: 0 });
    const value = createProposalValue({ minimumSponsors: 0 });
    let scheduleSequence = 0;
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:active-charter-policy')) {
        return row(activeInstitutionPolicy(rules));
      }
      if (text.includes('governance:schedule:allocate')) {
        scheduleSequence += 1;
        return row({ sequence: String(scheduleSequence) });
      }
      return { rowCount: 1, rows: [] };
    });

    const outcome = await dispatchGovernanceHandler(proposalCreationContext(value, sql));

    expect(outcome.event.payload).toMatchObject({ status: 'debate' });
    const insert = sql.calls.find((call) => call.text.includes('governance:proposal:create */'));
    expect(insert?.values[8]).toBe('debate');
    expect(insert?.values.slice(9, 16)).toEqual(['15', '20', '20', '25', 0, 5_000, 5_001]);
    expect(
      sql.calls
        .filter((call) => call.text.includes('governance:schedule:create'))
        .map((call) => [call.values[3], call.values[4]]),
    ).toEqual([
      ['20', 'OpenProposalVotingV1'],
      ['25', 'CloseAndTallyProposalV1'],
      ['25', 'CertifyAndEnactProposalV1'],
    ]);
  });

  it.each([
    ['forged outer action', proposalAuthorization({ actionCode: 'governance.propose' })],
    [
      'missing policy action',
      proposalAuthorization({ context: { policyResourceType: 'proposal' } }),
    ],
    [
      'forged policy action',
      proposalAuthorization({
        context: {
          policyActionCode: 'governance.appoint',
          policyResourceType: 'proposal',
        },
      }),
    ],
    [
      'missing policy resource',
      proposalAuthorization({ context: { policyActionCode: 'governance.propose' } }),
    ],
    [
      'forged policy resource',
      proposalAuthorization({
        context: {
          policyActionCode: 'governance.propose',
          policyResourceType: 'office',
        },
      }),
    ],
    ['forged target type', proposalAuthorization({ resourceType: 'proposal' })],
    ['forged target id', proposalAuthorization({ resourceId: uuid(99) })],
  ])('rejects %s authority evidence before proposal reads', async (_name, authorization) => {
    const value = createProposalValue();
    const sql = new ScriptedSql(() => row(activeInstitutionPolicy()));
    const context = proposalCreationContext(value, sql);
    context.input.authorization = authorization;

    await expect(dispatchGovernanceHandler(context)).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(sql.calls).toHaveLength(0);
  });

  it.each([
    [
      'approval threshold',
      (payload: CreateProposalPayload) => ({ ...payload, approvalThresholdBps: 1 }),
      'GOVERNANCE_POLICY_DENIED',
    ],
    [
      'quorum',
      (payload: CreateProposalPayload) => ({ ...payload, quorumBps: 0 }),
      'GOVERNANCE_POLICY_DENIED',
    ],
    [
      'window',
      (payload: CreateProposalPayload) => ({ ...payload, votingOpensAtTick: '21' }),
      'GOVERNANCE_POLICY_DENIED',
    ],
    [
      'ballot policy',
      (payload: CreateProposalPayload) => ({
        ...payload,
        ballotPolicy: { ...payload.ballotPolicy, replacementAllowed: false },
      }),
      'GOVERNANCE_POLICY_DENIED',
    ],
    [
      'jurisdiction',
      (payload: CreateProposalPayload) => ({
        ...payload,
        jurisdictionEntityKey: 'jurisdiction:unrelated',
      }),
      'GOVERNANCE_POLICY_DENIED',
    ],
    [
      'charter version',
      (payload: CreateProposalPayload) => ({ ...payload, targetCharterVersion: '2' }),
      'AGGREGATE_VERSION_CONFLICT',
    ],
    [
      'action charter version',
      (payload: CreateProposalPayload) => ({
        ...payload,
        action:
          payload.action.actionType === 'create_law'
            ? { ...payload.action, targetCharterVersion: '2' }
            : payload.action,
      }),
      'AGGREGATE_VERSION_CONFLICT',
    ],
  ])('rejects a caller-selected %s before proposal persistence', async (_name, mutate, code) => {
    const base = createProposalValue();
    const value = createProposalValue(mutate(base.payload));
    const sql = new ScriptedSql((text) =>
      text.includes('governance:proposal:active-charter-policy')
        ? row(activeInstitutionPolicy())
        : { rowCount: 1, rows: [] },
    );

    await expect(
      dispatchGovernanceHandler(proposalCreationContext(value, sql)),
    ).rejects.toMatchObject({ code });
    expect(sql.calls.some((call) => call.text.includes('governance:proposal:create */'))).toBe(
      false,
    );
  });

  it('moves a proposal into debate when its sponsorship threshold is reached', async () => {
    const value = command('SponsorProposalV1', 'in_world', {
      expectedProposalVersion: '1',
      proposalId,
    });
    let proposalLoads = 0;
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) {
        proposalLoads += 1;
        return row(
          proposalRow({
            debate_closes_tick: '20',
            minimum_sponsors: 1,
            sponsorship_closes_tick: '15',
            status: proposalLoads === 1 ? 'sponsoring' : 'debate',
          }),
        );
      }
      return { rowCount: 1, rows: [] };
    });

    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));

    expect(outcome.event.payload).toMatchObject({ status: 'debate' });
    expect(
      sql.calls.find((call) => call.text.includes('governance:proposal:sponsor-increment'))?.text,
    ).toContain("then 'debate'");
  });

  it('records sponsorship failure when an under-sponsored proposal reaches voting open', async () => {
    const value = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) {
        return row(
          proposalRow({
            minimum_sponsors: 2,
            status: 'sponsoring',
            voting_closes_tick: '11',
          }),
        );
      }
      if (text.includes('governance:proposal:sponsor-count')) return row({ count: 1 });
      return { rowCount: 1, rows: [] };
    });

    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));

    expect(outcome.event.payload).toMatchObject({ status: 'rejected' });
    expect(
      sql.calls.some((call) => call.text.includes('governance:proposal:sponsorship-terminal')),
    ).toBe(true);
    expect(
      sql.calls.some((call) =>
        call.text.includes('governance:proposal:sponsorship-contest-terminal'),
      ),
    ).toBe(true);
    expect(sql.calls.some((call) => call.text.includes('governance:eligibility:'))).toBe(false);
  });

  it('rejects a proposal discovered at its close tick without freezing eligibility', async () => {
    const value = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) {
        return row(
          proposalRow({
            minimum_sponsors: 1,
            status: 'scheduled',
            voting_closes_tick: '10',
          }),
        );
      }
      return { rowCount: 1, rows: [] };
    });

    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));

    expect(outcome.event).toMatchObject({
      aggregateVersion: '2',
      payload: {
        aggregateId: proposalId,
        occurredTick: '10',
        status: 'rejected',
      },
      summaryCode: 'PROPOSAL_REJECTED_VOTING_WINDOW_MISSED',
    });
    expect(outcome.responseDetails).toEqual({
      rejectionReason: 'voting_window_missed',
      votingClosesTick: '10',
    });
    expect(
      sql.calls.some((call) => call.text.includes('governance:proposal:delayed-open-terminal')),
    ).toBe(true);
    expect(
      sql.calls.some((call) =>
        call.text.includes('governance:proposal:delayed-open-contest-terminal'),
      ),
    ).toBe(true);
    expect(
      sql.calls.find((call) => call.text.includes('governance:proposal:transition'))?.values[7],
    ).toBe('PROPOSAL_VOTING_WINDOW_MISSED');
    expect(sql.calls.some((call) => call.text.includes('governance:proposal:sponsor-count'))).toBe(
      false,
    );
    expect(sql.calls.some((call) => call.text.includes('governance:eligibility:'))).toBe(false);
    expect(sql.calls.some((call) => call.text.includes('governance:proposal:open */'))).toBe(false);
  });

  it('never exposes a secret choice outside the fixed ballot-cast boundary', async () => {
    const value = command('CastProposalBallotV1', 'in_world', {
      choice: 'yes',
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) return row(proposalRow());
      if (text.includes('governance:ballot:participation')) return row();
      if (text.includes('governance:ballot:mode')) return row({ ballot_mode: 'secret' });
      if (text.includes('governance:ballot:cast-choice-boundary')) {
        return row({
          ballot_mode: 'secret',
          effective_revision: 1,
          participation_id: uuid(40),
          participation_version: '1',
          receipt_hash: Buffer.from(hash, 'hex'),
        });
      }
      if (text.includes('governance:ballot:turnout')) return row({ count: 1 });
      if (text.includes('governance:entity:resolve-key')) {
        return row({ logical_key: 'harbor:citizen:one' });
      }
      return row();
    });
    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));
    expect(outcome.event.payload).toMatchObject({
      ballotMode: 'secret',
      disclosure: 'aggregate_only',
      eventType: 'ProposalBallotRecordedSecretV1',
    });
    expect(JSON.stringify(outcome)).not.toMatch(/"choice"|voterEntity/iu);
    const callsWithChoice = sql.calls.filter((call) =>
      call.values.some((item) => typeof item === 'string' && item.includes('"choice":"yes"')),
    );
    expect(callsWithChoice).toHaveLength(1);
    expect(callsWithChoice[0]?.text).toContain('governance:ballot:cast-choice-boundary');
  });

  it('publishes exact proposal choice totals without voter, choice, or receipt linkage', async () => {
    const value = command('CastProposalBallotV1', 'in_world', {
      choice: 'yes',
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) {
        return row(proposalRow({ ballot_disclosure: 'choice_totals', ballot_mode: 'public' }));
      }
      if (text.includes('governance:ballot:participation')) return row();
      if (text.includes('governance:ballot:mode')) return row({ ballot_mode: 'public' });
      if (text.includes('governance:ballot:cast-choice-boundary')) {
        return row({
          ballot_mode: 'public',
          choice_totals: { abstainCount: 1, noCount: 1, yesCount: 2 },
          effective_revision: 1,
          participation_id: uuid(40),
          participation_version: '1',
          receipt_hash: Buffer.from(hash, 'hex'),
        });
      }
      if (text.includes('governance:ballot:turnout')) return row({ count: 4 });
      return row();
    });

    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));

    expect(outcome.event.payload).toEqual({
      abstainCount: 1,
      aggregateVersion: '1',
      ballotMode: 'public',
      disclosure: 'choice_totals',
      eventType: 'ProposalBallotRecordedPublicV1',
      noCount: 1,
      proposalId,
      turnoutCount: 4,
      yesCount: 2,
    });
    expect(sql.calls.some((call) => call.text.includes('governance:entity:resolve-key'))).toBe(
      false,
    );
    expect(
      sql.calls.find((call) => call.text.includes('governance:ballot:cast-choice-boundary'))?.text,
    ).toContain('choice_totals');
  });

  it('publishes exact election choice totals without voter, choice, or receipt linkage', async () => {
    const electionId = uuid(52);
    const value = command('CastElectionBallotV1', 'in_world', {
      choice: { choiceType: 'abstain' },
      electionId,
      eligibilitySnapshotId: snapshotId,
      expectedElectionVersion: '1',
      replaceExisting: false,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:election:load')) {
        return row(
          electionRow({
            ballot_disclosure: 'choice_totals',
            ballot_mode: 'public',
            status: 'open',
          }),
        );
      }
      if (text.includes('governance:ballot:participation')) return row();
      if (text.includes('governance:ballot:mode')) return row({ ballot_mode: 'public' });
      if (text.includes('governance:ballot:cast-choice-boundary')) {
        return row({
          ballot_mode: 'public',
          choice_totals: {
            abstainCount: 1,
            candidateTotals: [
              { candidateKey: 'character:alice', voteCount: 2 },
              { candidateKey: 'character:bob', voteCount: 0 },
            ],
          },
          effective_revision: 1,
          participation_id: uuid(40),
          participation_version: '1',
          receipt_hash: Buffer.from(hash, 'hex'),
        });
      }
      if (text.includes('governance:ballot:turnout')) return row({ count: 3 });
      return row();
    });

    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));

    expect(outcome.event.payload).toEqual({
      abstainCount: 1,
      aggregateVersion: '1',
      ballotMode: 'public',
      candidateTotals: [
        { candidateKey: 'character:alice', voteCount: 2 },
        { candidateKey: 'character:bob', voteCount: 0 },
      ],
      disclosure: 'choice_totals',
      electionId,
      eventType: 'ElectionBallotRecordedPublicV1',
      turnoutCount: 3,
    });
    expect(sql.calls.some((call) => call.text.includes('governance:entity:resolve-key'))).toBe(
      false,
    );
  });

  it('rejects invalid replacement direction before recording a ballot', async () => {
    const value = command('CastProposalBallotV1', 'in_world', {
      choice: 'abstain',
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) return row(proposalRow());
      if (text.includes('governance:ballot:participation')) {
        return row({ participation_id: uuid(40) });
      }
      return row();
    });
    await expect(dispatchGovernanceHandler(handlerContext(value, sql))).rejects.toMatchObject({
      code: 'BALLOT_ALREADY_CAST',
    });
    expect(sql.calls.some((call) => call.text.includes('cast-choice-boundary'))).toBe(false);
  });

  it('maps a closed ballot window to a safe domain rejection', async () => {
    const value = command('CastProposalBallotV1', 'in_world', {
      choice: 'no',
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) return row(proposalRow());
      if (text.includes('governance:ballot:participation')) return row();
      if (text.includes('governance:ballot:mode')) return row({ ballot_mode: 'secret' });
      if (text.includes('governance:ballot:cast-choice-boundary')) {
        throw Object.assign(new Error('contest is not open'), { code: '55000' });
      }
      return row();
    });
    await expect(dispatchGovernanceHandler(handlerContext(value, sql))).rejects.toMatchObject({
      code: 'BALLOT_WINDOW_CLOSED',
      safeFailure: true,
    });
  });

  it('permits scheduler catch-up but rejects a mismatched membership checksum', async () => {
    const value = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) {
        return row(proposalRow({ status: 'scheduled', voting_closes_tick: '11' }));
      }
      if (text.includes('governance:proposal:sponsor-count')) return row({ count: 0 });
      if (text.includes('governance:eligibility:proposal-policy')) {
        return row({
          eligibility_policy: { kind: 'membership_role', role: 'player' },
          policy_source_id: uuid(91),
          policy_source_kind: 'charter_citizen_eligibility',
          policy_source_version: '1',
        });
      }
      if (text.includes('governance:eligibility:policy-members')) return row();
      return row();
    });
    await expect(dispatchGovernanceHandler(handlerContext(value, sql))).rejects.toMatchObject({
      code: 'TALLY_CHECKSUM_MISMATCH',
    });
  });

  it('requires exact proposer ownership for withdrawal', async () => {
    const value = command('WithdrawProposalV1', 'in_world', {
      expectedProposalVersion: '1',
      proposalId,
      reason: 'No longer appropriate',
    });
    const sql = new ScriptedSql((text) =>
      text.includes('governance:proposal:load')
        ? row(proposalRow({ proposer_entity_id: uuid(90), status: 'scheduled' }))
        : row(),
    );
    await expect(dispatchGovernanceHandler(handlerContext(value, sql))).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(sql.calls.some((call) => call.text.includes('governance:proposal:withdraw'))).toBe(
      false,
    );
  });

  it.each([
    ['past', '9'],
    ['future', '11'],
  ])('rejects a normal appointment with a %s authority start tick', async (_name, startsTick) => {
    const value = command('AppointOfficeholderV1', 'in_world', {
      expectedOfficeVersion: '1',
      holderEntityKey: 'character:appointed-citizen',
      officeId,
      reason: 'Exercise the exact office authority activation boundary.',
      seatIndex: 0,
      termEndsAtTick: '20',
      termStartsAtTick: startsTick,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:office:load-seat')) {
        return row({ office_version: '1', seat_id: officeSeatId });
      }
      if (text.includes('governance:entity:resolve-id')) return row({ id: uuid(90) });
      return { rowCount: 1, rows: [] };
    });
    const input = publicInput(value, {
      authorization: {
        actionCode: 'governance.office.appoint',
        allowed: true,
        context: {
          policyActionCode: 'governance.appoint',
          policyResourceType: 'office',
        },
        reasonCode: 'POLICY_ALLOWED',
        resourceId: officeId,
        resourceType: 'office',
        ruleId: 'governance.compiled_policy.v1',
      },
    });

    await expect(
      dispatchGovernanceHandler(handlerContext(value, sql, { input })),
    ).rejects.toMatchObject({ code: 'ENACTMENT_FAILED' });
    expect(sql.calls.some((call) => call.text.includes('governance:office:insert-term */'))).toBe(
      false,
    );
  });

  it('binds office removal to its outer action, appointment policy, and exact term target', async () => {
    const termId = uuid(92);
    const value = command('RemoveOfficeholderV1', 'in_world', {
      effectiveAtTick: '10',
      expectedTermVersion: '1',
      reason: 'Remove the officeholder under the compiled appointment authority.',
      termId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:office:load-term')) {
        return row({
          office_id: officeId,
          seat_index: 0,
          status: 'active',
          term_version: '1',
        });
      }
      return { rowCount: 1, rows: [] };
    });
    const input = publicInput(value, {
      authorization: {
        actionCode: 'governance.office.remove',
        allowed: true,
        context: {
          policyActionCode: 'governance.appoint',
          policyResourceType: 'office',
        },
        reasonCode: 'POLICY_ALLOWED',
        resourceId: termId,
        resourceType: 'office_term',
        ruleId: 'governance.compiled_policy.v1',
      },
    });

    const outcome = await dispatchGovernanceHandler(handlerContext(value, sql, { input }));

    expect(outcome.event).toMatchObject({
      aggregateId: termId,
      aggregateType: 'office_term',
      aggregateVersion: '2',
      summaryCode: 'OFFICEHOLDER_REMOVED',
    });
    expect(sql.calls.some((call) => call.text.includes('governance:office:remove */'))).toBe(true);
  });

  it.each([
    [
      'policy action used as the outer action',
      'governance.appoint',
      {
        policyActionCode: 'governance.appoint',
        policyResourceType: 'office',
      },
    ],
    ['missing policy context', 'governance.office.remove', {}],
  ])('rejects office removal with %s', async (_name, actionCode, policyContext) => {
    const termId = uuid(92);
    const value = command('RemoveOfficeholderV1', 'in_world', {
      effectiveAtTick: '10',
      expectedTermVersion: '1',
      reason: 'Reject evidence that is not exactly bound to this removal.',
      termId,
    });
    const sql = new ScriptedSql(() => row());
    const input = publicInput(value, {
      authorization: {
        actionCode,
        allowed: true,
        context: policyContext,
        reasonCode: 'POLICY_ALLOWED',
        resourceId: termId,
        resourceType: 'office_term',
        ruleId: 'governance.compiled_policy.v1',
      },
    });

    await expect(
      dispatchGovernanceHandler(handlerContext(value, sql, { input })),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(sql.calls).toHaveLength(0);
  });

  it.each([
    ['past', '9'],
    ['future', '11'],
  ])(
    'rejects an override appointment with a %s authority start tick',
    async (_name, startsTick) => {
      const value = command('ExecuteCreatorOverrideV1', 'creator', {
        approvalId: null,
        confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
        effect: {
          appointment: {
            expectedOfficeVersion: '1',
            holderEntityKey: 'character:appointed-citizen',
            officeId,
            reason: 'Exercise the exact override activation boundary.',
            seatIndex: 0,
            termEndsAtTick: '20',
            termStartsAtTick: startsTick,
          },
          effectType: 'appoint_officeholder',
        },
        impact: 'The appointment would otherwise create an authority interval.',
        reason: 'Reject retroactive or premature creator authority changes.',
      });
      const sql = new ScriptedSql((text) => {
        if (text.includes('governance:override:provenance')) {
          return row({ actor_user_id: uuid(6), target_id: officeId, target_type: 'office' });
        }
        if (text.includes('governance:office:load-seat')) {
          return row({ office_version: '1', seat_id: officeSeatId });
        }
        if (text.includes('governance:entity:resolve-id')) return row({ id: uuid(90) });
        return { rowCount: 1, rows: [] };
      });

      await expect(
        dispatchGovernanceHandler(
          handlerContext(value, sql, {
            creatorOverride: {
              action: 'governance.override.appoint',
              auditRecordId: uuid(91),
              creatorOverrideId: uuid(92),
              effectHash: hash,
              targetId: officeId,
              targetType: 'office',
            },
            policy: { ...DEFAULT_GOVERNANCE_COMMAND_POLICY, requireTwoPersonOverride: false },
          }),
        ),
      ).rejects.toMatchObject({ code: 'ENACTMENT_FAILED' });
      expect(sql.calls.some((call) => call.text.includes('governance:office:insert-term */'))).toBe(
        false,
      );
    },
  );

  it('keeps an override appointment distinct from its active term fact', async () => {
    const value = command('ExecuteCreatorOverrideV1', 'creator', {
      approvalId: null,
      confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
      effect: {
        appointment: {
          expectedOfficeVersion: '1',
          holderEntityKey: 'character:appointed-citizen',
          officeId,
          reason: 'Fill the vacant office under explicit emergency authority.',
          seatIndex: 0,
          termEndsAtTick: '20',
          termStartsAtTick: '10',
        },
        effectType: 'appoint_officeholder',
      },
      impact: 'Creates one bounded office authority interval.',
      reason: 'Exercise and permanently label the explicit override path.',
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:override:provenance')) {
        return row({ actor_user_id: uuid(6), target_id: officeId, target_type: 'office' });
      }
      if (text.includes('governance:office:load-seat')) {
        return row({ office_version: '1', seat_id: officeSeatId });
      }
      if (text.includes('governance:entity:resolve-id')) return row({ id: uuid(90) });
      if (text.includes('governance:office:term-number')) return row({ term_number: 1 });
      return { rowCount: 1, rows: [] };
    });
    const context = handlerContext(value, sql, {
      creatorOverride: {
        action: 'governance.override.appoint',
        auditRecordId: uuid(91),
        creatorOverrideId: uuid(92),
        effectHash: hash,
        targetId: officeId,
        targetType: 'office',
      },
      policy: { ...DEFAULT_GOVERNANCE_COMMAND_POLICY, requireTwoPersonOverride: false },
    });

    const outcome = await dispatchGovernanceHandler(context);

    expect(outcome.event).toMatchObject({
      aggregateType: 'governance_override',
      aggregateVersion: '1',
      eventType: 'GovernanceOverrideExecutedV1',
      ledgerKind: 'override',
    });
    expect(context.additionalEvents).toHaveLength(1);
    expect(context.additionalEvents[0]).toMatchObject({
      aggregateType: 'office_term',
      aggregateVersion: '1',
      eventType: 'GovernanceOfficeTermChangedV1',
      payload: {
        eventType: 'GovernanceOfficeTermChangedV1',
        officeId,
        seatIndex: 0,
        status: 'active',
      },
    });
  });

  it.each([
    ['past', '9'],
    ['future', '11'],
  ])(
    'fails proposal appointment enactment with a %s authority start tick',
    async (_name, startsTick) => {
      const value = command('CertifyAndEnactProposalV1', 'system', {
        enactmentKey: 'governance:proposal:appointment-enactment',
        expectedProposalVersion: '1',
        expectedResultChecksum: hash,
        proposalId,
        resultId: uuid(50),
      });
      const sql = new ScriptedSql((text) => {
        if (text.includes('governance:proposal:load')) {
          return row(proposalRow({ status: 'tallied' }));
        }
        if (text.includes('governance:proposal:certify-load')) {
          return row({
            algorithm_version: 'proposal_yes_no_v1',
            input_checksum: Buffer.from(hash, 'hex'),
            outcome: 'passed',
            output_checksum: Buffer.from(hash, 'hex'),
            proposal_id: proposalId,
            quorum_met: true,
            tally_id: uuid(51),
            threshold_met: true,
          });
        }
        if (text.includes('governance:enactment:load-actions')) {
          return row({
            action_id: uuid(52),
            action_kind: 'office_appointment',
            action_ordinal: 0,
            action_payload: {
              actionSchemaVersion: 1,
              actionType: 'appoint_officeholder',
              expectedOfficeVersion: '1',
              holderEntityKey: 'character:appointed-citizen',
              officeId,
              seatIndex: 0,
              termEndsAtTick: '20',
              termStartsAtTick: startsTick,
            },
          });
        }
        if (text.includes('governance:office:load-seat')) {
          return row({ office_version: '1', seat_id: officeSeatId });
        }
        if (text.includes('governance:entity:resolve-id')) return row({ id: uuid(90) });
        return { rowCount: 1, rows: [] };
      });

      const outcome = await dispatchGovernanceHandler(handlerContext(value, sql));

      expect(outcome.responseDetails).toMatchObject({
        enactmentFailure: 'ENACTMENT_FAILED',
        status: 'passed_but_enactment_failed',
      });
      expect(sql.calls.some((call) => call.text.includes('governance:office:insert-term */'))).toBe(
        false,
      );
    },
  );

  it('stages an active term fact for a successfully enacted proposal appointment', async () => {
    const value = command('CertifyAndEnactProposalV1', 'system', {
      enactmentKey: 'governance:proposal:appointment-effect-event',
      expectedProposalVersion: '1',
      expectedResultChecksum: hash,
      proposalId,
      resultId: uuid(50),
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) {
        return row(proposalRow({ status: 'tallied' }));
      }
      if (text.includes('governance:proposal:certify-load')) {
        return row({
          algorithm_version: 'proposal_yes_no_v1',
          input_checksum: Buffer.from(hash, 'hex'),
          outcome: 'passed',
          output_checksum: Buffer.from(hash, 'hex'),
          proposal_id: proposalId,
          quorum_met: true,
          tally_id: uuid(51),
          threshold_met: true,
        });
      }
      if (text.includes('governance:enactment:load-actions')) {
        return row({
          action_id: uuid(52),
          action_kind: 'office_appointment',
          action_ordinal: 0,
          action_payload: {
            actionSchemaVersion: 1,
            actionType: 'appoint_officeholder',
            expectedOfficeVersion: '1',
            holderEntityKey: 'character:appointed-citizen',
            officeId,
            seatIndex: 0,
            termEndsAtTick: '20',
            termStartsAtTick: '10',
          },
        });
      }
      if (text.includes('governance:office:load-seat')) {
        return row({ office_version: '1', seat_id: officeSeatId });
      }
      if (text.includes('governance:entity:resolve-id')) return row({ id: uuid(90) });
      if (text.includes('governance:office:term-number')) return row({ term_number: 1 });
      return { rowCount: 1, rows: [] };
    });
    const context = handlerContext(value, sql);

    const outcome = await dispatchGovernanceHandler(context);

    expect(outcome.responseDetails).toMatchObject({ status: 'enacted' });
    expect(context.additionalEvents).toHaveLength(1);
    expect(context.additionalEvents[0]).toMatchObject({
      aggregateType: 'office_term',
      aggregateVersion: '1',
      eventType: 'GovernanceOfficeTermChangedV1',
      payload: {
        eventType: 'GovernanceOfficeTermChangedV1',
        officeId,
        seatIndex: 0,
        status: 'active',
      },
    });
    expect(sql.calls.some((call) => call.text.includes('governance:office:seed-term-stream'))).toBe(
      false,
    );
  });

  it('rolls back only enactment effects and records passed-but-failed status', async () => {
    const value = command('CertifyAndEnactProposalV1', 'system', {
      enactmentKey: 'governance:proposal:enactment',
      expectedProposalVersion: '1',
      expectedResultChecksum: hash,
      proposalId,
      resultId: uuid(50),
    });
    let lawCheckCount = 0;
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:proposal:load')) {
        return row(proposalRow({ status: 'tallied' }));
      }
      if (text.includes('governance:proposal:certify-load')) {
        return row({
          algorithm_version: 'proposal_yes_no_v1',
          input_checksum: Buffer.from(hash, 'hex'),
          outcome: 'passed',
          output_checksum: Buffer.from(hash, 'hex'),
          proposal_id: proposalId,
          quorum_met: true,
          tally_id: uuid(51),
          threshold_met: true,
        });
      }
      if (text.includes('governance:enactment:load-actions')) {
        return row(
          {
            action_id: uuid(52),
            action_kind: 'law_create',
            action_ordinal: 0,
            action_payload: {
              actionSchemaVersion: 1,
              actionType: 'create_law',
              effectiveFromTick: '10',
              effectiveUntilTick: null,
              lawKey: 'law:first-effect-rolls-back',
              policy: { kind: 'membership_role', role: 'player' },
              summary: 'Stages one effect event before the later action fails.',
              targetCharterVersion: '1',
              title: 'First staged law',
            },
          },
          {
            action_id: uuid(53),
            action_kind: 'law_create',
            action_ordinal: 1,
            action_payload: {
              actionSchemaVersion: 1,
              actionType: 'create_law',
              effectiveFromTick: '10',
              effectiveUntilTick: null,
              lawKey: 'law:conflicting-second-effect',
              policy: { kind: 'membership_role', role: 'player' },
              summary: 'Conflicts after the first effect has been staged.',
              targetCharterVersion: '1',
              title: 'Conflicting staged law',
            },
          },
        );
      }
      if (text.includes('governance:enactment:law-create-check')) {
        lawCheckCount += 1;
        return lawCheckCount === 1 ? row() : row({ present: true });
      }
      if (text.includes('governance:enactment:proposal-jurisdiction')) {
        return row({ jurisdiction_entity_id: jurisdictionEntityId });
      }
      return { rowCount: 1, rows: [] };
    });
    const context = handlerContext(value, sql);
    const outcome = await dispatchGovernanceHandler(context);
    expect(outcome.responseDetails).toMatchObject({
      enactmentFailure: 'LAW_VERSION_CONFLICT',
      outcome: 'passed',
      status: 'passed_but_enactment_failed',
    });
    expect(sql.calls.map((call) => call.text.trim())).toContain(
      'rollback to savepoint governance_enactment',
    );
    expect(
      sql.calls.some((call) => call.text.includes('governance:proposal:enactment-failed')),
    ).toBe(true);
    expect(context.additionalEvents).toEqual([]);
    expect(lawCheckCount).toBe(2);
  });

  it('stages one safe law-version fact for every enacted create, amend, and repeal action', async () => {
    const amendLawId = uuid(81);
    const repealLawId = uuid(82);
    const value = command('CertifyAndEnactProposalV1', 'system', {
      enactmentKey: 'governance:proposal:law-effect-events',
      expectedProposalVersion: '1',
      expectedResultChecksum: hash,
      proposalId,
      resultId: uuid(50),
    });
    const sql = new ScriptedSql((text, values) => {
      if (text.includes('governance:proposal:load')) {
        return row(proposalRow({ status: 'tallied' }));
      }
      if (text.includes('governance:proposal:certify-load')) {
        return row({
          algorithm_version: 'proposal_yes_no_v1',
          input_checksum: Buffer.from(hash, 'hex'),
          outcome: 'passed',
          output_checksum: Buffer.from(hash, 'hex'),
          proposal_id: proposalId,
          quorum_met: true,
          tally_id: uuid(51),
          threshold_met: true,
        });
      }
      if (text.includes('governance:enactment:load-actions')) {
        return row(
          {
            action_id: uuid(52),
            action_kind: 'law_create',
            action_ordinal: 0,
            action_payload: {
              actionSchemaVersion: 1,
              actionType: 'create_law',
              effectiveFromTick: '10',
              effectiveUntilTick: null,
              lawKey: 'law:effect-event-create',
              policy: { kind: 'membership_role', role: 'player' },
              summary: 'Creates a law and a corresponding immutable domain fact.',
              targetCharterVersion: '1',
              title: 'Effect event create law',
            },
          },
          {
            action_id: uuid(53),
            action_kind: 'law_amend',
            action_ordinal: 1,
            action_payload: {
              actionSchemaVersion: 1,
              actionType: 'amend_law',
              effectiveFromTick: '10',
              effectiveUntilTick: null,
              expectedLawVersion: '1',
              lawId: amendLawId,
              policy: { kind: 'membership_role', role: 'creator' },
              summary: 'Amends a law and emits its immutable version fact.',
              title: 'Effect event amended law',
            },
          },
          {
            action_id: uuid(54),
            action_kind: 'law_repeal',
            action_ordinal: 2,
            action_payload: {
              actionSchemaVersion: 1,
              actionType: 'repeal_law',
              effectiveAtTick: '10',
              expectedLawVersion: '1',
              lawId: repealLawId,
              reason: 'The replaced authority is no longer needed.',
            },
          },
        );
      }
      if (text.includes('governance:enactment:law-create-check')) return row();
      if (text.includes('governance:enactment:proposal-jurisdiction')) {
        return row({ jurisdiction_entity_id: jurisdictionEntityId });
      }
      if (text.includes('governance:enactment:law-load')) {
        return row({
          current_version: 1,
          jurisdiction_entity_id: jurisdictionEntityId,
          policy_ast: { kind: 'membership_role', role: 'player' },
          previous_version_id: uuid(values[1] === amendLawId ? 83 : 84),
          stable_key: values[1] === amendLawId ? 'law:amend-source' : 'law:repeal-source',
          summary: 'Existing law summary.',
          title: 'Existing law',
        });
      }
      return { rowCount: 1, rows: [] };
    });
    const context = handlerContext(value, sql);

    const outcome = await dispatchGovernanceHandler(context);

    expect(outcome.responseDetails).toMatchObject({ status: 'enacted' });
    expect(context.additionalEvents).toHaveLength(3);
    expect(context.additionalEvents.map((event) => event.eventType)).toEqual([
      'GovernanceLawVersionActivatedV1',
      'GovernanceLawVersionActivatedV1',
      'GovernanceLawVersionActivatedV1',
    ]);
    expect(context.additionalEvents.map((event) => event.aggregateType)).toEqual([
      'law_version',
      'law_version',
      'law_version',
    ]);
    expect(context.additionalEvents.map((event) => event.aggregateVersion)).toEqual([
      '1',
      '1',
      '1',
    ]);
    expect(context.additionalEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        effectiveFromTick: '10',
        lawVersion: '1',
        sourceProposalId: proposalId,
      }),
      {
        effectiveFromTick: '10',
        eventType: 'GovernanceLawVersionActivatedV1',
        lawId: amendLawId,
        lawVersion: '2',
        sourceProposalId: proposalId,
      },
      {
        effectiveFromTick: '10',
        eventType: 'GovernanceLawVersionActivatedV1',
        lawId: repealLawId,
        lawVersion: '2',
        sourceProposalId: proposalId,
      },
    ]);
    expect(new Set(context.additionalEvents.map((event) => event.eventId)).size).toBe(3);
    expect(new Set(context.additionalEvents.map((event) => event.ledgerEntryId)).size).toBe(3);
  });

  it('cancels an election discovered at its close tick and schedules its successor', async () => {
    const electionId = uuid(52);
    const occurrenceKey = `governance:election:${electionId}:open:4`;
    const value = command('OpenElectionV1', 'system', {
      electionId,
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedElectionVersion: '1',
      occurrenceKey,
    });
    let scheduleSequence = 0;
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:election:load')) {
        return row(
          electionRow({
            certification_tick: '10',
            election_id: electionId,
            status: 'voting_scheduled',
            term_starts_tick: '10',
            voting_closes_tick: '10',
          }),
        );
      }
      if (text.includes('governance:schedule:allocate')) {
        scheduleSequence += 1;
        return row({ sequence: String(scheduleSequence) });
      }
      return { rowCount: 1, rows: [] };
    });
    const input = internalInput(value, {
      scheduler: {
        completedEventId: uuid(8),
        dueTick: '4',
        occurrenceKey,
        scheduledActionId: uuid(9),
      },
    });

    const outcome = await dispatchGovernanceHandler(
      handlerContext(value, sql, { input, ids: ids(300) }),
    );

    expect(outcome.event).toMatchObject({
      aggregateVersion: '2',
      payload: {
        aggregateId: electionId,
        occurredTick: '10',
        status: 'cancelled',
      },
      summaryCode: 'ELECTION_CANCELLED_VOTING_WINDOW_MISSED',
    });
    expect(outcome.responseDetails).toMatchObject({
      cancellationReason: 'voting_window_missed',
      votingClosesTick: '10',
    });
    expect(String(outcome.responseDetails?.['successorElectionId'])).toMatch(
      /^018f8652-3cb6-7d52-904b-/u,
    );
    expect(
      sql.calls.some((call) => call.text.includes('governance:election:delayed-open-terminal')),
    ).toBe(true);
    expect(
      sql.calls.some((call) =>
        call.text.includes('governance:election:delayed-open-contest-terminal'),
      ),
    ).toBe(true);
    const successor = sql.calls.find((call) =>
      call.text.includes('governance:election:successor */'),
    );
    expect(successor?.values.slice(7, 13)).toEqual(['100', '104', '104', '110', '110', '110']);
    expect(
      sql.calls
        .filter((call) => call.text.includes('governance:schedule:create'))
        .map((call) => [call.values[3], call.values[4]]),
    ).toEqual([
      ['104', 'OpenElectionV1'],
      ['110', 'CloseAndTallyElectionV1'],
      ['110', 'CertifyElectionV1'],
    ]);
    expect(
      sql.calls.some((call) => call.text.includes('governance:election:candidate-count')),
    ).toBe(false);
    expect(sql.calls.some((call) => call.text.includes('governance:eligibility:'))).toBe(false);
    expect(sql.calls.some((call) => call.text.includes('governance:election:open */'))).toBe(false);
  });

  it('keeps a two-cycle cadence alive through a vacancy and no-candidate cancellation', async () => {
    const firstElectionId = uuid(52);
    const certify = command('CertifyElectionV1', 'system', {
      electionId: firstElectionId,
      expectedElectionVersion: '3',
      expectedResultChecksum: hash,
      resultId: uuid(56),
      termTransitionKey: 'governance:election:vacancy-transition',
    });
    let firstScheduleSequence = 0;
    const firstSql = new ScriptedSql((text) => {
      if (text.includes('governance:election:load')) {
        return row(
          electionRow({
            aggregate_version: '3',
            election_id: firstElectionId,
            quorum_numerator: 5_000,
          }),
        );
      }
      if (text.includes('governance:election:certify-load')) {
        return row({
          abstain_count: 0,
          algorithm_version: 'election_plurality_v1',
          ballot_count: 0,
          candidacy_id: uuid(55),
          candidate_key: 'player:vacancy-candidate',
          election_id: firstElectionId,
          eligible_count: 1,
          input_checksum: Buffer.from(hash, 'hex'),
          output_checksum: Buffer.from(hash, 'hex'),
          participating_count: 0,
          tally_id: uuid(57),
        });
      }
      if (text.includes('governance:schedule:allocate')) {
        firstScheduleSequence += 1;
        return row({ sequence: String(firstScheduleSequence) });
      }
      return { rowCount: 1, rows: [] };
    });

    const firstOutcome = await dispatchGovernanceHandler(handlerContext(certify, firstSql));

    expect(firstOutcome.responseDetails).toMatchObject({ outcome: 'vacant_no_quorum' });
    const secondElectionId = String(firstOutcome.responseDetails?.['successorElectionId']);
    const secondContestId = String(firstOutcome.responseDetails?.['successorContestId']);
    const firstSuccessor = firstSql.calls.find((call) =>
      call.text.includes('governance:election:successor */'),
    );
    expect(firstSuccessor?.values.slice(7, 13)).toEqual(['100', '104', '104', '109', '109', '109']);
    expect(firstSuccessor?.values[18]).toBe(JSON.stringify(electionRow().election_rule_snapshot));
    expect(
      firstSql.calls.filter((call) => call.text.includes('governance:schedule:create')),
    ).toHaveLength(3);

    const occurrenceKey = `governance:election:${secondElectionId}:open:104`;
    const openBase = command('OpenElectionV1', 'system', {
      electionId: secondElectionId,
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '5',
      },
      expectedElectionVersion: '1',
      occurrenceKey,
    });
    const open = { ...openBase, expectedStateRevision: '5', expectedTick: '104' };
    let secondScheduleSequence = 0;
    const secondSql = new ScriptedSql((text) => {
      if (text.includes('governance:election:load')) {
        return row(
          electionRow({
            certification_tick: '109',
            contest_id: secondContestId,
            election_id: secondElectionId,
            nomination_closes_tick: '104',
            nomination_opens_tick: '100',
            quorum_numerator: 5_000,
            status: 'nominations_scheduled',
            term_starts_tick: '109',
            voting_closes_tick: '109',
            voting_opens_tick: '104',
          }),
        );
      }
      if (text.includes('governance:election:candidate-count')) return row({ count: 0 });
      if (text.includes('governance:schedule:allocate')) {
        secondScheduleSequence += 1;
        return row({ sequence: String(secondScheduleSequence) });
      }
      return { rowCount: 1, rows: [] };
    });
    const secondInput = internalInput(open, {
      scheduler: {
        completedEventId: uuid(60),
        dueTick: '104',
        occurrenceKey,
        scheduledActionId: uuid(61),
      },
    });

    const secondOutcome = await dispatchGovernanceHandler(
      handlerContext(open, secondSql, {
        ids: ids(200),
        input: secondInput,
        resultingStateRevision: '6',
        world: { ...world, current_tick: '104', state_revision: '5' },
      }),
    );

    expect(secondOutcome.event.payload).toMatchObject({ status: 'cancelled' });
    const secondSuccessor = secondSql.calls.find((call) =>
      call.text.includes('governance:election:successor */'),
    );
    expect(secondSuccessor?.values.slice(7, 13)).toEqual([
      '200',
      '204',
      '204',
      '209',
      '209',
      '209',
    ]);
    expect(secondSuccessor?.values[18]).toBe(JSON.stringify(electionRow().election_rule_snapshot));
    expect(
      secondSql.calls
        .filter((call) => call.text.includes('governance:schedule:create'))
        .map((call) => [call.values[3], call.values[4]]),
    ).toEqual([
      ['204', 'OpenElectionV1'],
      ['209', 'CloseAndTallyElectionV1'],
      ['209', 'CertifyElectionV1'],
    ]);
    expect(secondSql.calls.some((call) => call.text.includes('governance:eligibility:'))).toBe(
      false,
    );
  });

  it('allows election certification catch-up and locks only mutable seat authority', async () => {
    const electionId = uuid(52);
    const officeId = uuid(53);
    const seatId = uuid(54);
    const candidacyId = uuid(55);
    const priorTermId = uuid(58);
    const value = command('CertifyElectionV1', 'system', {
      electionId,
      expectedElectionVersion: '3',
      expectedResultChecksum: hash,
      resultId: uuid(56),
      termTransitionKey: 'governance:election:term-transition',
    });
    let scheduleSequence = 0;
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:election:load')) {
        return row(
          electionRow({
            aggregate_version: '3',
            contest_version: '3',
            election_id: electionId,
            office_id: officeId,
            seat_id: seatId,
          }),
        );
      }
      if (text.includes('governance:election:certify-load')) {
        return row({
          abstain_count: 0,
          algorithm_version: 'election_plurality_v1',
          ballot_count: 1,
          candidacy_id: candidacyId,
          candidate_key: 'player:candidate',
          election_id: electionId,
          eligible_count: 1,
          input_checksum: Buffer.from(hash, 'hex'),
          output_checksum: Buffer.from(hash, 'hex'),
          participating_count: 1,
          tally_id: uuid(57),
        });
      }
      if (text.includes('governance:election:term-source')) {
        return row({
          office_key: 'office:council-speaker',
          seat_id: seatId,
          seat_ordinal: 1,
          term_ticks: '100',
          winner_entity_id: actorEntityId,
        });
      }
      if (text.includes('governance:office:end-prior-term-load')) {
        return row({ status: 'active', term_id: priorTermId, term_version: '1' });
      }
      if (text.includes('governance:office:term-number')) return row({ term_number: 2 });
      if (text.includes('governance:schedule:allocate')) {
        scheduleSequence += 1;
        return row({ sequence: String(scheduleSequence) });
      }
      return { rowCount: 1, rows: [] };
    });

    const context = handlerContext(value, sql);
    const outcome = await dispatchGovernanceHandler(context);
    expect(outcome.responseDetails?.outcome).toBe('elected');
    expect(typeof outcome.responseDetails?.termId).toBe('string');
    const priorTermLock = sql.calls.find((call) =>
      call.text.includes('governance:office:end-prior-term-load'),
    );
    expect(priorTermLock?.text).toMatch(/for update of authority\s*$/u);
    expect(priorTermLock?.text).not.toContain('for update of authority,term');
    expect(
      context.additionalEvents
        .filter((event) => event.eventType === 'GovernanceOfficeTermChangedV1')
        .map((event) => ({
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          payload: event.payload,
        })),
    ).toEqual([
      {
        aggregateId: priorTermId,
        aggregateVersion: '2',
        payload: {
          eventType: 'GovernanceOfficeTermChangedV1',
          officeId,
          seatIndex: 0,
          status: 'ended',
          termId: priorTermId,
        },
      },
      {
        aggregateId: outcome.responseDetails?.termId,
        aggregateVersion: '1',
        payload: {
          eventType: 'GovernanceOfficeTermChangedV1',
          officeId,
          seatIndex: 0,
          status: 'active',
          termId: outcome.responseDetails?.termId,
        },
      },
    ]);
    const successor = sql.calls.find((call) =>
      call.text.includes('governance:election:successor */'),
    );
    expect(successor?.values.slice(2, 19)).toEqual([
      institutionId,
      officeId,
      seatId,
      'regular',
      'nominations_scheduled',
      '100',
      '104',
      '104',
      '109',
      '109',
      '109',
      0,
      'stable_key',
      'secret',
      'aggregate_only',
      false,
      JSON.stringify(electionRow().election_rule_snapshot),
    ]);
    expect(
      sql.calls
        .filter((call) => call.text.includes('governance:schedule:create'))
        .map((call) => [call.values[3], call.values[4]]),
    ).toEqual([
      ['104', 'OpenElectionV1'],
      ['109', 'CloseAndTallyElectionV1'],
      ['109', 'CertifyElectionV1'],
    ]);
    const authority = sql.calls.find((call) =>
      call.text.includes('governance:office:insert-term-authority'),
    );
    expect(authority?.text).toContain("int8range($7::bigint,$8::bigint,'[)')");
    expect(authority?.values.slice(6, 8)).toEqual(['9', '109']);
  });

  it('routes proposal recount through the aggregate-only database boundary', async () => {
    const replacementChecksum = 'b'.repeat(64);
    const value = command('RepairGovernanceResultV1', 'administrator', {
      approvalId: null,
      confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
      expectedCurrentResultChecksum: hash,
      reason: 'Recompute the frozen proposal ballots and append linked evidence.',
      repairKind: 'proposal_recount',
      replacementResultChecksum: replacementChecksum,
      sourceResultId: uuid(80),
    });
    const sql = new ScriptedSql((text, values) => {
      if (text.includes('governance:repair:proposal-recount')) {
        return row({
          input_checksum: Buffer.from(hash, 'hex'),
          outcome: 'passed',
          result_checksum: Buffer.from(replacementChecksum, 'hex'),
          result_id: values[2],
          tally_id: values[3],
        });
      }
      return { rowCount: 1, rows: [] };
    });
    const outcome = await dispatchGovernanceHandler(
      handlerContext(value, sql, {
        policy: { ...DEFAULT_GOVERNANCE_COMMAND_POLICY, requireTwoPersonRepair: false },
      }),
    );
    expect(outcome.responseDetails).toMatchObject({
      outcome: 'passed',
      resultChecksum: replacementChecksum,
      status: 'recounted',
    });
    expect(outcome.event.payload).toMatchObject({
      repairKind: 'proposal_recount',
      replacementResultChecksum: replacementChecksum,
      sourceResultId: uuid(80),
    });
    expect(sql.calls.some((call) => call.text.includes('governance:repair:append-recount'))).toBe(
      true,
    );
    expect(sql.calls.some((call) => call.text.includes('secret_ballot_choices'))).toBe(false);
  });

  it('retains the repair anchor while staging the same law-version fact on compensation', async () => {
    const sourceResultId = uuid(80);
    const actionId = uuid(81);
    const action = {
      actionSchemaVersion: 1 as const,
      actionType: 'create_law' as const,
      effectiveFromTick: '10',
      effectiveUntilTick: null,
      lawKey: 'law:repaired-enactment-effect',
      policy: { kind: 'membership_role' as const, role: 'player' as const },
      summary: 'A repaired proposal still publishes the immutable law-version fact.',
      targetCharterVersion: '1',
      title: 'Repaired enactment law',
    };
    const compensationPlanChecksum = sha256Hex({
      actions: [
        {
          actionChecksum: hash,
          actionId,
          actionOrdinal: 0,
          actionPayload: action,
        },
      ],
      algorithmVersion: 'governance_certification_compensation_v1',
      proposalId,
      sourceResultChecksum: hash,
      sourceResultId,
    });
    const value = command('RepairGovernanceResultV1', 'administrator', {
      approvalId: null,
      confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
      expectedCurrentResultChecksum: hash,
      reason: 'Retry the immutable enactment plan under explicit repair authority.',
      repairKind: 'certification_compensation',
      replacementResultChecksum: compensationPlanChecksum,
      sourceResultId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:repair:source')) {
        return row({
          aggregate_version: '2',
          outcome: 'passed',
          proposal_id: proposalId,
          proposal_status: 'passed_but_enactment_failed',
          result_checksum: Buffer.from(hash, 'hex'),
        });
      }
      if (text.includes('governance:repair:immutable-actions')) {
        return row({
          action_checksum: Buffer.from(hash, 'hex'),
          action_id: actionId,
          action_ordinal: 0,
          action_payload: action,
        });
      }
      if (text.includes('governance:repair:next-attempt')) {
        return row({ enactment_attempt: 2 });
      }
      if (text.includes('governance:enactment:load-actions')) {
        return row({
          action_id: actionId,
          action_kind: 'law_create',
          action_ordinal: 0,
          action_payload: action,
        });
      }
      if (text.includes('governance:enactment:law-create-check')) return row();
      if (text.includes('governance:enactment:proposal-jurisdiction')) {
        return row({ jurisdiction_entity_id: jurisdictionEntityId });
      }
      return { rowCount: 1, rows: [] };
    });
    const context = handlerContext(value, sql, {
      policy: { ...DEFAULT_GOVERNANCE_COMMAND_POLICY, requireTwoPersonRepair: false },
    });

    const outcome = await dispatchGovernanceHandler(context);

    expect(outcome.event).toMatchObject({
      aggregateId: proposalId,
      aggregateType: 'proposal',
      aggregateVersion: '3',
      eventType: 'GovernanceRepairAppendedV1',
      ledgerKind: 'repair_anchor',
    });
    expect(context.additionalEvents).toHaveLength(1);
    expect(context.additionalEvents[0]).toMatchObject({
      aggregateType: 'law_version',
      aggregateVersion: '1',
      eventType: 'GovernanceLawVersionActivatedV1',
      payload: {
        effectiveFromTick: '10',
        eventType: 'GovernanceLawVersionActivatedV1',
        lawVersion: '1',
        sourceProposalId: proposalId,
      },
    });
  });

  it('consumes one distinct, unexpired, fully bound second approval exactly once', async () => {
    const termId = uuid(60);
    const approvalId = uuid(61);
    const value = command('ExecuteCreatorOverrideV1', 'creator', {
      approvalId,
      confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
      effect: {
        effectType: 'remove_officeholder',
        removal: {
          effectiveAtTick: '10',
          expectedTermVersion: '1',
          reason: 'Remove the conflicted officeholder.',
          termId,
        },
      },
      impact: 'End the conflicted authority interval at the current tick.',
      reason: 'Emergency action reviewed by a distinct administrator.',
    });
    const bindingHash = governanceTwoPersonApprovalBindingHashV1(value);
    let used = false;
    const sql = new ScriptedSql((text, values) => {
      if (text.includes('governance:override:provenance')) {
        return row({ actor_user_id: uuid(6), target_id: termId, target_type: 'office_term' });
      }
      if (text.includes('governance:two-person:approval')) {
        expect(values).toEqual([
          approvalId,
          worldId,
          uuid(6),
          'governance.approve_override',
          'GOVERNANCE_OVERRIDE_SECOND_APPROVAL',
          value.commandId,
          bindingHash,
        ]);
        expect(text).toContain('actor_user_id::text<>$3');
        expect(text).toContain("redacted_metadata->>'approvalExpiresAt'");
        expect(text).toContain("redacted_metadata->>'approvalIssuedAt'");
        expect(text).toContain("approval.issued_at between audit.occurred_at-interval '1 minute'");
        expect(text).toContain("and audit.occurred_at+interval '1 minute'");
        expect(text).toContain('approval.expires_at > approval.issued_at');
        expect(text).toContain("approval.expires_at <= approval.issued_at+interval '15 minutes'");
        expect(text).toContain(
          "audit.occurred_at between transaction_timestamp()-interval '15 minutes'",
        );
        expect(text).toContain('approval_session.revoked_at is null');
        expect(text).toContain('approval_session.auth_version=approval_user.auth_version');
        expect(text).toContain("approval_user.status='active'");
        expect(text).toContain("approval_user.platform_role='platform_admin'");
        expect(text).toContain("approval_membership.status='active'");
        expect(text).toContain("approval_membership.role in ('creator','administrator')");
        expect(text).toContain('governance_override_approvals used');
        expect(text).toContain('governance_repair_approvals used');
        return used ? row() : row({ actor_user_id: uuid(62) });
      }
      if (text.includes('governance:office:load-term')) {
        return row({ office_id: uuid(63), seat_index: 0, status: 'active', term_version: '1' });
      }
      if (text.includes('governance:override:approval')) used = true;
      return { rowCount: 1, rows: [] };
    });
    const context = () =>
      handlerContext(value, sql, {
        creatorOverride: {
          action: 'governance.override.remove_officeholder',
          auditRecordId: uuid(64),
          creatorOverrideId: uuid(65),
          effectHash: hash,
          targetId: termId,
          targetType: 'office_term',
        },
      });

    const firstContext = context();
    const outcome = await dispatchGovernanceHandler(firstContext);
    expect(typeof outcome.event.aggregateId).toBe('string');
    expect(outcome.event).toMatchObject({
      aggregateType: 'governance_override',
      aggregateVersion: '1',
      eventType: 'GovernanceOverrideExecutedV1',
    });
    expect(firstContext.additionalEvents).toHaveLength(1);
    expect(firstContext.additionalEvents[0]).toMatchObject({
      aggregateId: termId,
      aggregateType: 'office_term',
      aggregateVersion: '2',
      eventType: 'GovernanceOfficeTermChangedV1',
      payload: {
        eventType: 'GovernanceOfficeTermChangedV1',
        officeId: uuid(63),
        seatIndex: 0,
        status: 'removed',
        termId,
      },
    });
    expect(used).toBe(true);
    await expect(dispatchGovernanceHandler(context())).rejects.toMatchObject({
      code: 'TWO_PERSON_APPROVAL_REQUIRED',
    });
  });

  it.each([
    ['self approval', 'self'],
    ['expired approval', 'expired'],
    ['mutated reviewed command', 'mutated'],
    ['disabled approver', 'disabled'],
    ['changed approver authentication version', 'auth_changed'],
    ['demoted platform approver', 'demoted'],
    ['removed world authority membership', 'removed'],
  ] as const)('rejects %s before applying an override effect', async (_label, failure) => {
    const termId = uuid(60);
    const approvalId = uuid(61);
    const reviewed = command('ExecuteCreatorOverrideV1', 'creator', {
      approvalId: null,
      confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
      effect: {
        effectType: 'remove_officeholder',
        removal: {
          effectiveAtTick: '10',
          expectedTermVersion: '1',
          reason: 'Remove the conflicted officeholder.',
          termId,
        },
      },
      impact: 'End the conflicted authority interval at the current tick.',
      reason: 'Emergency action reviewed by a distinct administrator.',
    });
    const value = {
      ...reviewed,
      payload: {
        ...reviewed.payload,
        approvalId,
        reason:
          failure === 'mutated'
            ? 'A different emergency reason introduced after review.'
            : reviewed.payload.reason,
      },
    };
    const reviewedBindingHash = governanceTwoPersonApprovalBindingHashV1(reviewed);
    const sql = new ScriptedSql((text, values) => {
      if (text.includes('governance:override:provenance')) {
        return row({ actor_user_id: uuid(6), target_id: termId, target_type: 'office_term' });
      }
      if (text.includes('governance:two-person:approval')) {
        const actorUserId = failure === 'self' ? uuid(6) : uuid(62);
        const matches =
          actorUserId !== values[2] &&
          !['auth_changed', 'demoted', 'disabled', 'expired', 'removed'].includes(failure) &&
          values[6] === reviewedBindingHash;
        return matches ? row({ actor_user_id: actorUserId }) : row();
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(
      dispatchGovernanceHandler(
        handlerContext(value, sql, {
          creatorOverride: {
            action: 'governance.override.remove_officeholder',
            auditRecordId: uuid(64),
            creatorOverrideId: uuid(65),
            effectHash: hash,
            targetId: termId,
            targetType: 'office_term',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'TWO_PERSON_APPROVAL_REQUIRED' });
    expect(sql.calls.some((call) => call.text.includes('governance:office:load-term'))).toBe(false);
  });
});

describe('transactional PostgreSQL orchestration', () => {
  it('re-reads a durable replay after a concurrent command receipt wins', async () => {
    const value = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    const input = internalInput(value);
    const accepted = {
      commandId: value.commandId,
      eventIds: [uuid(81)],
      resultingStateRevision: '5',
      schemaVersion: 1 as const,
      status: 'accepted' as const,
    };
    const attempts: string[][] = [];
    const retryAttempts: number[] = [];
    const executor = new PostgresGovernanceCommandExecutor(
      {
        connect: async () => {
          const attempt = attempts.length;
          const queries: string[] = [];
          attempts.push(queries);
          return {
            on: () => undefined,
            query: async (text: string) => {
              queries.push(text);
              if (attempt === 0 && text.includes('governance:command:insert-received')) {
                throw Object.assign(new Error('duplicate command receipt'), {
                  code: '23505',
                  constraint: 'command_records_pkey',
                });
              }
              if (attempt === 1 && text.includes('governance:command:replay-id')) {
                return row({
                  actor_id: input.actor.actorId,
                  actor_type: input.actor.actorType,
                  command_type: value.type,
                  id: value.commandId,
                  idempotency_key: value.idempotencyKey,
                  request_hash: governanceCommandRequestHashV1(input),
                  response_summary: accepted,
                  status: 'accepted',
                  world_id: worldId,
                });
              }
              return row();
            },
            release: () => undefined,
            removeListener: () => undefined,
          } as GovernanceSqlClient;
        },
      },
      {
        ids: ids(),
        retryDelay: async (attempt) => {
          retryAttempts.push(attempt);
        },
      },
    );

    await expect(executor.executeInternal(input as never)).resolves.toEqual({
      replayed: true,
      result: accepted,
    });
    expect(attempts).toHaveLength(2);
    expect(retryAttempts).toEqual([0]);
    expect(attempts.flat().filter((text) => text === 'rollback')).toHaveLength(2);
    expect(attempts[1]!.some((text) => text.includes('governance:command:insert-received'))).toBe(
      false,
    );
  });

  it('does not retry or mask an unrelated uniqueness violation', async () => {
    const value = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    let connections = 0;
    const retryAttempts: number[] = [];
    const executor = new PostgresGovernanceCommandExecutor(
      {
        connect: async () => {
          connections += 1;
          return {
            on: () => undefined,
            query: async (text: string) => {
              if (text.includes('governance:command:replay-')) return row();
              if (text.includes('governance:command:insert-received')) {
                throw Object.assign(new Error('unrelated uniqueness violation'), {
                  code: '23505',
                  constraint: 'proposal_sponsors_member_unique',
                });
              }
              return row();
            },
            release: () => undefined,
            removeListener: () => undefined,
          };
        },
      },
      {
        ids: ids(),
        retryDelay: async (attempt) => {
          retryAttempts.push(attempt);
        },
      },
    );

    await expect(executor.executeInternal(internalInput(value) as never)).rejects.toMatchObject({
      code: '23505',
      constraint: 'proposal_sponsors_member_unique',
    });
    expect(connections).toBe(1);
    expect(retryAttempts).toEqual([]);
  });

  it('generates atomic creator-override provenance for platform administrators', async () => {
    const termId = uuid(60);
    const value = command('ExecuteCreatorOverrideV1', 'administrator', {
      approvalId: null,
      confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
      effect: {
        effectType: 'remove_officeholder',
        removal: {
          effectiveAtTick: '10',
          expectedTermVersion: '1',
          reason: 'Emergency removal',
          termId,
        },
      },
      impact: 'Remove the conflicted officeholder',
      reason: 'Emergency governance correction',
    });
    const input = publicInput(value, {
      actor: { actorEntityId: null, actorId: uuid(61), actorType: 'platform_admin' },
      recentCredential: {
        commandRequestHash: governanceRecentCredentialCommandHashV1(value),
        proofHash: Buffer.alloc(32, 8),
        sessionId: uuid(62),
        userId: uuid(61),
      },
    });
    const sql = new ScriptedSql((text, values) => {
      if (text.includes('governance:recent-credential:consume')) return row({ authorized: true });
      if (text.includes('governance:command:load-world')) return row(world);
      if (text.includes('governance:command:allocation')) {
        return row({
          last_entry_hash: world.last_entry_hash,
          next_event_sequence: world.next_event_sequence,
          next_ledger_sequence: world.next_ledger_sequence,
        });
      }
      if (text.includes('governance:command:replay-')) return row();
      if (text.includes('governance:override:provenance')) {
        return row({ actor_user_id: uuid(61), target_id: termId, target_type: 'office_term' });
      }
      if (text.includes('governance:override:insert-provenance')) {
        expect(values.slice(0, 6)).toEqual([
          expect.any(String),
          worldId,
          uuid(61),
          'governance.override.remove_officeholder',
          'office_term',
          termId,
        ]);
      }
      return { rowCount: 1, rows: [] };
    });
    const client = Object.assign(sql, { release: (): void => undefined }) as GovernanceSqlClient;
    const executor = new PostgresGovernanceCommandExecutor(
      { connect: async () => client },
      { ids: ids() },
    );
    const result = await executor.executePublic(input as never);
    expect(result.result).toMatchObject({
      rejectionCode: 'TWO_PERSON_APPROVAL_REQUIRED',
      status: 'rejected',
    });
    const provenance = sql.calls.find((call) =>
      call.text.includes('governance:override:insert-provenance'),
    );
    const inserted = sql.calls.find((call) =>
      call.text.includes('governance:command:insert-received'),
    );
    expect(sql.calls.some((call) => call.text.includes('governance:override:insert-audit'))).toBe(
      true,
    );
    expect(inserted?.text).not.toContain('override_id');
    expect(inserted?.text).toContain('$15::bigint,$16,$17');
    expect(inserted?.values).not.toContain(provenance?.values[0]);
    const rejected = sql.calls.find((call) =>
      call.text.includes('/* governance:command:reject */'),
    );
    expect(rejected?.text).toContain('resulting_state_revision=null');
    expect(rejected?.values[5]).toBe(provenance?.values[0]);
    const consumed = sql.calls.find((call) =>
      call.text.includes('governance:recent-credential:consume'),
    );
    expect(consumed?.values.slice(0, 7)).toEqual([
      Buffer.alloc(32, 8),
      uuid(62),
      uuid(61),
      worldId,
      value.commandId,
      value.type,
      governanceRecentCredentialCommandHashV1(value),
    ]);
  });

  it('rejects a recent-credential proof when any bound override command field changes before DB access', async () => {
    const value = command('ExecuteCreatorOverrideV1', 'administrator', {
      approvalId: null,
      confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
      effect: {
        effectType: 'remove_officeholder',
        removal: {
          effectiveAtTick: '10',
          expectedTermVersion: '1',
          reason: 'Emergency removal',
          termId: uuid(60),
        },
      },
      impact: 'Remove the conflicted officeholder',
      reason: 'Emergency governance correction',
    });
    const issuedCommandRequestHash = governanceRecentCredentialCommandHashV1(value);
    const mutations: GovernanceCommandRequestV1[] = [
      { ...value, expectedAggregateVersion: '2' },
      {
        ...value,
        payload: {
          ...value.payload,
          reason: 'A materially different emergency correction',
        },
      },
      {
        ...value,
        payload: {
          ...value.payload,
          effect: {
            effectType: 'remove_officeholder',
            removal: {
              effectiveAtTick: '10',
              expectedTermVersion: '1',
              reason: 'A different removal effect',
              termId: uuid(60),
            },
          },
        },
      },
    ];

    for (const mutatedCommand of mutations) {
      let connectionAttempts = 0;
      const executor = new PostgresGovernanceCommandExecutor(
        {
          connect: async () => {
            connectionAttempts += 1;
            throw new Error('DB must not be reached for a mismatched credential binding');
          },
        },
        { ids: ids() },
      );
      const input = publicInput(mutatedCommand, {
        actor: { actorEntityId: null, actorId: uuid(61), actorType: 'platform_admin' },
        recentCredential: {
          commandRequestHash: issuedCommandRequestHash,
          proofHash: Buffer.alloc(32, 8),
          sessionId: uuid(62),
          userId: uuid(61),
        },
      });

      await expect(executor.executePublic(input as never)).rejects.toMatchObject({
        code: 'RECENT_CREDENTIAL_INVALID',
      });
      expect(connectionAttempts).toBe(0);
    }
  });

  it('rolls back expired or wrong-bound recent credentials before override provenance', async () => {
    const value = command('ExecuteCreatorOverrideV1', 'administrator', {
      approvalId: null,
      confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
      effect: {
        effectType: 'remove_officeholder',
        removal: {
          effectiveAtTick: '10',
          expectedTermVersion: '1',
          reason: 'Emergency removal',
          termId: uuid(60),
        },
      },
      impact: 'Remove the conflicted officeholder',
      reason: 'Emergency governance correction',
    });
    const input = publicInput(value, {
      actor: { actorEntityId: null, actorId: uuid(61), actorType: 'platform_admin' },
      recentCredential: {
        commandRequestHash: governanceRecentCredentialCommandHashV1(value),
        proofHash: Buffer.alloc(32, 8),
        sessionId: uuid(62),
        userId: uuid(61),
      },
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:command:replay-')) return row();
      if (text.includes('governance:recent-credential:consume')) return row({ authorized: false });
      return { rowCount: 1, rows: [] };
    });
    const client = Object.assign(sql, { release: (): void => undefined }) as GovernanceSqlClient;
    const executor = new PostgresGovernanceCommandExecutor(
      { connect: async () => client },
      { ids: ids() },
    );

    await expect(executor.executePublic(input as never)).rejects.toMatchObject({
      code: 'RECENT_CREDENTIAL_INVALID',
    });
    expect(
      sql.calls.some((call) => call.text.includes('governance:override:insert-provenance')),
    ).toBe(false);
    expect(sql.calls.at(-1)?.text).toBe('rollback');
  });

  it('verifies the exact previously consumed request hash before returning a durable replay', async () => {
    const value = command('RepairGovernanceResultV1', 'administrator', {
      approvalId: null,
      confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
      expectedCurrentResultChecksum: hash,
      reason: 'Recompute the frozen ballots and append linked evidence.',
      repairKind: 'proposal_recount',
      replacementResultChecksum: 'b'.repeat(64),
      sourceResultId: uuid(80),
    });
    const requestHash = governanceRecentCredentialCommandHashV1(value);
    const input = publicInput(value, {
      recentCredential: {
        commandRequestHash: requestHash,
        proofHash: Buffer.alloc(32, 8),
        sessionId: uuid(62),
        userId: uuid(6),
      },
    });
    const accepted = {
      commandId: value.commandId,
      eventIds: [uuid(81)],
      resultingStateRevision: '5',
      schemaVersion: 1 as const,
      status: 'accepted' as const,
    };
    const sql = new ScriptedSql((text, values) => {
      if (text.includes('governance:command:replay-id')) {
        return row({
          actor_id: input.actor.actorId,
          actor_type: input.actor.actorType,
          command_type: value.type,
          id: value.commandId,
          idempotency_key: value.idempotencyKey,
          request_hash: governanceCommandRequestHashV1(input),
          response_summary: accepted,
          status: 'accepted',
          world_id: worldId,
        });
      }
      if (text.includes('governance:recent-credential:verify-replay')) {
        return row({ authorized: Buffer.from(values[6] as Buffer).equals(requestHash) });
      }
      return row();
    });
    const client = Object.assign(sql, { release: (): void => undefined }) as GovernanceSqlClient;
    const executor = new PostgresGovernanceCommandExecutor(
      { connect: async () => client },
      { ids: ids() },
    );

    await expect(executor.executePublic(input as never)).resolves.toEqual({
      replayed: true,
      result: accepted,
    });
    input.recentCredential!.commandRequestHash = Buffer.alloc(32, 9);
    await expect(executor.executePublic(input as never)).rejects.toMatchObject({
      code: 'RECENT_CREDENTIAL_INVALID',
    });
  });

  it('stores HMAC request and payload hashes for actor-linked ballot commands', async () => {
    const value = command('CastProposalBallotV1', 'in_world', {
      choice: 'yes',
      eligibilitySnapshotId: snapshotId,
      expectedProposalVersion: '1',
      proposalId,
      replaceExisting: false,
    });
    const input = publicInput(value);
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:command:load-world')) return row(world);
      if (text.includes('governance:command:allocation')) {
        return row({
          last_entry_hash: world.last_entry_hash,
          next_event_sequence: world.next_event_sequence,
          next_ledger_sequence: world.next_ledger_sequence,
        });
      }
      if (text.includes('governance:command:velocity')) return row({ command_count: 2 });
      if (text.includes('governance:command:replay-')) return row();
      return { rowCount: 1, rows: [] };
    });
    const client = Object.assign(sql, { release: (): void => undefined }) as GovernanceSqlClient;
    const secretHashKey = 'test-only-governance-hmac-key-32-characters';
    const executor = new PostgresGovernanceCommandExecutor(
      { connect: async () => client },
      { ids: ids(), policy: { voteRateLimitPerMinute: 1 }, secretHashKey },
    );
    const result = await executor.executePublic(input as never);
    expect(result.result).toMatchObject({
      rejectionCode: 'GOVERNANCE_RATE_LIMITED',
      status: 'rejected',
    });
    const inserted = sql.calls.find((call) =>
      call.text.includes('governance:command:insert-received'),
    );
    expect(inserted?.values[7]).toEqual(governanceCommandPayloadHashV1(input, secretHashKey));
    expect(inserted?.values[7]).not.toEqual(governanceCommandPayloadHashV1(input));
    expect(inserted?.values[9]).toEqual(
      governanceCommandPrivateRequestHashV1(input, secretHashKey),
    );
    expect(inserted?.values[9]).not.toEqual(governanceCommandRequestHashV1(input));
  });

  it('persists expected tick and rejects the current command at the configured velocity limit', async () => {
    const value = command('SponsorProposalV1', 'in_world', {
      expectedProposalVersion: '1',
      proposalId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:command:load-world')) return row(world);
      if (text.includes('governance:command:allocation')) {
        return row({
          last_entry_hash: world.last_entry_hash,
          next_event_sequence: world.next_event_sequence,
          next_ledger_sequence: world.next_ledger_sequence,
        });
      }
      if (text.includes('governance:command:velocity')) return row({ command_count: 2 });
      if (text.includes('governance:command:replay-')) return row();
      return { rowCount: 1, rows: [] };
    });
    const client = Object.assign(sql, {
      release: (): void => undefined,
    }) as GovernanceSqlClient;
    const executor = new PostgresGovernanceCommandExecutor(
      { connect: async () => client },
      { ids: ids(), policy: { sponsorRateLimitPerMinute: 1 } },
    );
    const result = await executor.executePublic(publicInput(value) as never);
    expect(result.result).toMatchObject({
      rejectionCode: 'GOVERNANCE_RATE_LIMITED',
      status: 'rejected',
    });
    const inserted = sql.calls.find((call) =>
      call.text.includes('governance:command:insert-received'),
    );
    expect(inserted?.text).toContain('expected_tick');
    expect(inserted?.values[14]).toBe('10');
    expect(sql.calls.at(-1)?.text).toBe('commit');
  });

  it('consumes completed scheduler evidence with late catch-up and never updates the schedule row', async () => {
    const value = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:command:load-world')) return row(world);
      if (text.includes('governance:command:allocation')) {
        return row({
          last_entry_hash: world.last_entry_hash,
          next_event_sequence: world.next_event_sequence,
          next_ledger_sequence: world.next_ledger_sequence,
        });
      }
      if (text.includes('governance:schedule:validate-completed')) {
        return row({
          action_type: 'OpenProposalVotingV1',
          completed_event_id: uuid(8),
          completed_state_revision: '4',
          due_tick: '5',
          payload: { proposalId },
          status: 'completed',
        });
      }
      if (text.includes('governance:command:replay-')) return row();
      if (text.includes('governance:proposal:load')) return row();
      return { rowCount: 1, rows: [] };
    });
    const client = Object.assign(sql, {
      release: (): void => undefined,
    }) as GovernanceSqlClient;
    const executor = new PostgresGovernanceCommandExecutor(
      { connect: async () => client },
      { ids: ids() },
    );
    const result = await executor.executeInternal(internalInput(value) as never);
    expect(result.result).toMatchObject({
      rejectionCode: 'PROPOSAL_STATE_INVALID',
      status: 'rejected',
    });
    expect(sql.calls.some((call) => call.text.includes('validate-completed'))).toBe(true);
    expect(sql.calls.some((call) => /update\s+scheduled_actions/iu.test(call.text))).toBe(false);
  });

  it('rolls back stale internal preconditions so the same occurrence can retry refreshed', async () => {
    const stale = command('OpenProposalVotingV1', 'system', {
      eligibilitySnapshot: {
        eligibleCount: 0,
        policyChecksum: hash,
        snapshotChecksum: hash,
        snapshotId,
        sourceStateRevision: '4',
      },
      expectedProposalVersion: '1',
      occurrenceKey: 'governance:proposal:open:5',
      proposalId,
    });
    const sql = new ScriptedSql((text) => {
      if (text.includes('governance:command:load-world')) return row(world);
      if (text.includes('governance:command:allocation')) {
        return row({
          last_entry_hash: world.last_entry_hash,
          next_event_sequence: world.next_event_sequence,
          next_ledger_sequence: world.next_ledger_sequence,
        });
      }
      if (text.includes('governance:schedule:validate-completed')) {
        return row({
          action_type: 'OpenProposalVotingV1',
          completed_event_id: uuid(8),
          completed_state_revision: '4',
          due_tick: '5',
          payload: { proposalId },
          status: 'completed',
        });
      }
      if (text.includes('governance:command:replay-')) return row();
      if (text.includes('governance:proposal:load')) {
        return row(
          proposalRow({
            aggregate_version: '2',
            contest_version: '2',
            minimum_sponsors: 1,
            status: 'scheduled',
            voting_closes_tick: '11',
          }),
        );
      }
      if (text.includes('governance:proposal:sponsor-count')) return row({ count: 0 });
      if (text.includes('governance:command:graph-checksum')) {
        return row({ checksum: Buffer.from(hash, 'hex') });
      }
      return { rowCount: 1, rows: [] };
    });
    const client = Object.assign(sql, { release: (): void => undefined }) as GovernanceSqlClient;
    const executor = new PostgresGovernanceCommandExecutor(
      { connect: async () => client },
      { ids: ids() },
    );
    await expect(executor.executeInternal(internalInput(stale) as never)).rejects.toMatchObject({
      code: 'AGGREGATE_VERSION_CONFLICT',
      safeFailure: false,
    });
    const firstAttemptEnd = sql.calls.length;
    expect(sql.calls.slice(0, firstAttemptEnd).at(-1)?.text).toBe('rollback');
    expect(
      sql.calls
        .slice(0, firstAttemptEnd)
        .some((call) => call.text.includes('governance:command:reject')),
    ).toBe(false);

    const refreshed = {
      ...stale,
      expectedAggregateVersion: '2',
      payload: { ...stale.payload, expectedProposalVersion: '2' },
    };
    const result = await executor.executeInternal(internalInput(refreshed) as never);
    expect(result.result).toMatchObject({ status: 'accepted' });
    expect(
      sql.calls
        .slice(firstAttemptEnd)
        .some((call) => call.text.includes('governance:proposal:sponsorship-terminal')),
    ).toBe(true);
    expect(
      sql.calls
        .slice(firstAttemptEnd)
        .some((call) => call.text.includes('governance:schedule:occurrence')),
    ).toBe(true);
  });
});
