import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import {
  ScheduledActionV1Schema,
  SimulationBatchRunV1Schema,
  SimulationCommandRequestV1Schema,
  SimulationFailureV1Schema,
  SimulationWorldTimeV1Schema,
  WorldCommandResultV1Schema,
  WorldSimulationClockV1Schema,
  createValidator,
  type ScheduledActionV1,
  type SimulationBatchRunV1,
  type SimulationClockMode,
  type SimulationCommandRequestV1,
  type SimulationFailureV1,
  type SimulationWorldTimeV1,
  type WorldCommandResultV1,
  type WorldSimulationClockV1,
} from '../../packages/contracts/src/index.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const scheduleId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
const now = '2026-07-22T12:00:00.000Z';
const epochAt = '2000-01-01T00:00:00.000Z';
const epochMilliseconds = 946_684_800_000;
const worldMillisecondsPerTick = 86_400_000;
const csrfToken = 'c'.repeat(43);

const validators = {
  action: createValidator(ScheduledActionV1Schema),
  batch: createValidator(SimulationBatchRunV1Schema),
  clock: createValidator(WorldSimulationClockV1Schema),
  command: createValidator<SimulationCommandRequestV1>(SimulationCommandRequestV1Schema),
  commandResult: createValidator(WorldCommandResultV1Schema),
  failure: createValidator(SimulationFailureV1Schema),
  worldTime: createValidator(SimulationWorldTimeV1Schema),
};

type ContractValidator = ReturnType<typeof createValidator>;

interface SimulationMockOptions {
  canManage?: boolean;
  canSchedule?: boolean;
  clockGate?: Promise<void>;
  commandConflict?: boolean;
  degradedWake?: boolean;
  initialMode?: SimulationClockMode;
  initialScheduledAction?: boolean;
  latestFailedBatch?: boolean;
}

interface SimulationMockState {
  aggregateVersion: number;
  batches: SimulationBatchRunV1[];
  commandHeaders: Array<Record<string, string>>;
  commands: SimulationCommandRequestV1[];
  clockReads: number;
  csrfReads: number;
  failures: SimulationFailureV1[];
  mode: SimulationClockMode;
  noticeExecutions: number;
  schedule: ScheduledActionV1[];
  scheduleQueries: URLSearchParams[];
  stateRevision: number;
  tick: number;
}

function fixtureUuid(sequence: number): string {
  return `018f8652-3cb6-7d52-904b-${sequence.toString(16).padStart(12, '0')}`;
}

function json(route: Route, body: object, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function checkedJson(route: Route, validator: ContractValidator, body: object, status = 200) {
  expect(
    validator.issues(body),
    `Mock response violated its public contract: ${JSON.stringify(body)}`,
  ).toEqual([]);
  return json(route, body, status);
}

function scheduledNotice(stateRevision = 1): ScheduledActionV1 {
  return {
    actionSchemaVersion: 1,
    actionType: 'EmitWorldNoticeV1',
    cancelledCommandId: null,
    completedEventId: null,
    completedStateRevision: null,
    createdAt: now,
    createdBy: { actorId, actorType: 'user' },
    createdCommandId: fixtureUuid(80),
    createdStateRevision: String(stateRevision),
    dueTick: '3',
    id: scheduleId,
    payload: { text: 'Guild Founding Day', visibility: 'member' },
    payloadHash: 'a'.repeat(64),
    priority: -2,
    processVersion: '1.0.0',
    scheduleSchemaVersion: 1,
    scheduleSequence: '1',
    status: 'scheduled',
    updatedAt: now,
    worldId,
  };
}

function failedBatch(): SimulationBatchRunV1 {
  return {
    attempts: 3,
    batchKey: 'b'.repeat(64),
    batchSchemaVersion: 1,
    commandId: fixtureUuid(90),
    completedAt: now,
    errorCode: 'SIMULATION_HANDLER_FAILED',
    fromTick: '8',
    id: fixtureUuid(91),
    inputChecksum: 'c'.repeat(64),
    outcomeHash: null,
    processRegistryVersion: 1,
    startedAt: now,
    status: 'failed',
    toTick: '9',
    worldId,
  };
}

function openFailure(): SimulationFailureV1 {
  return {
    aggregateVersion: '1',
    attempts: 3,
    batchRunId: fixtureUuid(91),
    errorCode: 'SIMULATION_HANDLER_FAILED',
    failureSchemaVersion: 1,
    id: fixtureUuid(92),
    openedAt: now,
    processType: 'EmitWorldNoticeV1',
    processVersion: '1.0.0',
    redactedContext: { failedCommandType: 'AdvanceSimulationV1' },
    resolutionCommandId: null,
    resolvedAt: null,
    resolvedByActorId: null,
    scheduleId,
    status: 'open',
    tick: '9',
    worldId,
  };
}

function worldTime(tick: number): SimulationWorldTimeV1 {
  const unixMilliseconds = epochMilliseconds + tick * worldMillisecondsPerTick;
  return {
    epochAt,
    tick: String(tick),
    worldTimeAt: new Date(unixMilliseconds).toISOString(),
    worldTimeUnixMilliseconds: String(unixMilliseconds),
  };
}

function clock(state: SimulationMockState): WorldSimulationClockV1 {
  return {
    clockSchemaVersion: 1,
    configuration: {
      epochAt,
      maxBatchTicks: 64,
      maxCatchUpTicks: 256,
      prngAlgorithmVersion: 'xorshift32-sha256-v1',
      wallCadenceMilliseconds: 10_000,
      worldMillisecondsPerTick,
    },
    currentTick: String(state.tick),
    lastWallAnchorAt: state.mode === 'running' ? now : null,
    mode: state.mode,
    outcomeHash: 'e'.repeat(64),
    projectionSchemaVersion: 1,
    rowVersion: String(state.aggregateVersion),
    updatedAt: now,
    updatedStateRevision: String(state.stateRevision),
    worldId,
  };
}

function acceptedResult(
  commandId: string,
  commandSequence: number,
  resultingStateRevision: number,
): WorldCommandResultV1 {
  const eventSequence = String(commandSequence);
  return {
    commandId,
    eventIds: [fixtureUuid(100 + commandSequence)],
    eventSequenceRange: { from: eventSequence, to: eventSequence },
    ledgerSequenceRange: {
      from: String(commandSequence * 2 - 1),
      to: String(commandSequence * 2),
    },
    resultingStateRevision: String(resultingStateRevision),
    schemaVersion: 1,
    status: 'accepted',
  };
}

function completeDueNotices(state: SimulationMockState, completionRevision: number): void {
  state.schedule = state.schedule.map((action) => {
    if (action.status !== 'scheduled' || Number(action.dueTick) > state.tick) return action;
    state.noticeExecutions += 1;
    return {
      ...action,
      completedEventId: fixtureUuid(140 + state.noticeExecutions),
      completedStateRevision: String(completionRevision),
      status: 'completed',
      updatedAt: now,
    };
  });
}

async function mockSimulation(
  page: Page,
  options: SimulationMockOptions = {},
): Promise<SimulationMockState> {
  const state: SimulationMockState = {
    aggregateVersion: 1,
    batches: options.latestFailedBatch ? [failedBatch()] : [],
    commandHeaders: [],
    commands: [],
    clockReads: 0,
    csrfReads: 0,
    failures: options.latestFailedBatch ? [openFailure()] : [],
    mode: options.initialMode ?? 'paused',
    noticeExecutions: 0,
    schedule:
      options.initialScheduledAction || options.latestFailedBatch
        ? [{ ...scheduledNotice(), dueTick: options.latestFailedBatch ? '9' : '3' }]
        : [],
    scheduleQueries: [],
    stateRevision: 1,
    tick: options.latestFailedBatch ? 8 : 0,
  };
  const canManage = options.canManage ?? true;
  const canSchedule = options.canSchedule ?? canManage;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/v1/auth/csrf' && request.method() === 'POST') {
      state.csrfReads += 1;
      return json(route, { csrfToken });
    }
    if (path === `/api/v1/worlds/${worldId}/simulation/clock`) {
      state.clockReads += 1;
      if (options.clockGate) await options.clockGate;
      const clockProjection = clock(state);
      const time = worldTime(state.tick);
      expect(validators.clock.issues(clockProjection)).toEqual([]);
      expect(validators.worldTime.issues(time)).toEqual([]);
      const nextDueAction =
        state.schedule.find(
          (action) => action.status === 'scheduled' && Number(action.dueTick) > state.tick,
        ) ?? null;
      return json(route, {
        aggregateVersion: String(state.aggregateVersion),
        backlogCount: state.schedule.filter((action) => action.status === 'scheduled').length,
        canManage,
        canSchedule,
        clock: clockProjection,
        degradedWake: options.degradedWake ?? false,
        designVersion: '1',
        lastBatch: state.batches.at(0) ?? null,
        nextDueAction,
        stateRevision: String(state.stateRevision),
        worldTime: time,
      });
    }
    if (path === `/api/v1/worlds/${worldId}/simulation/schedule`) {
      state.scheduleQueries.push(new URLSearchParams(url.search));
      for (const action of state.schedule) expect(validators.action.issues(action)).toEqual([]);
      return json(route, { items: state.schedule, nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/simulation/batches`) {
      for (const batch of state.batches) expect(validators.batch.issues(batch)).toEqual([]);
      for (const failure of state.failures) expect(validators.failure.issues(failure)).toEqual([]);
      return json(route, { failures: state.failures, items: state.batches, nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/commands` && request.method() === 'POST') {
      const body: unknown = JSON.parse(request.postData() ?? '{}');
      expect(validators.command.issues(body)).toEqual([]);
      if (!validators.command.is(body))
        throw new Error('Simulation mock received an invalid command body.');
      state.commands.push(body);
      state.commandHeaders.push(request.headers());

      if (options.commandConflict) {
        return json(
          route,
          {
            error: {
              code: 'EXPECTED_TICK_MISMATCH',
              message: 'The authoritative clock is already at tick 1.',
              requestId: fixtureUuid(199),
            },
          },
          409,
        );
      }

      const nextRevision = state.stateRevision + 1;
      if (body.type === 'StartWorldClockV1') {
        state.mode = 'running';
        state.aggregateVersion += 1;
      } else if (body.type === 'PauseWorldClockV1') {
        state.mode = 'paused';
        state.aggregateVersion += 1;
      } else if (body.type === 'ConfigureWorldClockV1') {
        state.aggregateVersion += 1;
      } else if (body.type === 'ScheduleWorldNoticeV1') {
        state.schedule = [
          {
            ...scheduledNotice(nextRevision),
            createdCommandId: body.commandId,
            dueTick: body.payload.dueTick,
            payload: { text: body.payload.text, visibility: body.payload.visibility },
            priority: body.payload.priority,
          },
        ];
      } else if (body.type === 'CancelScheduledActionV1') {
        state.schedule = state.schedule.map((action) =>
          action.id === body.payload.scheduleId
            ? {
                ...action,
                cancelledCommandId: body.commandId,
                status: 'cancelled',
                updatedAt: now,
              }
            : action,
        );
      } else if (body.type === 'ResolveSimulationFailureV1') {
        state.failures = state.failures.map((failure) =>
          failure.id === body.payload.failureId
            ? {
                ...failure,
                aggregateVersion: '2',
                resolutionCommandId: body.commandId,
                resolvedAt: now,
                resolvedByActorId: actorId,
                status: 'resolved',
              }
            : failure,
        );
        if (body.payload.resolution === 'cancel_action') {
          state.schedule = state.schedule.map((action) =>
            action.id === scheduleId
              ? {
                  ...action,
                  cancelledCommandId: body.commandId,
                  completedStateRevision: String(nextRevision),
                  status: 'cancelled',
                  updatedAt: now,
                }
              : action,
          );
        }
        state.mode = 'paused';
        state.aggregateVersion += 1;
      } else if (body.type === 'AdvanceSimulationV1') {
        const fromTick = state.tick + 1;
        state.tick += body.payload.ticks;
        state.aggregateVersion += 1;
        completeDueNotices(state, nextRevision);
        state.batches = [
          {
            attempts: 1,
            batchKey: 'b'.repeat(64),
            batchSchemaVersion: 1,
            commandId: body.commandId,
            completedAt: now,
            errorCode: null,
            fromTick: String(fromTick),
            id: fixtureUuid(200 + state.commands.length),
            inputChecksum: 'c'.repeat(64),
            outcomeHash: 'd'.repeat(64),
            processRegistryVersion: 1,
            startedAt: now,
            status: 'completed',
            toTick: String(state.tick),
            worldId,
          },
          ...state.batches,
        ];
      }
      state.stateRevision = nextRevision;
      const result = acceptedResult(body.commandId, state.commands.length, nextRevision);
      return checkedJson(route, validators.commandResult, result);
    }
    return json(
      route,
      {
        error: {
          code: 'NOT_FOUND',
          message: `${request.method()} ${path} not mocked`,
          requestId: fixtureUuid(255),
        },
      },
      404,
    );
  });

  return state;
}

test('creator controls schedule a notice and execute it exactly once at tick 3 by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ height: 720, width: 320 });
  const state = await mockSimulation(page);
  await page.goto(`/worlds/${worldId}/simulate`);

  await expect(page.getByRole('heading', { name: 'World clock and schedule' })).toBeVisible();
  await expect(page.getByText('paused · tick 0')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clock controls' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause now' })).toBeDisabled();

  const configuration = page.getByText('Configure tick-zero clock', { exact: true });
  await configuration.focus();
  await configuration.press('Enter');
  await expect(page.getByLabel('World milliseconds per tick')).toHaveValue('86400000');

  const start = page.getByRole('button', { name: 'Start continuous mode' });
  await start.focus();
  await start.press('Enter');
  await expect(page.getByText('running · tick 0')).toBeVisible();
  await expect(page.locator('.success-message')).toContainText(
    'StartWorldClock accepted at state revision 2',
  );

  const pause = page.getByRole('button', { name: 'Pause now' });
  await pause.focus();
  await pause.press('Enter');
  await expect(page.getByText('paused · tick 0')).toBeVisible();
  await expect(page.locator('.success-message')).toContainText(
    'PauseWorldClock accepted at state revision 3',
  );

  await page.getByLabel('Due tick').fill('3');
  await page.getByLabel('Priority (lower runs first)').fill('-2');
  await page.getByLabel('Visibility').selectOption('member');
  await page.getByLabel('Notice text').fill('Guild Founding Day');
  const schedule = page.getByRole('button', { name: 'Schedule notice' });
  await schedule.focus();
  await schedule.press('Enter');
  await expect(page.locator('.success-message')).toContainText(
    'ScheduleWorldNotice accepted at state revision 4',
  );
  const scheduleRow = page.getByRole('row').filter({ hasText: 'EmitWorldNoticeV1' });
  await expect(scheduleRow).toContainText('scheduled');
  await expect(scheduleRow).toContainText('3');
  await expect(scheduleRow.getByRole('button', { name: 'Cancel' })).toBeVisible();

  const singleStep = page.getByRole('button', { name: 'Single-step' });
  await singleStep.focus();
  await singleStep.press('Enter');
  await expect(page.getByText('paused · tick 1')).toBeVisible();
  await singleStep.focus();
  await singleStep.press('Enter');
  await expect(page.getByText('paused · tick 2')).toBeVisible();

  await page.getByLabel('Bounded ticks').fill('1');
  const advance = page.getByRole('button', { name: 'Advance exact range' });
  await advance.focus();
  await advance.press('Enter');
  await expect(page.getByText('paused · tick 3')).toBeVisible();
  await expect(scheduleRow).toContainText('completed');
  await expect(scheduleRow.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(page.getByText('ticks 3–3')).toBeVisible();
  expect(state.noticeExecutions).toBe(1);

  expect(state.commands.map((command) => command.type)).toEqual([
    'StartWorldClockV1',
    'PauseWorldClockV1',
    'ScheduleWorldNoticeV1',
    'AdvanceSimulationV1',
    'AdvanceSimulationV1',
    'AdvanceSimulationV1',
  ]);
  expect(state.commands[2]).toMatchObject({
    expectedAggregateVersion: '0',
    expectedStateRevision: '3',
    expectedTick: '0',
    expectedWorldVersion: '1',
    payload: {
      dueTick: '3',
      priority: -2,
      text: 'Guild Founding Day',
      visibility: 'member',
    },
  });
  expect(
    state.commands
      .filter((command) => command.type === 'AdvanceSimulationV1')
      .map((command) => ({ expectedTick: command.expectedTick, ticks: command.payload.ticks })),
  ).toEqual([
    { expectedTick: '0', ticks: 1 },
    { expectedTick: '1', ticks: 1 },
    { expectedTick: '2', ticks: 1 },
  ]);
  for (const [index, headers] of state.commandHeaders.entries()) {
    expect(headers['idempotency-key']).toBe(state.commands[index]?.idempotencyKey);
    expect(headers['x-csrf-token']).toBe(csrfToken);
  }
  expect(state.scheduleQueries.every((query) => query.get('limit') === '100')).toBe(true);

  await page.reload();
  await expect(page.getByText('paused · tick 3')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'EmitWorldNoticeV1' })).toContainText(
    'completed',
  );
  expect(state.noticeExecutions).toBe(1);
  await expect(page.getByText('Guild Founding Day')).toHaveCount(0);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const mobileLayout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(mobileLayout.documentWidth, JSON.stringify(mobileLayout)).toBeLessThanOrEqual(
    mobileLayout.viewportWidth,
  );
});

test('member sees exact clock and schedule state without creator mutations', async ({ page }) => {
  const state = await mockSimulation(page, {
    canManage: false,
    canSchedule: false,
    initialScheduledAction: true,
  });
  await page.goto(`/worlds/${worldId}/simulate`);

  await expect(page.getByRole('heading', { name: 'Read-only simulation' })).toBeVisible();
  await expect(page.getByText(/Creator controls are not available/u)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clock controls' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Schedule a world notice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start continuous mode' })).toHaveCount(0);
  const scheduleRow = page.getByRole('row').filter({ hasText: 'EmitWorldNoticeV1' });
  await expect(scheduleRow).toContainText('scheduled');
  await expect(scheduleRow.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  expect(state.commands).toHaveLength(0);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('announces the loading state until the authoritative clock read resolves', async ({
  page,
}) => {
  let releaseClock!: () => void;
  const clockGate = new Promise<void>((resolve) => {
    releaseClock = resolve;
  });
  await mockSimulation(page, { clockGate });
  await page.goto(`/worlds/${worldId}/simulate`);

  const loading = page.getByText('Loading the authoritative world clock…').locator('..');
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: 'World clock and schedule' })).toHaveCount(0);
  releaseClock();
  await expect(page.getByRole('heading', { name: 'World clock and schedule' })).toBeVisible();
});

test('surfaces an authoritative tick conflict, focuses it, and does not retry', async ({
  page,
}) => {
  const state = await mockSimulation(page, { commandConflict: true });
  await page.goto(`/worlds/${worldId}/simulate`);
  await expect(page.getByRole('heading', { name: 'Clock controls' })).toBeVisible();

  const singleStep = page.getByRole('button', { name: 'Single-step' });
  await singleStep.focus();
  await singleStep.press('Enter');

  const conflict = page.getByRole('alert').filter({ hasText: 'EXPECTED_TICK_MISMATCH' });
  await expect(conflict).toContainText('The authoritative clock is already at tick 1.');
  await expect(conflict).toBeFocused();
  await expect(page.getByText('paused · tick 0')).toBeVisible();
  expect(state.commands).toHaveLength(1);
  expect(state.clockReads).toBe(1);
});

test('explains degraded wake delivery and an auto-paused deterministic failure', async ({
  page,
}) => {
  const state = await mockSimulation(page, {
    degradedWake: true,
    initialMode: 'error',
    latestFailedBatch: true,
  });
  await page.goto(`/worlds/${worldId}/simulate`);

  await expect(page.getByText('error · tick 8')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Automatic wake delivery is degraded');
  await expect(
    page.getByRole('alert').filter({
      hasText: 'The clock auto-paused after a deterministic process failure',
    }),
  ).toBeVisible();
  await expect(page.getByText('SIMULATION_HANDLER_FAILED').first()).toBeVisible();
  await expect(page.getByText(/Review the failure and History/u)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start continuous mode' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Single-step' })).toBeDisabled();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Cancel failed action' }).click();
  await expect(page.getByText('paused · tick 8')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start continuous mode' })).toBeEnabled();
  expect(state.failures[0]).toMatchObject({ status: 'resolved' });
  expect(state.schedule[0]).toMatchObject({ status: 'cancelled' });
  expect(state.commands.at(-1)).toMatchObject({
    expectedAggregateVersion: '1',
    expectedTick: '8',
    payload: { failureId: fixtureUuid(92), resolution: 'cancel_action' },
    type: 'ResolveSimulationFailureV1',
  });

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
