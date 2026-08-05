import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import {
  runLiveCommerceBrowserDemo,
  runLiveCommerceBrowserEvidenceReview,
} from './compose-commerce-browser-smoke.mjs';
import { runLiveGovernanceBrowserDemo } from './compose-governance-browser-smoke.mjs';

const api = 'http://127.0.0.1:4000';
const webPort = process.env.WEB_PORT ?? '3000';
const web = `http://127.0.0.1:${webPort}`;
const browserOrigin = `http://localhost:${webPort}`;
const operationsToken = process.env.OPERATIONS_TOKEN;
const commerceBrowserSmokeEnabled = process.env.COMPOSE_SMOKE_BROWSER === 'true';

class CookieJar {
  constructor(entries = []) {
    this.cookies = new Map(entries);
  }

  capture(response) {
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (/max-age=0/iu.test(value) || cookieValue === '') this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
    }
  }

  clone() {
    return new CookieJar(this.cookies.entries());
  }

  get(name) {
    return this.cookies.get(name);
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function browserRequest(jar, path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('origin', browserOrigin);
  const cookies = jar.header();
  if (cookies) headers.set('cookie', cookies);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${browserOrigin}/api/v1${path}`, {
    ...options,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers,
  });
  jar.capture(response);
  const responseText = await response.text();
  const body = responseText ? JSON.parse(responseText) : null;
  return { body, response };
}

async function rateLimitedRead(jar, path, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await browserRequest(jar, path);
    if (result.response.status !== 429 || result.body?.error?.code !== 'RATE_LIMITED') {
      return result;
    }
    const retryAfterSeconds = Number(result.response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(60_000, Math.max(500, Math.ceil(retryAfterSeconds * 1_000) + 250))
      : 5_000;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
  } while (Date.now() < deadline);
  return result;
}

async function mutation(jar, path, method, body, idempotencyKey) {
  const csrf = jar.get('wg_csrf');
  if (!csrf) throw new Error('The browser cookie jar did not contain a CSRF token.');
  return browserRequest(jar, path, {
    body,
    headers: {
      'idempotency-key': idempotencyKey,
      'x-csrf-token': decodeURIComponent(csrf),
    },
    method,
  });
}

async function commandMutation(jar, worldId, command, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await mutation(
      jar,
      `/worlds/${worldId}/commands`,
      'POST',
      command,
      command.idempotencyKey,
    );
    if (result.response.status !== 429 || result.body?.error?.code !== 'RATE_LIMITED') {
      return result;
    }
    const retryAfterSeconds = Number(result.response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(60_000, Math.max(500, Math.ceil(retryAfterSeconds * 1_000) + 250))
      : 5_000;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
  } while (Date.now() < deadline);
  return result;
}

function expectStatus(result, status, operation) {
  if (result.response.status === status) return result.body;
  const code = result.body?.error?.code ?? 'UNKNOWN_ERROR';
  const message = result.body?.error?.message ?? 'No public error message was returned.';
  throw new Error(
    `${operation} returned ${result.response.status} (${code}); expected ${status}: ${message}`,
  );
}

function canonicalizeJson(input, ancestors = new Set()) {
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'string') return input.normalize('NFC');
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers.');
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== 'object') {
    throw new TypeError(`Canonical JSON does not support ${typeof input}.`);
  }
  if (ancestors.has(input)) throw new TypeError('Canonical JSON does not support cyclic values.');
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return input.map((value) => canonicalizeJson(value, ancestors));
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only arrays and plain objects.');
    }
    const normalizedKeys = Object.keys(input).map((key) => [key, key.normalize('NFC')]);
    if (new Set(normalizedKeys.map(([, key]) => key)).size !== normalizedKeys.length) {
      throw new TypeError('Canonical JSON object keys collide after Unicode normalization.');
    }
    return Object.fromEntries(
      normalizedKeys
        .sort((left, right) => (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0))
        .map(([sourceKey, normalizedKey]) => [
          normalizedKey,
          canonicalizeJson(input[sourceKey], ancestors),
        ]),
    );
  } finally {
    ancestors.delete(input);
  }
}

function canonicalJson(input) {
  const value = canonicalizeJson(input);
  function serialize(item) {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map((entry) => serialize(entry)).join(',')}]`;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(item[key])}`)
      .join(',')}}`;
  }
  return serialize(value);
}

function memberPrincipalKey(worldId, userId) {
  const digest = createHash('sha256')
    .update(
      `worldgraph-member-principal-v1\0${worldId.toLowerCase()}\0${userId.toLowerCase()}`,
      'utf8',
    )
    .digest('hex');
  return `member-${digest.slice(0, 32)}`;
}

function expectExactKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was not an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys were not exact: ${JSON.stringify(actual)}.`);
  }
}

function expectSortedStableKeys(entries, expectedKeys, label) {
  const keys = entries.map((entry) => entry.stableKey);
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} stable keys were not exact: ${JSON.stringify(keys)}.`);
  }
}

function assertPrimitiveProvenance(value, expected, label) {
  if (
    value.primitiveKey !== expected.primitiveKey ||
    value.primitiveRef !== expected.primitiveRef ||
    value.primitiveVersion !== '1.0.0' ||
    !/^[a-f0-9]{64}$/u.test(value.primitiveContentHash) ||
    !/^[a-f0-9-]{36}$/u.test(value.primitiveVersionId)
  ) {
    throw new Error(`${label} primitive provenance was not exact: ${JSON.stringify(value)}.`);
  }
}

function assertExactEconomySeedPlan(plan) {
  expectExactKeys(
    plan,
    [
      'assets',
      'businesses',
      'currency',
      'economySeedPlanSchemaVersion',
      'employmentOffers',
      'facilities',
      'initialSupplyMinor',
      'inventories',
      'recipeVersions',
      'resources',
      'taxPolicies',
      'treasury',
      'wallets',
    ],
    'Economy seed plan',
  );
  expectExactKeys(
    plan.currency,
    [
      'cashOutAllowed',
      'code',
      'currencySchemaVersion',
      'issuerEntityLogicalKey',
      'maxSupplyMinor',
      'minorUnitScale',
      'name',
      'noCashValue',
      'stableKey',
    ],
    'Economy seed currency',
  );
  if (
    plan.economySeedPlanSchemaVersion !== 2 ||
    plan.initialSupplyMinor !== '30000' ||
    plan.currency.cashOutAllowed !== false ||
    plan.currency.code !== 'GCR' ||
    plan.currency.currencySchemaVersion !== 1 ||
    typeof plan.currency.issuerEntityLogicalKey !== 'string' ||
    plan.currency.maxSupplyMinor !== '10000000000' ||
    plan.currency.minorUnitScale !== 2 ||
    plan.currency.name !== 'Guild Credits' ||
    plan.currency.noCashValue !== true ||
    plan.currency.stableKey !== 'currency:gcr'
  ) {
    throw new Error(`Economy seed currency was not exact: ${JSON.stringify(plan.currency)}.`);
  }
  if (!Array.isArray(plan.wallets) || plan.wallets.length !== 6) {
    throw new Error('Economy seed plan did not contain exactly six wallets.');
  }
  for (const wallet of plan.wallets) {
    expectExactKeys(
      wallet,
      [
        'initialBalanceMinor',
        'ownerEntityLogicalKey',
        'stableKey',
        'walletKind',
        'walletSchemaVersion',
      ],
      'Economy seed wallet',
    );
  }
  const stableKeys = plan.wallets.map((wallet) => wallet.stableKey);
  if (
    JSON.stringify(stableKeys) !==
    JSON.stringify(
      [...stableKeys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    )
  ) {
    throw new Error('Economy seed wallets were not code-point sorted.');
  }
  const treasuryWallets = plan.wallets.filter((wallet) => wallet.walletKind === 'treasury');
  const playerWallets = plan.wallets.filter((wallet) => wallet.walletKind === 'player');
  const organizationWallets = plan.wallets.filter((wallet) => wallet.walletKind === 'organization');
  const treasuryWallet = treasuryWallets[0];
  if (
    treasuryWallets.length !== 1 ||
    playerWallets.length !== 3 ||
    organizationWallets.length !== 2 ||
    treasuryWallet?.initialBalanceMinor !== '0' ||
    treasuryWallet.ownerEntityLogicalKey !== plan.currency.issuerEntityLogicalKey ||
    treasuryWallet.stableKey !== 'wallet:treasury:gcr' ||
    treasuryWallet.walletSchemaVersion !== 1 ||
    playerWallets.some(
      (wallet) =>
        wallet.initialBalanceMinor !== '10000' ||
        wallet.stableKey !== `wallet:player:${wallet.ownerEntityLogicalKey}:gcr` ||
        wallet.walletSchemaVersion !== 1,
    ) ||
    JSON.stringify(
      organizationWallets.map((wallet) => [
        wallet.initialBalanceMinor,
        wallet.ownerEntityLogicalKey,
        wallet.stableKey,
        wallet.walletSchemaVersion,
      ]),
    ) !==
      JSON.stringify([
        ['0', 'organization:artisan-guild', 'wallet:organization:artisan-guild:gcr', 1],
        ['0', 'organization:energy-guild', 'wallet:organization:energy-guild:gcr', 1],
      ]) ||
    new Set(plan.wallets.map((wallet) => wallet.ownerEntityLogicalKey)).size !== 6 ||
    plan.wallets.reduce((sum, wallet) => sum + BigInt(wallet.initialBalanceMinor), 0n) !== 30000n
  ) {
    throw new Error(
      `Economy seed wallet distribution was not exact: ${JSON.stringify(plan.wallets)}.`,
    );
  }
  if (!Array.isArray(plan.assets) || plan.assets.length !== 3) {
    throw new Error('Economy seed plan did not contain exactly three assets.');
  }
  expectSortedStableKeys(
    plan.assets,
    [
      'asset:facility:energy-harbor-annex',
      'asset:facility:energy-harbor-workshop',
      'asset:founding-seal',
    ],
    'Economy seed assets',
  );
  const asset = plan.assets.find((entry) => entry.stableKey === 'asset:founding-seal');
  const workshop = plan.assets.find(
    (entry) => entry.stableKey === 'asset:facility:energy-harbor-workshop',
  );
  const annex = plan.assets.find(
    (entry) => entry.stableKey === 'asset:facility:energy-harbor-annex',
  );
  if (!asset || !workshop || !annex) throw new Error('Economy seed assets were incomplete.');
  expectExactKeys(
    asset,
    [
      'assetSchemaVersion',
      'assetType',
      'initialOwnerEntityLogicalKey',
      'metadata',
      'stableKey',
      'transferable',
      'worldEntityLogicalKey',
    ],
    'Economy seed asset',
  );
  expectExactKeys(asset.metadata, ['displayName', 'provenance'], 'Economy seed asset metadata');
  if (
    asset.assetSchemaVersion !== 1 ||
    asset.assetType !== 'founding_seal' ||
    !playerWallets.some(
      (wallet) => wallet.ownerEntityLogicalKey === asset.initialOwnerEntityLogicalKey,
    ) ||
    asset.metadata.displayName !== 'Founding Seal' ||
    asset.metadata.provenance !== 'compiler-economy-adapter-v1' ||
    asset.stableKey !== 'asset:founding-seal' ||
    asset.transferable !== true ||
    asset.worldEntityLogicalKey !== null
  ) {
    throw new Error(`Economy seed asset was not exact: ${JSON.stringify(asset)}.`);
  }
  if (
    workshop.assetSchemaVersion !== 1 ||
    workshop.assetType !== 'workshop' ||
    workshop.initialOwnerEntityLogicalKey !== 'organization:energy-guild' ||
    workshop.metadata.displayName !== 'Energy Harbor Workshop' ||
    workshop.metadata.provenance !== 'compiler-economy-adapter-v2' ||
    workshop.transferable !== true ||
    workshop.worldEntityLogicalKey !== null
  ) {
    throw new Error(`Economy seed workshop was not exact: ${JSON.stringify(workshop)}.`);
  }
  if (
    annex.assetSchemaVersion !== 1 ||
    annex.assetType !== 'workshop' ||
    annex.initialOwnerEntityLogicalKey !== 'organization:energy-guild' ||
    annex.metadata.displayName !== 'Energy Harbor Workshop Annex' ||
    annex.metadata.provenance !== 'compiler-economy-adapter-v2' ||
    annex.transferable !== true ||
    annex.worldEntityLogicalKey !== null
  ) {
    throw new Error(`Economy seed annex was not exact: ${JSON.stringify(annex)}.`);
  }

  expectSortedStableKeys(
    plan.resources,
    ['resource:energy', 'resource:iron-ore', 'resource:metal-part'],
    'Economy seed resources',
  );
  const expectedResources = [
    ['Energy', 'energy', 'worldgraph.resource.energy', 'energy-unit', ['energy', 'scarce']],
    ['Iron Ore', 'iron-ore', 'worldgraph.resource.iron-ore', 'ore-unit', ['iron', 'ore']],
    [
      'Metal Part',
      'metal-part',
      'worldgraph.resource.metal-part',
      'part',
      ['manufactured', 'metal'],
    ],
  ];
  for (const [index, resource] of plan.resources.entries()) {
    const [displayName, primitiveRef, primitiveKey, unit, tags] = expectedResources[index];
    assertPrimitiveProvenance(resource, { primitiveKey, primitiveRef }, 'Economy seed resource');
    if (
      resource.displayName !== displayName ||
      resource.quantityScale !== 0 ||
      resource.resourceSchemaVersion !== 1 ||
      resource.unit !== unit ||
      JSON.stringify(resource.tags) !== JSON.stringify(tags)
    ) {
      throw new Error(`Economy seed resource was not exact: ${JSON.stringify(resource)}.`);
    }
  }

  if (plan.recipeVersions.length !== 1) {
    throw new Error('Economy seed plan did not contain exactly one recipe version.');
  }
  const recipe = plan.recipeVersions[0];
  assertPrimitiveProvenance(
    recipe,
    {
      primitiveKey: 'worldgraph.production-recipe.metal-part-fabrication',
      primitiveRef: 'metal-part-fabrication',
    },
    'Economy seed recipe',
  );
  if (
    recipe.durationTicks !== '12' ||
    recipe.facilityAssetType !== 'workshop' ||
    recipe.recipeVersionSchemaVersion !== 1 ||
    recipe.stableKey !== 'recipe-version:metal-part-fabrication:1' ||
    recipe.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(recipe.checksum) ||
    JSON.stringify(recipe.inputs) !==
      JSON.stringify([
        { quantity: '1', resourceStableKey: 'resource:energy' },
        { quantity: '2', resourceStableKey: 'resource:iron-ore' },
      ]) ||
    JSON.stringify(recipe.outputs) !==
      JSON.stringify([{ quantity: '1', resourceStableKey: 'resource:metal-part' }])
  ) {
    throw new Error(`Economy seed recipe was not exact: ${JSON.stringify(recipe)}.`);
  }

  expectSortedStableKeys(
    plan.inventories,
    [
      'inventory:energy-harbor-workshop:energy',
      'inventory:energy-harbor-workshop:iron-ore',
      'inventory:energy-harbor-workshop:metal-part',
    ],
    'Economy seed inventories',
  );
  const expectedInventoryQuantities = ['100', '100', '0'];
  const expectedInventoryResources = [
    'resource:energy',
    'resource:iron-ore',
    'resource:metal-part',
  ];
  for (const [index, inventory] of plan.inventories.entries()) {
    if (
      inventory.containerAssetStableKey !== 'asset:facility:energy-harbor-workshop' ||
      inventory.inventorySchemaVersion !== 1 ||
      inventory.ownerEntityLogicalKey !== 'organization:energy-guild' ||
      inventory.quantity !== expectedInventoryQuantities[index] ||
      inventory.resourceStableKey !== expectedInventoryResources[index]
    ) {
      throw new Error(`Economy seed inventory was not exact: ${JSON.stringify(inventory)}.`);
    }
  }

  if (
    canonicalJson(plan.businesses) !==
      canonicalJson([
        {
          businessSchemaVersion: 1,
          displayName: 'Energy Harbor Works',
          organizationEntityLogicalKey: 'organization:energy-guild',
          stableKey: 'business:energy-guild',
          status: 'active',
          walletStableKey: 'wallet:organization:energy-guild:gcr',
        },
      ]) ||
    canonicalJson(plan.facilities) !==
      canonicalJson([
        {
          assetStableKey: 'asset:facility:energy-harbor-workshop',
          businessStableKey: 'business:energy-guild',
          facilitySchemaVersion: 1,
          recipeVersionStableKeys: ['recipe-version:metal-part-fabrication:1'],
          stableKey: 'facility:energy-harbor-workshop',
          status: 'active',
        },
      ]) ||
    canonicalJson(plan.employmentOffers) !==
      canonicalJson([
        {
          businessStableKey: 'business:energy-guild',
          cadenceTicks: '12',
          currencyStableKey: 'currency:gcr',
          employmentOfferSchemaVersion: 1,
          maxPaymentsPerPeriod: 1,
          roleKey: 'metalworker',
          stableKey: 'employment-offer:energy-guild:metalworker',
          status: 'open',
          wageMinor: '100',
        },
      ])
  ) {
    throw new Error('Economy seed business, facility, or employment offer was not exact.');
  }
  expectSortedStableKeys(
    plan.taxPolicies,
    ['tax-policy:guild-council:harbor-dues', 'tax-policy:guild-council:sales'],
    'Economy seed tax policies',
  );
  const [periodicTax, salesTax] = plan.taxPolicies;
  if (
    periodicTax.taxType !== 'periodic_flat' ||
    periodicTax.collectionMode !== 'added_to_payer' ||
    periodicTax.fixedAmountMinor !== '10' ||
    periodicTax.intervalTicks !== '5' ||
    periodicTax.payerEntityLogicalKey !== 'organization:energy-guild' ||
    periodicTax.payerWalletStableKey !== 'wallet:organization:energy-guild:gcr' ||
    salesTax.taxType !== 'sales' ||
    salesTax.collectionMode !== 'added_to_payer' ||
    salesTax.rateBps !== 250 ||
    plan.taxPolicies.some(
      (policy) =>
        policy.authorityEntityLogicalKey !== 'institution:guild-council' ||
        policy.effectiveFromTick !== '0' ||
        policy.effectiveUntilTick !== null ||
        policy.roundingMode !== 'floor' ||
        policy.status !== 'active' ||
        policy.taxPolicySchemaVersion !== 1 ||
        policy.treasuryWalletStableKey !== 'wallet:treasury:gcr',
    ) ||
    canonicalJson(plan.treasury) !==
      canonicalJson({
        currencyStableKey: 'currency:gcr',
        institutionEntityLogicalKey: 'institution:guild-council',
        treasuryBindingSchemaVersion: 1,
        walletStableKey: 'wallet:treasury:gcr',
      })
  ) {
    throw new Error('Economy seed tax and treasury bindings were not exact.');
  }

  return { asset, organizationWallets, playerWallets, treasuryWallet };
}

async function waitFor(path, expectedStatus, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(path, { cache: 'no-store' });
      lastStatus = response.status;
      if (response.status === expectedStatus) return response;
    } catch {
      lastStatus = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${path}; expected ${expectedStatus}, last ${lastStatus}.`);
}

async function verifyOperationalWorker(stage) {
  if (!operationsToken) return;
  const key = `compose-${stage}-${Date.now()}`;
  const deadline = Date.now() + 180_000;
  let lastStatus = 'not-requested';
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/api/v1/system/smoke-jobs`, {
      body: '{}',
      headers: {
        authorization: `Bearer ${operationsToken}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      method: 'POST',
    });
    const result = await response.json();
    if (response.status === 429 && result?.error?.code === 'RATE_LIMITED') {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? Math.min(60_000, Math.max(500, Math.ceil(retryAfterSeconds * 1_000) + 250))
        : 5_000;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      continue;
    }
    if (response.status !== 202) {
      throw new Error(`${stage} smoke enqueue failed: ${JSON.stringify(result)}`);
    }
    lastStatus = result.status;
    if (result.status === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(`${stage} worker smoke did not complete; last status ${lastStatus}.`);
}

async function waitForManifestRun(jar, runId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const result = await browserRequest(jar, `/manifest-generations/${runId}`);
    const run = expectStatus(result, 200, 'read manifest generation');
    lastStatus = run.status;
    if (['cancelled', 'failed', 'succeeded'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Manifest generation ${runId} did not finish; last status ${lastStatus}.`);
}

async function waitForCompilationRun(jar, worldId, runId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStage = 'unknown';
  while (Date.now() < deadline) {
    const result = await browserRequest(jar, `/worlds/${worldId}/compilations/${runId}`);
    const run = expectStatus(result, 200, 'read world compilation');
    lastStage = `${run.status}/${run.stage}`;
    if (['cancelled', 'failed', 'succeeded'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Compilation ${runId} did not finish; last state ${lastStage}.`);
}

async function readEconomySummary(jar, worldId) {
  return expectStatus(
    await browserRequest(jar, `/worlds/${worldId}/economy/summary`),
    200,
    'read economy summary',
  );
}

function economyCommand(summary, type, payload, idempotencyKey) {
  return {
    commandId: randomUUID(),
    expectedAggregateVersion: summary.economyHeadVersion ?? '0',
    expectedStateRevision: summary.stateRevision,
    expectedWorldVersion: summary.designVersion,
    idempotencyKey,
    payload,
    schemaVersion: 1,
    type,
  };
}

async function submitEconomyCommand(jar, worldId, command) {
  const result = expectStatus(await commandMutation(jar, worldId, command), 200, command.type);
  if (result.status !== 'accepted') {
    throw new Error(`${command.type} was not accepted: ${JSON.stringify(result)}.`);
  }
  return result;
}

async function controlledWallets(jar, worldId, label) {
  const page = expectStatus(
    await browserRequest(jar, `/worlds/${worldId}/economy/wallets?limit=100`),
    200,
    `read ${label} controlled wallets`,
  );
  if (page.nextCursor !== null) {
    throw new Error(`${label} controlled wallets exceeded the bounded smoke page.`);
  }
  return page.items;
}

async function onlyControlledPlayerWallet(jar, worldId, label) {
  const wallets = await controlledWallets(jar, worldId, label);
  const players = wallets.filter((item) => item.wallet.walletKind === 'player');
  if (players.length !== 1) {
    throw new Error(`${label} did not have exactly one controlled player wallet.`);
  }
  return players[0];
}

async function readEconomyAsset(jar, worldId, assetKey = 'asset:founding-seal') {
  return expectStatus(
    await browserRequest(jar, `/worlds/${worldId}/assets/${encodeURIComponent(assetKey)}`),
    200,
    `read ${assetKey}`,
  );
}

async function readOffer(jar, worldId, offerId) {
  const page = expectStatus(
    await browserRequest(
      jar,
      `/worlds/${worldId}/asset-transfer-offers?limit=1&offerId=${encodeURIComponent(offerId)}`,
    ),
    200,
    'read exact asset transfer offer',
  );
  if (page.items.length !== 1 || page.nextCursor !== null) {
    throw new Error(`Offer ${offerId} was not visible exactly once.`);
  }
  return page.items[0];
}

async function readWalletTransactions(jar, worldId, walletId, label) {
  return expectStatus(
    await browserRequest(
      jar,
      `/worlds/${worldId}/economy/wallets/${encodeURIComponent(walletId)}/transactions?limit=100`,
    ),
    200,
    `read ${label} wallet transactions`,
  );
}

async function readSimulationClock(jar, worldId) {
  return expectStatus(
    await browserRequest(jar, `/worlds/${worldId}/simulation/clock`),
    200,
    'read simulation clock',
  );
}

async function submitSimulationCommand(jar, worldId, command) {
  return expectStatus(await commandMutation(jar, worldId, command), 200, command.type);
}

function simulationCommand(clockView, type, payload, idempotencyKey, expectedAggregateVersion) {
  return {
    commandId: randomUUID(),
    expectedAggregateVersion: expectedAggregateVersion ?? clockView.aggregateVersion,
    expectedStateRevision: clockView.stateRevision,
    expectedTick: clockView.clock.currentTick,
    expectedWorldVersion: clockView.designVersion,
    idempotencyKey,
    payload,
    schemaVersion: 1,
    type,
  };
}

async function waitForSimulationTickAfter(jar, worldId, tick, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let clockView = await readSimulationClock(jar, worldId);
  while (BigInt(clockView.clock.currentTick) <= BigInt(tick) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    clockView = await readSimulationClock(jar, worldId);
  }
  if (BigInt(clockView.clock.currentTick) <= BigInt(tick)) {
    throw new Error(`Simulation did not advance after tick ${tick}.`);
  }
  return clockView;
}

async function readCommercePage(jar, worldId, path, label) {
  const page = expectStatus(
    await browserRequest(jar, `/worlds/${worldId}/economy/${path}`),
    200,
    label,
  );
  if (page.nextCursor !== null) {
    throw new Error(`${label} exceeded the bounded smoke page.`);
  }
  return page;
}

async function readCommerceReconciliation(jar, worldId) {
  return expectStatus(
    await browserRequest(jar, `/worlds/${worldId}/economy/reconciliation`),
    200,
    'read commerce reconciliation',
  );
}

async function commerceContext(jar, worldId) {
  const [summary, clock, reconciliation] = await Promise.all([
    readEconomySummary(jar, worldId),
    readSimulationClock(jar, worldId),
    readCommerceReconciliation(jar, worldId),
  ]);
  return {
    designVersion: summary.designVersion,
    expansionVersion: reconciliation.expansionVersion,
    stateRevision: summary.stateRevision,
    tick: clock.clock.currentTick,
  };
}

function worldCommerceCommand(context, type, payload, idempotencyKey) {
  return {
    commandId: randomUUID(),
    expectedAggregateVersion: context.expansionVersion,
    expectedStateRevision: context.stateRevision,
    expectedTick: context.tick,
    expectedWorldVersion: context.designVersion,
    idempotencyKey,
    payload,
    schemaVersion: 1,
    type,
  };
}

async function waitForCommerce(jar, worldId, path, label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let page;
  while (Date.now() < deadline) {
    page = await readCommercePage(jar, worldId, path, label);
    if (predicate(page)) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not reach its expected state: ${JSON.stringify(page)}.`);
}

async function waitForHistoryEvent(jar, worldId, eventType, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let page;
  while (Date.now() < deadline) {
    page = expectStatus(
      await browserRequest(
        jar,
        `/worlds/${worldId}/history?eventType=${encodeURIComponent(eventType)}&limit=10`,
      ),
      200,
      `read ${eventType} history`,
    );
    if (page.items.length > 0) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${eventType} history did not become visible: ${JSON.stringify(page)}.`);
}

async function waitForScheduledAction(jar, worldId, actionType, dueTick, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let action = null;
  while (Date.now() < deadline) {
    const schedule = expectStatus(
      await browserRequest(jar, `/worlds/${worldId}/simulation/schedule?limit=100`),
      200,
      `read ${actionType} schedule`,
    );
    action =
      schedule.items.find((item) => item.actionType === actionType && item.dueTick === dueTick) ??
      null;
    if (action?.status === 'completed' && action.completedEventId) return action;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${actionType} at tick ${dueTick} did not complete: ${JSON.stringify(action)}.`);
}

async function advanceSimulationTo(jar, worldId, targetTick, idempotencyKey) {
  const clock = await readSimulationClock(jar, worldId);
  const delta = BigInt(targetTick) - BigInt(clock.clock.currentTick);
  if (delta <= 0n) throw new Error(`Cannot advance simulation to non-future tick ${targetTick}.`);
  await submitSimulationCommand(
    jar,
    worldId,
    simulationCommand(clock, 'AdvanceSimulationV1', { ticks: Number(delta) }, idempotencyKey),
  );
  const advanced = await readSimulationClock(jar, worldId);
  if (advanced.clock.currentTick !== targetTick || advanced.clock.mode !== 'paused') {
    throw new Error(`Simulation did not advance exactly to paused tick ${targetTick}.`);
  }
  return advanced;
}

function governanceCommand(clockView, type, payload, expectedAggregateVersion, idempotencyKey) {
  return {
    commandId: randomUUID(),
    expectedAggregateVersion,
    expectedStateRevision: clockView.stateRevision,
    expectedTick: clockView.clock.currentTick,
    expectedWorldVersion: clockView.designVersion,
    idempotencyKey,
    payload,
    schemaVersion: 1,
    type,
  };
}

async function submitGovernanceCommand(jar, worldId, command) {
  const result = expectStatus(await commandMutation(jar, worldId, command), 200, command.type);
  if (result.status !== 'accepted') {
    throw new Error(`${command.type} was not accepted: ${JSON.stringify(result)}.`);
  }
  return result;
}

async function readGovernancePage(jar, worldId, path, label) {
  const page = expectStatus(
    await rateLimitedRead(jar, `/worlds/${worldId}/governance/${path}`),
    200,
    label,
  );
  if (page.page?.nextCursor !== null || !/^\d+$/u.test(page.page?.projectionRevision ?? '')) {
    throw new Error(`${label} did not return one complete projection-bounded page.`);
  }
  return page;
}

async function waitForGovernanceItem(jar, worldId, path, label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let page;
  while (Date.now() < deadline) {
    page = await readGovernancePage(jar, worldId, path, label);
    const item = page.items.find(predicate);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not reach its expected state: ${JSON.stringify(page)}.`);
}

async function enactPublicGovernanceProposal(input) {
  const clock = await readSimulationClock(input.proposer, input.worldId);
  const sponsorshipEndsAtTick = (
    BigInt(clock.clock.currentTick) + BigInt(input.charter.proposalRules.sponsorshipTicks)
  ).toString();
  const debateEndsAtTick = (
    BigInt(sponsorshipEndsAtTick) + BigInt(input.charter.proposalRules.debateTicks)
  ).toString();
  const votingOpensAtTick = debateEndsAtTick;
  const votingClosesAtTick = (
    BigInt(votingOpensAtTick) + BigInt(input.charter.proposalRules.votingTicks)
  ).toString();
  const action = input.action(votingClosesAtTick);
  await submitGovernanceCommand(
    input.proposer,
    input.worldId,
    governanceCommand(
      clock,
      'CreateProposalV1',
      {
        action,
        approvalThresholdBps: input.charter.proposalRules.approvalThresholdBps,
        ballotPolicy: input.charter.proposalRules.ballotPolicy,
        body: input.body,
        debateEndsAtTick,
        institutionId: input.institution.institutionId,
        jurisdictionEntityKey: input.institution.jurisdictionEntityKey,
        minimumSponsors: input.charter.proposalRules.minimumSponsors,
        proposalKey: input.proposalKey,
        quorumBps: input.charter.proposalRules.quorumBps,
        sponsorshipEndsAtTick,
        targetCharterVersion: input.charter.version,
        title: input.title,
        votingClosesAtTick,
        votingOpensAtTick,
      },
      '0',
      `${input.idempotencyPrefix}-create`,
    ),
  );
  const debating = await waitForGovernanceItem(
    input.proposer,
    input.worldId,
    'proposals?limit=100',
    `read ${input.title} debate`,
    (proposal) => proposal.title === input.title && proposal.status === 'debate',
  );
  await advanceSimulationTo(
    input.proposer,
    input.worldId,
    votingOpensAtTick,
    `${input.idempotencyPrefix}-open`,
  );
  const opened = await waitForGovernanceItem(
    input.proposer,
    input.worldId,
    'proposals?limit=100',
    `open ${input.title} voting`,
    (proposal) => proposal.proposalId === debating.proposalId && proposal.status === 'open',
  );
  if (!opened.eligibilitySnapshotId || opened.eligibleCount !== input.voters.length) {
    throw new Error(`${input.title} did not freeze the exact three-account eligibility set.`);
  }
  for (const [index, voter] of input.voters.entries()) {
    const voterClock = await readSimulationClock(voter, input.worldId);
    await submitGovernanceCommand(
      voter,
      input.worldId,
      governanceCommand(
        voterClock,
        'CastProposalBallotV1',
        {
          choice: 'yes',
          eligibilitySnapshotId: opened.eligibilitySnapshotId,
          expectedProposalVersion: opened.aggregateVersion,
          proposalId: opened.proposalId,
          replaceExisting: false,
        },
        opened.aggregateVersion,
        `${input.idempotencyPrefix}-vote-${index + 1}`,
      ),
    );
  }
  await advanceSimulationTo(
    input.proposer,
    input.worldId,
    votingClosesAtTick,
    `${input.idempotencyPrefix}-close`,
  );
  const enacted = await waitForGovernanceItem(
    input.proposer,
    input.worldId,
    'proposals?limit=100',
    `enact ${input.title}`,
    (proposal) => proposal.proposalId === opened.proposalId && proposal.status === 'enacted',
  );
  const result = expectStatus(
    await browserRequest(
      input.proposer,
      `/worlds/${input.worldId}/governance/proposals/${opened.proposalId}/result`,
    ),
    200,
    `read ${input.title} result`,
  );
  if (
    enacted.turnoutCount !== input.voters.length ||
    result.certified !== true ||
    result.outcome !== 'passed' ||
    result.yesCount !== input.voters.length ||
    result.noCount !== 0
  ) {
    throw new Error(
      `${input.title} did not produce one exact certified enactment: ${JSON.stringify({ enacted, result })}.`,
    );
  }
  return { action, proposal: enacted, result, votingClosesAtTick };
}

await waitFor(`${api}/health/ready`, 200);
await waitFor(`${web}/health/live`, 200);
const info = await (await fetch(`${api}/api/v1/system/info`)).json();
if (
  info.codename !== 'Anvil' ||
  info.versions.contracts !== 10 ||
  info.versions.runtimeSchema !== 10 ||
  info.versions.authoritativeCommandSchema !== 1 ||
  info.versions.domainEventSchema !== 1 ||
  info.versions.ledgerSchema !== 1 ||
  info.versions.projectionSchema !== 1 ||
  info.versions.outboxSchema !== 1 ||
  info.versions.historySchema !== 1 ||
  info.versions.manifestSchema !== 1 ||
  info.versions.primitiveSchema !== 1 ||
  info.versions.compiler !== '1.3.0' ||
  info.versions.compilerConfigSchema !== 1 ||
  info.versions.compilerArtifactSchema !== 4 ||
  info.versions.worldGraphSchema !== 1 ||
  info.versions.compilationQueueSchema !== 1 ||
  info.versions.simulationBatchSchema !== 1 ||
  info.versions.simulationClockSchema !== 1 ||
  info.versions.simulationFailureSchema !== 1 ||
  info.versions.simulationOutcomeSchema !== 1 ||
  info.versions.simulationPrngAlgorithm !== 'xorshift32-sha256-v1' ||
  info.versions.simulationPrngSchema !== 1 ||
  info.versions.simulationProcessSchema !== 1 ||
  info.versions.simulationProcessRegistry !== 3 ||
  info.versions.simulationProjectionSchema !== 1 ||
  info.versions.simulationQueueSchema !== 1 ||
  info.versions.simulationScheduleSchema !== 1 ||
  info.versions.economySchema !== 1 ||
  info.versions.economySeedPlanSchema !== 2 ||
  info.versions.currencySchema !== 1 ||
  info.versions.walletSchema !== 1 ||
  info.versions.financialTransactionSchema !== 1 ||
  info.versions.assetSchema !== 1 ||
  info.versions.ownershipSchema !== 1 ||
  info.versions.assetTransferOfferSchema !== 1 ||
  info.versions.economyReconciliationSchema !== 3 ||
  info.versions.resourceTypeSchema !== 1 ||
  info.versions.productionRecipeSchema !== 1 ||
  info.versions.productionRecipeVersionSchema !== 1 ||
  info.versions.inventorySchema !== 1 ||
  info.versions.inventoryReservationSchema !== 1 ||
  info.versions.inventoryMovementSchema !== 1 ||
  info.versions.businessSchema !== 1 ||
  info.versions.businessFacilitySchema !== 1 ||
  info.versions.productionRunSchema !== 1 ||
  info.versions.employmentContractSchema !== 1 ||
  info.versions.workRecordSchema !== 1 ||
  info.versions.payrollRecordSchema !== 1 ||
  info.versions.marketListingSchema !== 1 ||
  info.versions.marketTradeSchema !== 1 ||
  info.versions.taxPolicySchema !== 1 ||
  info.versions.taxAssessmentSchema !== 1 ||
  info.versions.economyExpansionHeadSchema !== 1 ||
  info.versions.governanceSchema !== 1 ||
  info.versions.governancePolicySchema !== 1 ||
  info.versions.governanceSeedPlanSchema !== 1
) {
  throw new Error('System info did not match the public compatibility contract.');
}

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const password = 'Compose verification password! 2026';
const alice = new CookieJar();
const bob = new CookieJar();
const cora = new CookieJar();
const observer = new CookieJar();
const aliceRegistration = await browserRequest(alice, '/auth/register', {
  body: { displayName: 'Compose Alice', email: `alice-${run}@example.test`, password },
  method: 'POST',
});
expectStatus(aliceRegistration, 201, 'register Alice');
const aliceSetCookies = aliceRegistration.response.headers.getSetCookie();
if (
  !aliceSetCookies.some(
    (value) =>
      value.startsWith('wg_session=') &&
      value.includes('HttpOnly') &&
      value.includes('SameSite=Lax'),
  ) ||
  !aliceSetCookies.some((value) => value.startsWith('wg_csrf=') && !value.includes('HttpOnly'))
) {
  throw new Error('Authentication cookies did not preserve their required browser flags.');
}
expectStatus(
  await browserRequest(bob, '/auth/register', {
    body: { displayName: 'Compose Bob', email: `bob-${run}@example.test`, password },
    method: 'POST',
  }),
  201,
  'register Bob',
);
expectStatus(
  await browserRequest(cora, '/auth/register', {
    body: { displayName: 'Compose Cora', email: `cora-${run}@example.test`, password },
    method: 'POST',
  }),
  201,
  'register Cora',
);
expectStatus(
  await browserRequest(observer, '/auth/register', {
    body: { displayName: 'Compose Observer', email: `observer-${run}@example.test`, password },
    method: 'POST',
  }),
  201,
  'register observer',
);

const staleAlice = alice.clone();
expectStatus(
  await browserRequest(alice, '/auth/login', {
    body: { email: `ALICE-${run}@example.test`, password },
    method: 'POST',
  }),
  200,
  'rotate Alice session on login',
);
expectStatus(await browserRequest(staleAlice, '/auth/me'), 401, 'reject rotated Alice session');
expectStatus(await browserRequest(alice, '/auth/me'), 200, 'refresh Alice session');

const primitivePage = expectStatus(
  await browserRequest(alice, '/primitives?limit=100'),
  200,
  'browse starter primitives',
);
const harborPrimitiveKeys = [
  'worldgraph.production-recipe.metal-part-fabrication',
  'worldgraph.resource.iron-ore',
  'worldgraph.resource.metal-part',
];
const importedHarborPrimitiveKeys = primitivePage.items
  .filter((item) => harborPrimitiveKeys.includes(item.key))
  .map((item) => item.key)
  .sort();
if (
  primitivePage.items.length !== 20 ||
  primitivePage.nextCursor !== null ||
  JSON.stringify(importedHarborPrimitiveKeys) !== JSON.stringify(harborPrimitiveKeys)
) {
  throw new Error(
    'The exact starter, Harbor economy, and governance catalogs were not imported once.',
  );
}
const governmentPage = expectStatus(
  await browserRequest(alice, '/primitives?kinds=government&tags=city-state&limit=100'),
  200,
  'filter starter primitives before ranking',
);
if (
  governmentPage.items.length !== 1 ||
  governmentPage.items[0]?.key !== 'worldgraph.government.guild-council' ||
  governmentPage.items[0]?.version !== '1.0.0'
) {
  throw new Error('Primitive kind/tag filters did not return the pinned guild council version.');
}
const councilDetail = expectStatus(
  await browserRequest(alice, '/primitives/worldgraph.government.guild-council/versions/1.0.0'),
  200,
  'inspect an exact primitive version',
);
if (
  councilDetail.contentHash !== governmentPage.items[0].contentHash ||
  councilDetail.lifecycle !== 'published'
) {
  throw new Error('Exact primitive detail did not preserve publication identity and hash.');
}

const retrieval = expectStatus(
  await browserRequest(alice, '/primitive-retrievals', {
    body: {
      limit: 8,
      query: 'guild-led energy-scarce floating city with a council and closed-loop credits',
    },
    method: 'POST',
  }),
  200,
  'retrieve primitives with semantic indexing disabled',
);
const expectedRetrieval = [
  'worldgraph.government.guild-council',
  'worldgraph.currency.closed-loop-credits',
  'worldgraph.resource.energy',
  'worldgraph.district.floating-mixed-use',
  'worldgraph.visual-style.low-poly-floating-city',
  'worldgraph.organization.guild',
  'worldgraph.terrain.floating-platform',
  'worldgraph.production-recipe.energy-reclamation',
];
if (
  JSON.stringify(retrieval.results.map((result) => result.primitive.key)) !==
    JSON.stringify(expectedRetrieval) ||
  retrieval.provider.semanticAvailable !== false ||
  !retrieval.warnings.some((warning) => warning.code === 'SEMANTIC_PROVIDER_DISABLED')
) {
  throw new Error('Deterministic lexical fallback did not match the reviewed retrieval fixture.');
}

const created = expectStatus(
  await mutation(
    alice,
    '/worlds',
    'POST',
    { name: 'Floating Guild City', slug: `compose-${run}` },
    `world-${run}`,
  ),
  201,
  'create world',
);
const replayed = expectStatus(
  await mutation(
    alice,
    '/worlds',
    'POST',
    { name: 'Floating Guild City', slug: `compose-${run}` },
    `world-${run}`,
  ),
  201,
  'replay world creation',
);
if (created.world.id !== replayed.world.id) {
  throw new Error('Idempotent world creation did not replay the original world.');
}
const worldId = created.world.id;
expectStatus(await browserRequest(bob, `/worlds/${worldId}`), 404, 'hide an unjoined world');

const invitation = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/invitations`,
    'POST',
    { email: `bob-${run}@example.test`, expiresIn: 3600, role: 'player' },
    `invite-bob-${run}`,
  ),
  201,
  'invite Bob',
);
if (!invitation.rawToken || alice.header().includes(invitation.rawToken)) {
  throw new Error('Invitation token was missing or leaked into browser cookies.');
}
expectStatus(
  await mutation(
    bob,
    '/invitations/accept',
    'POST',
    { rawToken: invitation.rawToken },
    `accept-bob-${run}`,
  ),
  200,
  'accept Bob invitation',
);
const coraInvitation = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/invitations`,
    'POST',
    { email: `cora-${run}@example.test`, expiresIn: 3600, role: 'player' },
    `invite-cora-${run}`,
  ),
  201,
  'invite Cora',
);
expectStatus(
  await mutation(
    cora,
    '/invitations/accept',
    'POST',
    { rawToken: coraInvitation.rawToken },
    `accept-cora-${run}`,
  ),
  200,
  'accept Cora invitation',
);
expectStatus(
  await mutation(
    bob,
    `/worlds/${worldId}`,
    'PATCH',
    { expectedRowVersion: 1, name: 'Unauthorized rename' },
    `deny-rename-${run}`,
  ),
  403,
  'deny player rename',
);

const membershipPage = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}/memberships`),
  200,
  'list memberships',
);
const aliceId = expectStatus(await browserRequest(alice, '/auth/me'), 200, 'read Alice session')
  .user.id;
const bobId = expectStatus(await browserRequest(bob, '/auth/me'), 200, 'read Bob session').user.id;
const coraId = expectStatus(await browserRequest(cora, '/auth/me'), 200, 'read Cora session').user
  .id;
const bobMembership = membershipPage.items.find((item) => item.user.id === bobId);
if (!bobMembership) throw new Error('Bob membership was not visible to the creator.');
const promoted = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/memberships/${bobId}`,
    'PATCH',
    { expectedRowVersion: bobMembership.rowVersion, role: 'administrator' },
    `promote-bob-${run}`,
  ),
  200,
  'promote Bob',
);
const ordinaryInvitation = expectStatus(
  await mutation(
    bob,
    `/worlds/${worldId}/invitations`,
    'POST',
    { email: `observer-${run}@example.test`, expiresIn: 3600, role: 'observer' },
    `admin-invite-${run}`,
  ),
  201,
  'administrator invitation',
);
expectStatus(
  await mutation(
    bob,
    `/worlds/${worldId}/invitations/${ordinaryInvitation.invitation.id}/revoke`,
    'POST',
    undefined,
    `admin-revoke-${run}`,
  ),
  200,
  'administrator invitation revocation',
);
const observerInvitation = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/invitations`,
    'POST',
    { email: `observer-${run}@example.test`, expiresIn: 3600, role: 'observer' },
    `invite-observer-${run}`,
  ),
  201,
  'invite read-only observer',
);
expectStatus(
  await mutation(
    observer,
    '/invitations/accept',
    'POST',
    { rawToken: observerInvitation.rawToken },
    `accept-observer-${run}`,
  ),
  200,
  'accept read-only observer invitation',
);

const overrideBody = {
  action: 'membership.force_demote_administrator',
  confirmation: 'USE CREATOR OVERRIDE',
  expectedRowVersion: promoted.membership.rowVersion,
  reason: 'Compose verification of explicit administrator demotion.',
  targetUserId: bobId,
};
const overridden = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/creator-overrides`,
    'POST',
    overrideBody,
    `override-bob-${run}`,
  ),
  200,
  'creator override',
);
const overrideReplay = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/creator-overrides`,
    'POST',
    overrideBody,
    `override-bob-${run}`,
  ),
  200,
  'creator override replay',
);
if (overridden.override.auditRecordId !== overrideReplay.override.auditRecordId) {
  throw new Error('Creator override replay created a different audit record.');
}
const authorityAudit = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}/authority/audit`),
  200,
  'read authority audit',
);
if (!authorityAudit.items.some((item) => item.action === overrideBody.action)) {
  throw new Error('Creator override was absent from the authority audit.');
}

const manifestPrompt =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';
const manifestStart = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/manifest-generations`,
    'POST',
    { prompt: manifestPrompt, seed: 'compose-m04-golden' },
    `manifest-generate-${run}`,
  ),
  202,
  'start provider-disabled manifest generation',
);
const manifestReplay = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/manifest-generations`,
    'POST',
    { prompt: manifestPrompt, seed: 'compose-m04-golden' },
    `manifest-generate-${run}`,
  ),
  202,
  'replay manifest generation command',
);
if (manifestStart.runId !== manifestReplay.runId) {
  throw new Error('Manifest generation idempotency did not replay the durable run.');
}
const manifestRun = await waitForManifestRun(alice, manifestStart.runId);
if (
  manifestRun.status !== 'succeeded' ||
  manifestRun.outcome?.mode !== 'fallback' ||
  !manifestRun.outputRevisionId ||
  !manifestRun.catalogSnapshotHash ||
  !manifestRun.resolvedInputHash
) {
  throw new Error(
    `Provider-disabled manifest generation did not publish a resolved fallback: ${JSON.stringify(manifestRun)}`,
  );
}
const manifestDetail = expectStatus(
  await browserRequest(
    alice,
    `/worlds/${worldId}/manifest-revisions/${manifestRun.outputRevisionId}`,
  ),
  200,
  'inspect generated manifest revision',
);
if (
  manifestDetail.revision.contentHash.length !== 64 ||
  manifestDetail.revision.manifest.manifestSchemaVersion !== 1 ||
  manifestDetail.report?.valid !== true ||
  manifestDetail.provenance.entries.length === 0
) {
  throw new Error(
    'Generated manifest did not preserve valid schema, hash, report, and provenance.',
  );
}
const worldBeforeApproval = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}`),
  200,
  'read world before manifest approval',
).world;
const acknowledgedWarningCodes = [
  ...new Set(
    manifestDetail.report.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) => diagnostic.code),
  ),
].sort();
const approvedManifest = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/manifest-revisions/${manifestRun.outputRevisionId}/approve`,
    'POST',
    {
      acknowledgedWarningCodes,
      confirmationName: worldBeforeApproval.name,
      expectedContentHash: manifestDetail.revision.contentHash,
      expectedWorldVersion: worldBeforeApproval.rowVersion,
    },
    `manifest-approve-${run}`,
  ),
  200,
  'approve exact manifest revision',
);
const worldAfterApproval = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}`),
  200,
  'read world after manifest approval',
).world;
if (
  approvedManifest.revisionId !== manifestRun.outputRevisionId ||
  worldAfterApproval.currentApprovedManifestRevisionId !== manifestRun.outputRevisionId ||
  worldAfterApproval.manifestSchemaVersion !== 1
) {
  throw new Error('Manifest approval did not advance exactly one compatible world pointer.');
}

const compilationStart = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/compilations`,
    'POST',
    {
      expectedManifestHash: manifestDetail.revision.contentHash,
      manifestRevisionId: manifestRun.outputRevisionId,
      seed: 'compose-m05-golden',
    },
    `world-compile-${run}`,
  ),
  202,
  'start deterministic world compilation',
);
const compilationReplay = expectStatus(
  await mutation(
    alice,
    `/worlds/${worldId}/compilations`,
    'POST',
    {
      expectedManifestHash: manifestDetail.revision.contentHash,
      manifestRevisionId: manifestRun.outputRevisionId,
      seed: 'compose-m05-golden',
    },
    `world-compile-${run}`,
  ),
  202,
  'replay deterministic world compilation',
);
if (compilationStart.runId !== compilationReplay.runId) {
  throw new Error('Compilation idempotency did not replay the durable run.');
}
expectStatus(
  await browserRequest(bob, `/worlds/${worldId}/compilations/${compilationStart.runId}`),
  200,
  'allow an active member to read compilation progress',
);
const compilationRun = await waitForCompilationRun(alice, worldId, compilationStart.runId);
if (
  compilationRun.status !== 'succeeded' ||
  compilationRun.stage !== 'activated' ||
  !compilationRun.artifactHash ||
  compilationRun.compilerVersion !== '1.3.0' ||
  compilationRun.compilerConfigVersion !== 1
) {
  throw new Error(`World compilation did not activate exactly: ${JSON.stringify(compilationRun)}`);
}
const runtimeSummary = expectStatus(
  await browserRequest(bob, `/worlds/${worldId}/runtime-summary`),
  200,
  'read active runtime summary as a member',
);
if (
  runtimeSummary.artifactHash !== compilationRun.artifactHash ||
  runtimeSummary.compilerVersion !== '1.3.0' ||
  runtimeSummary.compilerConfigVersion !== 1 ||
  runtimeSummary.entityCount < 35 ||
  runtimeSummary.relationshipCount < 40 ||
  runtimeSummary.controllerCount !== 3 ||
  runtimeSummary.stateRevision !== 2 ||
  runtimeSummary.lastLedgerSequence !== 2
) {
  throw new Error(
    `Runtime summary did not match the activated graph: ${JSON.stringify(runtimeSummary)}`,
  );
}
const compiledArtifact = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}/compilations/${compilationStart.runId}/artifact`),
  200,
  'download and verify compiled artifact',
);
expectExactKeys(
  compiledArtifact,
  ['artifactKind', 'artifactSchemaVersion', 'canonicalBytes', 'contentHash', 'inputHash', 'world'],
  'Compiled artifact wrapper',
);
expectExactKeys(
  compiledArtifact.world,
  [
    'artifactSchemaVersion',
    'compilerConfigVersion',
    'compilerVersion',
    'controllers',
    'counts',
    'economySeedPlan',
    'economySeedPlanHash',
    'entities',
    'governanceSeedPlan',
    'governanceSeedPlanHash',
    'inputHash',
    'manifestContentHash',
    'manifestSchemaVersion',
    'metadata',
    'relationships',
    'seed',
    'visualPlan',
    'worldGraphSchemaVersion',
  ],
  'Compiled world V4',
);
const parsedCanonicalWorld = JSON.parse(compiledArtifact.canonicalBytes);
const computedArtifactHash = createHash('sha256')
  .update(compiledArtifact.canonicalBytes, 'utf8')
  .digest('hex');
const seedPlan = compiledArtifact.world.economySeedPlan;
const seedShape = assertExactEconomySeedPlan(seedPlan);
const computedSeedPlanHash = createHash('sha256')
  .update(canonicalJson({ domain: 'worldgraph.economy-seed-plan.v2', plan: seedPlan }), 'utf8')
  .digest('hex');
const governanceSeedPlan = compiledArtifact.world.governanceSeedPlan;
const computedGovernanceSeedPlanHash = createHash('sha256')
  .update(
    canonicalJson({
      domain: 'worldgraph.governance-seed-plan.v1',
      value: governanceSeedPlan,
    }),
    'utf8',
  )
  .digest('hex');
const controllerEntityKeys = compiledArtifact.world.controllers
  .map((controller) => controller.entityLogicalKey)
  .sort();
const aliceController = compiledArtifact.world.controllers.find(
  (controller) => controller.principalKey === memberPrincipalKey(worldId, aliceId),
);
const bobController = compiledArtifact.world.controllers.find(
  (controller) => controller.principalKey === memberPrincipalKey(worldId, bobId),
);
const coraController = compiledArtifact.world.controllers.find(
  (controller) => controller.principalKey === memberPrincipalKey(worldId, coraId),
);
const playerWalletOwnerKeys = seedShape.playerWallets
  .map((wallet) => wallet.ownerEntityLogicalKey)
  .sort();
const creatorCharacters = compiledArtifact.world.entities.filter(
  (entity) => entity.entityType === 'player_character' && entity.state.membershipRole === 'creator',
);
if (
  compiledArtifact.artifactKind !== 'compiled_world' ||
  compiledArtifact.artifactSchemaVersion !== 4 ||
  compiledArtifact.world.artifactSchemaVersion !== 4 ||
  compiledArtifact.world.compilerVersion !== '1.3.0' ||
  compiledArtifact.world.compilerConfigVersion !== 1 ||
  compiledArtifact.inputHash !== compiledArtifact.world.inputHash ||
  compiledArtifact.canonicalBytes !== canonicalJson(parsedCanonicalWorld) ||
  canonicalJson(parsedCanonicalWorld) !== canonicalJson(compiledArtifact.world) ||
  computedArtifactHash !== compiledArtifact.contentHash ||
  compiledArtifact.contentHash !== compilationRun.artifactHash ||
  !/^[a-f0-9]{64}$/u.test(compiledArtifact.world.economySeedPlanHash) ||
  computedSeedPlanHash !== compiledArtifact.world.economySeedPlanHash ||
  governanceSeedPlan?.governanceSeedPlanSchemaVersion !== 1 ||
  !/^[a-f0-9]{64}$/u.test(compiledArtifact.world.governanceSeedPlanHash) ||
  computedGovernanceSeedPlanHash !== compiledArtifact.world.governanceSeedPlanHash ||
  runtimeSummary.entityCount !== compiledArtifact.world.counts.entities ||
  runtimeSummary.relationshipCount !== compiledArtifact.world.counts.relationships ||
  runtimeSummary.controllerCount !== compiledArtifact.world.counts.controllers ||
  compiledArtifact.world.entities.length !== compiledArtifact.world.counts.entities ||
  compiledArtifact.world.relationships.length !== compiledArtifact.world.counts.relationships ||
  compiledArtifact.world.controllers.length !== compiledArtifact.world.counts.controllers ||
  !aliceController ||
  !bobController ||
  !coraController ||
  new Set([
    aliceController.entityLogicalKey,
    bobController.entityLogicalKey,
    coraController.entityLogicalKey,
  ]).size !== 3 ||
  JSON.stringify(controllerEntityKeys) !== JSON.stringify(playerWalletOwnerKeys) ||
  creatorCharacters.length !== 1 ||
  creatorCharacters[0].logicalKey !== seedShape.asset.initialOwnerEntityLogicalKey ||
  compiledArtifact.canonicalBytes.includes(aliceId) ||
  compiledArtifact.canonicalBytes.includes(bobId) ||
  compiledArtifact.canonicalBytes.includes(coraId) ||
  compiledArtifact.canonicalBytes.includes(`alice-${run}@example.test`) ||
  compiledArtifact.canonicalBytes.includes(`bob-${run}@example.test`) ||
  compiledArtifact.canonicalBytes.includes(`cora-${run}@example.test`) ||
  compiledArtifact.canonicalBytes.includes(manifestPrompt)
) {
  throw new Error(
    `Compiled V4 artifact, economy/governance seed plans, graph counts, or privacy boundary failed: ${JSON.stringify(
      {
        artifactHash: {
          computed: computedArtifactHash,
          run: compilationRun.artifactHash,
          wrapper: compiledArtifact.contentHash,
        },
        artifactKind: compiledArtifact.artifactKind,
        artifactSchemaVersion: compiledArtifact.artifactSchemaVersion,
        canonicalBytesMatchParsed:
          compiledArtifact.canonicalBytes === canonicalJson(parsedCanonicalWorld),
        controllersFound: {
          alice: Boolean(aliceController),
          bob: Boolean(bobController),
          cora: Boolean(coraController),
        },
        controllerEntityKeys,
        creatorCharacterKeys: creatorCharacters.map((entity) => entity.logicalKey),
        economySeedPlanHash: {
          computed: computedSeedPlanHash,
          world: compiledArtifact.world.economySeedPlanHash,
        },
        foundingAssetOwner: seedShape.asset.initialOwnerEntityLogicalKey,
        governanceSeedPlanHash: {
          computed: computedGovernanceSeedPlanHash,
          world: compiledArtifact.world.governanceSeedPlanHash,
        },
        inputHashMatches: compiledArtifact.inputHash === compiledArtifact.world.inputHash,
        playerWalletOwnerKeys,
        privacyLeakDetected:
          compiledArtifact.canonicalBytes.includes(aliceId) ||
          compiledArtifact.canonicalBytes.includes(bobId) ||
          compiledArtifact.canonicalBytes.includes(coraId) ||
          compiledArtifact.canonicalBytes.includes(`alice-${run}@example.test`) ||
          compiledArtifact.canonicalBytes.includes(`bob-${run}@example.test`) ||
          compiledArtifact.canonicalBytes.includes(`cora-${run}@example.test`) ||
          compiledArtifact.canonicalBytes.includes(manifestPrompt),
        runtimeCounts: {
          controllers: runtimeSummary.controllerCount,
          entities: runtimeSummary.entityCount,
          relationships: runtimeSummary.relationshipCount,
        },
        worldCounts: compiledArtifact.world.counts,
        worldLengths: {
          controllers: compiledArtifact.world.controllers.length,
          entities: compiledArtifact.world.entities.length,
          relationships: compiledArtifact.world.relationships.length,
        },
        worldMatchesCanonical:
          canonicalJson(parsedCanonicalWorld) === canonicalJson(compiledArtifact.world),
        worldSchemaVersion: compiledArtifact.world.artifactSchemaVersion,
      },
    )}.`,
  );
}
const districts = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}/entities?entityType=district&limit=100`),
  200,
  'browse authoritative districts',
);
const district = districts.items.find((item) => item.logicalKey === 'district:civic-platform');
if (!district || districts.runtime.activeWorldVersionId !== runtimeSummary.activeWorldVersionId) {
  throw new Error('The seeded district or graph revision metadata was missing.');
}
const controls = expectStatus(
  await browserRequest(
    alice,
    `/worlds/${worldId}/relationships?relationshipType=account_controls&limit=100`,
  ),
  200,
  'browse account control relationships',
);
if (controls.items.length !== 3) {
  throw new Error('Every playable member did not receive exactly one account control edge.');
}
const districtNeighbors = expectStatus(
  await browserRequest(
    alice,
    `/worlds/${worldId}/entities/${encodeURIComponent(district.logicalKey)}/neighbors?limit=100`,
  ),
  200,
  'inspect bounded typed district neighbors',
);
const neighborTypes = new Set(
  districtNeighbors.items.map((item) => item.relationship.relationshipType),
);
if (!neighborTypes.has('located_in') || !neighborTypes.has('governs')) {
  throw new Error('Expected located_in and governs district relationships were missing.');
}

let simulation = await readSimulationClock(alice, worldId);
if (
  simulation.clock.currentTick !== '0' ||
  simulation.clock.mode !== 'paused' ||
  simulation.clock.outcomeHash.length !== 64 ||
  simulation.stateRevision !== '2'
) {
  throw new Error(`Fresh simulation state was invalid: ${JSON.stringify(simulation)}`);
}
await submitSimulationCommand(
  alice,
  worldId,
  simulationCommand(
    simulation,
    'ConfigureWorldClockV1',
    {
      epoch: simulation.clock.configuration.epochAt,
      maxBatch: 64,
      maxCatchUp: 256,
      wallCadenceMs: 100,
      worldMillisecondsPerTick: simulation.clock.configuration.worldMillisecondsPerTick,
    },
    `simulation-configure-${run}`,
  ),
);
simulation = await readSimulationClock(alice, worldId);
const scheduleCommand = simulationCommand(
  simulation,
  'ScheduleWorldNoticeV1',
  { dueTick: '3', priority: -2, text: 'Guild Founding Day', visibility: 'member' },
  `simulation-schedule-${run}`,
  '0',
);
const scheduleAccepted = await submitSimulationCommand(alice, worldId, scheduleCommand);
const scheduleReplay = await submitSimulationCommand(alice, worldId, scheduleCommand);
if (
  scheduleAccepted.commandId !== scheduleReplay.commandId ||
  scheduleAccepted.resultingStateRevision !== scheduleReplay.resultingStateRevision
) {
  throw new Error('Simulation schedule command did not replay its exact accepted result.');
}

for (let tick = 1; tick <= 3; tick += 1) {
  simulation = await readSimulationClock(alice, worldId);
  await submitSimulationCommand(
    alice,
    worldId,
    simulationCommand(
      simulation,
      'AdvanceSimulationV1',
      { ticks: 1 },
      `simulation-advance-${tick}-${run}`,
    ),
  );
}
simulation = await readSimulationClock(alice, worldId);
const schedulePage = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}/simulation/schedule?limit=100`),
  200,
  'read simulation schedule',
);
const noticeAction = schedulePage.items.find(
  (item) => item.createdCommandId === scheduleCommand.commandId,
);
if (
  simulation.clock.currentTick !== '3' ||
  simulation.clock.mode !== 'paused' ||
  simulation.lastBatch?.toTick !== '3' ||
  simulation.lastBatch?.outcomeHash !== simulation.clock.outcomeHash ||
  !noticeAction ||
  noticeAction.status !== 'completed' ||
  !noticeAction.completedEventId
) {
  throw new Error(
    `Tick-three notice did not execute exactly with its batch: ${JSON.stringify({ noticeAction, simulation })}`,
  );
}

const historyDeadline = Date.now() + 15_000;
let noticeHistory = null;
while (!noticeHistory && Date.now() < historyDeadline) {
  const history = expectStatus(
    await browserRequest(
      alice,
      `/worlds/${worldId}/history?eventType=WorldNoticeEmittedV1&limit=10`,
    ),
    200,
    'read emitted notice history',
  );
  noticeHistory = history.items.find((item) => item.targetId === noticeAction.id) ?? null;
  if (!noticeHistory) await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!noticeHistory || JSON.stringify(noticeHistory).includes('Guild Founding Day')) {
  throw new Error('Notice execution history was missing or leaked notice text.');
}

const initializeGovernanceCommand = {
  commandId: randomUUID(),
  expectedAggregateVersion: '0',
  expectedStateRevision: simulation.stateRevision,
  expectedTick: simulation.clock.currentTick,
  expectedWorldVersion: simulation.designVersion,
  idempotencyKey: `governance-initialize-${run}`,
  payload: {
    compiledWorldVersionId: runtimeSummary.activeWorldVersionId,
    seedPlanHash: compiledArtifact.world.governanceSeedPlanHash,
  },
  schemaVersion: 1,
  type: 'InitializeWorldGovernanceV1',
};
const initializedGovernance = expectStatus(
  await commandMutation(alice, worldId, initializeGovernanceCommand),
  200,
  'InitializeWorldGovernanceV1',
);
const initializedGovernanceReplay = expectStatus(
  await commandMutation(alice, worldId, initializeGovernanceCommand),
  200,
  'replay InitializeWorldGovernanceV1',
);
if (
  initializedGovernance.status !== 'accepted' ||
  initializedGovernance.eventIds.length !== 25 ||
  JSON.stringify(initializedGovernanceReplay) !== JSON.stringify(initializedGovernance)
) {
  throw new Error(
    `Governance initialization/replay was not exact: ${JSON.stringify(initializedGovernance)}.`,
  );
}
const [governanceCharter, governanceInstitutions, governanceOffices] = await Promise.all([
  browserRequest(alice, `/worlds/${worldId}/governance/charter`),
  browserRequest(bob, `/worlds/${worldId}/governance/institutions?limit=100`),
  browserRequest(observer, `/worlds/${worldId}/governance/offices?limit=100`),
]);
const charter = expectStatus(governanceCharter, 200, 'read initialized governance charter');
const institutions = expectStatus(
  governanceInstitutions,
  200,
  'read governance institutions as a player',
);
const offices = expectStatus(governanceOffices, 200, 'read governance offices as an observer');
if (
  charter.title !== 'Harbor City Civic Charter' ||
  !/^[a-f0-9]{64}$/u.test(charter.checksum) ||
  institutions.items.length !== 1 ||
  offices.items.length !== 2 ||
  institutions.page.nextCursor !== null ||
  offices.page.nextCursor !== null
) {
  throw new Error('Initialized governance charter, institution, or office projection was invalid.');
}

const institution = institutions.items[0];
const treasurerOffice = offices.items.find(
  (office) => office.stableKey === 'office:guild-council:treasurer',
);
const initialElections = await readGovernancePage(
  alice,
  worldId,
  'elections?limit=100',
  'read initialized governance elections',
);
const selectedElection = initialElections.items.find(
  (election) =>
    election.officeId === treasurerOffice?.officeId && election.status === 'nominations_open',
);
if (!institution || !treasurerOffice || !selectedElection || !aliceController) {
  throw new Error(
    'The real governance demo could not resolve its institution, office, election, or actor.',
  );
}

let governanceClock = await readSimulationClock(alice, worldId);
const nominationCommand = governanceCommand(
  governanceClock,
  'NominateCandidateV1',
  {
    candidateEntityKey: aliceController.entityLogicalKey,
    electionId: selectedElection.electionId,
    expectedElectionVersion: selectedElection.aggregateVersion,
    officeId: selectedElection.officeId,
    statement: 'Keep public funds auditable and every exercise of office authority bounded.',
  },
  selectedElection.aggregateVersion,
  `governance-nominate-alice-${run}`,
);
await submitGovernanceCommand(alice, worldId, nominationCommand);
let aliceCandidacy = await waitForGovernanceItem(
  alice,
  worldId,
  `elections/${selectedElection.electionId}/candidates?limit=100`,
  'read nominated Treasurer candidate',
  (candidate) =>
    candidate.candidateEntityKey === aliceController.entityLogicalKey &&
    candidate.status === 'nominated',
);
governanceClock = await readSimulationClock(alice, worldId);
await submitGovernanceCommand(
  alice,
  worldId,
  governanceCommand(
    governanceClock,
    'AcceptNominationV1',
    {
      candidacyId: aliceCandidacy.candidacyId,
      electionId: selectedElection.electionId,
      expectedCandidacyVersion: aliceCandidacy.aggregateVersion,
      expectedElectionVersion: selectedElection.aggregateVersion,
    },
    aliceCandidacy.aggregateVersion,
    `governance-accept-alice-${run}`,
  ),
);
aliceCandidacy = await waitForGovernanceItem(
  alice,
  worldId,
  `elections/${selectedElection.electionId}/candidates?limit=100`,
  'read accepted Treasurer candidate',
  (candidate) =>
    candidate.candidacyId === aliceCandidacy.candidacyId && candidate.status === 'accepted',
);

governanceClock = await readSimulationClock(alice, worldId);
const proposalSponsorshipEndsAtTick = (
  BigInt(governanceClock.clock.currentTick) + BigInt(charter.proposalRules.sponsorshipTicks)
).toString();
const proposalDebateEndsAtTick = (
  BigInt(proposalSponsorshipEndsAtTick) + BigInt(charter.proposalRules.debateTicks)
).toString();
const proposalVotingOpensAtTick = proposalDebateEndsAtTick;
const proposalVotingClosesAtTick = (
  BigInt(proposalVotingOpensAtTick) + BigInt(charter.proposalRules.votingTicks)
).toString();
const publicProposalCommand = governanceCommand(
  governanceClock,
  'CreateProposalV1',
  {
    action: {
      actionSchemaVersion: 1,
      actionType: 'create_law',
      effectiveFromTick: proposalVotingClosesAtTick,
      effectiveUntilTick: null,
      lawKey: `law:compose-harbor-safety-${run}`,
      policy: { kind: 'membership_role', role: 'player' },
      summary: 'Establishes a versioned harbor-safety authority rule through a real public ballot.',
      targetCharterVersion: charter.version,
      title: 'Compose Harbor Safety',
    },
    approvalThresholdBps: charter.proposalRules.approvalThresholdBps,
    ballotPolicy: charter.proposalRules.ballotPolicy,
    body: 'Three independent accounts exercise the compiled charter and deterministic tally path.',
    debateEndsAtTick: proposalDebateEndsAtTick,
    institutionId: institution.institutionId,
    jurisdictionEntityKey: institution.jurisdictionEntityKey,
    minimumSponsors: charter.proposalRules.minimumSponsors,
    proposalKey: `proposal:compose-harbor-safety-${run}`,
    quorumBps: charter.proposalRules.quorumBps,
    sponsorshipEndsAtTick: proposalSponsorshipEndsAtTick,
    targetCharterVersion: charter.version,
    title: 'Compose Harbor Safety Proposal',
    votingClosesAtTick: proposalVotingClosesAtTick,
    votingOpensAtTick: proposalVotingOpensAtTick,
  },
  '0',
  `governance-create-public-proposal-${run}`,
);
await submitGovernanceCommand(alice, worldId, publicProposalCommand);
const scheduledPublicProposal = await waitForGovernanceItem(
  alice,
  worldId,
  'proposals?limit=100',
  'read debating public proposal',
  (proposal) => proposal.title === 'Compose Harbor Safety Proposal' && proposal.status === 'debate',
);

await advanceSimulationTo(
  alice,
  worldId,
  proposalVotingOpensAtTick,
  `governance-advance-proposal-open-${run}`,
);
const openedPublicProposal = await waitForGovernanceItem(
  alice,
  worldId,
  'proposals?limit=100',
  'wait for public proposal voting',
  (proposal) =>
    proposal.proposalId === scheduledPublicProposal.proposalId && proposal.status === 'open',
);
if (
  openedPublicProposal.eligibleCount !== 3 ||
  !openedPublicProposal.eligibilitySnapshotId ||
  openedPublicProposal.ballotPolicy.ballotMode !== 'public' ||
  openedPublicProposal.ballotPolicy.disclosure !== 'choice_totals' ||
  openedPublicProposal.ballotPolicy.replacementAllowed !== true
) {
  throw new Error(
    `The public proposal snapshot was not exact: ${JSON.stringify(openedPublicProposal)}.`,
  );
}

governanceClock = await readSimulationClock(alice, worldId);
const firstAliceBallot = governanceCommand(
  governanceClock,
  'CastProposalBallotV1',
  {
    choice: 'no',
    eligibilitySnapshotId: openedPublicProposal.eligibilitySnapshotId,
    expectedProposalVersion: openedPublicProposal.aggregateVersion,
    proposalId: openedPublicProposal.proposalId,
    replaceExisting: false,
  },
  openedPublicProposal.aggregateVersion,
  `governance-public-ballot-alice-first-${run}`,
);
const firstAliceBallotResult = await submitGovernanceCommand(alice, worldId, firstAliceBallot);
const firstAliceBallotReplay = await submitGovernanceCommand(alice, worldId, firstAliceBallot);
if (JSON.stringify(firstAliceBallotReplay) !== JSON.stringify(firstAliceBallotResult)) {
  throw new Error('The first public ballot did not replay its exact durable result.');
}

governanceClock = await readSimulationClock(alice, worldId);
await submitGovernanceCommand(
  alice,
  worldId,
  governanceCommand(
    governanceClock,
    'CastProposalBallotV1',
    {
      choice: 'yes',
      eligibilitySnapshotId: openedPublicProposal.eligibilitySnapshotId,
      expectedProposalVersion: openedPublicProposal.aggregateVersion,
      proposalId: openedPublicProposal.proposalId,
      replaceExisting: true,
    },
    openedPublicProposal.aggregateVersion,
    `governance-public-ballot-alice-replacement-${run}`,
  ),
);
for (const [label, voter] of [
  ['bob', bob],
  ['cora', cora],
]) {
  governanceClock = await readSimulationClock(voter, worldId);
  await submitGovernanceCommand(
    voter,
    worldId,
    governanceCommand(
      governanceClock,
      'CastProposalBallotV1',
      {
        choice: 'yes',
        eligibilitySnapshotId: openedPublicProposal.eligibilitySnapshotId,
        expectedProposalVersion: openedPublicProposal.aggregateVersion,
        proposalId: openedPublicProposal.proposalId,
        replaceExisting: false,
      },
      openedPublicProposal.aggregateVersion,
      `governance-public-ballot-${label}-${run}`,
    ),
  );
}
governanceClock = await readSimulationClock(observer, worldId);
const observerBallot = governanceCommand(
  governanceClock,
  'CastProposalBallotV1',
  {
    choice: 'yes',
    eligibilitySnapshotId: openedPublicProposal.eligibilitySnapshotId,
    expectedProposalVersion: openedPublicProposal.aggregateVersion,
    proposalId: openedPublicProposal.proposalId,
    replaceExisting: false,
  },
  openedPublicProposal.aggregateVersion,
  `governance-public-ballot-observer-denied-${run}`,
);
const observerBallotDenied = expectStatus(
  await commandMutation(observer, worldId, observerBallot),
  403,
  'deny observer governance ballot',
);
if (
  observerBallotDenied.status !== 'rejected' ||
  observerBallotDenied.rejectionCode !== 'AUTHORIZATION_DENIED'
) {
  throw new Error(
    `Observer ballot denial was not durable and explicit: ${JSON.stringify(observerBallotDenied)}.`,
  );
}
const replacedReceipt = expectStatus(
  await browserRequest(
    alice,
    `/worlds/${worldId}/governance/proposals/${openedPublicProposal.proposalId}/receipt`,
  ),
  200,
  'read replaced public ballot receipt',
);
if (replacedReceipt.ballotMode !== 'public' || replacedReceipt.choice !== 'yes') {
  throw new Error(
    `The effective public ballot was not the replacement: ${JSON.stringify(replacedReceipt)}.`,
  );
}

await advanceSimulationTo(
  alice,
  worldId,
  proposalVotingClosesAtTick,
  `governance-advance-proposal-close-${run}`,
);
const enactedPublicProposal = await waitForGovernanceItem(
  alice,
  worldId,
  'proposals?limit=100',
  'wait for public proposal enactment',
  (proposal) =>
    proposal.proposalId === openedPublicProposal.proposalId && proposal.status === 'enacted',
);
const publicProposalResult = expectStatus(
  await browserRequest(
    alice,
    `/worlds/${worldId}/governance/proposals/${openedPublicProposal.proposalId}/result`,
  ),
  200,
  'read certified public proposal result',
);
const enactedLaws = await readGovernancePage(
  observer,
  worldId,
  'laws?limit=100',
  'read enacted law as observer',
);
const publicSafetyLaw = enactedLaws.items.find(
  (law) => law.stableKey === `law:compose-harbor-safety-${run}`,
);
if (
  enactedPublicProposal.turnoutCount !== 3 ||
  publicProposalResult.outcome !== 'passed' ||
  publicProposalResult.certified !== true ||
  publicProposalResult.yesCount !== 3 ||
  publicProposalResult.noCount !== 0 ||
  !publicSafetyLaw ||
  publicSafetyLaw.status !== 'active' ||
  publicSafetyLaw.effectiveFromTick !== proposalVotingClosesAtTick
) {
  throw new Error(
    `The real proposal tally or law enactment was not exact: ${JSON.stringify({
      enactedPublicProposal,
      publicProposalResult,
    })}.`,
  );
}

await advanceSimulationTo(
  alice,
  worldId,
  selectedElection.votingOpensAtTick,
  `governance-advance-election-open-${run}`,
);
const openedElection = await waitForGovernanceItem(
  alice,
  worldId,
  'elections?limit=100',
  'wait for secret Treasurer election',
  (election) => election.electionId === selectedElection.electionId && election.status === 'open',
);
if (
  openedElection.eligibleCount !== 3 ||
  !openedElection.eligibilitySnapshotId ||
  openedElection.ballotPolicy.ballotMode !== 'secret' ||
  openedElection.ballotPolicy.disclosure !== 'aggregate_only' ||
  openedElection.ballotPolicy.replacementAllowed !== false
) {
  throw new Error(`The secret election snapshot was not exact: ${JSON.stringify(openedElection)}.`);
}
for (const [label, voter] of [
  ['alice', alice],
  ['bob', bob],
  ['cora', cora],
]) {
  governanceClock = await readSimulationClock(voter, worldId);
  await submitGovernanceCommand(
    voter,
    worldId,
    governanceCommand(
      governanceClock,
      'CastElectionBallotV1',
      {
        choice: {
          candidateKey: aliceController.entityLogicalKey,
          choiceType: 'candidate',
        },
        electionId: openedElection.electionId,
        eligibilitySnapshotId: openedElection.eligibilitySnapshotId,
        expectedElectionVersion: openedElection.aggregateVersion,
        replaceExisting: false,
      },
      openedElection.aggregateVersion,
      `governance-secret-election-ballot-${label}-${run}`,
    ),
  );
}
const secretElectionReceipt = expectStatus(
  await browserRequest(
    cora,
    `/worlds/${worldId}/governance/elections/${openedElection.electionId}/receipt`,
  ),
  200,
  'read secret election receipt',
);
if (
  secretElectionReceipt.ballotMode !== 'secret' ||
  Object.hasOwn(secretElectionReceipt, 'choice') ||
  JSON.stringify(secretElectionReceipt).includes(aliceController.entityLogicalKey)
) {
  throw new Error(
    `The secret election receipt leaked a selection: ${JSON.stringify(secretElectionReceipt)}.`,
  );
}

await advanceSimulationTo(
  alice,
  worldId,
  openedElection.votingClosesAtTick,
  `governance-advance-election-close-${run}`,
);
const certifiedElection = await waitForGovernanceItem(
  alice,
  worldId,
  'elections?limit=100',
  'wait for Treasurer election certification',
  (election) =>
    election.electionId === openedElection.electionId && election.status === 'certified',
);
const certifiedElectionResult = expectStatus(
  await browserRequest(
    observer,
    `/worlds/${worldId}/governance/elections/${openedElection.electionId}/result`,
  ),
  200,
  'read certified Treasurer election result',
);
const certifiedTerms = await readGovernancePage(
  observer,
  worldId,
  'terms?limit=100',
  'read certified office term',
);
const successorElections = await readGovernancePage(
  observer,
  worldId,
  'elections?limit=100',
  'read scheduled successor Treasurer election',
);
const successorElection = successorElections.items.find(
  (election) =>
    election.officeId === openedElection.officeId &&
    election.electionId !== openedElection.electionId &&
    election.votingOpensAtTick === (BigInt(openedElection.votingOpensAtTick) + 48n).toString(),
);
const electedTermEndsAtTick = (
  BigInt(openedElection.votingClosesAtTick) + BigInt(treasurerOffice.termDurationTicks)
).toString();
if (
  certifiedElection.turnoutCount !== 3 ||
  certifiedElectionResult.certified !== true ||
  certifiedElectionResult.outcome !== 'elected' ||
  certifiedElectionResult.winnerCandidateKey !== aliceController.entityLogicalKey ||
  certifiedElectionResult.candidateTotals.length !== 1 ||
  certifiedElectionResult.candidateTotals[0]?.voteCount !== 3 ||
  !successorElection ||
  successorElection.status !== 'nominations_scheduled' ||
  successorElection.votingClosesAtTick !==
    (BigInt(openedElection.votingClosesAtTick) + 48n).toString() ||
  successorElection.ballotPolicy.ballotMode !== 'secret' ||
  successorElection.ballotPolicy.disclosure !== 'aggregate_only' ||
  successorElection.ballotPolicy.replacementAllowed !== false ||
  !certifiedTerms.items.some(
    (term) =>
      term.sourceId === certifiedElectionResult.resultId &&
      term.sourceType === 'election' &&
      term.holderEntityKey === aliceController.entityLogicalKey &&
      term.startsAtTick === openedElection.votingClosesAtTick &&
      term.endsAtTick === electedTermEndsAtTick &&
      term.status === 'active',
  )
) {
  throw new Error(
    `The real secret election or term transition was not exact: ${JSON.stringify({
      certifiedElection,
      certifiedElectionResult,
    })}.`,
  );
}

simulation = await readSimulationClock(alice, worldId);

const economyBeforeInitialization = await readEconomySummary(alice, worldId);
if (
  economyBeforeInitialization.status !== 'not_initialized' ||
  economyBeforeInitialization.economyHeadVersion !== null ||
  economyBeforeInitialization.currentTick !== '27' ||
  economyBeforeInitialization.designVersion !== String(runtimeSummary.worldVersionNumber) ||
  economyBeforeInitialization.stateRevision !== simulation.stateRevision ||
  economyBeforeInitialization.seedPlan.available !== true ||
  economyBeforeInitialization.seedPlan.hash !== compiledArtifact.world.economySeedPlanHash ||
  economyBeforeInitialization.seedPlan.sourceKind !== 'compiler_1_2' ||
  economyBeforeInitialization.capabilities.canInitialize !== true ||
  economyBeforeInitialization.virtualValueBoundary.noCashValue !== true ||
  economyBeforeInitialization.virtualValueBoundary.cashOutAllowed !== false
) {
  throw new Error(
    `Pre-initialization economy state was invalid: ${JSON.stringify(economyBeforeInitialization)}.`,
  );
}
const initializeEconomy = economyCommand(
  economyBeforeInitialization,
  'InitializeWorldEconomyV1',
  {
    compiledWorldVersionId: runtimeSummary.activeWorldVersionId,
    seedPlanHash: compiledArtifact.world.economySeedPlanHash,
  },
  `economy-initialize-${run}`,
);
const initializedEconomy = await submitEconomyCommand(alice, worldId, initializeEconomy);
if (
  initializedEconomy.eventIds.length !== 1 ||
  BigInt(initializedEconomy.resultingStateRevision) !==
    BigInt(economyBeforeInitialization.stateRevision) + 1n
) {
  throw new Error(
    `Economy initialization receipt was invalid: ${JSON.stringify(initializedEconomy)}.`,
  );
}

let economySummary = await readEconomySummary(alice, worldId);
const currencyPage = expectStatus(
  await browserRequest(alice, `/worlds/${worldId}/economy/currencies`),
  200,
  'read initialized economy currency',
);
let aliceWallet = await onlyControlledPlayerWallet(alice, worldId, 'Alice');
let bobWallet = await onlyControlledPlayerWallet(bob, worldId, 'Bob');
if (
  economySummary.status !== 'reconciling' ||
  economySummary.economyHeadVersion !== '1' ||
  economySummary.stateRevision !== initializedEconomy.resultingStateRevision ||
  economySummary.reconciliation.status !== 'reconciling' ||
  economySummary.issuanceTarget?.currencyCode !== 'GCR' ||
  economySummary.issuanceTarget.currentSupplyMinor !== '30000' ||
  economySummary.issuanceTarget.treasuryBalanceMinor !== '0' ||
  currencyPage.items.length !== 1 ||
  currencyPage.nextCursor !== null ||
  currencyPage.items[0].currency.code !== 'GCR' ||
  currencyPage.items[0].currency.stableKey !== 'currency:gcr' ||
  currencyPage.items[0].currency.minorUnitScale !== 2 ||
  currencyPage.items[0].currency.noCashValue !== true ||
  currencyPage.items[0].currency.cashOutAllowed !== false ||
  currencyPage.items[0].currentSupplyMinor !== '30000' ||
  aliceWallet.wallet.walletKind !== 'player' ||
  bobWallet.wallet.walletKind !== 'player' ||
  aliceWallet.wallet.currencyId !== currencyPage.items[0].currency.id ||
  bobWallet.wallet.currencyId !== currencyPage.items[0].currency.id ||
  aliceWallet.balance.availableMinor !== '10000' ||
  bobWallet.balance.availableMinor !== '10000' ||
  aliceWallet.balance.rowVersion !== '1' ||
  bobWallet.balance.rowVersion !== '1' ||
  aliceWallet.wallet.ownerEntityLogicalKey !== seedShape.asset.initialOwnerEntityLogicalKey ||
  bobWallet.wallet.ownerEntityLogicalKey === aliceWallet.wallet.ownerEntityLogicalKey
) {
  throw new Error(
    `Economy initialization did not materialize the exact seed: ${JSON.stringify({ aliceWallet, bobWallet, currencyPage, economySummary })}.`,
  );
}
expectStatus(
  await browserRequest(
    alice,
    `/worlds/${worldId}/economy/wallets/${encodeURIComponent(bobWallet.wallet.id)}/transactions?limit=100`,
  ),
  404,
  'hide Bob wallet history from creator Alice',
);
expectStatus(
  await browserRequest(
    bob,
    `/worlds/${worldId}/economy/wallets/${encodeURIComponent(aliceWallet.wallet.id)}/transactions?limit=100`,
  ),
  404,
  'hide Alice wallet history from Bob',
);

const currencyTransfer = economyCommand(
  economySummary,
  'TransferCurrencyV1',
  {
    amount: '25.00',
    destinationWalletId: bobWallet.wallet.id,
    expectedDestinationVersion: bobWallet.balance.rowVersion,
    expectedSourceVersion: aliceWallet.balance.rowVersion,
    memo: 'Compose private settlement.',
    sourceWalletId: aliceWallet.wallet.id,
  },
  `economy-transfer-${run}`,
);
const currencyTransferred = await submitEconomyCommand(alice, worldId, currencyTransfer);
if (currencyTransferred.eventIds.length !== 1) {
  throw new Error(
    `Currency transfer did not emit exactly one event: ${JSON.stringify(currencyTransferred)}.`,
  );
}
aliceWallet = await onlyControlledPlayerWallet(alice, worldId, 'Alice after transfer');
bobWallet = await onlyControlledPlayerWallet(bob, worldId, 'Bob after transfer');
if (
  aliceWallet.balance.availableMinor !== '7500' ||
  bobWallet.balance.availableMinor !== '12500' ||
  aliceWallet.balance.rowVersion !== '2' ||
  bobWallet.balance.rowVersion !== '2'
) {
  throw new Error(
    `The 25.00 GCR transfer did not balance exactly: ${JSON.stringify({ aliceWallet, bobWallet })}.`,
  );
}
const aliceTransferHistory = await readWalletTransactions(
  alice,
  worldId,
  aliceWallet.wallet.id,
  'Alice',
);
const bobTransferHistory = await readWalletTransactions(bob, worldId, bobWallet.wallet.id, 'Bob');
const aliceTransferFact = aliceTransferHistory.items.find(
  (item) => item.transaction.commandId === currencyTransfer.commandId,
);
const bobTransferFact = bobTransferHistory.items.find(
  (item) => item.transaction.commandId === currencyTransfer.commandId,
);
if (
  aliceTransferFact?.memo !== 'Compose private settlement.' ||
  bobTransferFact?.memo !== 'Compose private settlement.' ||
  aliceTransferFact.transaction.kind !== 'transfer' ||
  aliceTransferFact.transaction.supplyDeltaMinor !== '0' ||
  aliceTransferFact.transaction.postings.reduce(
    (sum, posting) => sum + BigInt(posting.signedAmountMinor),
    0n,
  ) !== 0n
) {
  throw new Error(
    'Participant transaction history did not preserve the balanced private transfer.',
  );
}

let foundingSeal = await readEconomyAsset(alice, worldId);
economySummary = await readEconomySummary(alice, worldId);
const giftSeal = economyCommand(
  economySummary,
  'TransferAssetV1',
  {
    assetKey: 'asset:founding-seal',
    expectedOwnershipVersion: foundingSeal.ownership.ownershipVersion,
    toOwnerEntityKey: bobWallet.wallet.ownerEntityLogicalKey,
  },
  `economy-gift-${run}`,
);
const sealGifted = await submitEconomyCommand(alice, worldId, giftSeal);
if (sealGifted.eventIds.length !== 1) {
  throw new Error(`Asset gift did not emit exactly one event: ${JSON.stringify(sealGifted)}.`);
}
foundingSeal = await readEconomyAsset(bob, worldId);
if (
  foundingSeal.asset.stableKey !== 'asset:founding-seal' ||
  foundingSeal.asset.transferable !== true ||
  foundingSeal.ownership.ownerEntityLogicalKey !== bobWallet.wallet.ownerEntityLogicalKey ||
  foundingSeal.ownership.ownershipVersion !== '2' ||
  foundingSeal.controlledByActor !== true
) {
  throw new Error(`Founding-seal title did not move to Bob: ${JSON.stringify(foundingSeal)}.`);
}

economySummary = await readEconomySummary(bob, worldId);
bobWallet = await onlyControlledPlayerWallet(bob, worldId, 'Bob before offer');
const createOffer = economyCommand(
  economySummary,
  'CreateAssetTransferOfferV1',
  {
    assetKey: 'asset:founding-seal',
    buyerEntityKey: aliceWallet.wallet.ownerEntityLogicalKey,
    currencyId: bobWallet.wallet.currencyId,
    expectedOwnershipVersion: foundingSeal.ownership.ownershipVersion,
    expiresAtTick: (BigInt(economySummary.currentTick) + 100n).toString(10),
    price: '10.00',
    sellerWalletId: bobWallet.wallet.id,
  },
  `economy-offer-${run}`,
);
const offerCreated = await submitEconomyCommand(bob, worldId, createOffer);
if (offerCreated.eventIds.length !== 1) {
  throw new Error(
    `Offer creation did not emit exactly one event: ${JSON.stringify(offerCreated)}.`,
  );
}
const sellerOffers = expectStatus(
  await browserRequest(bob, `/worlds/${worldId}/asset-transfer-offers?status=open&limit=100`),
  200,
  'list Bob open offers',
);
const foundingSealOffers = sellerOffers.items.filter(
  (item) =>
    item.assetKey === 'asset:founding-seal' && item.offer.sellerWalletId === bobWallet.wallet.id,
);
if (foundingSealOffers.length !== 1) {
  throw new Error(
    `Bob did not have exactly one open founding-seal offer: ${JSON.stringify(sellerOffers)}.`,
  );
}
const offerId = foundingSealOffers[0].offer.id;
const buyerOffer = await readOffer(alice, worldId, offerId);
if (
  buyerOffer.offer.status !== 'open' ||
  buyerOffer.offer.priceMinor !== '1000' ||
  buyerOffer.offer.buyerEntityLogicalKey !== aliceWallet.wallet.ownerEntityLogicalKey ||
  buyerOffer.offer.sellerEntityLogicalKey !== bobWallet.wallet.ownerEntityLogicalKey ||
  buyerOffer.controlledBuyer !== true ||
  buyerOffer.controlledSeller !== false ||
  buyerOffer.canAccept !== true ||
  buyerOffer.eligibleBuyerWallet?.walletId !== aliceWallet.wallet.id
) {
  throw new Error(`Alice did not receive the exact targeted offer: ${JSON.stringify(buyerOffer)}.`);
}

economySummary = await readEconomySummary(alice, worldId);
aliceWallet = await onlyControlledPlayerWallet(alice, worldId, 'Alice before purchase');
foundingSeal = await readEconomyAsset(alice, worldId);
const acceptOffer = economyCommand(
  economySummary,
  'AcceptAssetTransferOfferV1',
  {
    buyerWalletId: aliceWallet.wallet.id,
    expectedBuyerWalletVersion: buyerOffer.eligibleBuyerWallet.walletVersion,
    expectedOfferVersion: buyerOffer.offer.rowVersion,
    expectedOwnershipVersion: foundingSeal.ownership.ownershipVersion,
    expectedSellerWalletVersion: buyerOffer.sellerWalletVersion,
    offerId,
    sellerWalletId: bobWallet.wallet.id,
  },
  `economy-accept-${run}`,
);
const offerAccepted = await submitEconomyCommand(alice, worldId, acceptOffer);
if (offerAccepted.eventIds.length !== 4) {
  throw new Error(
    `Paid title transfer did not emit four atomic events: ${JSON.stringify(offerAccepted)}.`,
  );
}
aliceWallet = await onlyControlledPlayerWallet(alice, worldId, 'Alice after purchase');
bobWallet = await onlyControlledPlayerWallet(bob, worldId, 'Bob after purchase');
foundingSeal = await readEconomyAsset(alice, worldId);
const acceptedOffer = await readOffer(alice, worldId, offerId);
if (
  aliceWallet.balance.availableMinor !== '6500' ||
  bobWallet.balance.availableMinor !== '13500' ||
  aliceWallet.balance.rowVersion !== '3' ||
  bobWallet.balance.rowVersion !== '3' ||
  foundingSeal.ownership.ownerEntityLogicalKey !== aliceWallet.wallet.ownerEntityLogicalKey ||
  foundingSeal.ownership.ownershipVersion !== '3' ||
  acceptedOffer.offer.status !== 'accepted' ||
  acceptedOffer.offer.rowVersion !== '2' ||
  acceptedOffer.canAccept !== false
) {
  throw new Error(
    `Atomic paid title transfer was not exact: ${JSON.stringify({ acceptedOffer, aliceWallet, bobWallet, foundingSeal })}.`,
  );
}
const purchaseHistory = await readWalletTransactions(
  alice,
  worldId,
  aliceWallet.wallet.id,
  'Alice after purchase',
);
const purchaseFact = purchaseHistory.items.find(
  (item) => item.transaction.commandId === acceptOffer.commandId,
);
if (
  purchaseFact?.transaction.kind !== 'asset_purchase' ||
  purchaseFact.transaction.supplyDeltaMinor !== '0' ||
  purchaseFact.transaction.postings.length !== 2 ||
  purchaseFact.transaction.postings.reduce(
    (sum, posting) => sum + BigInt(posting.signedAmountMinor),
    0n,
  ) !== 0n
) {
  throw new Error('Paid title transfer did not expose one balanced participant transaction.');
}

economySummary = await readEconomySummary(alice, worldId);
const reconcileEconomy = economyCommand(
  economySummary,
  'ReconcileWorldEconomyV1',
  { expectedEconomyHeadVersion: economySummary.economyHeadVersion },
  `economy-reconcile-${run}`,
);
const economyReconciled = await submitEconomyCommand(alice, worldId, reconcileEconomy);
if (economyReconciled.eventIds.length !== 1) {
  throw new Error(
    `Economy reconciliation did not emit one event: ${JSON.stringify(economyReconciled)}.`,
  );
}
economySummary = await readEconomySummary(alice, worldId);
const finalCurrencyPage = expectStatus(
  await browserRequest(bob, `/worlds/${worldId}/economy/currencies`),
  200,
  'read reconciled currency supply',
);
if (
  economySummary.status !== 'ready' ||
  economySummary.economyHeadVersion !== '6' ||
  economySummary.stateRevision !== economyReconciled.resultingStateRevision ||
  economySummary.reconciliation.status !== 'current' ||
  economySummary.reconciliation.lastReconciledAt === null ||
  economySummary.reconciliation.lastReconciledStateRevision !==
    reconcileEconomy.expectedStateRevision ||
  !/^[a-f0-9]{64}$/u.test(economySummary.projectionChecksum ?? '') ||
  finalCurrencyPage.items.length !== 1 ||
  finalCurrencyPage.items[0].currentSupplyMinor !== '30000' ||
  economySummary.issuanceTarget?.treasuryBalanceMinor !== '0'
) {
  throw new Error(`Final economy reconciliation was not exact: ${JSON.stringify(economySummary)}.`);
}

simulation = await readSimulationClock(alice, worldId);
const initializeCommerceCommand = worldCommerceCommand(
  {
    designVersion: economySummary.designVersion,
    expansionVersion: '0',
    stateRevision: economySummary.stateRevision,
    tick: simulation.clock.currentTick,
  },
  'InitializeWorldCommerceV1',
  {
    compiledWorldVersionId: runtimeSummary.activeWorldVersionId,
    seedPlanHash: compiledArtifact.world.economySeedPlanHash,
  },
  `commerce-initialize-${run}`,
);
const commerceInitialized = await submitEconomyCommand(alice, worldId, initializeCommerceCommand);
const commerceInitializeReplay = await submitEconomyCommand(
  alice,
  worldId,
  initializeCommerceCommand,
);
if (
  canonicalJson(commerceInitialized) !== canonicalJson(commerceInitializeReplay) ||
  commerceInitialized.eventIds.length !== 2
) {
  throw new Error(
    `Commerce initialization and periodic-tax schedule were not exact: ${JSON.stringify(commerceInitialized)}.`,
  );
}

let commerceReconciliation = await readCommerceReconciliation(alice, worldId);
if (
  commerceReconciliation.expansionVersion !== '1' ||
  commerceReconciliation.lastRun !== null ||
  commerceReconciliation.projection.status !== 'catching_up' ||
  !/^[a-f0-9]{64}$/u.test(commerceReconciliation.projectionChecksum)
) {
  throw new Error(
    `Fresh commerce projection metadata was not exact: ${JSON.stringify(commerceReconciliation)}.`,
  );
}

const resourcePage = await readCommercePage(
  alice,
  worldId,
  'resources?limit=100',
  'read commerce resources',
);
const recipePage = await readCommercePage(
  alice,
  worldId,
  'recipes?limit=100',
  'read production recipes',
);
const businessPage = await readCommercePage(
  alice,
  worldId,
  'businesses?limit=100',
  'read businesses',
);
const facilityPage = await readCommercePage(
  alice,
  worldId,
  'facilities?limit=100',
  'read business facilities',
);
const employmentOfferPage = await readCommercePage(
  alice,
  worldId,
  'employment/offers?limit=100',
  'read employment offers',
);
let inventoryPage = await readCommercePage(
  alice,
  worldId,
  'inventories?limit=100',
  'read initialized inventories',
);
const resourceKeys = resourcePage.items.map((item) => item.stableKey);
const business = businessPage.items[0];
const facility = facilityPage.items[0];
const recipe = recipePage.items[0];
if (
  JSON.stringify(resourceKeys) !==
    JSON.stringify(['resource:energy', 'resource:iron-ore', 'resource:metal-part']) ||
  recipePage.items.length !== 1 ||
  recipe.durationTicks !== '12' ||
  recipe.facilityAssetType !== 'workshop' ||
  recipe.inputs.length !== 2 ||
  recipe.outputs.length !== 1 ||
  businessPage.items.length !== 1 ||
  business.backingOrganizationEntityKey !== 'organization:energy-guild' ||
  business.status !== 'active' ||
  business.rowVersion !== '1' ||
  facilityPage.items.length !== 1 ||
  facility.businessId !== business.id ||
  facility.status !== 'active' ||
  facility.rowVersion !== '1' ||
  JSON.stringify(facility.recipeVersionIds) !== JSON.stringify([recipe.id]) ||
  employmentOfferPage.items.length !== 1 ||
  employmentOfferPage.items[0].businessId !== business.id ||
  employmentOfferPage.items[0].roleCode !== 'metalworker' ||
  employmentOfferPage.items[0].wageMinor !== '100' ||
  inventoryPage.items.length !== 3
) {
  throw new Error(
    `Initialized commerce catalog was not exact: ${JSON.stringify({ businessPage, employmentOfferPage, facilityPage, inventoryPage, recipePage, resourcePage })}.`,
  );
}
const initializedFacilityInventories = inventoryPage.items.filter(
  (item) => item.containerAssetId === facility.facilityAssetId,
);
const initializedQuantities = Object.fromEntries(
  initializedFacilityInventories.map((item) => [item.resourceType.stableKey, item.quantity]),
);
if (
  initializedFacilityInventories.length !== 3 ||
  initializedQuantities['resource:energy'] !== '100' ||
  initializedQuantities['resource:iron-ore'] !== '100' ||
  initializedQuantities['resource:metal-part'] !== '0'
) {
  throw new Error(
    `Initialized facility inventory was not exact: ${JSON.stringify(inventoryPage)}.`,
  );
}

const aliceCommerceWallets = await controlledWallets(alice, worldId, 'Alice commerce');
const bobCommerceWallets = await controlledWallets(bob, worldId, 'Bob commerce');
const coraCommerceWallets = await controlledWallets(cora, worldId, 'Cora commerce');
const commerceActors = [
  { jar: alice, label: 'Alice', wallets: aliceCommerceWallets },
  { jar: bob, label: 'Bob', wallets: bobCommerceWallets },
  { jar: cora, label: 'Cora', wallets: coraCommerceWallets },
];
const managerActor = commerceActors.find((actor) =>
  actor.wallets.some((item) => item.wallet.id === business.walletId),
);
const workerActor = commerceActors.find((actor) =>
  actor.wallets.some(
    (item) =>
      item.wallet.walletKind === 'organization' &&
      item.wallet.ownerEntityLogicalKey === 'organization:artisan-guild',
  ),
);
if (!managerActor) {
  throw new Error('No compiled player affiliation controlled the seeded business wallet.');
}
if (!workerActor || workerActor === managerActor) {
  throw new Error('No distinct compiled player affiliation controlled the artisan wallet.');
}
const managerJar = managerActor.jar;
const workerJar = workerActor.jar;
const managerLabel = managerActor.label;
const workerLabel = workerActor.label;
let managerWallets = managerActor.wallets;
let managerPlayerWallet = managerWallets.find((item) => item.wallet.walletKind === 'player');
let businessWallet = managerWallets.find((item) => item.wallet.id === business.walletId);
let workerPlayerWallet = await onlyControlledPlayerWallet(
  workerJar,
  worldId,
  `${workerLabel} commerce worker`,
);
const workerOrganizationWallet = workerActor.wallets.find(
  (item) =>
    item.wallet.walletKind === 'organization' &&
    item.wallet.ownerEntityLogicalKey === 'organization:artisan-guild',
);
if (
  !managerPlayerWallet ||
  !businessWallet ||
  !workerOrganizationWallet ||
  workerOrganizationWallet.wallet.ownerEntityLogicalKey !== 'organization:artisan-guild' ||
  workerOrganizationWallet.balance.availableMinor !== '0'
) {
  throw new Error(`${managerLabel} did not expose both player and business wallets.`);
}

const createArtisanBusinessCommand = worldCommerceCommand(
  await commerceContext(workerJar, worldId),
  'CreateBusinessV1',
  {
    backingOrganizationEntityKey: workerOrganizationWallet.wallet.ownerEntityLogicalKey,
    walletId: workerOrganizationWallet.wallet.id,
  },
  `commerce-create-artisan-business-${run}`,
);
await submitEconomyCommand(workerJar, worldId, createArtisanBusinessCommand);
let currentBusinessPage = await readCommercePage(
  workerJar,
  worldId,
  'businesses?limit=100',
  'read runtime-created business',
);
const artisanBusiness = currentBusinessPage.items.find(
  (item) => item.backingOrganizationEntityKey === 'organization:artisan-guild',
);
if (
  currentBusinessPage.items.length !== 2 ||
  !artisanBusiness ||
  artisanBusiness.walletId !== workerOrganizationWallet.wallet.id ||
  artisanBusiness.rowVersion !== '1' ||
  artisanBusiness.status !== 'active' ||
  artisanBusiness.canManage !== true
) {
  throw new Error(
    `Runtime business creation was not exact: ${JSON.stringify(currentBusinessPage)}.`,
  );
}

const annexBeforeConfiguration = await readEconomyAsset(
  managerJar,
  worldId,
  'asset:facility:energy-harbor-annex',
);
if (
  annexBeforeConfiguration.asset.assetType !== 'workshop' ||
  annexBeforeConfiguration.asset.transferable !== true ||
  annexBeforeConfiguration.ownership.ownerEntityLogicalKey !==
    business.backingOrganizationEntityKey ||
  annexBeforeConfiguration.ownership.ownershipVersion !== '1'
) {
  throw new Error(
    `Unconfigured facility prerequisite was not exact: ${JSON.stringify(annexBeforeConfiguration)}.`,
  );
}
const configureAnnexPayload = {
  businessId: business.id,
  expectedBusinessVersion: business.rowVersion,
  expectedOwnershipVersion: annexBeforeConfiguration.ownership.ownershipVersion,
  facilityAssetId: annexBeforeConfiguration.asset.id,
  recipeVersionIds: [recipe.id],
};
await submitEconomyCommand(
  managerJar,
  worldId,
  worldCommerceCommand(
    await commerceContext(managerJar, worldId),
    'ConfigureBusinessFacilityV1',
    configureAnnexPayload,
    `commerce-configure-annex-${run}`,
  ),
);
const configuredFacilityPage = await readCommercePage(
  managerJar,
  worldId,
  'facilities?limit=100',
  'read runtime-configured facility',
);
const configuredAnnex = configuredFacilityPage.items.find(
  (item) => item.facilityAssetId === annexBeforeConfiguration.asset.id,
);
if (
  configuredFacilityPage.items.length !== 2 ||
  !configuredAnnex ||
  configuredAnnex.rowVersion !== '1' ||
  configuredAnnex.status !== 'active' ||
  JSON.stringify(configuredAnnex.recipeVersionIds) !== JSON.stringify([recipe.id])
) {
  throw new Error(
    `Runtime facility configuration was not exact: ${JSON.stringify(configuredFacilityPage)}.`,
  );
}

economySummary = await readEconomySummary(managerJar, worldId);
const deniedAnnexTransferCommand = economyCommand(
  economySummary,
  'TransferAssetV1',
  {
    assetKey: annexBeforeConfiguration.asset.stableKey,
    expectedOwnershipVersion: annexBeforeConfiguration.ownership.ownershipVersion,
    toOwnerEntityKey: workerPlayerWallet.wallet.ownerEntityLogicalKey,
  },
  `commerce-transfer-configured-annex-denied-${run}`,
);
const deniedAnnexTransfer = expectStatus(
  await commandMutation(managerJar, worldId, deniedAnnexTransferCommand),
  409,
  'reject configured facility title transfer',
);
if (
  deniedAnnexTransfer.status !== 'rejected' ||
  deniedAnnexTransfer.rejectionCode !== 'ASSET_NOT_TRANSFERABLE'
) {
  throw new Error(
    `Configured facility transfer was not rejected exactly: ${JSON.stringify(deniedAnnexTransfer)}.`,
  );
}
const annexAfterRejectedTransfer = await readEconomyAsset(
  managerJar,
  worldId,
  annexBeforeConfiguration.asset.stableKey,
);
if (
  annexAfterRejectedTransfer.ownership.ownerEntityLogicalKey !==
    annexBeforeConfiguration.ownership.ownerEntityLogicalKey ||
  annexAfterRejectedTransfer.ownership.ownershipVersion !==
    annexBeforeConfiguration.ownership.ownershipVersion
) {
  throw new Error('Rejected configured-facility transfer changed title ownership.');
}

economySummary = await readEconomySummary(managerJar, worldId);
const managerBalanceBeforeFunding = BigInt(managerPlayerWallet.balance.availableMinor);
const fundBusinessCommand = economyCommand(
  economySummary,
  'TransferCurrencyV1',
  {
    amount: '50.00',
    destinationWalletId: business.walletId,
    expectedDestinationVersion: businessWallet.balance.rowVersion,
    expectedSourceVersion: managerPlayerWallet.balance.rowVersion,
    memo: 'Compose commerce operating capital.',
    sourceWalletId: managerPlayerWallet.wallet.id,
  },
  `commerce-fund-business-${run}`,
);
await submitEconomyCommand(managerJar, worldId, fundBusinessCommand);
managerWallets = await controlledWallets(managerJar, worldId, `${managerLabel} after funding`);
managerPlayerWallet = managerWallets.find((item) => item.wallet.walletKind === 'player');
businessWallet = managerWallets.find((item) => item.wallet.id === business.walletId);
if (
  !managerPlayerWallet ||
  !businessWallet ||
  businessWallet.balance.availableMinor !== '5000' ||
  businessWallet.balance.rowVersion !== '2' ||
  BigInt(managerPlayerWallet.balance.availableMinor) !== managerBalanceBeforeFunding - 5000n
) {
  throw new Error(
    `Business funding was not exact: ${JSON.stringify({ businessWallet, managerPlayerWallet })}.`,
  );
}

const candidates = await readCommercePage(
  managerJar,
  worldId,
  `businesses/${encodeURIComponent(business.id)}/employment-candidates?limit=100`,
  'read employment candidates',
);
const workerCandidate = candidates.items.find(
  (item) => item.workerWalletId === workerPlayerWallet.wallet.id,
);
if (!workerCandidate) {
  throw new Error(`${workerLabel} was not an eligible employment candidate.`);
}
const commerceStartTick = simulation.clock.currentTick;
const payrollTick = (BigInt(commerceStartTick) + 1n).toString(10);
const productionTick = (BigInt(commerceStartTick) + 12n).toString(10);
const periodicTaxTicks = [5n, 10n, 15n].map((offset) =>
  (BigInt(commerceStartTick) + offset).toString(10),
);
const finalPeriodicTaxTick = periodicTaxTicks[2];
if (!finalPeriodicTaxTick) throw new Error('The final periodic-tax tick was not derived.');
const contractCommand = worldCommerceCommand(
  await commerceContext(managerJar, worldId),
  'CreateEmploymentContractV1',
  {
    businessId: business.id,
    cooldownTicks: '1',
    effectiveFromTick: commerceStartTick,
    effectiveToTick: (BigInt(commerceStartTick) + 100n).toString(10),
    employerWalletId: business.walletId,
    expectedBusinessVersion: business.rowVersion,
    maxPerformancesPerPeriod: 1,
    periodTicks: '12',
    rewardCapMinor: '100',
    roleCode: 'metalworker',
    wageMinor: '100',
    wageRuleKind: 'per_shift',
    workerEntityKey: workerCandidate.workerEntityKey,
    workerWalletId: workerCandidate.workerWalletId,
  },
  `commerce-contract-${run}`,
);
await submitEconomyCommand(managerJar, worldId, contractCommand);
let contractPage = await readCommercePage(
  workerJar,
  worldId,
  'employment/contracts?limit=100',
  'read offered employment contract',
);
let contract = contractPage.items.find(
  (item) =>
    item.businessId === business.id && item.workerEntityKey === workerCandidate.workerEntityKey,
);
if (
  !contract ||
  contract.status !== 'offered' ||
  contract.rowVersion !== '1' ||
  contract.canWork !== true ||
  contract.privateTermsVisible !== true ||
  contract.wageMinor !== '100'
) {
  throw new Error(`Employment contract was not exact: ${JSON.stringify(contractPage)}.`);
}

await submitEconomyCommand(
  workerJar,
  worldId,
  worldCommerceCommand(
    await commerceContext(workerJar, worldId),
    'AcceptEmploymentContractV1',
    { contractId: contract.id, expectedContractVersion: contract.rowVersion },
    `commerce-accept-contract-${run}`,
  ),
);
contractPage = await readCommercePage(
  workerJar,
  worldId,
  'employment/contracts?limit=100',
  'read accepted employment contract',
);
contract = contractPage.items.find((item) => item.id === contract.id);
if (!contract || contract.status !== 'active' || contract.rowVersion !== '2') {
  throw new Error(`Employment acceptance was not exact: ${JSON.stringify(contractPage)}.`);
}
const performJobCommand = worldCommerceCommand(
  await commerceContext(workerJar, worldId),
  'PerformJobV1',
  { contractId: contract.id, expectedContractVersion: contract.rowVersion },
  `commerce-perform-job-${run}`,
);
const performedJob = await submitEconomyCommand(workerJar, worldId, performJobCommand);
const performedJobReplay = await submitEconomyCommand(workerJar, worldId, performJobCommand);
if (canonicalJson(performedJob) !== canonicalJson(performedJobReplay)) {
  throw new Error('PerformJobV1 did not replay its exact accepted receipt.');
}

const recipeInputIds = new Set(recipe.inputs.map((item) => item.resourceTypeId));
const productionInputs = initializedFacilityInventories.filter((item) =>
  recipeInputIds.has(item.resourceType.id),
);
if (productionInputs.length !== 2) {
  throw new Error('The production recipe did not bind exactly two initialized input inventories.');
}
await submitEconomyCommand(
  managerJar,
  worldId,
  worldCommerceCommand(
    await commerceContext(managerJar, worldId),
    'StartProductionRunV1',
    {
      businessId: business.id,
      expectedBusinessVersion: business.rowVersion,
      expectedFacilityVersion: facility.rowVersion,
      expectedInventories: productionInputs.map((item) => ({
        inventoryId: item.id,
        rowVersion: item.rowVersion,
      })),
      facilityId: facility.id,
      recipeVersionId: recipe.id,
      runQuantity: '10',
    },
    `commerce-start-production-${run}`,
  ),
);
let productionPage = await readCommercePage(
  managerJar,
  worldId,
  `production-runs?businessId=${encodeURIComponent(business.id)}&limit=100`,
  'read scheduled production run',
);
if (
  productionPage.items.length !== 1 ||
  productionPage.items[0].dueTick !== productionTick ||
  productionPage.items[0].runQuantity !== '10' ||
  !['ready', 'scheduled'].includes(productionPage.items[0].status)
) {
  throw new Error(`Production run was not scheduled exactly: ${JSON.stringify(productionPage)}.`);
}

await advanceSimulationTo(alice, worldId, payrollTick, `commerce-advance-payroll-${run}`);
await waitForScheduledAction(alice, worldId, 'SettlePayrollV1', payrollTick);
const paidJobs = await waitForCommerce(
  workerJar,
  worldId,
  'employment/jobs?limit=100',
  'read settled payroll',
  (page) => page.items.length === 1 && page.items[0].payroll?.status === 'paid',
);
if (
  paidJobs.items[0].grossMinor !== '100' ||
  paidJobs.items[0].payroll.grossMinor !== '100' ||
  paidJobs.items[0].payroll.taxMinor !== '0' ||
  paidJobs.items[0].payroll.netMinor !== '100'
) {
  throw new Error(`Payroll settlement was not exact: ${JSON.stringify(paidJobs)}.`);
}

for (const [index, taxTick] of periodicTaxTicks.slice(0, 2).entries()) {
  await advanceSimulationTo(alice, worldId, taxTick, `commerce-advance-tax-${taxTick}-${run}`);
  await waitForScheduledAction(alice, worldId, 'AssessPeriodicTaxV1', taxTick);
  const expectedCount = index + 1;
  await waitForCommerce(
    managerJar,
    worldId,
    'tax-assessments?limit=100',
    `read periodic tax at tick ${taxTick}`,
    (page) =>
      page.items.filter((item) => item.sourceType === 'periodic_tax' && item.amountMinor === '10')
        .length === expectedCount,
  );
}
await advanceSimulationTo(alice, worldId, productionTick, `commerce-advance-production-${run}`);
await waitForScheduledAction(alice, worldId, 'CompleteProductionRunV1', productionTick);
await waitForCommerce(
  managerJar,
  worldId,
  `production-runs?businessId=${encodeURIComponent(business.id)}&limit=100`,
  'read completed production run',
  (page) => page.items.length === 1 && page.items[0].status === 'completed',
);
contractPage = await readCommercePage(
  managerJar,
  worldId,
  'employment/contracts?limit=100',
  'read active contract before termination',
);
contract = contractPage.items.find((item) => item.id === contract.id);
if (!contract || contract.status !== 'active' || contract.rowVersion !== '2') {
  throw new Error(
    `Employment contract changed before termination: ${JSON.stringify(contractPage)}.`,
  );
}
await submitEconomyCommand(
  managerJar,
  worldId,
  worldCommerceCommand(
    await commerceContext(managerJar, worldId),
    'EndEmploymentContractV1',
    {
      contractId: contract.id,
      expectedContractVersion: contract.rowVersion,
      reason: 'Compose smoke shift completed.',
    },
    `commerce-end-contract-${run}`,
  ),
);
contractPage = await readCommercePage(
  workerJar,
  worldId,
  'employment/contracts?limit=100',
  'read ended employment contract',
);
contract = contractPage.items.find((item) => item.id === contract.id);
if (!contract || contract.status !== 'ended' || contract.rowVersion !== '3') {
  throw new Error(`Employment termination was not exact: ${JSON.stringify(contractPage)}.`);
}
inventoryPage = await readCommercePage(
  managerJar,
  worldId,
  'inventories?limit=100',
  'read produced inventories',
);
let facilityInventories = inventoryPage.items.filter(
  (item) => item.containerAssetId === facility.facilityAssetId,
);
const producedState = Object.fromEntries(
  facilityInventories.map((item) => [
    item.resourceType.stableKey,
    { quantity: item.quantity, reserved: item.reservedQuantity },
  ]),
);
if (
  producedState['resource:energy']?.quantity !== '90' ||
  producedState['resource:energy']?.reserved !== '0' ||
  producedState['resource:iron-ore']?.quantity !== '80' ||
  producedState['resource:iron-ore']?.reserved !== '0' ||
  producedState['resource:metal-part']?.quantity !== '10' ||
  producedState['resource:metal-part']?.reserved !== '0'
) {
  throw new Error(
    `Completed production inventory was not exact: ${JSON.stringify(producedState)}.`,
  );
}

const metalInventory = facilityInventories.find(
  (item) => item.resourceType.stableKey === 'resource:metal-part',
);
if (!metalInventory) throw new Error('Produced metal-part inventory was missing.');
const proposalLifecycleTicks =
  BigInt(charter.proposalRules.sponsorshipTicks) +
  BigInt(charter.proposalRules.debateTicks) +
  BigInt(charter.proposalRules.votingTicks);
const listingExpiresAtTick = (
  BigInt(finalPeriodicTaxTick) +
  proposalLifecycleTicks * 2n +
  1n
).toString(10);
const listingCommand = worldCommerceCommand(
  await commerceContext(managerJar, worldId),
  'CreateMarketListingV1',
  {
    expiresAtTick: listingExpiresAtTick,
    expectedInventoryVersion: metalInventory.rowVersion,
    quantity: '10',
    sellerInventoryId: metalInventory.id,
    sellerWalletId: business.walletId,
    unitPriceMinor: '100',
  },
  `commerce-list-ten-${run}`,
);
await submitEconomyCommand(managerJar, worldId, listingCommand);
let listingPage = await readCommercePage(
  workerJar,
  worldId,
  'market/listings?status=open&limit=100',
  'read open market listing',
);
let listing = listingPage.items.find(
  (item) => item.resourceType.stableKey === 'resource:metal-part' && item.offeredQuantity === '10',
);
if (
  !listing ||
  listing.remainingQuantity !== '10' ||
  listing.rowVersion !== '1' ||
  listing.unitPriceMinor !== '100' ||
  listing.canCancel !== false
) {
  throw new Error(`Market listing was not exact: ${JSON.stringify(listingPage)}.`);
}
const listingId = listing.id;
const preview = expectStatus(
  await browserRequest(
    workerJar,
    `/worlds/${worldId}/economy/market/listings/${encodeURIComponent(listing.id)}/purchase-preview?quantity=3`,
  ),
  200,
  'preview three-unit purchase',
);
if (
  preview.preview.listingId !== listingId ||
  preview.preview.listingVersion !== listing.rowVersion ||
  preview.preview.quantity !== '3' ||
  preview.preview.grossMinor !== '300' ||
  preview.preview.taxMinor !== '7' ||
  preview.preview.feeMinor !== '0' ||
  preview.preview.sellerNetMinor !== '300' ||
  preview.preview.buyerTotalMinor !== '307' ||
  !/^[a-f0-9]{64}$/u.test(preview.preview.quoteHash)
) {
  throw new Error(`Market purchase preview was not exact: ${JSON.stringify(preview)}.`);
}
workerPlayerWallet = await onlyControlledPlayerWallet(
  workerJar,
  worldId,
  `${workerLabel} before market purchase`,
);
const browserPurchase = commerceBrowserSmokeEnabled
  ? await runLiveCommerceBrowserDemo({
      baseUrl: browserOrigin,
      buyerCookieHeader: workerJar.header(),
      buyerWalletId: workerPlayerWallet.wallet.id,
      expectedItemizationText: [
        'Item subtotal300 minor units',
        'Tax7 minor units',
        'Marketplace fee0 minor units',
        'Exact total307 minor units',
      ],
      expectedTradeText: ['3 units at tick', 'Gross 300 · tax 7 · fee 0', '307 total minor units'],
      listingId,
      managerCookieHeader: managerJar.header(),
      productionInputCount: 2,
      productionQuantity: '10',
      productionTick,
      purchaseQuantity: '3',
      quantityAfter: '7 part',
      quantityBefore: '10 part',
      resourceDisplayName: 'Metal Part',
      worldId,
    })
  : null;
const purchaseCommand =
  browserPurchase?.command ??
  worldCommerceCommand(
    await commerceContext(workerJar, worldId),
    'PurchaseMarketListingV1',
    {
      buyerInventoryId: null,
      buyerWalletId: workerPlayerWallet.wallet.id,
      expectedBuyerInventoryVersion: null,
      expectedBuyerWalletVersion: workerPlayerWallet.balance.rowVersion,
      expectedListingVersion: listing.rowVersion,
      listingId,
      quantity: '3',
    },
    `commerce-buy-three-${run}`,
  );
const purchased =
  browserPurchase?.result ?? (await submitEconomyCommand(workerJar, worldId, purchaseCommand));
const purchaseReplay = await submitEconomyCommand(workerJar, worldId, purchaseCommand);
if (canonicalJson(purchased) !== canonicalJson(purchaseReplay)) {
  throw new Error('Three-unit market purchase did not replay its exact accepted receipt.');
}
listingPage = await readCommercePage(
  workerJar,
  worldId,
  'market/listings?status=open&limit=100',
  'read partially filled listing',
);
listing = listingPage.items.find((item) => item.id === listingId);
const tradePage = await readCommercePage(
  workerJar,
  worldId,
  `market/trades?listingId=${encodeURIComponent(listingId)}&limit=100`,
  'read exact market trade',
);
if (
  !listing ||
  listing.remainingQuantity !== '7' ||
  listing.rowVersion !== '2' ||
  tradePage.items.length !== 1 ||
  tradePage.items[0].quantity !== '3' ||
  tradePage.items[0].grossMinor !== '300' ||
  tradePage.items[0].taxMinor !== '7' ||
  tradePage.items[0].buyerTotalMinor !== '307' ||
  tradePage.items[0].sellerNetMinor !== '300'
) {
  throw new Error(
    `Partial market purchase was not exact: ${JSON.stringify({ listingPage, tradePage })}.`,
  );
}

await advanceSimulationTo(
  alice,
  worldId,
  finalPeriodicTaxTick,
  `commerce-advance-tax-${finalPeriodicTaxTick}-${run}`,
);
await waitForScheduledAction(alice, worldId, 'AssessPeriodicTaxV1', finalPeriodicTaxTick);

const taxPage = await waitForCommerce(
  observer,
  worldId,
  'tax-assessments?limit=100',
  'read collected tax assessments',
  (page) =>
    page.items.filter((item) => item.sourceType === 'periodic_tax').length === 3 &&
    page.items.filter((item) => item.sourceType === 'market_trade').length === 1,
);
const periodicTaxes = taxPage.items.filter((item) => item.sourceType === 'periodic_tax');
const salesTaxes = taxPage.items.filter((item) => item.sourceType === 'market_trade');
const treasury = expectStatus(
  await browserRequest(observer, `/worlds/${worldId}/economy/treasury`),
  200,
  'read treasury summary',
);
if (
  periodicTaxes.length !== 3 ||
  periodicTaxes.some((item) => item.amountMinor !== '10') ||
  salesTaxes.length !== 1 ||
  salesTaxes[0].amountMinor !== '7' ||
  taxPage.items.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n) !== 37n ||
  treasury.treasury.balanceMinor !== '37' ||
  treasury.treasury.revenueMinor !== '37' ||
  treasury.treasury.noCashValue !== true ||
  treasury.treasury.lastRevenueTick !== finalPeriodicTaxTick
) {
  throw new Error(
    `Tax and treasury state was not exact: ${JSON.stringify({ taxPage, treasury })}.`,
  );
}

const salesTaxAssessment = salesTaxes[0];
if (!salesTaxAssessment) throw new Error('The governed sales-tax target was not discoverable.');
const governedTax = await enactPublicGovernanceProposal({
  action: (effectiveFromTick) => ({
    actionSchemaVersion: 1,
    actionType: 'update_tax',
    effectiveFromTick,
    expectedTaxPolicyVersion: '1',
    newRateBps: 333,
    taxPolicyId: salesTaxAssessment.policyId,
  }),
  body: 'Three citizens approve a bounded sales-tax change through the compiled charter.',
  charter,
  idempotencyPrefix: `governance-compose-tax-${run}`,
  institution,
  proposalKey: `proposal:compose-sales-tax-${run}`,
  proposer: alice,
  title: 'Compose Sales Tax Update',
  voters: [alice, bob, cora],
  worldId,
});
const governedProject = await enactPublicGovernanceProposal({
  action: (effectiveAtTick) => ({
    actionSchemaVersion: 1,
    actionType: 'authorize_public_project',
    amountMinor: '20',
    budgetKey: `budget:compose-civic-platform-${run}`,
    currencyId: treasury.treasury.currencyId,
    description: 'Funds a bounded accessibility repair on the public harbor platform.',
    effectiveAtTick,
    projectKey: 'district:civic-platform',
    treasuryWalletId: treasury.treasury.treasuryWalletId,
  }),
  body: 'Three citizens authorize a treasury-backed civic-platform repair.',
  charter,
  idempotencyPrefix: `governance-compose-project-${run}`,
  institution,
  proposalKey: `proposal:compose-civic-platform-${run}`,
  proposer: alice,
  title: 'Compose Civic Platform Project',
  voters: [alice, bob, cora],
  worldId,
});
const governedEffects = await readGovernancePage(
  observer,
  worldId,
  'proposals?limit=100',
  'read governed tax and project enactments',
);
if (
  governedTax.action.actionType !== 'update_tax' ||
  governedProject.action.actionType !== 'authorize_public_project' ||
  !governedEffects.items.some(
    (proposal) =>
      proposal.proposalId === governedTax.proposal.proposalId &&
      proposal.status === 'enacted' &&
      proposal.action.actionType === 'update_tax' &&
      proposal.action.newRateBps === 333,
  ) ||
  !governedEffects.items.some(
    (proposal) =>
      proposal.proposalId === governedProject.proposal.proposalId &&
      proposal.status === 'enacted' &&
      proposal.action.actionType === 'authorize_public_project' &&
      proposal.action.amountMinor === '20',
  )
) {
  throw new Error('The governed tax/project effects were not visible through the public API.');
}
const postGovernanceTaxPage = await waitForCommerce(
  observer,
  worldId,
  'tax-assessments?limit=100',
  'read post-governance tax assessments',
  (page) =>
    page.items.filter((item) => item.sourceType === 'periodic_tax').length === 5 &&
    page.items.filter((item) => item.sourceType === 'market_trade').length === 1,
);
const postGovernancePeriodicTaxes = postGovernanceTaxPage.items.filter(
  (item) => item.sourceType === 'periodic_tax',
);
const postGovernanceSalesTaxes = postGovernanceTaxPage.items.filter(
  (item) => item.sourceType === 'market_trade',
);
const postGovernanceTreasury = expectStatus(
  await browserRequest(observer, `/worlds/${worldId}/economy/treasury`),
  200,
  'read post-governance treasury summary',
);
const postGovernanceListingPage = await readCommercePage(
  workerJar,
  worldId,
  'market/listings?status=open&limit=100',
  'read retained partially filled listing',
);
const postGovernanceListing = postGovernanceListingPage.items.find((item) => item.id === listingId);
if (
  postGovernancePeriodicTaxes.length !== 5 ||
  postGovernancePeriodicTaxes.some((item) => item.amountMinor !== '10') ||
  postGovernanceSalesTaxes.length !== 1 ||
  postGovernanceSalesTaxes[0].amountMinor !== '7' ||
  postGovernanceTaxPage.items.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n) !== 57n ||
  postGovernanceTreasury.treasury.balanceMinor !== '57' ||
  postGovernanceTreasury.treasury.revenueMinor !== '57' ||
  postGovernanceTreasury.treasury.noCashValue !== true ||
  postGovernanceTreasury.treasury.lastRevenueTick !== governedProject.votingClosesAtTick ||
  !postGovernanceListing ||
  postGovernanceListing.remainingQuantity !== '7' ||
  postGovernanceListing.rowVersion !== '2' ||
  postGovernanceListing.expiresAtTick !== listingExpiresAtTick
) {
  throw new Error(
    `Post-governance commerce state was not exact: ${JSON.stringify({
      postGovernanceListingPage,
      postGovernanceTaxPage,
      postGovernanceTreasury,
    })}.`,
  );
}
if (commerceBrowserSmokeEnabled) {
  const overrideClock = await readSimulationClock(alice, worldId);
  await runLiveGovernanceBrowserDemo({
    baseUrl: browserOrigin,
    creatorCookieHeader: alice.header(),
    effectiveAtTick: overrideClock.clock.currentTick,
    electedHolderEntityKey: aliceController.entityLogicalKey,
    lawId: publicSafetyLaw.lawId,
    lawTitle: publicSafetyLaw.title,
    lawVersion: publicSafetyLaw.lawVersion,
    observerCookieHeader: observer.header(),
    password,
    projectProposalTitle: 'Compose Civic Platform Project',
    taxProposalTitle: 'Compose Sales Tax Update',
    worldId,
  });
  const postOverrideLaws = await readGovernancePage(
    observer,
    worldId,
    'laws?limit=100',
    'read explicit override law transition',
  );
  const postOverrideLaw = postOverrideLaws.items.find(
    (law) => law.lawId === publicSafetyLaw.lawId && law.lawVersion === publicSafetyLaw.lawVersion,
  );
  const postOverrideAudit = await readGovernancePage(
    observer,
    worldId,
    'audit?limit=100',
    'read explicit override audit',
  );
  if (
    postOverrideLaw?.status !== 'repealed' ||
    !postOverrideAudit.items.some(
      (item) =>
        item.eventType === 'governance.override' &&
        item.actorMode === 'creator' &&
        item.reason === 'Emergency harbor access conflict requires a bounded repeal.',
    )
  ) {
    throw new Error('The browser override was not persisted as a distinct creator audit fact.');
  }
}

inventoryPage = await readCommercePage(
  managerJar,
  worldId,
  'inventories?limit=100',
  'read post-trade inventories',
);
facilityInventories = inventoryPage.items.filter(
  (item) => item.containerAssetId === facility.facilityAssetId,
);
const sellerMetal = facilityInventories.find(
  (item) => item.resourceType.stableKey === 'resource:metal-part',
);
const buyerMetal = inventoryPage.items.find(
  (item) =>
    item.ownerEntityKey === workerCandidate.workerEntityKey &&
    item.containerAssetId === null &&
    item.resourceType.stableKey === 'resource:metal-part',
);
if (
  !sellerMetal ||
  sellerMetal.quantity !== '7' ||
  sellerMetal.reservedQuantity !== '7' ||
  sellerMetal.availableQuantity !== '0' ||
  !buyerMetal ||
  buyerMetal.quantity !== '3' ||
  buyerMetal.reservedQuantity !== '0' ||
  Number(sellerMetal.quantity) + Number(buyerMetal.quantity) !== 10
) {
  throw new Error(
    `Post-trade inventory conservation was not exact: ${JSON.stringify({ buyerMetal, sellerMetal })}.`,
  );
}

const reconcileCommerceContext = await commerceContext(alice, worldId);
const reconcileCommerceCommand = worldCommerceCommand(
  reconcileCommerceContext,
  'ReconcileWorldCommerceV1',
  { expectedExpansionVersion: reconcileCommerceContext.expansionVersion },
  `commerce-reconcile-${run}`,
);
const commerceReconciled = await submitEconomyCommand(alice, worldId, reconcileCommerceCommand);
if (commerceReconciled.eventIds.length !== 1) {
  throw new Error(
    `Commerce reconciliation did not emit one event: ${JSON.stringify(commerceReconciled)}.`,
  );
}
commerceReconciliation = await readCommerceReconciliation(observer, worldId);
if (
  commerceReconciliation.lastRun?.status !== 'matched' ||
  commerceReconciliation.lastRun.mismatchCount !== 0 ||
  commerceReconciliation.lastRun.resourceCount !== 3 ||
  commerceReconciliation.lastRun.inventoryCount !== 4 ||
  commerceReconciliation.lastRun.tradeCount !== 1 ||
  commerceReconciliation.lastRun.assessmentCount !== 6 ||
  commerceReconciliation.projection.status !== 'current' ||
  commerceReconciliation.projection.lagRevisions !== '0'
) {
  throw new Error(
    `Commerce reconciliation was not exact: ${JSON.stringify(commerceReconciliation)}.`,
  );
}
if (commerceBrowserSmokeEnabled) {
  await waitForHistoryEvent(workerJar, worldId, 'WorldCommerceReconciledV1');
  await runLiveCommerceBrowserEvidenceReview({
    baseUrl: browserOrigin,
    businessEntityKey: business.backingOrganizationEntityKey,
    businessWalletId: business.walletId,
    buyerCookieHeader: workerJar.header(),
    contractRole: 'metalworker',
    contractStatus: 'ended (terminal)',
    expectedTradeText: ['3 units at tick', 'Gross 300 · tax 7 · fee 0', '307 total minor units'],
    facilityCount: 2,
    jobGrossMinor: '100',
    jobTick: commerceStartTick,
    lastRevenueTick: governedProject.votingClosesAtTick,
    managerCookieHeader: managerJar.header(),
    marketTaxMinor: '7',
    periodicTaxCount: 5,
    periodicTaxMinor: '10',
    productionInputCount: 2,
    productionQuantity: '10',
    productionTick,
    purchaseQuantity: '3',
    quantityAfter: '7 part',
    reconciliationCommandId: commerceReconciled.commandId,
    reconciliationChecksum: commerceReconciliation.projectionChecksum,
    reconciliationStateRevision: commerceReconciled.resultingStateRevision,
    resourceDisplayName: 'Metal Part',
    treasuryMinor: '57',
    worldId,
  });
}

const observerResources = await readCommercePage(
  observer,
  worldId,
  'resources?limit=100',
  'read public resource catalog as observer',
);
const observerBusinesses = await readCommercePage(
  observer,
  worldId,
  'businesses?limit=100',
  'read safe business summary as observer',
);
const observerContracts = await readCommercePage(
  observer,
  worldId,
  'employment/contracts?limit=100',
  'read private contracts as observer',
);
const observerControlledInventories = await readCommercePage(
  observer,
  worldId,
  'inventories?controlled=true&limit=100',
  'read controlled inventories as observer',
);
if (
  observerResources.items.length !== 3 ||
  observerBusinesses.items.length !== 2 ||
  observerBusinesses.items.some((item) => item.canManage !== false) ||
  observerContracts.items.length !== 0 ||
  observerControlledInventories.items.length !== 0
) {
  throw new Error('Observer commerce reads did not preserve their public/private boundary.');
}
expectStatus(
  await browserRequest(new CookieJar(), `/worlds/${worldId}/economy/resources?limit=100`),
  401,
  'reject unauthenticated commerce read',
);

const finalCommerceWallets = await Promise.all(
  commerceActors.map((actor) =>
    controlledWallets(actor.jar, worldId, `${actor.label} final commerce`),
  ),
);
const visibleWallets = new Map(finalCommerceWallets.flat().map((item) => [item.wallet.id, item]));
if (
  visibleWallets.size !== 5 ||
  [...visibleWallets.values()].reduce(
    (sum, item) => sum + BigInt(item.balance.availableMinor),
    BigInt(postGovernanceTreasury.treasury.balanceMinor),
  ) !== 30000n
) {
  throw new Error('Closed-loop currency conservation failed after commerce settlement.');
}
const commerceCurrencyPage = expectStatus(
  await browserRequest(observer, `/worlds/${worldId}/economy/currencies`),
  200,
  'read conserved commerce currency supply',
);
if (
  commerceCurrencyPage.items.length !== 1 ||
  commerceCurrencyPage.items[0].currentSupplyMinor !== '30000'
) {
  throw new Error('Commerce changed the closed-loop GCR supply.');
}

simulation = await readSimulationClock(alice, worldId);
const automaticStartTick = simulation.clock.currentTick;
await submitSimulationCommand(
  alice,
  worldId,
  simulationCommand(simulation, 'StartWorldClockV1', {}, `simulation-start-${run}`),
);
const automaticallyAdvanced = await waitForSimulationTickAfter(alice, worldId, automaticStartTick);

await verifyOperationalWorker('before-dependency-outage');
execFileSync('docker', ['compose', 'stop', 'redis'], { stdio: 'inherit' });
await waitFor(`${api}/health/live`, 200);
await waitFor(`${api}/health/ready`, 503);
await new Promise((resolve) => setTimeout(resolve, 2_500));
const redisDownFirst = await readSimulationClock(alice, worldId);
await new Promise((resolve) => setTimeout(resolve, 2_500));
const redisDownSecond = await readSimulationClock(alice, worldId);
if (redisDownSecond.clock.currentTick !== redisDownFirst.clock.currentTick) {
  throw new Error(
    `Redis loss did not stop automatic simulation: ${redisDownFirst.clock.currentTick} -> ${redisDownSecond.clock.currentTick}.`,
  );
}
execFileSync('docker', ['compose', 'start', 'redis'], { stdio: 'inherit' });
await waitFor(`${api}/health/ready`, 200);
const recoveredSimulation = await waitForSimulationTickAfter(
  alice,
  worldId,
  redisDownSecond.clock.currentTick,
);
if (
  BigInt(recoveredSimulation.clock.currentTick) <= BigInt(automaticallyAdvanced.clock.currentTick)
) {
  throw new Error(
    'Simulation did not recover its PostgreSQL-authoritative clock after Redis return.',
  );
}

let pauseAccepted = false;
for (let attempt = 0; attempt < 5 && !pauseAccepted; attempt += 1) {
  const current = await readSimulationClock(alice, worldId);
  const pause = simulationCommand(
    current,
    'PauseWorldClockV1',
    {},
    `simulation-pause-${attempt}-${run}`,
  );
  const result = await commandMutation(alice, worldId, pause);
  if (result.response.status === 200) pauseAccepted = true;
  else if (result.response.status !== 409) expectStatus(result, 200, 'PauseWorldClockV1');
}
if (!pauseAccepted || (await readSimulationClock(alice, worldId)).clock.mode !== 'paused') {
  throw new Error('Recovered simulation clock could not be paused authoritatively.');
}

expectStatus(
  await mutation(alice, '/auth/logout', 'POST', undefined, `logout-${run}`),
  204,
  'logout Alice',
);
expectStatus(await browserRequest(alice, '/auth/logout', { method: 'POST' }), 204, 'retry logout');
expectStatus(await browserRequest(alice, '/auth/me'), 401, 'reject logged-out session');

execFileSync('docker', ['compose', 'stop', 'postgres'], { stdio: 'inherit' });
await waitFor(`${api}/health/live`, 200);
await waitFor(`${api}/health/ready`, 503);
execFileSync('docker', ['compose', 'start', 'postgres'], { stdio: 'inherit' });
await waitFor(`${api}/health/ready`, 200);
await verifyOperationalWorker('after-dependency-recovery');

console.log(
  `Compose smoke passed${commerceBrowserSmokeEnabled ? ' with two-session live browser commerce' : ''}: reviewed primitive bootstrap/retrieval, multi-user authority and safe observer reads, provider-disabled governed manifest generation/approval, deterministic compiler 1.3/artifact 4/economy plan 2/governance plan 1 compile and activation, three-account public proposal/replacement/law enactment plus secret election/term certification, initialized closed-loop GCR plus commerce, private transfer and atomic title sale, public runtime business creation and facility configuration with title lock, employment/work exact replay/termination, payroll/production, periodic and sales tax, list-ten/buy-three exact replay, treasury/inventory/currency conservation, core and commerce reconciliation, tick-three notice execution, continuous PostgreSQL-fenced simulation, idempotent worker delivery, Redis/PostgreSQL degradation, and recovery verified.`,
);
