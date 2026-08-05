const VISIBLE_TIMEOUT_MS = 20_000;

function cookiesFromHeader(header, url) {
  if (!header) return [];
  return header.split('; ').map((pair) => {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw new Error('The Compose governance cookie header was malformed.');
    return { name: pair.slice(0, separator), url, value: pair.slice(separator + 1) };
  });
}

async function openPage(page, url, label) {
  let response;
  try {
    response = await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
  } catch (error) {
    throw new Error(`The live governance browser demo could not open ${label}.`, { cause: error });
  }
  if (!response?.ok()) {
    throw new Error(
      `The live governance browser demo opened ${label} with HTTP ${response?.status() ?? 'unknown'}.`,
    );
  }
}

async function visible(locator, label) {
  try {
    await locator.waitFor({ state: 'visible', timeout: VISIBLE_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`The live governance browser demo could not see ${label}.`, { cause: error });
  }
}

async function assertAccessible(page, AxeBuilder, label) {
  const result = await new AxeBuilder({ page }).analyze();
  if (result.violations.length > 0) {
    throw new Error(
      `${label} had accessibility violations: ${result.violations
        .map((violation) => violation.id)
        .join(', ')}.`,
    );
  }
}

async function assertNoViewportOverflow(page, label) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  if (!fits) throw new Error(`${label} overflowed its mobile viewport.`);
}

function contestCard(page, heading) {
  return page
    .locator('article.govern-contest-card')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
    .first();
}

/**
 * Reviews real tax/project/election state in separate creator and observer browser sessions, then
 * executes a reasoned emergency repeal through the UI's frozen-command and reauthentication flow.
 */
export async function runLiveGovernanceBrowserDemo(input) {
  const [{ chromium }, { default: AxeBuilder }] = await Promise.all([
    import('@playwright/test'),
    import('@axe-core/playwright'),
  ]);
  const browser = await chromium.launch({ headless: true });
  const creatorContext = await browser.newContext({ viewport: { height: 900, width: 1440 } });
  const observerContext = await browser.newContext({ viewport: { height: 844, width: 375 } });
  try {
    await Promise.all([
      creatorContext.addCookies(cookiesFromHeader(input.creatorCookieHeader, input.baseUrl)),
      observerContext.addCookies(cookiesFromHeader(input.observerCookieHeader, input.baseUrl)),
    ]);
    const creatorPage = await creatorContext.newPage();
    const observerPage = await observerContext.newPage();

    await Promise.all([
      openPage(
        creatorPage,
        `${input.baseUrl}/worlds/${input.worldId}/govern/proposals`,
        'the creator proposal workspace',
      ),
      openPage(
        observerPage,
        `${input.baseUrl}/worlds/${input.worldId}/govern/proposals`,
        'the observer proposal workspace',
      ),
    ]);
    await Promise.all([
      visible(
        creatorPage.getByRole('heading', { level: 1, name: 'Proposals and ballots' }),
        'the creator proposal heading',
      ),
      visible(
        observerPage.getByRole('heading', { level: 1, name: 'Proposals and ballots' }),
        'the observer proposal heading',
      ),
    ]);

    const taxCard = contestCard(creatorPage, input.taxProposalTitle);
    const projectCard = contestCard(creatorPage, input.projectProposalTitle);
    await Promise.all([
      visible(taxCard, 'the enacted tax proposal'),
      visible(projectCard, 'the enacted public-project proposal'),
    ]);
    await visible(taxCard.getByText('Enacted', { exact: true }), 'the enacted tax status');
    await visible(taxCard.getByText(/to 3\.33% at tick/u), 'the exact governed tax effect');
    await visible(projectCard.getByText('Enacted', { exact: true }), 'the enacted project status');
    await visible(
      projectCard.getByText(/district:civic-platform/u),
      'the exact governed project target',
    );
    await visible(projectCard.getByText(/20 minor units/u), 'the exact governed project amount');
    await visible(
      observerPage.getByText('Create proposal unavailable', { exact: true }),
      'the observer proposal denial',
    );
    if ((await observerPage.getByRole('button', { name: 'Create proposal' }).count()) !== 0) {
      throw new Error('The observer browser received a proposal-creation control.');
    }
    await Promise.all([
      assertAccessible(creatorPage, AxeBuilder, 'The live creator governance proposals'),
      assertAccessible(observerPage, AxeBuilder, 'The live observer governance proposals'),
    ]);
    await assertNoViewportOverflow(observerPage, 'The live observer governance proposals');

    await openPage(
      creatorPage,
      `${input.baseUrl}/worlds/${input.worldId}/govern`,
      'the creator charter and office workspace',
    );
    await visible(
      creatorPage.getByRole('heading', { level: 2, name: 'Offices and immutable terms' }),
      'the immutable office terms',
    );
    await visible(
      creatorPage.getByText(input.electedHolderEntityKey, { exact: false }).first(),
      'the certified elected officeholder',
    );

    await openPage(
      creatorPage,
      `${input.baseUrl}/worlds/${input.worldId}/govern/override`,
      'the isolated creator override workspace',
    );
    await visible(
      creatorPage.getByRole('heading', { level: 1, name: 'Operator actions' }),
      'the operator-actions heading',
    );
    const override = creatorPage
      .locator('form')
      .filter({ hasText: 'Explicit emergency law override' });
    await visible(override, 'the explicit emergency override form');
    await override
      .getByLabel('Operator reason')
      .fill('Emergency harbor access conflict requires a bounded repeal.');
    await override
      .getByLabel('Before/after impact')
      .fill('The safety law remains historical but stops granting authority at this exact tick.');
    await override.getByLabel('Law ID').fill(input.lawId);
    await override.getByLabel('Expected law version').fill(input.lawVersion);
    await override.getByLabel('Effective tick').fill(input.effectiveAtTick);
    await override
      .getByLabel('Legal repeal reason')
      .fill('Emergency access is restored through an explicit audited override.');
    await override
      .getByLabel('Type the exact confirmation')
      .fill('EXECUTE EXPLICIT GOVERNANCE OVERRIDE');
    await override.getByRole('button', { name: 'Review override' }).click();

    const review = creatorPage.getByRole('region', { name: 'Review creator override' });
    await visible(review, 'the frozen creator-override review');
    await visible(review.getByText(`Law ${input.lawId}`, { exact: true }), 'the frozen law target');
    await visible(
      review.getByText(`Law version ${input.lawVersion}`, { exact: true }),
      'the frozen law version',
    );
    await visible(
      review.getByText(input.effectiveAtTick, { exact: true }),
      'the frozen override tick',
    );
    await assertAccessible(creatorPage, AxeBuilder, 'The frozen live creator override review');

    const passwordForm = creatorPage
      .locator('form')
      .filter({ hasText: 'Password reauthentication' });
    await passwordForm.getByLabel('Current password').fill(input.password);
    const commandResponsePromise = creatorPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/worlds/${input.worldId}/commands`,
    );
    await passwordForm
      .getByRole('button', { name: 'Verify password and execute override' })
      .click();
    const commandResponse = await commandResponsePromise;
    const commandResult = await commandResponse.json();
    const command = commandResponse.request().postDataJSON();
    if (
      commandResponse.status() !== 200 ||
      commandResult?.status !== 'accepted' ||
      command?.type !== 'ExecuteCreatorOverrideV1' ||
      command?.payload?.effect?.proposalAction?.actionType !== 'repeal_law' ||
      command?.payload?.effect?.proposalAction?.lawId !== input.lawId ||
      command?.payload?.effect?.proposalAction?.effectiveAtTick !== input.effectiveAtTick ||
      JSON.stringify(command).includes(input.password)
    ) {
      throw new Error(
        `The live creator override was not the exact accepted command: ${JSON.stringify({ command, commandResult, status: commandResponse.status() })}.`,
      );
    }
    await visible(
      creatorPage.getByText(/Accepted at authoritative revision/u),
      'the committed creator-override receipt',
    );

    await Promise.all([
      openPage(
        observerPage,
        `${input.baseUrl}/worlds/${input.worldId}/govern/audit`,
        'the observer governance audit',
      ),
      openPage(
        creatorPage,
        `${input.baseUrl}/worlds/${input.worldId}/govern/laws`,
        'the post-override law history',
      ),
    ]);
    const auditRow = observerPage
      .getByRole('row')
      .filter({ hasText: 'Governance Override' })
      .filter({ hasText: 'Creator' })
      .first();
    await visible(auditRow, 'the creator-labeled immutable override audit row');
    await visible(
      auditRow.getByText(/Emergency harbor access conflict/u),
      'the durable override reason',
    );
    const lawRow = creatorPage.getByRole('row').filter({ hasText: input.lawTitle }).first();
    await visible(lawRow, 'the overridden law history row');
    await visible(
      lawRow.getByText('Repealed', { exact: true }),
      'the tick-derived repealed status',
    );
    await Promise.all([
      assertAccessible(observerPage, AxeBuilder, 'The live observer governance audit'),
      assertAccessible(creatorPage, AxeBuilder, 'The live post-override law history'),
    ]);
    await assertNoViewportOverflow(observerPage, 'The live observer governance audit');

    return { command, commandResult };
  } finally {
    await Promise.allSettled([creatorContext.close(), observerContext.close()]);
    await browser.close();
  }
}
