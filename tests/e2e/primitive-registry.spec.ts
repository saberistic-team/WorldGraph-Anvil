import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import {
  createValidator,
  PrimitiveCommandResponseSchema,
  PrimitiveDependencyViewSchema,
  PrimitiveDraftCommandResponseSchema,
  PrimitiveListResponseSchema,
  PrimitiveReindexResponseSchema,
  PrimitiveRetrievalResponseSchema,
  PrimitiveVersionViewSchema,
  type PrimitiveDependencyView,
  type PrimitiveDraftInput,
  type PrimitiveKind,
  type PrimitiveListItem,
  type PrimitiveVersionView,
} from '../../packages/contracts/src/index.js';

const userId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
const now = '2026-07-21T12:00:00.000Z';
const hash = 'c065b367849253adc984cb037de346da9e2391cd4a5d468111e0c0d03776c99e';

const listValidator = createValidator(PrimitiveListResponseSchema);
const retrievalValidator = createValidator(PrimitiveRetrievalResponseSchema);
const detailValidator = createValidator(PrimitiveVersionViewSchema);
const dependencyValidator = createValidator(PrimitiveDependencyViewSchema);
const draftCommandValidator = createValidator(PrimitiveDraftCommandResponseSchema);
const commandValidator = createValidator(PrimitiveCommandResponseSchema);
const reindexValidator = createValidator(PrimitiveReindexResponseSchema);

function listItem(
  id: string,
  key: string,
  displayName: string,
  kind: PrimitiveKind,
  tags: string[],
  overrides: Partial<PrimitiveListItem> = {},
): PrimitiveListItem {
  return {
    contentHash: hash,
    createdAt: now,
    displayName,
    id,
    indexErrorCode: null,
    indexState: 'completed',
    key,
    kind,
    lifecycle: 'published',
    publishedAt: now,
    rowVersion: 2,
    tags,
    updatedAt: now,
    version: '1.0.0',
    ...overrides,
  };
}

const council = listItem(
  '018f8652-3cb6-7d52-904b-cce7901d7e32',
  'worldgraph.government.guild-council',
  'Guild Council',
  'government',
  ['city-state', 'guild', 'council'],
);
const currency = listItem(
  '018f8652-3cb6-7d52-904b-cce7901d7e33',
  'worldgraph.currency.closed-loop-credits',
  'Closed-loop Credits',
  'currency',
  ['city-state', 'closed-loop'],
);
const energy = listItem(
  '018f8652-3cb6-7d52-904b-cce7901d7e34',
  'worldgraph.resource.energy',
  'Energy',
  'resource',
  ['city-state', 'energy-scarce'],
);
const district = listItem(
  '018f8652-3cb6-7d52-904b-cce7901d7e35',
  'worldgraph.district.floating-mixed-use',
  'Floating Mixed-use District',
  'district',
  ['city-state', 'floating'],
);
const visualStyle = listItem(
  '018f8652-3cb6-7d52-904b-cce7901d7e36',
  'worldgraph.visual-style.low-poly-floating-city',
  'Low-poly Floating City',
  'visual_style',
  ['city-state', 'floating'],
);
const deprecatedCouncil = listItem(
  '018f8652-3cb6-7d52-904b-cce7901d7e41',
  'worldgraph.government.legacy-council',
  'Legacy Council',
  'government',
  ['city-state', 'legacy'],
  {
    indexErrorCode: 'PROVIDER_TIMEOUT',
    indexState: 'failed',
    lifecycle: 'deprecated',
    rowVersion: 3,
  },
);

const published = [council, currency, energy, district, visualStyle];
const councilDetail: PrimitiveVersionView = {
  ...council,
  behaviorRef: 'governance.guild-council.v1',
  compatibility: { worldScale: ['city-state'] },
  defaults: { seats: 7 },
  deprecatedAt: null,
  deprecationReason: null,
  dependencies: [],
  documentation:
    "## Guild council\n\nA reviewed council. [unsafe destination](javascript:alert(1))\n\n<script>alert('unsafe')</script>\n\n![remote](https://example.test/tracker.png)\n\n- Elects councillors\n- Schedules sessions",
  parameterSchema: {
    additionalProperties: false,
    properties: { seats: { maximum: 21, minimum: 3, type: 'integer' } },
    type: 'object',
  },
  primitiveSchemaVersion: 1,
  provenance: { catalog: 'city-state-starter', reviewed: true },
  visualHints: { motif: 'council-ring' },
};
const deprecatedDetail: PrimitiveVersionView = {
  ...councilDetail,
  ...deprecatedCouncil,
  deprecatedAt: now,
  deprecationReason: 'Superseded by the reviewed guild council.',
  documentation: '## Legacy council\n\nRetained for exact-version consumers.',
};
const councilDependencies: PrimitiveDependencyView[] = [
  {
    dependencyFamilyId: '018f8652-3cb6-7d52-904b-cce7901d7e42',
    key: 'worldgraph.organization.guild',
    parameterMapping: {},
    required: true,
    resolvedContentHash: hash,
    resolvedVersion: '1.0.0',
    resolvedVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e37',
    versionRange: '^1.0.0',
  },
];

function session(platformRole: 'platform_admin' | 'user') {
  return {
    session: {
      absoluteExpiresAt: '2026-08-21T12:00:00.000Z',
      id: '018f8652-3cb6-7d52-904b-cce7901d7e38',
      idleExpiresAt: '2026-07-28T12:00:00.000Z',
    },
    user: {
      displayName: platformRole === 'platform_admin' ? 'Ada Admin' : 'Nora User',
      email: `${platformRole}@example.test`,
      id: userId,
      platformRole,
      rowVersion: 1,
      status: 'active',
    },
  };
}

function json(route: Route, body: object, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

interface ContractValidator {
  is(value: unknown): boolean;
  issues(value: unknown): Array<{ keyword: string; message: string; path: string }>;
}

function checkedJson(route: Route, validator: ContractValidator, body: object, status = 200) {
  expect(
    validator.issues(body),
    `Mock response violated its public contract: ${JSON.stringify(body)}`,
  ).toEqual([]);
  return json(route, body, status);
}

function summary(view: PrimitiveVersionView): PrimitiveListItem {
  return {
    contentHash: view.contentHash,
    createdAt: view.createdAt,
    displayName: view.displayName,
    id: view.id,
    indexErrorCode: view.indexErrorCode,
    indexState: view.indexState,
    key: view.key,
    kind: view.kind,
    lifecycle: view.lifecycle,
    publishedAt: view.publishedAt,
    rowVersion: view.rowVersion,
    tags: view.tags,
    updatedAt: view.updatedAt,
    version: view.version,
  };
}

function draftView(
  input: PrimitiveDraftInput,
  previous: PrimitiveVersionView | null = null,
): PrimitiveVersionView {
  return {
    behaviorRef: input.behaviorRef ?? null,
    compatibility: input.compatibility,
    contentHash: hash,
    createdAt: previous?.createdAt ?? now,
    defaults: input.defaults,
    dependencies: input.dependencies.map((dependency) => ({
      dependencyFamilyId: '018f8652-3cb6-7d52-904b-cce7901d7e42',
      key: dependency.key,
      parameterMapping: dependency.parameterMapping ?? {},
      required: dependency.required ?? true,
      resolvedContentHash: null,
      resolvedVersion: null,
      resolvedVersionId: null,
      versionRange: dependency.versionRange,
    })),
    deprecatedAt: null,
    deprecationReason: null,
    displayName: input.displayName,
    documentation: input.documentation,
    id: previous?.id ?? '018f8652-3cb6-7d52-904b-cce7901d7e40',
    indexErrorCode: null,
    indexState: 'not_requested',
    key: input.key,
    kind: input.kind,
    lifecycle: 'draft',
    parameterSchema: input.parameterSchema,
    primitiveSchemaVersion: 1,
    provenance: input.provenance,
    publishedAt: null,
    rowVersion: (previous?.rowVersion ?? 0) + 1,
    tags: input.tags,
    updatedAt: now,
    version: input.version,
    visualHints: input.visualHints,
  };
}

interface MockState {
  authDelayMs: number;
  currentDraft: PrimitiveVersionView | null;
  draftListRequests: number;
  failNextReindex: boolean;
  failNextList: boolean;
  forceEmpty: boolean;
  noCompatible: boolean;
  platformRole: 'platform_admin' | 'user';
  publishIdempotencyKeys: string[];
  reindexIdempotencyKeys: string[];
  slowRetrievalDelayMs: number;
}

async function mockRegistry(
  page: Page,
  options: Partial<
    Pick<
      MockState,
      | 'authDelayMs'
      | 'failNextReindex'
      | 'failNextList'
      | 'forceEmpty'
      | 'noCompatible'
      | 'platformRole'
      | 'slowRetrievalDelayMs'
    >
  > = {},
): Promise<MockState> {
  const state: MockState = {
    authDelayMs: options.authDelayMs ?? 0,
    currentDraft: null,
    draftListRequests: 0,
    failNextReindex: options.failNextReindex ?? false,
    failNextList: options.failNextList ?? false,
    forceEmpty: options.forceEmpty ?? false,
    noCompatible: options.noCompatible ?? false,
    platformRole: options.platformRole ?? 'user',
    publishIdempotencyKeys: [],
    reindexIdempotencyKeys: [],
    slowRetrievalDelayMs: options.slowRetrievalDelayMs ?? 0,
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.endsWith('/auth/me')) {
      if (state.authDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.authDelayMs));
      }
      return json(route, session(state.platformRole));
    }
    if (path.endsWith('/auth/csrf')) return json(route, { csrfToken: 'c'.repeat(43) });

    if (path === '/api/v1/primitive-retrievals') {
      if (state.noCompatible) {
        return json(
          route,
          {
            error: {
              code: 'NO_COMPATIBLE_PRIMITIVES',
              message: 'No compatible published primitives matched.',
              requestId: userId,
            },
          },
          404,
        );
      }
      const input = request.postDataJSON() as {
        kinds?: PrimitiveKind[];
        query: string;
        tags?: string[];
      };
      if (input.query === 'slow council' && state.slowRetrievalDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.slowRetrievalDelayMs));
      }
      let filtered = published.filter(
        (primitive) =>
          (!input.kinds || input.kinds.includes(primitive.kind)) &&
          (!input.tags || input.tags.every((tag) => primitive.tags.includes(tag))),
      );
      if (input.query === 'slow council') {
        filtered = filtered.filter((primitive) => primitive.id === council.id);
      } else if (input.query === 'fast credits') {
        filtered = filtered.filter((primitive) => primitive.id === currency.id);
      }
      const response = {
        normalizedQueryHash: hash,
        provider: {
          configurationId: 'disabled-v1',
          degradedReason: 'PROVIDER_DISABLED',
          model: null,
          name: 'disabled',
          semanticAvailable: false,
        },
        ranking: {
          k: 60,
          strategy: 'weighted_rrf_v1',
          weights: { lexical: 1, tag: 0.6, vector: 0.35 },
        },
        results: filtered.map((primitive, index) => ({
          dependencyClosure: [],
          index: {
            contentHash: hash,
            indexSchemaVersion: 1,
            lastErrorCode: null,
            model: null,
            provider: null,
            providerConfigurationId: 'disabled-v1',
            status: 'disabled',
          },
          primitive,
          rank: index + 1,
          reason: {
            lexicalRank: index + 1,
            lexicalScore: 1 - index * 0.1,
            matchedTags: primitive.tags.filter((tag) => ['guild', 'floating'].includes(tag)),
            matchedTerms: [primitive.kind.replaceAll('_', ' ')],
            score: 0.02 - index * 0.001,
            tagRank: index + 1,
            tagScore: 1,
            vectorRank: null,
            vectorSimilarity: null,
          },
        })),
        retrievalRunId: '018f8652-3cb6-7d52-904b-cce7901d7e39',
        warnings: [
          {
            code: 'SEMANTIC_PROVIDER_DISABLED',
            message: 'Semantic provider disabled; lexical fallback used.',
          },
        ],
      };
      return checkedJson(route, retrievalValidator, response);
    }

    if (path.endsWith('/dependencies') && path.includes('/primitives/')) {
      for (const dependency of councilDependencies) {
        expect(dependencyValidator.issues(dependency)).toEqual([]);
      }
      return json(route, { dependencies: councilDependencies });
    }
    if (path === `/api/v1/primitives/${council.key}/versions/${council.version}`) {
      return checkedJson(route, detailValidator, councilDetail);
    }
    if (
      path === `/api/v1/primitives/${deprecatedCouncil.key}/versions/${deprecatedCouncil.version}`
    ) {
      return checkedJson(route, detailValidator, deprecatedDetail);
    }
    if (path.startsWith('/api/v1/primitives/') && method === 'GET' && state.currentDraft) {
      return checkedJson(route, detailValidator, state.currentDraft);
    }

    if (path === '/api/v1/primitives' && method === 'GET') {
      const lifecycle = url.searchParams.get('lifecycle');
      if (lifecycle === 'draft') {
        state.draftListRequests += 1;
        return checkedJson(route, listValidator, {
          items: state.currentDraft?.lifecycle === 'draft' ? [summary(state.currentDraft)] : [],
          nextCursor: null,
        });
      }
      if (lifecycle === 'deprecated') {
        const isSecondPage = url.searchParams.get('cursor') === 'deprecated-page-2';
        const current =
          state.currentDraft?.lifecycle === 'deprecated' ? [summary(state.currentDraft)] : [];
        return checkedJson(route, listValidator, {
          items: isSecondPage ? [deprecatedCouncil, ...current] : [],
          nextCursor: isSecondPage ? null : 'deprecated-page-2',
        });
      }
      if (state.failNextList) {
        state.failNextList = false;
        return json(
          route,
          {
            error: {
              code: 'RETRIEVAL_UNAVAILABLE',
              message: 'Lexical retrieval is temporarily unavailable.',
              requestId: userId,
            },
          },
          503,
        );
      }
      if (state.forceEmpty)
        return checkedJson(route, listValidator, { items: [], nextCursor: null });
      const kind = url.searchParams.get('kinds');
      const tag = url.searchParams.get('tags');
      let items: PrimitiveListItem[] = [...published];
      if (state.currentDraft?.lifecycle === 'published') {
        items = [
          ...items.filter((item) => item.id !== state.currentDraft?.id),
          summary(state.currentDraft),
        ];
      }
      if (kind) items = items.filter((item) => item.kind === kind);
      if (tag) items = items.filter((item) => item.tags.includes(tag));
      const isAdminPage = url.searchParams.get('limit') === '50';
      const cursor = url.searchParams.get('cursor');
      if (!isAdminPage && !kind && !tag) {
        return checkedJson(route, listValidator, {
          items: cursor ? items.slice(3) : items.slice(0, 3),
          nextCursor: cursor ? null : 'opaque-next-cursor',
        });
      }
      return checkedJson(route, listValidator, { items, nextCursor: null });
    }

    if (path === '/api/v1/admin/primitives/drafts' && method === 'POST') {
      const input = request.postDataJSON() as PrimitiveDraftInput;
      state.currentDraft = draftView(input);
      const response = {
        primitive: summary(state.currentDraft),
        validation: { contentHash: hash, issues: [], valid: true },
      };
      return checkedJson(route, draftCommandValidator, response, 201);
    }

    if (
      path.endsWith('/draft') &&
      path.startsWith('/api/v1/admin/primitives/') &&
      method === 'PUT'
    ) {
      const input = request.postDataJSON() as {
        draft: PrimitiveDraftInput;
        expectedRowVersion: number;
      };
      state.currentDraft = draftView(input.draft, state.currentDraft);
      const response = {
        primitive: summary(state.currentDraft),
        validation: { contentHash: hash, issues: [], valid: true },
      };
      return checkedJson(route, draftCommandValidator, response);
    }

    if (path.endsWith('/publish') && path.startsWith('/api/v1/admin/primitives/')) {
      state.publishIdempotencyKeys.push(request.headers()['idempotency-key'] ?? '');
      if (!state.currentDraft) throw new Error('Expected a current draft before publication.');
      const dependencies = state.currentDraft.dependencies;
      if (dependencies.some((dependency) => dependency.key === 'worldgraph.missing.nope')) {
        return json(
          route,
          {
            error: {
              code: 'DEPENDENCY_NOT_FOUND',
              details: {
                issues: [
                  {
                    code: 'DEPENDENCY_NOT_FOUND',
                    message: 'No compatible published dependency was found.',
                    pointer: '/draft/dependencies/0/key',
                  },
                ],
              },
              message: 'Publication validation failed.',
              requestId: userId,
            },
          },
          422,
        );
      }
      state.currentDraft = {
        ...state.currentDraft,
        dependencies: dependencies.map((dependency) => ({
          ...dependency,
          resolvedContentHash: hash,
          resolvedVersion: '1.0.0',
          resolvedVersionId: council.id,
        })),
        lifecycle: 'published',
        publishedAt: now,
        rowVersion: state.currentDraft.rowVersion + 1,
        updatedAt: now,
      };
      return checkedJson(route, commandValidator, { primitive: summary(state.currentDraft) });
    }

    if (path.endsWith('/reindex') && path.startsWith('/api/v1/admin/primitives/')) {
      state.reindexIdempotencyKeys.push(request.headers()['idempotency-key'] ?? '');
      if (!state.currentDraft) throw new Error('Expected a current primitive before reindexing.');
      if (state.failNextReindex) {
        state.failNextReindex = false;
        return json(
          route,
          {
            error: {
              code: 'REINDEX_UNAVAILABLE',
              message: 'The reindex request was not accepted.',
              requestId: userId,
            },
          },
          503,
        );
      }
      return checkedJson(
        route,
        reindexValidator,
        {
          index: {
            contentHash: hash,
            indexSchemaVersion: 1,
            lastErrorCode: null,
            model: null,
            provider: null,
            providerConfigurationId: 'disabled-v1',
            status: 'pending',
          },
          primitiveVersionId: state.currentDraft.id,
        },
        202,
      );
    }
    if (path.endsWith('/deprecate') && path.startsWith('/api/v1/admin/primitives/')) {
      if (!state.currentDraft) throw new Error('Expected a current primitive before deprecation.');
      const input = request.postDataJSON() as { reason: string };
      state.currentDraft = {
        ...state.currentDraft,
        deprecatedAt: now,
        deprecationReason: input.reason,
        lifecycle: 'deprecated',
        rowVersion: state.currentDraft.rowVersion + 1,
        updatedAt: now,
      };
      return checkedJson(route, commandValidator, { primitive: summary(state.currentDraft) });
    }

    return json(
      route,
      { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: userId } },
      404,
    );
  });
  return state;
}

test('browses, URL-filters, searches, and explains deterministic degraded results', async ({
  page,
}) => {
  await mockRegistry(page);
  await page.goto('/primitives');
  await expect(page.getByRole('heading', { name: 'World primitives' })).toBeVisible();
  await page.getByLabel('Kind').selectOption('government');
  await page.getByLabel('Tag', { exact: true }).fill('city-state');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/\/primitives\?kind=government&tag=city-state$/u);
  await expect(page.getByRole('heading', { name: 'Guild Council', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Closed-loop Credits' })).toHaveCount(0);

  await page
    .getByLabel('Search the catalog')
    .fill('guild-led energy-scarce floating city with a council and closed-loop credits');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Semantic ranking unavailable.')).toBeVisible();
  await expect(page.locator('.primitive-card h2')).toHaveText(['Guild Council']);

  await page.getByLabel('Kind').selectOption('');
  await page.getByLabel('Tag', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.primitive-card h2')).toHaveText([
    'Guild Council',
    'Closed-loop Credits',
    'Energy',
    'Floating Mixed-use District',
    'Low-poly Floating City',
  ]);
  await expect(page.getByText(/Rank 1 · score/u)).toBeVisible();
  await expect(page).toHaveTitle('WorldGraph — Anvil');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('shows an exact version and renders documentation without active HTML, links, or assets', async ({
  page,
}) => {
  await mockRegistry(page);
  await page.goto(`/primitives/${council.key}/versions/1.0.0`);
  await expect(page.getByRole('heading', { name: 'Guild Council', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Documentation' })).toBeVisible();
  await expect(page.getByText('Resolved exact version:')).toBeVisible();
  await expect(
    page
      .locator('.definition-section')
      .filter({ has: page.getByRole('heading', { name: 'Integrity and provenance' }) })
      .locator('code'),
  ).toHaveText(hash);
  await expect(
    page.locator('.safe-markdown a, .safe-markdown img, .safe-markdown script'),
  ).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('shows sanitized index diagnostics and deprecation metadata for an exact version', async ({
  page,
}) => {
  await mockRegistry(page);
  await page.goto(`/primitives/${deprecatedCouncil.key}/versions/${deprecatedCouncil.version}`);
  await expect(page.getByRole('heading', { name: 'Legacy Council', exact: true })).toBeVisible();
  await expect(page.getByText('Index issue: PROVIDER_TIMEOUT')).toBeVisible();
  await expect(page.getByText('Deprecation reason')).toBeVisible();
  await expect(page.getByText('Superseded by the reviewed guild council.')).toBeVisible();
  await expect(
    page
      .locator('.integrity-list div')
      .filter({ has: page.getByText('Deprecated at', { exact: true }) }),
  ).toContainText(now);
});

test('offers a focused retry and useful empty state after a transient catalog failure', async ({
  page,
}) => {
  await mockRegistry(page, { failNextList: true, forceEmpty: true });
  await page.goto('/primitives');
  const alert = page.locator('.error-summary');
  await expect(alert).toContainText('RETRIEVAL_UNAVAILABLE');
  await expect(alert).toBeFocused();
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByRole('heading', { name: 'No matching primitives' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse all primitives' })).toBeVisible();
});

test('treats no compatible retrieval candidates as an empty result instead of an outage', async ({
  page,
}) => {
  await mockRegistry(page, { noCompatible: true });
  await page.goto('/primitives?q=no-compatible-candidate');
  await expect(page.getByRole('heading', { name: 'No matching primitives' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Catalog unavailable' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Browse all primitives' })).toBeVisible();
});

test('provides a deterministic first-page control from the final cursor page', async ({ page }) => {
  await mockRegistry(page);
  await page.goto('/primitives');
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/cursor=opaque-next-cursor/u);
  await expect(page.getByRole('heading', { name: 'Floating Mixed-use District' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
  await page.getByRole('link', { name: 'First page' }).click();
  await expect(page).not.toHaveURL(/cursor=/u);
  await expect(page.getByRole('heading', { name: 'Guild Council', exact: true })).toBeVisible();
});

test('does not allow a late catalog response to replace a newer search', async ({ page }) => {
  await mockRegistry(page, { slowRetrievalDelayMs: 400 });
  await page.goto('/primitives');

  const slowRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/v1/primitive-retrievals') &&
      request.postData()?.includes('slow council') === true,
  );
  await page.getByLabel('Search the catalog').fill('slow council');
  await page.getByRole('button', { name: 'Apply' }).click();
  await slowRequest;

  await page.getByLabel('Search the catalog').fill('fast credits');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('heading', { name: 'Closed-loop Credits' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByRole('heading', { name: 'Closed-loop Credits' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Guild Council', exact: true })).toHaveCount(0);
});

test('denies registry administration to a normal user without requesting drafts', async ({
  page,
}) => {
  const state = await mockRegistry(page, { platformRole: 'user' });
  await page.goto('/admin/primitives');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(state.draftListRequests).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('keeps all administration controls hidden until authorization is positively established', async ({
  page,
}) => {
  await mockRegistry(page, { authDelayMs: 350, platformRole: 'platform_admin' });
  await page.goto('/admin/primitives');
  await expect(page.getByLabel('Checking registry authorization')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New draft' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Create primitive draft' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Primitive administration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New draft' })).toBeVisible();
});

test('loads deprecated versions across cursors and exposes their diagnostics to administrators', async ({
  page,
}) => {
  await mockRegistry(page, { platformRole: 'platform_admin' });
  await page.goto('/admin/primitives');
  const legacyVersion = page.getByRole('button', { name: /Legacy Council/u });
  await expect(legacyVersion).toBeVisible();
  await legacyVersion.click();
  await expect(page.getByRole('heading', { name: 'Legacy Council', exact: true })).toBeVisible();
  await expect(page.getByText('Index issue: PROVIDER_TIMEOUT')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Deprecated exact version' })).toBeVisible();
  await expect(page.getByText('Superseded by the reviewed guild council.')).toBeVisible();
  await expect(page.getByText(`Deprecated at ${now}`)).toBeVisible();
});

test('corrects, publishes, retries reindex idempotently, then deprecates and reindexes freshly', async ({
  page,
}) => {
  const state = await mockRegistry(page, {
    failNextReindex: true,
    platformRole: 'platform_admin',
  });
  await page.goto('/admin/primitives');
  await page.getByLabel('Stable key').fill('worldgraph.government.harbor-council');
  await page.getByLabel('Display name').fill('Harbor Council');
  await page.getByLabel('Tags').fill('city-state, council');
  await page
    .getByLabel('Documentation (safe Markdown)')
    .fill('## Harbor Council\n\nA draft council.');
  await page.getByRole('button', { name: 'Add dependency' }).click();
  await page.getByLabel('Dependency key').fill('worldgraph.missing.nope');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText('Draft created.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Draft validation passed' })).toBeVisible();
  await expect(page.getByText(hash)).toBeVisible();

  await page.getByRole('button', { name: 'Review and publish…' }).click();
  const firstPublish = page.getByRole('dialog');
  await expect(firstPublish).toHaveAccessibleName(/Publish .*@1\.0\.0/u);
  const immutableConfirmation = firstPublish.getByLabel(
    'I understand this exact version becomes immutable.',
  );
  await expect(immutableConfirmation).toBeFocused();
  await immutableConfirmation.check();
  await firstPublish.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Review and publish…' }).click();
  await expect(immutableConfirmation).not.toBeChecked();
  await immutableConfirmation.check();
  await firstPublish.getByRole('button', { name: 'Publish immutable version' }).click();
  await expect(page.locator('.error-summary')).toContainText('DEPENDENCY_NOT_FOUND');
  const dependencyIssue = page.getByRole('link', { name: /\/draft\/dependencies\/0\/key/u });
  await dependencyIssue.click();
  await expect(page.getByLabel('Dependency key')).toBeFocused();

  await page.getByLabel('Dependency key').fill(council.key);
  await page.getByRole('button', { name: 'Correct draft' }).click();
  await expect(page.getByText('Draft corrected.')).toBeVisible();
  await page.getByRole('button', { name: 'Review and publish…' }).click();
  const secondPublish = page.getByRole('dialog');
  await secondPublish.getByLabel('I understand this exact version becomes immutable.').check();
  await secondPublish.getByRole('button', { name: 'Publish immutable version' }).click();
  await expect(
    page.getByText('Version published. Its semantic definition is now immutable.'),
  ).toBeVisible();
  await expect(page.getByText('Semantic definition locked.')).toBeVisible();
  await expect(page.getByLabel('Stable key')).toBeDisabled();

  await page.getByRole('button', { name: 'Request reindex' }).click();
  await expect(page.locator('.error-summary')).toContainText('REINDEX_UNAVAILABLE');
  await page.getByRole('button', { name: 'Request reindex' }).click();
  await expect(page.getByText(/Repeating this command is safe and idempotent/u)).toBeVisible();
  await page.getByRole('button', { name: 'Request reindex' }).click();
  await expect.poll(() => state.reindexIdempotencyKeys.length).toBe(3);

  await page
    .getByLabel('Deprecation reason')
    .fill('Superseded by the next reviewed Harbor Council version.');
  await page.getByRole('button', { name: 'Deprecate exact version' }).click();
  await expect(page.getByRole('heading', { name: 'Deprecated exact version' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Harbor Council/u }).click();
  await expect(page.getByRole('heading', { name: 'Deprecated exact version' })).toBeVisible();
  await page.getByRole('button', { name: 'Request reindex' }).click();
  await expect.poll(() => state.reindexIdempotencyKeys.length).toBe(4);

  expect(state.publishIdempotencyKeys).toHaveLength(2);
  expect(state.publishIdempotencyKeys[1]).not.toBe('');
  expect(state.reindexIdempotencyKeys).toHaveLength(4);
  expect(state.reindexIdempotencyKeys[0]).toBe(state.reindexIdempotencyKeys[1]);
  expect(state.reindexIdempotencyKeys[2]).not.toBe(state.reindexIdempotencyKeys[1]);
  expect(state.reindexIdempotencyKeys[3]).not.toBe(state.reindexIdempotencyKeys[2]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('keeps catalog controls keyboard-reachable and usable at 320 CSS pixels', async ({ page }) => {
  await mockRegistry(page);
  await page.setViewportSize({ height: 720, width: 320 });
  await page.goto('/primitives');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
