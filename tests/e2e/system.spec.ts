import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const info = {
  build: { api: 'e2e-api' },
  codename: 'Anvil',
  features: { operationalSmoke: false },
  name: 'WorldGraph',
  versions: {
    api: 'v1',
    compiler: '1.0.0',
    compilerArtifactSchema: 1,
    compilerConfigSchema: 1,
    compilationQueueSchema: 1,
    contracts: 5,
    manifestGeneratorSchema: 1,
    manifestPromptTemplate: 1,
    manifestQueueSchema: 1,
    manifestSchema: 1,
    manifestValidator: 1,
    primitiveSchema: 1,
    runtimeSchema: 5,
    worldGraphSchema: 1,
  },
};
const components = ['api', 'postgresql', 'redis', 'worker'].map((name) => ({
  name,
  status: 'healthy',
}));

test('home and healthy system status are accessible', async ({ page }) => {
  await page.route('**/api/system/info', (route) =>
    route.fulfill({ body: JSON.stringify(info), contentType: 'application/json' }),
  );
  await page.route('**/api/system/ready', (route) =>
    route.fulfill({
      body: JSON.stringify({ checkedAt: '2026-07-21T12:00:00.000Z', components, status: 'ready' }),
      contentType: 'application/json',
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Build a society, not just a scene.' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'View system status' }).click();
  await expect(
    page.getByRole('heading', { name: 'All required components are healthy' }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('degraded state reports stable code and retry recovers focus', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/system/info', (route) =>
    route.fulfill({ body: JSON.stringify(info), contentType: 'application/json' }),
  );
  await page.route('**/api/system/ready', (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        body: JSON.stringify({
          error: {
            code: 'DEPENDENCY_NOT_READY',
            details: {
              components: [{ name: 'redis', status: 'unavailable', code: 'REDIS_UNAVAILABLE' }],
            },
            message: 'Unavailable',
            requestId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
          },
        }),
        contentType: 'application/json',
        status: 503,
      });
    }
    return route.fulfill({
      body: JSON.stringify({ checkedAt: '2026-07-21T12:00:00.000Z', components, status: 'ready' }),
      contentType: 'application/json',
    });
  });
  await page.goto('/system');
  await expect(page.getByText('Error code: DEPENDENCY_NOT_READY')).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry checks' });
  await retry.click();
  await expect(
    page.getByRole('heading', { name: 'All required components are healthy' }),
  ).toBeVisible();
  await expect(retry).toBeFocused();
});
