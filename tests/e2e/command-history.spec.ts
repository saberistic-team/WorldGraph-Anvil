import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import {
  RuntimeSummaryViewSchema,
  WorldCommandRequestV1Schema,
  WorldCommandResultV1Schema,
  WorldEntityDetailResponseSchema,
  WorldEntityListResponseSchema,
  WorldHistoryEntryV1Schema,
  WorldNeighborResponseSchema,
  WorldRelationshipListResponseSchema,
  WorldSchema,
  createValidator,
  type RuntimeSummaryView,
  type World,
  type WorldCommandRequestV1,
  type WorldCommandResultV1,
  type WorldEntityView,
  type WorldHistoryEntryV1,
} from '../../packages/contracts/src/index.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const activeVersionId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const manifestRevisionId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const eventId = '018f8652-3cb6-7d52-904b-cce7901d7e29';
const entityKey = 'district:harbor';
const now = '2026-07-22T12:00:00.000Z';
const csrfToken = 'c'.repeat(43);

const world: World = {
  activeWorldVersionId: activeVersionId,
  createdAt: now,
  currentApprovedManifestRevisionId: manifestRevisionId,
  id: worldId,
  lifecycle: 'active',
  manifestSchemaVersion: 1,
  name: 'Harbor City',
  role: 'creator',
  rowVersion: 1,
  slug: 'harbor-city',
  updatedAt: now,
};

const initialSummary: RuntimeSummaryView = {
  activatedAt: now,
  activeWorldVersionId: activeVersionId,
  artifactHash: 'a'.repeat(64),
  compilerConfigVersion: 1,
  compilerVersion: '1.0.0',
  controllerCount: 1,
  entityCount: 1,
  lastLedgerSequence: 1,
  lifecycle: 'active',
  manifestContentHash: 'b'.repeat(64),
  manifestRevisionId,
  manifestSchemaVersion: 1,
  relationshipCount: 0,
  seed: 'harbor-city-v1',
  stateRevision: 3,
  worldGraphSchemaVersion: 1,
  worldId,
  worldVersionNumber: 1,
};

const initialEntity: WorldEntityView = {
  createdWorldVersionId: activeVersionId,
  entitySchemaVersion: 1,
  entityType: 'district',
  logicalKey: entityKey,
  retiredWorldVersionId: null,
  rowVersion: 0,
  state: {
    name: 'Harbor District',
    parameters: {},
    primitiveRef: 'harbor-district',
  },
  worldId,
};

const validators = {
  command: createValidator<WorldCommandRequestV1>(WorldCommandRequestV1Schema),
  commandResult: createValidator(WorldCommandResultV1Schema),
  entities: createValidator(WorldEntityListResponseSchema),
  entity: createValidator(WorldEntityDetailResponseSchema),
  historyEntry: createValidator(WorldHistoryEntryV1Schema),
  neighbors: createValidator(WorldNeighborResponseSchema),
  relationships: createValidator(WorldRelationshipListResponseSchema),
  summary: createValidator(RuntimeSummaryViewSchema),
  world: createValidator(WorldSchema),
};

type ContractValidator = ReturnType<typeof createValidator>;
type CommandMode = 'network-uncertain-accepted' | 'stale-rejected';

interface CommandDemoState {
  commandLookups: number;
  commandPayload: WorldCommandRequestV1 | null;
  commandResult: WorldCommandResultV1 | null;
  detailReads: number;
  entity: WorldEntityView;
  historyQueries: URLSearchParams[];
  postAttempts: number;
  postHeaders: Record<string, string> | null;
  summary: RuntimeSummaryView;
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

function acceptedResult(commandId: string): WorldCommandResultV1 {
  return {
    commandId,
    eventIds: [eventId],
    eventSequenceRange: { from: '1', to: '1' },
    ledgerSequenceRange: { from: '2', to: '3' },
    resultingStateRevision: '4',
    schemaVersion: 1,
    status: 'accepted',
  };
}

function rejectedResult(commandId: string): WorldCommandResultV1 {
  return {
    commandId,
    currentStateRevision: '4',
    eventIds: [],
    rejectionCode: 'REVISION_CONFLICT',
    schemaVersion: 1,
    status: 'rejected',
  };
}

function acceptedHistory(commandId: string): WorldHistoryEntryV1 {
  return {
    actor: { actorId, actorType: 'user' },
    category: 'entity',
    commandId,
    correlationId: commandId,
    eventId,
    eventType: 'WorldEntityRenamedV1',
    historySchemaVersion: 1,
    ledgerSequence: '3',
    occurredAt: now,
    resultingStateRevision: '4',
    summaryArgs: { entityKey },
    targetId: entityKey,
    targetType: 'world_entity',
    titleKey: 'history.entity.renamed',
    visibility: 'member',
    worldId,
  };
}

async function mockCommandDemo(page: Page, mode: CommandMode): Promise<CommandDemoState> {
  const state: CommandDemoState = {
    commandLookups: 0,
    commandPayload: null,
    commandResult: null,
    detailReads: 0,
    entity: structuredClone(initialEntity),
    historyQueries: [],
    postAttempts: 0,
    postHeaders: null,
    summary: structuredClone(initialSummary),
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/v1/auth/csrf') return json(route, { csrfToken });
    if (path === `/api/v1/worlds/${worldId}`) {
      expect(validators.world.issues(world)).toEqual([]);
      return json(route, { world });
    }
    if (path === `/api/v1/worlds/${worldId}/runtime-summary`) {
      return checkedJson(route, validators.summary, state.summary);
    }
    if (path === `/api/v1/worlds/${worldId}/entities`) {
      return checkedJson(route, validators.entities, {
        items: [state.entity],
        nextCursor: null,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: state.summary.stateRevision,
          worldVersionNumber: state.summary.worldVersionNumber,
        },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/relationships`) {
      return checkedJson(route, validators.relationships, {
        items: [],
        nextCursor: null,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: state.summary.stateRevision,
          worldVersionNumber: state.summary.worldVersionNumber,
        },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/entities/${encodeURIComponent(entityKey)}/neighbors`) {
      return checkedJson(route, validators.neighbors, {
        entity: state.entity,
        items: [],
        nextCursor: null,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: state.summary.stateRevision,
          worldVersionNumber: state.summary.worldVersionNumber,
        },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/entities/${encodeURIComponent(entityKey)}`) {
      return checkedJson(route, validators.entity, {
        entity: state.entity,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: state.summary.stateRevision,
          worldVersionNumber: state.summary.worldVersionNumber,
        },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/commands` && request.method() === 'POST') {
      state.postAttempts += 1;
      state.postHeaders = request.headers();
      const body: unknown = JSON.parse(request.postData() ?? '{}');
      expect(validators.command.issues(body)).toEqual([]);
      if (!validators.command.is(body))
        throw new Error('Rename command mock received invalid body.');
      state.commandPayload = body;

      if (mode === 'stale-rejected') {
        state.commandResult = rejectedResult(body.commandId);
        return checkedJson(route, validators.commandResult, state.commandResult, 409);
      }

      state.commandResult = acceptedResult(body.commandId);
      state.entity = {
        ...state.entity,
        rowVersion: state.entity.rowVersion + 1,
        state: { ...state.entity.state, name: body.payload.newDisplayName },
      };
      state.summary = {
        ...state.summary,
        lastLedgerSequence: 3,
        stateRevision: 4,
      };
      return route.abort('failed');
    }
    const commandMatch = path.match(/^\/api\/v1\/commands\/([^/]+)$/u);
    if (commandMatch?.[1]) {
      state.commandLookups += 1;
      expect(commandMatch[1]).toBe(state.commandPayload?.commandId);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!state.commandResult) throw new Error('Command lookup occurred before submission.');
      return checkedJson(route, validators.commandResult, state.commandResult);
    }
    if (path === `/api/v1/worlds/${worldId}/history`) {
      state.historyQueries.push(new URLSearchParams(url.search));
      const commandId = state.commandPayload?.commandId;
      if (!commandId || state.commandResult?.status !== 'accepted') {
        return json(route, { items: [], nextCursor: null });
      }
      const entry = acceptedHistory(commandId);
      expect(validators.historyEntry.issues(entry)).toEqual([]);
      return json(route, { items: [entry], nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/history/3`) {
      state.detailReads += 1;
      const command = state.commandPayload;
      if (!command) throw new Error('History detail occurred before command submission.');
      const entry = acceptedHistory(command.commandId);
      return json(route, {
        command: {
          authorizationRuleId: 'world.entity.rename.creator',
          commandId: command.commandId,
          commandType: command.type,
          decidedAt: now,
          expectedAggregateVersion: command.expectedAggregateVersion,
          expectedStateRevision: command.expectedStateRevision,
          expectedWorldVersion: command.expectedWorldVersion,
          overrideId: null,
          requestedAt: now,
          schemaVersion: command.schemaVersion,
          status: 'accepted',
        },
        entry,
        event: {
          aggregateId: entityKey,
          aggregateType: 'world_entity',
          aggregateVersion: '1',
          eventId,
          eventSchemaVersion: 1,
          eventType: 'WorldEntityRenamedV1',
          worldEventSequence: '1',
        },
        projection: { resultingStateRevision: '4' },
      });
    }
    return json(
      route,
      { error: { code: 'NOT_FOUND', message: `${request.method()} ${path} not mocked` } },
      404,
    );
  });

  return state;
}

async function selectHarborDistrict(page: Page): Promise<void> {
  await page.goto(`/worlds/${worldId}/graph`);
  await expect(page.getByRole('heading', { name: 'WorldGraph Explorer' })).toBeVisible();
  const district = page.getByRole('button', { name: /Harbor District/u }).first();
  await district.focus();
  await district.press('Enter');
  await expect(page.getByRole('region', { name: 'Harbor District' })).toBeFocused();
}

test('recovers an accepted rename, then filters and inspects its history accessibly', async ({
  page,
}) => {
  const state = await mockCommandDemo(page, 'network-uncertain-accepted');
  await selectHarborDistrict(page);

  const rename = page.getByRole('button', { name: 'Rename', exact: true });
  await rename.focus();
  await rename.press('Enter');
  const name = page.getByLabel('New display name');
  await name.fill('Harbor Commons');
  await name.press('Enter');

  const status = page.getByRole('status');
  await expect(status).toContainText('network result is uncertain');
  await expect(status).toContainText('Accepted at state revision 4');
  await expect(page.getByRole('heading', { level: 2, name: 'Harbor Commons' })).toBeVisible();

  expect(state.postAttempts).toBe(1);
  expect(state.commandLookups).toBe(1);
  expect(state.commandPayload).toMatchObject({
    expectedAggregateVersion: '1',
    expectedStateRevision: '3',
    expectedWorldVersion: '1',
    payload: { entityKey, newDisplayName: 'Harbor Commons' },
  });
  expect(state.postHeaders?.['idempotency-key']).toBe(state.commandPayload?.idempotencyKey);
  expect(state.postHeaders?.['x-csrf-token']).toBe(csrfToken);

  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'World History' })).toBeVisible();
  await page.getByLabel('Actor ID').fill(actorId);
  await page.getByLabel('Entity key').fill(entityKey);
  const eventFilter = page.getByLabel('Event type');
  await eventFilter.fill('WorldEntityRenamedV1');
  await eventFilter.press('Enter');

  await expect.poll(() => state.historyQueries.length).toBeGreaterThan(1);
  const applied = state.historyQueries.at(-1);
  expect(applied?.get('actorId')).toBe(actorId);
  expect(applied?.get('targetId')).toBe(entityKey);
  expect(applied?.get('eventType')).toBe('WorldEntityRenamedV1');
  expect(applied?.get('limit')).toBe('25');

  const historyEntry = page.getByRole('button', { name: 'Entity renamed' });
  await historyEntry.focus();
  await historyEntry.press('Enter');
  const detail = page.locator('section[tabindex="-1"]').filter({ hasText: 'Entity renamed' });
  await expect(detail).toBeFocused();
  await expect(detail).toContainText('RenameWorldEntityV1');
  await expect(detail).toContainText('WorldEntityRenamedV1');
  await expect(detail).toContainText('World state advanced to revision 4');
  expect(state.detailReads).toBe(1);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('shows a stale rename as a recorded revision conflict without retrying', async ({ page }) => {
  const state = await mockCommandDemo(page, 'stale-rejected');
  await selectHarborDistrict(page);

  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('New display name').fill('Stale Harbor Name');
  await page.getByRole('button', { name: 'Confirm rename' }).click();

  await expect(page.getByRole('status')).toContainText(
    'REVISION_CONFLICT: the world is now at revision 4',
  );
  await expect(page.getByRole('heading', { level: 2, name: 'Harbor District' })).toBeVisible();
  expect(state.postAttempts).toBe(1);
  expect(state.commandLookups).toBe(0);
  expect(state.commandResult).toMatchObject({
    currentStateRevision: '4',
    eventIds: [],
    rejectionCode: 'REVISION_CONFLICT',
    status: 'rejected',
  });
});
