import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const csrfToken = 'c'.repeat(43);

const snapshot = {
  etag: 'a'.repeat(64),
  features: [
    {
      entityLogicalKey: 'district:harbor',
      geometryKind: 'polygon',
      layer: 'district',
      properties: { zoning: 'harbor' },
      ringOrPath: [
        { xMilli: -10_000, yMilli: -10_000 },
        { xMilli: 10_000, yMilli: -10_000 },
        { xMilli: 10_000, yMilli: 10_000 },
        { xMilli: -10_000, yMilli: 10_000 },
        { xMilli: -10_000, yMilli: -10_000 },
      ],
      stableKey: 'district:harbor',
    },
    {
      entityLogicalKey: 'entity:workshop-1',
      geometryKind: 'point',
      layer: 'building',
      properties: { archetype: 'workshop' },
      ringOrPath: [{ xMilli: 2_000, yMilli: 1_000 }],
      stableKey: 'building:workshop-1',
    },
  ],
  geographyVersion: '1',
  spatialReference: {
    boundsMaxXMilli: 50_000,
    boundsMaxYMilli: 50_000,
    boundsMinXMilli: -50_000,
    boundsMinYMilli: -50_000,
    originXMilli: 0,
    originYMilli: 0,
    srid: 3857,
    units: 'meters',
  },
  stateRevision: '12',
} as const;

const scenePlan = {
  checksum: 'b'.repeat(64),
  etag: 'b'.repeat(64),
  geographyVersion: '1',
  plan: {
    bounds: {
      maxXMilli: 50_000,
      maxYMilli: 50_000,
      minXMilli: -50_000,
      minYMilli: -50_000,
    },
    nodes: [
      {
        archetype: 'workshop',
        entityLogicalKey: 'entity:workshop-1',
        layer: 'building',
        lodHint: 'medium',
        materialToken: 'kit.lowpoly.building',
        provenance: { sourceStableKey: 'building:workshop-1' },
        transform: {
          scaleMilli: 1_000,
          xMilli: 2_000,
          yMilli: 1_000,
          yawMilliDegrees: 0,
          zMilli: 0,
        },
      },
    ],
    styleKitVersion: 1,
    visualScenePlanSchemaVersion: 1,
    warnings: [],
  },
  publishedAtTick: '0',
  stateRevision: '12',
  status: 'published',
} as const;

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status,
  });
}

async function stubExploreApis(page: Page): Promise<void> {
  await page.route(`**/api/v1/worlds/${worldId}/geography**`, (route) =>
    fulfillJson(route, snapshot),
  );
  await page.route(`**/api/v1/worlds/${worldId}/visual-scene-plan**`, (route) =>
    fulfillJson(route, scenePlan),
  );
  await page.route('**/api/v1/auth/csrf', (route) => fulfillJson(route, { csrfToken }));
  await page.route('**/api/v1/auth/me', (route) =>
    fulfillJson(route, {
      user: {
        displayName: 'Explorer',
        email: 'explorer@example.test',
        id: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        platformRole: 'user',
      },
    }),
  );
}

test.describe('Explore geography lens', () => {
  test('loads accessible 2D list/map and inspector parity', async ({ page }) => {
    await stubExploreApis(page);
    await page.goto(`/worlds/${worldId}/explore`);
    await expect(page.getByRole('heading', { name: 'City geography' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '2D list / map' })).toBeVisible();
    await page.getByRole('button', { name: /building:workshop-1/ }).click();
    await expect(page.getByRole('complementary').getByText('building:workshop-1')).toBeVisible();
    await expect(page.getByRole('complementary').getByText('entity:workshop-1')).toBeVisible();

    await page.getByLabel('Enable WebGL').uncheck();
    await expect(page.getByText(/WebGL is disabled/i)).toBeVisible();

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
  });
});
