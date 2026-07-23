import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const userId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const memberId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const invitationId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const now = '2026-07-21T12:00:00.000Z';
const me = {
  session: {
    absoluteExpiresAt: '2026-08-21T12:00:00.000Z',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e29',
    idleExpiresAt: '2026-07-28T12:00:00.000Z',
  },
  user: {
    displayName: 'Alice',
    email: 'alice@example.test',
    id: userId,
    platformRole: 'user',
    rowVersion: 1,
    status: 'active',
  },
};
const world = {
  activeWorldVersionId: null,
  createdAt: now,
  currentApprovedManifestRevisionId: null,
  id: worldId,
  lifecycle: 'draft',
  manifestSchemaVersion: null,
  name: 'Floating Guild City',
  role: 'creator',
  rowVersion: 1,
  slug: 'floating-guild-city',
  updatedAt: now,
};
const members = [
  {
    joinedAt: now,
    role: 'creator',
    rowVersion: 1,
    status: 'active',
    user: { displayName: 'Alice', id: userId },
  },
  {
    joinedAt: now,
    role: 'administrator',
    rowVersion: 2,
    status: 'active',
    user: { displayName: 'Bob', id: memberId },
  },
];

function json(route: Route, body: object, status = 200, headers?: Record<string, string>) {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    ...(headers ? { headers } : {}),
    status,
  });
}

async function mockApi(page: Page, worlds: object[] = [world]) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/auth/register') || path.endsWith('/auth/login')) {
      return json(route, me, path.endsWith('/register') ? 201 : 200, {
        'set-cookie': 'wg_session=opaque; Path=/api/v1; HttpOnly; SameSite=Lax',
      });
    }
    if (path.endsWith('/auth/me')) return json(route, me);
    if (path.endsWith('/auth/csrf')) return json(route, { csrfToken: 'c'.repeat(43) });
    if (path === '/api/v1/worlds' && request.method() === 'GET')
      return json(route, { items: worlds, nextCursor: null });
    if (path === `/api/v1/worlds/${worldId}`) return json(route, { world });
    if (path.endsWith('/memberships')) return json(route, { items: members, nextCursor: null });
    if (path.endsWith('/invitations') && request.method() === 'GET')
      return json(route, { items: [], nextCursor: null });
    if (path.endsWith('/authority/audit'))
      return json(route, {
        items: [
          {
            action: 'world.created',
            id: 'audit-1',
            outcome: 'allowed',
            reasonCode: 'COMMAND_APPLIED',
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith('/creator-overrides'))
      return json(route, {
        membership: { role: 'player', rowVersion: 3, userId: memberId },
        override: { action: 'membership.force_demote_administrator' },
      });
    if (path.endsWith('/invitations') && request.method() === 'POST')
      return json(
        route,
        {
          invitation: {
            createdAt: now,
            email: 'bob@example.test',
            expiresAt: '2026-07-22T12:00:00.000Z',
            id: invitationId,
            intendedRole: 'player',
            rowVersion: 1,
            status: 'pending',
          },
          rawToken: 'i'.repeat(43),
        },
        201,
      );
    if (path.endsWith('/invitations/accept'))
      return json(route, { membership: { role: 'player', worldId } });
    return json(
      route,
      { error: { code: 'NOT_FOUND', message: 'Not found', requestId: userId } },
      404,
    );
  });
}

test('registers, reaches the empty dashboard, and remains accessible', async ({ page }) => {
  await mockApi(page, []);
  await page.goto('/register');
  await page.getByLabel('Display name').fill('Alice');
  await page.getByLabel('Email address').fill('alice@example.test');
  await page.getByLabel('Password').fill('Correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/worlds$/u);
  await expect(page).toHaveTitle('WorldGraph — Anvil');
  await expect(page.getByRole('heading', { name: 'Shape your first city-state' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(JSON.stringify(browserStorage)).not.toMatch(/opaque|wg_session|authToken|csrfToken/iu);
});

test('shows authority-aware members and requires explicit override confirmation', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto(`/worlds/${worldId}`);
  await page.getByRole('button', { name: 'Members' }).click();
  await expect(page.getByText('The sole creator cannot be removed or demoted.')).toBeVisible();
  await page.getByRole('button', { name: 'Creator override…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Administrator access is no longer appropriate.');
  await dialog.getByLabel(/Type USE CREATOR OVERRIDE/u).fill('USE CREATOR OVERRIDE');
  await dialog.getByRole('button', { name: 'Apply override' }).click();
  await expect(page.getByText('Creator override applied and immutably audited.')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('creates a one-time fragment invitation without browser storage', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/worlds/${worldId}`);
  await page.getByLabel('Email').fill('bob@example.test');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const invitationLink = page.getByLabel('Invitation link');
  await expect(invitationLink).toHaveValue(
    new RegExp(`/invitations/accept#token=${'i'.repeat(43)}$`, 'u'),
  );
  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(JSON.stringify(browserStorage)).not.toContain('i'.repeat(43));
});

test('scrubs invitation fragment before accepting it', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/invitations/accept#token=${'i'.repeat(43)}`);
  await expect(page).toHaveURL(/\/invitations\/accept$/u);
  await expect(page.getByRole('heading', { name: 'Invitation accepted' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open world' })).toHaveAttribute(
    'href',
    `/worlds/${worldId}`,
  );
});

test.describe('credential forms without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('cannot place credentials in URL query or history', async ({ page }) => {
    await page.goto('/register');
    const form = page.locator('form');
    await expect(form).toHaveAttribute('method', 'post');
    await expect(form).toHaveAttribute('action', '/auth-unavailable');
    await expect(
      page.getByText('JavaScript is required; credentials were not submitted.'),
    ).toBeVisible();
    await page.getByLabel('Email address').fill('alice@example.test');
    await page.getByLabel('Password').fill('Never put this password in a URL');
    await page.getByLabel('Password').press('Enter');
    await expect(page).toHaveURL(/\/register$/u);
    expect(page.url()).not.toMatch(/password|alice%40example/iu);
  });
});
