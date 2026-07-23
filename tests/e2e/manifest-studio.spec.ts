import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import {
  ApproveManifestRevisionResponseSchema,
  AuthenticatedSessionSchema,
  GetManifestRevisionResponseSchema,
  ManifestGenerationRunViewSchema,
  PrimitiveListResponseSchema,
  ManifestRevisionDiffViewSchema,
  ManifestRevisionListResponseSchema,
  StartManifestGenerationResponseSchema,
  StartWorldCompilationResponseSchema,
  WorldCompilationRunViewSchema,
  WorldSchema,
  createValidator,
  type GetManifestRevisionResponse,
  type CompilerDiagnosticV1,
  type ManifestDiagnostic,
  type ManifestGenerationRunView,
  type ManifestRevisionSummary,
  type ManifestValidationReportView,
  type WorldCompilationRunView,
  type WorldCompilationStage,
  type World,
  type WorldManifestV1,
} from '../../packages/contracts/src/index.js';
import {
  createDeterministicFallback,
  projectSafeYaml,
  starterManifestCatalog,
} from '../../packages/manifests/src/index.js';

const userId = '018f8652-3cb6-7d52-904b-cce7901d7e51';
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e52';
const approvedRevisionId = '018f8652-3cb6-7d52-904b-cce7901d7e53';
const draftRevisionId = '018f8652-3cb6-7d52-904b-cce7901d7e54';
const reportId = '018f8652-3cb6-7d52-904b-cce7901d7e55';
const runId = '018f8652-3cb6-7d52-904b-cce7901d7e56';
const compilationRunId = '018f8652-3cb6-7d52-904b-cce7901d7e59';
const activeWorldVersionId = '018f8652-3cb6-7d52-904b-cce7901d7e60';
const now = '2026-07-21T12:00:00.000Z';
const approvedHash = 'a'.repeat(64);
const draftHash = 'b'.repeat(64);
const reportHash = 'c'.repeat(64);
const diffCursor = 'cursorToken123456.signatureToken123456';
const prompt =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';

const fallback = createDeterministicFallback({
  catalog: starterManifestCatalog(),
  prompt,
  providerConfigurationId: 'disabled-v1',
  seed: 'manifest-studio-e2e',
});
const approvedManifest = fallback.envelope.manifest;
const draftManifest: WorldManifestV1 = {
  ...approvedManifest,
  metadata: {
    ...approvedManifest.metadata,
    description: `${approvedManifest.metadata.description} The energy guild now publishes a daily ration ledger.`,
  },
};
const pinnedPrimitive = draftManifest.primitiveRefs[0]!;
const alternatePrimitiveId = '018f8652-3cb6-7d52-904b-cce7901d7e58';
const primitiveCandidates = [
  {
    contentHash: pinnedPrimitive.contentHash,
    createdAt: now,
    displayName: `Current ${pinnedPrimitive.kind.replaceAll('_', ' ')}`,
    id: pinnedPrimitive.primitiveVersionId,
    indexErrorCode: null,
    indexState: 'completed',
    key: pinnedPrimitive.key,
    kind: pinnedPrimitive.kind,
    lifecycle: 'published',
    publishedAt: now,
    rowVersion: 1,
    tags: ['city-state'],
    updatedAt: now,
    version: pinnedPrimitive.version,
  },
  {
    contentHash: 'd'.repeat(64),
    createdAt: now,
    displayName: `Alternate ${pinnedPrimitive.kind.replaceAll('_', ' ')}`,
    id: alternatePrimitiveId,
    indexErrorCode: null,
    indexState: 'completed',
    key: `worldgraph.alternative.${pinnedPrimitive.kind.replaceAll('_', '-')}`,
    kind: pinnedPrimitive.kind,
    lifecycle: 'published',
    publishedAt: now,
    rowVersion: 1,
    tags: ['city-state'],
    updatedAt: now,
    version: '2.0.0',
  },
];

const session = {
  session: {
    absoluteExpiresAt: '2026-08-21T12:00:00.000Z',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e57',
    idleExpiresAt: '2026-07-28T12:00:00.000Z',
  },
  user: {
    displayName: 'Alice Creator',
    email: 'alice@example.test',
    id: userId,
    platformRole: 'user',
    rowVersion: 1,
    status: 'active',
  },
};

const warning: ManifestDiagnostic = {
  code: 'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
  fixes: [],
  location: null,
  message: 'Governance and scarcity rules require explicit creator review.',
  pointer: '/assumptions',
  relatedPointers: ['/simulation/rulePrimitiveRefs'],
  severity: 'warning',
};

const report: ManifestValidationReportView = {
  catalogSnapshotHash: fallback.catalogSnapshotHash,
  createdAt: now,
  diagnostics: [warning],
  id: reportId,
  manifestRevisionId: draftRevisionId,
  reportHash,
  valid: true,
  validatorVersion: 1,
};

const validators = {
  approval: createValidator(ApproveManifestRevisionResponseSchema),
  detail: createValidator(GetManifestRevisionResponseSchema),
  diff: createValidator(ManifestRevisionDiffViewSchema),
  list: createValidator(ManifestRevisionListResponseSchema),
  primitiveList: createValidator(PrimitiveListResponseSchema),
  run: createValidator(ManifestGenerationRunViewSchema),
  session: createValidator(AuthenticatedSessionSchema),
  start: createValidator(StartManifestGenerationResponseSchema),
  startCompilation: createValidator(StartWorldCompilationResponseSchema),
  compilationRun: createValidator(WorldCompilationRunViewSchema),
  world: createValidator(WorldSchema),
};

type ContractValidator = ReturnType<typeof createValidator>;

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

interface ManifestMockState {
  approved: boolean;
  approvalPayload: Record<string, unknown> | null;
  cancelPayload: Record<string, unknown> | null;
  cancelled: boolean;
  compilationPayload: Record<string, unknown> | null;
  compilationDiagnostics: CompilerDiagnosticV1[];
  compilationStage: WorldCompilationStage | null;
  generated: boolean;
  generationPayload: Record<string, unknown> | null;
  runReads: number;
}

function revisionSummary(
  id: string,
  revisionNumber: number,
  contentHash: string,
  approvalStatus: ManifestRevisionSummary['approvalStatus'],
): ManifestRevisionSummary {
  return {
    approvalStatus,
    approvedAt: approvalStatus === 'approved' ? now : null,
    approvedBy: approvalStatus === 'approved' ? userId : null,
    contentHash,
    createdAt: now,
    createdBy: userId,
    generationRunId: id === draftRevisionId ? runId : null,
    id,
    manifestSchemaVersion: 1,
    parentRevisionId: id === draftRevisionId ? approvedRevisionId : null,
    revisionNumber,
    rowVersion: approvalStatus === 'approved' ? 2 : 1,
    source: id === draftRevisionId ? 'generation' : 'manual',
    worldId,
  };
}

function world(state: ManifestMockState): World {
  const active = state.compilationStage === 'activated';
  const compileFailed = state.compilationStage === 'failed';
  const compiling =
    state.compilationStage !== null &&
    !['activated', 'cancelled', 'failed'].includes(state.compilationStage);
  return {
    activeWorldVersionId: active ? activeWorldVersionId : null,
    createdAt: now,
    currentApprovedManifestRevisionId: state.approved ? draftRevisionId : approvedRevisionId,
    id: worldId,
    lifecycle: active
      ? 'active'
      : compiling
        ? 'compiling'
        : compileFailed
          ? 'compile_failed'
          : 'manifest_approved',
    manifestSchemaVersion: 1,
    name: 'Floating Guild City',
    role: 'creator',
    rowVersion: state.approved ? 2 : 1,
    slug: 'floating-guild-city',
    updatedAt: now,
  };
}

function compilationRun(
  stage: WorldCompilationStage,
  diagnostics: CompilerDiagnosticV1[] = [],
): WorldCompilationRunView {
  const terminal = ['activated', 'cancelled', 'failed'].includes(stage);
  const status =
    stage === 'activated'
      ? 'succeeded'
      : stage === 'cancelled'
        ? 'cancelled'
        : stage === 'failed'
          ? 'failed'
          : stage === 'queued'
            ? 'queued'
            : 'running';
  const progress = {
    activated: 100,
    cancelled: 0,
    compiling: 55,
    failed: 55,
    queued: 0,
    seeding: 85,
    validating: 25,
  }[stage];
  return {
    artifactHash: stage === 'activated' ? 'e'.repeat(64) : null,
    completedAt: terminal ? now : null,
    compilerConfigVersion: 1,
    compilerVersion: '1.0.0',
    diagnostics,
    id: compilationRunId,
    inputHash: 'f'.repeat(64),
    manifestRevisionId: approvedRevisionId,
    progressPercent: progress,
    queuedAt: now,
    requestedByUserId: userId,
    rowVersion: progress + 1,
    seed: approvedManifest.seed,
    stage,
    startedAt: stage === 'queued' ? null : now,
    status,
    worldId,
  };
}

function detail(revisionId: string, state: ManifestMockState): GetManifestRevisionResponse {
  const isDraft = revisionId === draftRevisionId;
  const manifest = isDraft ? draftManifest : approvedManifest;
  const summary = isDraft
    ? revisionSummary(draftRevisionId, 2, draftHash, state.approved ? 'approved' : 'draft')
    : revisionSummary(approvedRevisionId, 1, approvedHash, 'approved');
  return {
    provenance: {
      entries: fallback.envelope.provenance,
      manifestRevisionId: revisionId,
    },
    report: isDraft ? report : null,
    revision: { ...summary, manifest },
    yaml: projectSafeYaml(manifest),
  };
}

function generationRun(status: 'cancelled' | 'queued' | 'succeeded'): ManifestGenerationRunView {
  const complete = status === 'succeeded';
  const cancelled = status === 'cancelled';
  return {
    attempts: complete ? 1 : 0,
    catalogSnapshotHash: complete ? fallback.catalogSnapshotHash : null,
    completedAt: complete || cancelled ? now : null,
    costEstimateMicrounits: complete ? 0 : null,
    errorCode: null,
    generatorSchemaVersion: 1,
    id: runId,
    inputHash: fallback.requestHash,
    inputTokenCount: complete ? 0 : null,
    model: null,
    outcome: complete
      ? {
          assumptions: fallback.envelope.assumptions,
          mode: 'fallback',
          suggestedFixes: fallback.envelope.suggestedFixes,
          unresolvedQuestions: fallback.envelope.unresolvedQuestions,
          warnings: fallback.envelope.warnings,
        }
      : null,
    outputRevisionId: complete ? draftRevisionId : null,
    outputTokenCount: complete ? 0 : null,
    progressPercent: complete ? 100 : 0,
    promptTemplateVersion: 1,
    provider: 'disabled',
    providerCallCount: 0,
    queuedAt: now,
    repairAttempts: 0,
    resolvedInputHash: complete ? fallback.resolvedInputHash : null,
    rowVersion: complete || cancelled ? 2 : 1,
    stage: complete ? 'complete' : 'queued',
    startedAt: complete ? now : null,
    status,
    worldId,
  };
}

async function mockManifestStudio(
  page: Page,
  options: { recoverCompletedRun?: boolean; stayQueued?: boolean } = {},
): Promise<ManifestMockState> {
  const state: ManifestMockState = {
    approved: false,
    approvalPayload: null,
    cancelPayload: null,
    cancelled: false,
    compilationPayload: null,
    compilationDiagnostics: [],
    compilationStage: null,
    generated: false,
    generationPayload: null,
    runReads: options.recoverCompletedRun ? 1 : 0,
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path.endsWith('/auth/me')) return checkedJson(route, validators.session, session);
    if (path.endsWith('/auth/csrf')) return json(route, { csrfToken: 'c'.repeat(43) });
    if (path === '/api/v1/primitives' && method === 'GET') {
      return checkedJson(route, validators.primitiveList, {
        items: primitiveCandidates,
        nextCursor: null,
      });
    }
    if (path === `/api/v1/worlds/${worldId}`) {
      const currentWorld = world(state);
      expect(validators.world.issues(currentWorld)).toEqual([]);
      return json(route, { world: currentWorld });
    }
    if (path === `/api/v1/worlds/${worldId}/compilations` && method === 'POST') {
      state.compilationPayload = request.postDataJSON() as Record<string, unknown>;
      state.compilationStage = 'queued';
      return checkedJson(
        route,
        validators.startCompilation,
        { rowVersion: 1, runId: compilationRunId, stage: 'queued', status: 'queued' },
        202,
      );
    }
    if (path === `/api/v1/worlds/${worldId}/compilations/${compilationRunId}`) {
      return checkedJson(
        route,
        validators.compilationRun,
        compilationRun(state.compilationStage ?? 'queued', state.compilationDiagnostics),
      );
    }
    if (path === `/api/v1/worlds/${worldId}/manifest-generations` && method === 'POST') {
      state.generationPayload = request.postDataJSON() as Record<string, unknown>;
      return checkedJson(route, validators.start, { rowVersion: 1, runId, status: 'queued' }, 202);
    }
    if (path === `/api/v1/manifest-generations/${runId}` && method === 'GET') {
      if (state.cancelled) {
        return checkedJson(route, validators.run, generationRun('cancelled'));
      }
      state.runReads += 1;
      const complete = !options.stayQueued && state.runReads >= 2;
      if (complete) state.generated = true;
      return checkedJson(route, validators.run, generationRun(complete ? 'succeeded' : 'queued'));
    }
    if (path === `/api/v1/manifest-generations/${runId}/cancel` && method === 'POST') {
      state.cancelPayload = request.postDataJSON() as Record<string, unknown>;
      state.cancelled = true;
      return checkedJson(route, validators.run, generationRun('cancelled'));
    }
    if (path === `/api/v1/worlds/${worldId}/manifest-revisions` && method === 'GET') {
      const items = state.generated
        ? [
            revisionSummary(draftRevisionId, 2, draftHash, state.approved ? 'approved' : 'draft'),
            revisionSummary(approvedRevisionId, 1, approvedHash, 'approved'),
          ]
        : [revisionSummary(approvedRevisionId, 1, approvedHash, 'approved')];
      return checkedJson(route, validators.list, { items, nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/manifest-revisions/diff` && method === 'GET') {
      expect(url.searchParams.get('limit')).toBe('100');
      const continuing = url.searchParams.get('cursor') === diffCursor;
      return checkedJson(route, validators.diff, {
        counts: { added: 0, changed: 2, removed: 0 },
        entries: continuing
          ? [
              {
                after: 'manifest-studio-e2e-v2',
                before: approvedManifest.seed,
                kind: 'changed',
                pointer: '/seed',
              },
            ]
          : [
              {
                after: draftManifest.metadata.description,
                before: approvedManifest.metadata.description,
                kind: 'changed',
                pointer: '/metadata/description',
              },
            ],
        fromContentHash: approvedHash,
        fromRevisionId: approvedRevisionId,
        nextCursor: continuing ? null : diffCursor,
        toContentHash: draftHash,
        toRevisionId: draftRevisionId,
      });
    }
    if (
      path === `/api/v1/worlds/${worldId}/manifest-revisions/${draftRevisionId}/validate` &&
      method === 'POST'
    ) {
      return json(route, { report });
    }
    if (
      path === `/api/v1/worlds/${worldId}/manifest-revisions/${draftRevisionId}/approve` &&
      method === 'POST'
    ) {
      state.approvalPayload = request.postDataJSON() as Record<string, unknown>;
      state.approved = true;
      return checkedJson(route, validators.approval, {
        contentHash: draftHash,
        manifestSchemaVersion: 1,
        revisionId: draftRevisionId,
        worldId,
        worldRowVersion: 2,
      });
    }
    const detailMatch = path.match(
      new RegExp(`^/api/v1/worlds/${worldId}/manifest-revisions/([^/]+)$`, 'u'),
    );
    if (detailMatch?.[1] && method === 'GET') {
      return checkedJson(route, validators.detail, detail(detailMatch[1], state));
    }
    return json(
      route,
      { error: { code: 'NOT_FOUND', message: `No mock for ${method} ${path}` } },
      404,
    );
  });
  return state;
}

test('recovers the staged fallback workflow and requires exact creator approval', async ({
  page,
}) => {
  const state = await mockManifestStudio(page);
  await page.goto(`/worlds/${worldId}/manifest`);

  await expect(page.getByRole('heading', { name: 'Manifest Studio' })).toBeVisible();
  await expect(page.getByText('Manifest approved', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Draft/u }).click();
  await expect(page.getByText('This approved revision is read-only.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create editable child' })).toBeVisible();

  await page.getByRole('tab', { name: /Describe/u }).click();
  await page.getByRole('button', { name: 'Regenerate draft' }).click();
  await expect(page.locator('.studio-live-status')).toHaveText(
    'Draft ready using the deterministic fallback.',
  );
  await expect(page.getByRole('tab', { name: /Draft/u })).toHaveAttribute('aria-selected', 'true');
  expect(state.generationPayload).toEqual({
    expectedParentContentHash: approvedHash,
    parentRevisionId: approvedRevisionId,
    prompt,
  });
  await page.getByText(/Exact primitive selections/u).click();
  await page.getByRole('button', { name: 'Change exact version…' }).first().click();
  const picker = page.getByLabel('Published replacement');
  await expect(picker).toBeFocused();
  await picker.selectOption(alternatePrimitiveId);
  await expect(
    page.getByRole('button', { name: 'Create child with this exact pin' }),
  ).toBeEnabled();
  await expect(page.getByRole('link', { name: /Inspect worldgraph\.alternative/u })).toBeVisible();
  await page.getByRole('button', { name: 'Close picker' }).click();

  await page.getByRole('tab', { name: /Validate/u }).click();
  await page.getByRole('button', { name: 'Validate again' }).click();
  await expect(
    page.getByText('Validation passed. Review every warning before approval.'),
  ).toBeVisible();
  await expect(page.getByText('HIGH_IMPACT_RULES_REQUIRE_REVIEW', { exact: true })).toBeVisible();
  const focusInEditor = page.getByRole('button', { name: 'Focus in editor' });
  await focusInEditor.focus();
  await focusInEditor.press('Enter');
  await expect(page.getByLabel('Safe YAML')).toBeFocused();

  await page.getByRole('tab', { name: /Review/u }).click();
  await expect(page.getByText('FALLBACK_TEMPLATE_USED', { exact: true })).toBeVisible();
  await expect(page.getByText(/Field provenance/u)).toBeVisible();
  const compare = page.getByRole('button', { name: 'Compare' });
  await compare.focus();
  await compare.press('Enter');
  await expect(page.locator('.diff-results strong')).toHaveText('metadata › description');
  await expect(page.locator('.diff-counts')).toContainText('~2 changed');
  const loadMoreChanges = page.getByRole('button', { name: 'Load more changes' });
  await loadMoreChanges.focus();
  await loadMoreChanges.press('Enter');
  await expect(page.locator('.diff-results strong')).toHaveText(['metadata › description', 'seed']);

  await page.getByRole('tab', { name: /Approve/u }).click();
  const approve = page.getByRole('button', { name: 'Approve exact revision' });
  await expect(approve).toBeDisabled();
  await page.getByLabel(/HIGH_IMPACT_RULES_REQUIRE_REVIEW/u).check();
  await page.getByLabel(/Type Floating Guild City to confirm/u).fill('Floating Guild City');
  await expect(approve).toBeEnabled();
  const approvalResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/${draftRevisionId}/approve`),
  );
  await approve.focus();
  await approve.press('Enter');
  await approvalResponse;

  expect(state.approvalPayload).toEqual({
    acknowledgedWarningCodes: ['HIGH_IMPACT_RULES_REQUIRE_REVIEW'],
    confirmationName: 'Floating Guild City',
    expectedContentHash: draftHash,
    expectedWorldVersion: 1,
  });
  await expect(page.getByRole('heading', { name: 'Approved manifest' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create child revision' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(JSON.stringify(browserStorage)).not.toContain(prompt);
});

test('recovers a durable completed generation from the run URL', async ({ page }) => {
  const state = await mockManifestStudio(page, { recoverCompletedRun: true });
  await page.goto(`/worlds/${worldId}/manifest?run=${runId}`);

  await expect(page.locator('.studio-live-status')).toHaveText(
    'Draft ready using the deterministic fallback.',
  );
  await expect(page.getByRole('tab', { name: /Draft/u })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /Revision 2/u })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(state.generationPayload).toBeNull();
  await expect(page).toHaveURL(new RegExp(`run=${runId}$`, 'u'));
});

test('cancels a queued durable generation with its current row version', async ({ page }) => {
  const state = await mockManifestStudio(page, { stayQueued: true });
  await page.goto(`/worlds/${worldId}/manifest`);
  await page.getByRole('button', { name: 'Regenerate draft' }).click();
  const cancel = page.getByRole('button', { name: 'Cancel generation' });
  await expect(cancel).toBeVisible();
  await cancel.click();

  await expect(page.locator('.studio-live-status')).toHaveText(
    'Generation cancelled. No draft was published.',
  );
  expect(state.cancelPayload).toEqual({ expectedRowVersion: 1 });
  await expect(cancel).toBeHidden();
});

test('confirms exact compile input and recovers every durable activation stage after refresh', async ({
  page,
}) => {
  const state = await mockManifestStudio(page);
  await page.goto(`/worlds/${worldId}/manifest`);
  await page.getByRole('tab', { name: /Approve/u }).click();

  await expect(page.getByRole('heading', { name: 'Compile world' })).toBeVisible();
  const compile = page.getByRole('button', { name: 'Compile exact approved manifest' });
  await expect(compile).toBeDisabled();
  await page.getByLabel(/Compile revision 1/u).check();
  await expect(compile).toBeEnabled();
  await compile.click();

  await expect(page).toHaveURL(new RegExp(`compilation=${compilationRunId}`, 'u'));
  expect(state.compilationPayload).toEqual({
    expectedManifestHash: approvedHash,
    manifestRevisionId: approvedRevisionId,
    seed: approvedManifest.seed,
  });
  await expect(
    page.getByText('Queued is in progress. This durable run survives refresh.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel before seeding' })).toBeVisible();

  state.compilationStage = 'validating';
  await page.reload();
  await expect(
    page.getByText('Validating is in progress. This durable run survives refresh.'),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Compilation stages' }).getByText('Validating'),
  ).toHaveAttribute('aria-current', 'step');

  state.compilationStage = 'compiling';
  await page.reload();
  await expect(
    page.getByText('Compiling is in progress. This durable run survives refresh.'),
  ).toBeVisible();

  state.compilationStage = 'seeding';
  await page.reload();
  await expect(
    page.getByText('Seeding is in progress. This durable run survives refresh.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel before seeding' })).toBeHidden();
  await expect(page.getByText(/cancellation is no longer safe/u)).toBeVisible();

  state.compilationStage = 'activated';
  await page.reload();
  await expect(page.getByText('World activated from the exact compiled artifact.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open World Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compile exact approved manifest' })).toBeHidden();
});

test('renders stable compiler diagnostics and distinguishes safe retry from required correction', async ({
  page,
}) => {
  const state = await mockManifestStudio(page);
  await page.goto(`/worlds/${worldId}/manifest`);
  await page.getByRole('tab', { name: /Approve/u }).click();
  await page.getByLabel(/Compile revision 1/u).check();
  await page.getByRole('button', { name: 'Compile exact approved manifest' }).click();
  await expect(page).toHaveURL(new RegExp(`compilation=${compilationRunId}`, 'u'));

  const diagnostic: CompilerDiagnosticV1 = {
    code: 'DANGLING_RELATIONSHIP_TARGET',
    message: 'A relationship target does not resolve to an emitted logical entity.',
    pointer: '/relationships/0/target',
    relatedKeys: ['district:missing'],
    retryable: false,
    severity: 'error',
    stage: 'link',
  };
  state.compilationDiagnostics = [diagnostic];
  state.compilationStage = 'failed';
  await page.reload();

  await expect(page.getByText('DANGLING_RELATIONSHIP_TARGET', { exact: true })).toBeVisible();
  await expect(page.getByText('/relationships/0/target', { exact: true })).toBeVisible();
  await expect(page.getByText('manifest change required', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry unchanged input' })).toBeHidden();
  await expect(page.getByText(/Create and approve a corrected manifest revision/u)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download JSON' })).toHaveAttribute(
    'href',
    `/api/v1/worlds/${worldId}/compilations/${compilationRunId}/diagnostics`,
  );

  state.compilationDiagnostics = [{ ...diagnostic, retryable: true }];
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry unchanged input' })).toBeVisible();
});
