import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import {
  RuntimeSummaryViewSchema,
  WorldEntityDetailResponseSchema,
  WorldEntityListResponseSchema,
  WorldNeighborResponseSchema,
  WorldRelationshipListResponseSchema,
  WorldSchema,
  createValidator,
  type RuntimeSummaryView,
  type World,
  type WorldEntityView,
  type WorldNeighborResponse,
  type WorldRelationshipView,
} from '../../packages/contracts/src/index.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const activeVersionId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const manifestRevisionId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const artifactHash = 'a'.repeat(64);
const manifestHash = 'b'.repeat(64);
const creatorPrincipal = `member-${'a'.repeat(32)}`;
const now = '2026-07-22T04:00:00.000Z';

const world: World = {
  activeWorldVersionId: activeVersionId,
  createdAt: now,
  currentApprovedManifestRevisionId: manifestRevisionId,
  id: worldId,
  lifecycle: 'active',
  manifestSchemaVersion: 1,
  name: 'Floating Guild City',
  role: 'creator',
  rowVersion: 4,
  slug: 'floating-guild-city',
  updatedAt: now,
};

const summary: RuntimeSummaryView = {
  activatedAt: now,
  activeWorldVersionId: activeVersionId,
  artifactHash,
  compilerConfigVersion: 1,
  compilerVersion: '1.0.0',
  controllerCount: 1,
  entityCount: 6,
  lastLedgerSequence: 0,
  lifecycle: 'active',
  manifestContentHash: manifestHash,
  manifestRevisionId,
  manifestSchemaVersion: 1,
  relationshipCount: 4,
  seed: 'floating-guild-city-v1',
  stateRevision: 0,
  worldGraphSchemaVersion: 1,
  worldId,
  worldVersionNumber: 1,
};

function entity(
  logicalKey: string,
  entityType: WorldEntityView['entityType'],
  state: WorldEntityView['state'],
): WorldEntityView {
  return {
    createdWorldVersionId: activeVersionId,
    entitySchemaVersion: 1,
    entityType,
    logicalKey,
    retiredWorldVersionId: null,
    rowVersion: 0,
    state,
    worldId,
  };
}

const entities = [
  entity('district:skyforge', 'district', {
    name: 'Skyforge District',
    parameters: {},
    primitiveRef: 'skyforge-district',
  }),
  entity('institution:aerie-council', 'institution', {
    districtLogicalKey: 'district:skyforge',
    name: 'Aerie Council',
    organizationLogicalKeys: ['organization:energy-guild'],
    parameters: {},
    primitiveRef: 'aerie-council',
  }),
  entity('organization:energy-guild', 'organization', {
    homeDistrictLogicalKey: 'district:skyforge',
    name: 'Energy Guild',
    parameters: {},
    primitiveRef: 'energy-guild',
  }),
  entity(`character:${creatorPrincipal}`, 'player_character', {
    blueprintLogicalKey: 'actor-blueprint:creator',
    homeDistrictLogicalKey: 'district:skyforge',
    membershipRole: 'creator',
    name: 'Creator Character',
    organizationLogicalKey: 'organization:energy-guild',
  }),
  entity('currency:closed-loop-credit', 'currency_definition_intent', {
    parameters: {},
    primitiveRef: 'closed-loop-credit',
  }),
  entity(`account:${creatorPrincipal}`, 'account_principal', {
    membershipRole: 'creator',
    principalKey: creatorPrincipal,
  }),
];

function relationship(
  logicalKey: string,
  relationshipType: WorldRelationshipView['relationshipType'],
  sourceLogicalKey: string,
  targetLogicalKey: string,
  attributes: WorldRelationshipView['attributes'],
): WorldRelationshipView {
  return {
    attributes,
    createdWorldVersionId: activeVersionId,
    logicalKey,
    relationshipSchemaVersion: 1,
    relationshipType,
    retiredWorldVersionId: null,
    rowVersion: 0,
    sourceLogicalKey,
    targetLogicalKey,
    worldId,
  };
}

const relationships = [
  relationship(
    'relationship:located-in-energy-guild-skyforge',
    'located_in',
    'organization:energy-guild',
    'district:skyforge',
    {},
  ),
  relationship(
    'relationship:governs-council-skyforge',
    'governs',
    'institution:aerie-council',
    'district:skyforge',
    { manifestRelationshipKey: 'council-governs-skyforge' },
  ),
  relationship(
    'relationship:member-of-creator-guild',
    'member_of',
    `character:${creatorPrincipal}`,
    'organization:energy-guild',
    {},
  ),
  relationship(
    'relationship:account-controls-creator',
    'account_controls',
    `account:${creatorPrincipal}`,
    `character:${creatorPrincipal}`,
    {},
  ),
];

const validators = {
  entities: createValidator(WorldEntityListResponseSchema),
  entity: createValidator(WorldEntityDetailResponseSchema),
  neighbors: createValidator(WorldNeighborResponseSchema),
  relationships: createValidator(WorldRelationshipListResponseSchema),
  summary: createValidator(RuntimeSummaryViewSchema),
  world: createValidator(WorldSchema),
};

type ContractValidator = ReturnType<typeof createValidator>;

function checkedJson(route: Route, validator: ContractValidator, body: object, status = 200) {
  expect(
    validator.issues(body),
    `Mock response violated its public contract: ${JSON.stringify(body)}`,
  ).toEqual([]);
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

interface GraphMockState {
  entityQueries: URLSearchParams[];
  relationshipQueries: URLSearchParams[];
}

async function mockWorldGraph(page: Page): Promise<GraphMockState> {
  const state: GraphMockState = { entityQueries: [], relationshipQueries: [] };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === `/api/v1/worlds/${worldId}`) {
      return checkedJson(route, validators.world, world);
    }
    if (path === `/api/v1/worlds/${worldId}/runtime-summary`) {
      return checkedJson(route, validators.summary, summary);
    }
    if (path === `/api/v1/worlds/${worldId}/entities`) {
      state.entityQueries.push(new URLSearchParams(url.search));
      return checkedJson(route, validators.entities, {
        items: entities,
        nextCursor: null,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: 0,
          worldVersionNumber: 1,
        },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/relationships`) {
      state.relationshipQueries.push(new URLSearchParams(url.search));
      return checkedJson(route, validators.relationships, {
        items: relationships,
        nextCursor: null,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: 0,
          worldVersionNumber: 1,
        },
      });
    }
    const neighborMatch = path.match(
      new RegExp(`^/api/v1/worlds/${worldId}/entities/([^/]+)/neighbors$`, 'u'),
    );
    if (neighborMatch?.[1]) {
      const logicalKey = decodeURIComponent(neighborMatch[1]);
      const selected = entities.find((item) => item.logicalKey === logicalKey)!;
      const items: WorldNeighborResponse['items'] = [];
      for (const edge of relationships) {
        if (edge.sourceLogicalKey === logicalKey) {
          items.push({
            direction: 'outbound',
            neighbor: entities.find((item) => item.logicalKey === edge.targetLogicalKey)!,
            relationship: edge,
          });
        }
        if (edge.targetLogicalKey === logicalKey) {
          items.push({
            direction: 'inbound',
            neighbor: entities.find((item) => item.logicalKey === edge.sourceLogicalKey)!,
            relationship: edge,
          });
        }
      }
      return checkedJson(route, validators.neighbors, {
        entity: selected,
        items,
        nextCursor: null,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: 0,
          worldVersionNumber: 1,
        },
      });
    }
    const entityMatch = path.match(new RegExp(`^/api/v1/worlds/${worldId}/entities/([^/]+)$`, 'u'));
    if (entityMatch?.[1]) {
      const logicalKey = decodeURIComponent(entityMatch[1]);
      return checkedJson(route, validators.entity, {
        entity: entities.find((item) => item.logicalKey === logicalKey)!,
        runtime: {
          activeWorldVersionId: activeVersionId,
          stateRevision: 0,
          worldVersionNumber: 1,
        },
      });
    }
    return route.fulfill({
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: `${path} not mocked` } }),
      contentType: 'application/json',
      status: 404,
    });
  });
  return state;
}

test('shows exact active identity and browses the authoritative graph accessibly', async ({
  page,
}) => {
  const state = await mockWorldGraph(page);
  await page.goto(`/worlds/${worldId}/overview`);

  await expect(page.getByRole('heading', { name: 'World Overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'World version 1' })).toBeVisible();
  await expect(page.getByText('1.0.0 · config v1')).toBeVisible();
  await expect(page.getByText(artifactHash, { exact: true })).toBeVisible();
  await expect(page.getByText('6', { exact: true })).toBeVisible();
  await expect(page.getByText('4', { exact: true })).toBeVisible();
  await expect(page.getByText('The graph is authoritative')).toBeVisible();

  await page.getByRole('link', { name: 'Browse authoritative graph' }).click();
  await expect(page.getByRole('heading', { name: 'WorldGraph Explorer' })).toBeVisible();
  await expect(page.getByRole('table', { name: /Authoritative entities/u })).toBeVisible();
  await expect(page.getByRole('table', { name: /Typed relationships/u })).toBeVisible();

  await page.getByLabel('Search logical key').fill('guild');
  await page.getByLabel('Entity type').fill('organization');
  await page.getByRole('button', { name: 'Apply entity filters' }).click();
  await expect.poll(() => state.entityQueries.length).toBeGreaterThan(1);
  expect(state.entityQueries.at(-1)?.get('query')).toBe('guild');
  expect(state.entityQueries.at(-1)?.get('entityType')).toBe('organization');

  await page.getByLabel('Endpoint logical key').fill('district:skyforge');
  await page.getByLabel('Endpoint direction').selectOption('target');
  await page.getByLabel('Relationship type').fill('located_in');
  await page.getByRole('button', { name: 'Apply relationship filters' }).click();
  await expect.poll(() => state.relationshipQueries.length).toBeGreaterThan(1);
  expect(state.relationshipQueries.at(-1)?.get('targetLogicalKey')).toBe('district:skyforge');
  expect(state.relationshipQueries.at(-1)?.get('relationshipType')).toBe('located_in');

  const district = page.getByRole('button', { name: /Skyforge District/u }).first();
  await district.focus();
  await district.press('Enter');
  await expect(page.getByRole('region', { name: 'Skyforge District' })).toBeFocused();
  const inbound = page.getByRole('region', { name: /Inbound/u });
  await expect(inbound).toBeVisible();
  await expect(inbound.getByText('Located In')).toBeVisible();
  await expect(inbound.getByText('Governs', { exact: true })).toBeVisible();
  await expect(page.getByText(/approved manifest revision/u)).toBeVisible();

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
