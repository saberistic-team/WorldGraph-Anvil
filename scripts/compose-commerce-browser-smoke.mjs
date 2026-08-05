const VISIBLE_TIMEOUT_MS = 20_000;

function cookiesFromHeader(header, url) {
  if (!header) return [];
  return header.split('; ').map((pair) => {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw new Error('The Compose browser cookie header was malformed.');
    return {
      name: pair.slice(0, separator),
      url,
      value: pair.slice(separator + 1),
    };
  });
}

async function openPage(page, url, label) {
  let response;
  try {
    response = await page.goto(url, {
      timeout: 30_000,
      waitUntil: 'domcontentloaded',
    });
  } catch (error) {
    throw new Error(`The live commerce browser demo could not open ${label}.`, { cause: error });
  }
  if (!response?.ok()) {
    throw new Error(
      `The live commerce browser demo opened ${label} with HTTP ${response?.status() ?? 'unknown'}.`,
    );
  }
}

async function visible(locator, label) {
  try {
    await locator.waitFor({ state: 'visible', timeout: VISIBLE_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`The live commerce browser demo could not see ${label}.`, { cause: error });
  }
}

async function attached(locator, label) {
  try {
    await locator.waitFor({ state: 'attached', timeout: VISIBLE_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`The live commerce browser demo could not load ${label}.`, { cause: error });
  }
}

async function assertCount(locator, expected, label) {
  const actual = await locator.count();
  if (actual !== expected) {
    throw new Error(
      `The live commerce browser demo found ${actual} ${label}; expected ${expected}.`,
    );
  }
}

async function assertContains(locator, expectedText, label) {
  const text = (await locator.textContent())?.replaceAll(/\s+/gu, ' ').trim() ?? '';
  if (!text.includes(expectedText.replaceAll(/\s+/gu, ' ').trim())) {
    throw new Error(
      `The live commerce browser demo did not find ${JSON.stringify(expectedText)} in ${label}: ${JSON.stringify(text)}.`,
    );
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

function recordWithHeading(page, heading) {
  return page
    .locator('article.commerce-record')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
    .first();
}

async function createBrowserSessions(input) {
  const [{ chromium }, { default: AxeBuilder }] = await Promise.all([
    import('@playwright/test'),
    import('@axe-core/playwright'),
  ]);
  const browser = await chromium.launch({ headless: true });
  let managerContext;
  let buyerContext;
  try {
    managerContext = await browser.newContext({ viewport: { height: 900, width: 1440 } });
    buyerContext = await browser.newContext({ viewport: { height: 844, width: 375 } });
    await Promise.all([
      managerContext.addCookies(cookiesFromHeader(input.managerCookieHeader, input.baseUrl)),
      buyerContext.addCookies(cookiesFromHeader(input.buyerCookieHeader, input.baseUrl)),
    ]);
    return {
      AxeBuilder,
      browser,
      buyerContext,
      buyerPage: await buyerContext.newPage(),
      managerContext,
      managerPage: await managerContext.newPage(),
    };
  } catch (error) {
    await Promise.allSettled([managerContext?.close(), buyerContext?.close()]);
    await browser.close();
    throw error;
  }
}

async function closeBrowserSessions(sessions) {
  await Promise.allSettled([sessions.managerContext.close(), sessions.buyerContext.close()]);
  await sessions.browser.close();
}

async function assertBusinessAndEmployment(page, input, perspective) {
  await visible(
    page.getByRole('heading', { level: 1, name: 'Business & jobs' }),
    `the ${perspective} business workspace`,
  );
  const seededBusiness = recordWithHeading(page, input.businessEntityKey);
  await visible(seededBusiness, `the ${perspective} seeded business`);
  await visible(
    seededBusiness.getByText(`${input.facilityCount} configured facility record(s)`, {
      exact: true,
    }),
    `the ${perspective} configured-facility count`,
  );
  await visible(
    seededBusiness.getByText(
      perspective === 'manager' ? 'You can manage this business.' : 'Read-only view.',
      { exact: true },
    ),
    `the ${perspective} business authority`,
  );

  const contract = recordWithHeading(page, input.contractRole);
  await visible(contract, `the ${perspective} employment contract`);
  await visible(
    contract.getByText(input.contractStatus, { exact: true }),
    `the ${perspective} terminal contract status`,
  );
  await visible(
    contract.getByText(perspective === 'manager' ? /manager view/u : /participant view/u),
    `the ${perspective} contract boundary`,
  );
  await visible(
    contract.getByText(`Compensation: ${input.jobGrossMinor} minor units`, { exact: true }),
    `the ${perspective} private compensation`,
  );

  const contractSection = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Your visible contracts & jobs', exact: true }),
  });
  const paidJob = contractSection
    .getByRole('listitem')
    .filter({ hasText: `${input.jobGrossMinor} gross minor units` })
    .first();
  await visible(paidJob, `the ${perspective} immutable job outcome`);
  await visible(
    paidJob.getByText(`Tick ${input.jobTick}`, { exact: true }),
    `the ${perspective} job tick`,
  );
  await visible(
    paidJob.getByText('paid (terminal)', { exact: true }),
    `the ${perspective} paid payroll`,
  );
}

async function assertProduction(page, input) {
  await visible(
    page.getByRole('heading', { level: 1, name: 'Production' }),
    'the manager production workspace',
  );
  const run = recordWithHeading(page, `Due tick ${input.productionTick}`);
  await visible(run, 'the deterministic production run');
  await visible(run.getByText('completed (terminal)', { exact: true }), 'the completed run status');
  await visible(
    run.getByText(`Run quantity: ${input.productionQuantity}`, { exact: true }),
    'the exact production quantity',
  );
  await visible(
    run.getByText(`${input.productionInputCount} reserved input(s) → 1 output(s)`, {
      exact: true,
    }),
    'the production input/output evidence',
  );
}

async function assertMarketEvidence(page, input) {
  await visible(
    page.getByRole('heading', { level: 1, name: 'Marketplace' }),
    'the buyer marketplace',
  );
  await visible(page.getByLabel('Virtual value boundary'), 'the no-real-money disclosure');

  const listing = recordWithHeading(page, input.resourceDisplayName);
  await visible(listing, 'the produced-resource listing');
  await visible(
    listing.getByText(`${input.quantityAfter} remaining`, { exact: true }),
    'the partially filled listing quantity',
  );

  const trades = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Immutable trade outcomes', exact: true }),
  });
  const trade = trades
    .getByRole('listitem')
    .filter({ hasText: `${input.purchaseQuantity} units at tick` })
    .first();
  await visible(trade, 'the immutable trade outcome');
  for (const expected of input.expectedTradeText) {
    await assertContains(trade, expected, 'the immutable trade outcome');
  }
}

/**
 * Runs the atomic purchase portion of the M09 Compose demo in two independent browser contexts.
 * The caller supplies already-authenticated manager and buyer sessions created by the real
 * registration/invitation flow. The returned command is replayed by the caller to prove that the
 * UI-generated idempotency identity has one effect.
 */
export async function runLiveCommerceBrowserDemo(input) {
  const sessions = await createBrowserSessions(input);
  const { AxeBuilder, buyerPage, managerPage } = sessions;

  try {
    await Promise.all([
      openPage(
        managerPage,
        `${input.baseUrl}/worlds/${input.worldId}/economy/production`,
        'the manager production workspace',
      ),
      openPage(
        buyerPage,
        `${input.baseUrl}/worlds/${input.worldId}/economy/market`,
        'the buyer marketplace',
      ),
    ]);

    await assertProduction(managerPage, input);
    await visible(
      buyerPage.getByRole('heading', { level: 1, name: 'Marketplace' }),
      'the buyer marketplace',
    );
    await visible(buyerPage.getByLabel('Virtual value boundary'), 'the no-real-money disclosure');
    await visible(
      buyerPage.getByText('Reconciliation pending', { exact: true }),
      'the zero-lag pending-verification state',
    );
    await visible(
      buyerPage.getByText('Projection data is current; reconciliation verification is pending.', {
        exact: true,
      }),
      'the zero-lag projection explanation',
    );

    const listing = recordWithHeading(buyerPage, input.resourceDisplayName);
    await visible(listing, 'the produced-resource listing');
    await visible(
      listing.getByText(`${input.quantityBefore} remaining`, { exact: true }),
      'the listing quantity',
    );
    await listing.getByRole('button', { name: 'Review purchase' }).click();
    await buyerPage.getByLabel(/^Exact quantity \(/u).fill(input.purchaseQuantity);
    await buyerPage.getByRole('button', { name: 'Preview exact total' }).click();
    await visible(
      buyerPage.getByRole('heading', { name: 'Server-authoritative itemization' }),
      'the server-authoritative itemization',
    );
    const itemization = buyerPage
      .getByRole('heading', { name: 'Server-authoritative itemization' })
      .locator('..');
    const itemizationText = (await itemization.textContent())?.replaceAll(/\s+/gu, '') ?? '';
    for (const expected of input.expectedItemizationText) {
      if (!itemizationText.includes(expected.replaceAll(/\s+/gu, ''))) {
        throw new Error(`The live purchase itemization omitted ${expected}.`);
      }
    }

    const wallet = buyerPage.getByLabel('Controlled buyer wallet');
    const matchingWallet = wallet.locator(`option[value="${input.buyerWalletId}"]`);
    await attached(matchingWallet, 'the funded buyer-wallet option');
    if ((await matchingWallet.count()) !== 1) {
      throw new Error('The buyer session did not expose the funded wallet selected by the demo.');
    }
    await wallet.selectOption(input.buyerWalletId);
    await buyerPage.getByLabel(/I reviewed the exact quantity/u).check();
    await assertAccessible(buyerPage, AxeBuilder, 'The live buyer itemized purchase confirmation');
    await assertNoViewportOverflow(buyerPage, 'The live buyer itemized purchase confirmation');

    const commandResponse = buyerPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/worlds/${input.worldId}/commands`,
    );
    await buyerPage.getByRole('button', { name: 'Purchase with one atomic settlement' }).click();
    const response = await commandResponse;
    const result = await response.json();
    const command = response.request().postDataJSON();
    const idempotencyKey = response.request().headers()['idempotency-key'];
    if (
      response.status() !== 200 ||
      result?.status !== 'accepted' ||
      command?.type !== 'PurchaseMarketListingV1' ||
      command?.payload?.listingId !== input.listingId ||
      command?.payload?.buyerWalletId !== input.buyerWalletId ||
      command?.payload?.quantity !== input.purchaseQuantity ||
      idempotencyKey !== command?.idempotencyKey
    ) {
      throw new Error(
        `The live browser purchase was not an exact accepted command: ${JSON.stringify({ command, result, status: response.status() })}.`,
      );
    }
    await visible(
      buyerPage.getByText(/Accepted at authoritative state revision/u),
      'the committed browser receipt',
    );
    await assertMarketEvidence(buyerPage, input);

    await Promise.all([
      assertAccessible(managerPage, AxeBuilder, 'The live manager production workspace'),
      assertAccessible(buyerPage, AxeBuilder, 'The live buyer marketplace'),
    ]);
    await assertNoViewportOverflow(buyerPage, 'The live buyer marketplace');

    return { command, idempotencyKey, result };
  } finally {
    await closeBrowserSessions(sessions);
  }
}

/**
 * Reviews the final, already-committed Compose journey through the real UI after the caller has
 * validated settlement and run commerce reconciliation. Both contexts retain their independent
 * manager/buyer authority; this function does not create or mutate any economic state.
 */
export async function runLiveCommerceBrowserEvidenceReview(input) {
  const sessions = await createBrowserSessions(input);
  const { AxeBuilder, buyerPage, managerPage } = sessions;

  try {
    await Promise.all([
      openPage(
        managerPage,
        `${input.baseUrl}/worlds/${input.worldId}/economy/business`,
        'the manager business workspace',
      ),
      openPage(
        buyerPage,
        `${input.baseUrl}/worlds/${input.worldId}/economy/business`,
        'the buyer employment workspace',
      ),
    ]);
    await Promise.all([
      assertBusinessAndEmployment(managerPage, input, 'manager'),
      assertBusinessAndEmployment(buyerPage, input, 'participant'),
    ]);
    await Promise.all([
      assertAccessible(managerPage, AxeBuilder, 'The live manager business workspace'),
      assertAccessible(buyerPage, AxeBuilder, 'The live participant employment workspace'),
    ]);
    await assertNoViewportOverflow(buyerPage, 'The live participant employment workspace');

    await Promise.all([
      openPage(
        managerPage,
        `${input.baseUrl}/worlds/${input.worldId}/economy/production`,
        'the final manager production workspace',
      ),
      openPage(
        buyerPage,
        `${input.baseUrl}/worlds/${input.worldId}/economy/market`,
        'the final buyer marketplace',
      ),
    ]);
    await Promise.all([
      assertProduction(managerPage, input),
      assertMarketEvidence(buyerPage, input),
    ]);
    await Promise.all([
      assertAccessible(managerPage, AxeBuilder, 'The final live production workspace'),
      assertAccessible(buyerPage, AxeBuilder, 'The final live marketplace'),
    ]);
    await assertNoViewportOverflow(buyerPage, 'The final live marketplace');

    await openPage(
      buyerPage,
      `${input.baseUrl}/worlds/${input.worldId}/economy/treasury`,
      'the buyer treasury and reconciliation workspace',
    );
    await visible(
      buyerPage.getByRole('heading', { level: 1, name: 'Treasury & reconciliation' }),
      'the treasury and reconciliation workspace',
    );
    const treasury = buyerPage.locator('section').filter({
      has: buyerPage.getByRole('heading', {
        name: 'Treasury & collected revenue',
        exact: true,
      }),
    });
    await visible(treasury, 'the treasury revenue evidence');
    await assertCount(
      treasury.getByText(`${input.treasuryMinor} minor units`, { exact: true }),
      2,
      'exact treasury balance/revenue values',
    );
    await visible(
      treasury.getByText(input.lastRevenueTick, { exact: true }),
      'the exact last-revenue tick',
    );

    const reconciliation = buyerPage.locator('section').filter({
      has: buyerPage.getByRole('heading', { name: 'Expansion reconciliation', exact: true }),
    });
    await visible(
      reconciliation.getByText('matched', { exact: true }),
      'the matched reconciliation result',
    );
    await visible(
      reconciliation.getByText('0', { exact: true }),
      'the zero reconciliation mismatch count',
    );
    await visible(
      reconciliation.getByText(input.reconciliationChecksum, { exact: true }),
      'the exact reconciliation checksum',
    );
    await visible(
      buyerPage.getByText(/current · revision/u),
      'the current commerce projection badge',
    );

    const taxes = buyerPage.locator('section').filter({
      has: buyerPage.getByRole('heading', { name: 'Tax assessments', exact: true }),
    });
    await visible(
      taxes.getByText('periodic tax', { exact: true }).first(),
      'the periodic tax facts',
    );
    await assertCount(
      taxes.getByText('periodic tax', { exact: true }),
      input.periodicTaxCount,
      'periodic tax facts',
    );
    await assertCount(
      taxes.getByText(`${input.periodicTaxMinor} minor units`, { exact: true }),
      input.periodicTaxCount,
      'periodic tax amounts',
    );
    await assertCount(
      taxes.getByText('market trade', { exact: true }),
      1,
      'market-trade tax facts',
    );
    await assertCount(
      taxes.getByText(`${input.marketTaxMinor} minor units`, { exact: true }),
      1,
      'market-trade tax amounts',
    );
    await assertAccessible(
      buyerPage,
      AxeBuilder,
      'The live buyer treasury and reconciliation workspace',
    );
    await assertNoViewportOverflow(
      buyerPage,
      'The live buyer treasury and reconciliation workspace',
    );

    await openPage(
      managerPage,
      `${input.baseUrl}/worlds/${input.worldId}/economy`,
      'the manager accounting workspace',
    );
    await visible(
      managerPage.getByRole('heading', { level: 1, name: 'Economy' }),
      'the manager accounting workspace',
    );
    const wallet = managerPage.getByRole('combobox', { name: 'Wallet', exact: true });
    const businessWallet = wallet.locator(`option[value="${input.businessWalletId}"]`);
    await attached(businessWallet, 'the controlled business-wallet history option');
    await wallet.selectOption(input.businessWalletId);
    const transactionTable = managerPage.getByRole('table', {
      name: 'Immutable financial transactions and their balanced wallet postings',
    });
    const marketPurchase = transactionTable
      .getByRole('row')
      .filter({ hasText: 'Market purchase' })
      .first();
    await visible(marketPurchase, 'the immutable marketplace financial transaction');
    await visible(
      marketPurchase.getByText('3 immutable postings', { exact: true }),
      'the balanced marketplace postings',
    );
    await visible(
      marketPurchase.getByRole('link', { name: 'Open world History', exact: true }),
      'the accounting-to-history link',
    );
    await assertAccessible(managerPage, AxeBuilder, 'The live manager accounting history');

    await openPage(
      buyerPage,
      `${input.baseUrl}/worlds/${input.worldId}/history`,
      'the buyer world history',
    );
    await visible(
      buyerPage.getByRole('heading', { level: 1, name: 'World History' }),
      'the world history workspace',
    );
    await buyerPage.getByLabel('Event type').fill('WorldCommerceReconciledV1');
    await buyerPage.getByRole('button', { name: 'Apply filters', exact: true }).click();
    const historyEntry = buyerPage
      .getByRole('button', {
        name: 'Commerce reconciled',
        exact: true,
      })
      .first();
    await visible(historyEntry, 'the member-visible commerce reconciliation history fact');
    await historyEntry.click();
    const historyDetail = buyerPage.getByRole('complementary', {
      name: 'History entry detail',
    });
    await visible(
      historyDetail.getByRole('heading', { name: 'Commerce reconciled', exact: true }),
      'the commerce reconciliation history detail',
    );
    await visible(
      historyDetail.getByText(/ReconcileWorldCommerceV1/u),
      'the reconciliation command identity',
    );
    await visible(
      historyDetail.getByText(input.reconciliationCommandId, { exact: true }),
      'the final reconciliation command ID',
    );
    await visible(
      historyDetail.getByText('WorldCommerceReconciledV1', { exact: true }),
      'the resulting reconciliation event identity',
    );
    await visible(
      historyDetail.getByText(/accepted ·/u),
      'the accepted reconciliation authorization result',
    );
    await visible(
      historyDetail.getByText(
        `World state advanced to revision ${input.reconciliationStateRevision}.`,
        { exact: true },
      ),
      'the final reconciliation state revision',
    );
    await assertAccessible(buyerPage, AxeBuilder, 'The live member world history');
    await assertNoViewportOverflow(buyerPage, 'The live member world history');
  } finally {
    await closeBrowserSessions(sessions);
  }
}
