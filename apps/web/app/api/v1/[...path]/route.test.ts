import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_PROXY_TIMEOUT_MS } from '../../../lib/api';
import { GET, MAX_PROXY_BODY_BYTES, POST } from './route';

const retrievalContext = {
  params: Promise.resolve({ path: ['primitive-retrievals'] }),
};
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser API proxy boundary', () => {
  it('rejects a declared oversized body with a stable 413 without contacting the API', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await POST(
      new Request('http://localhost/api/v1/primitive-retrievals', {
        body: '{}',
        headers: { 'content-length': String(MAX_PROXY_BODY_BYTES + 1) },
        method: 'POST',
      }),
      retrievalContext,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('bounds chunked bodies even when content-length is absent', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await POST(
      new Request('http://localhost/api/v1/primitive-retrievals', {
        body: 'x'.repeat(MAX_PROXY_BODY_BYTES + 1),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      retrievalContext,
    );

    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('preserves query strings and uses a timeout beyond the semantic deadline', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal('fetch', upstream);
    const response = await GET(
      new Request('http://localhost/api/v1/primitives?kinds=government&tags=city-state'),
      { params: Promise.resolve({ path: ['primitives'] }) },
    );

    expect(response.status).toBe(200);
    const upstreamUrl = upstream.mock.calls[0]?.[0];
    expect(upstreamUrl).toBeInstanceOf(URL);
    expect(upstreamUrl instanceof URL ? `${upstreamUrl.pathname}${upstreamUrl.search}` : '').toBe(
      '/api/v1/primitives?kinds=government&tags=city-state',
    );
    expect(API_PROXY_TIMEOUT_MS).toBeGreaterThan(3_000);
  });

  it('allows bounded manifest studio routes and rejects lookalike paths', async () => {
    const upstream = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', upstream);
    const allowed = await GET(
      new Request(`http://localhost/api/v1/worlds/${worldId}/manifest-revisions?limit=25`),
      { params: Promise.resolve({ path: ['worlds', worldId, 'manifest-revisions'] }) },
    );
    expect(allowed.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();

    const rejected = await GET(
      new Request(`http://localhost/api/v1/worlds/${worldId}/manifest-revisions/export-all`),
      {
        params: Promise.resolve({
          path: ['worlds', worldId, 'manifest-revisions', 'export-all'],
        }),
      },
    );
    expect(rejected.status).toBe(404);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('allows only bounded compilation and WorldGraph routes', async () => {
    const upstream = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', upstream);
    const runId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
    const allowedPaths = [
      `worlds/${worldId}/compilations/current`,
      `worlds/${worldId}/compilations/${runId}`,
      `worlds/${worldId}/compilations/${runId}/diagnostics`,
      `worlds/${worldId}/compilations/${runId}/artifact`,
      `worlds/${worldId}/runtime-summary`,
      `worlds/${worldId}/entities`,
      `worlds/${worldId}/entities/district:skyforge`,
      `worlds/${worldId}/entities/district:skyforge/neighbors`,
      `worlds/${worldId}/relationships`,
    ];

    for (const path of allowedPaths) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}?limit=25`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status, path).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(allowedPaths.length);

    const recursive = `worlds/${worldId}/entities/district:skyforge/neighbors/recursive`;
    const recursiveResponse = await GET(new Request(`http://localhost/api/v1/${recursive}`), {
      params: Promise.resolve({ path: recursive.split('/') }),
    });
    expect(recursiveResponse.status).toBe(404);

    const unsafeKey = `worlds/${worldId}/entities/District%2Fsecret`;
    const unsafeResponse = await GET(new Request(`http://localhost/api/v1/${unsafeKey}`), {
      params: Promise.resolve({
        path: ['worlds', worldId, 'entities', 'District/secret'],
      }),
    });
    expect(unsafeResponse.status).toBe(404);
  });

  it('allows bounded command and history routes without exposing operator endpoints', async () => {
    const upstream = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', upstream);
    const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
    const allowed = [
      `commands/${commandId}`,
      `worlds/${worldId}/runtime-head`,
      `worlds/${worldId}/history`,
      `worlds/${worldId}/history/42`,
    ];
    for (const path of allowed) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status).toBe(200);
    }
    const commandResponse = await POST(
      new Request(`http://localhost/api/v1/worlds/${worldId}/commands`, {
        body: '{}',
        method: 'POST',
      }),
      { params: Promise.resolve({ path: ['worlds', worldId, 'commands'] }) },
    );
    expect(commandResponse.status).toBe(200);
    const denied = await GET(
      new Request(`http://localhost/api/v1/worlds/${worldId}/ledger/export`),
      { params: Promise.resolve({ path: ['worlds', worldId, 'ledger', 'export'] }) },
    );
    expect(denied.status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(allowed.length + 1);
  });

  it('allows only exact simulation read routes through the browser boundary', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal('fetch', upstream);
    const scheduleId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
    const allowed = [
      `worlds/${worldId}/simulation/clock`,
      `worlds/${worldId}/simulation/schedule`,
      `worlds/${worldId}/simulation/schedule/${scheduleId}`,
      `worlds/${worldId}/simulation/batches`,
    ];

    for (const path of allowed) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}?limit=20`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status, path).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(allowed.length);
    const lastUpstreamUrl = upstream.mock.calls.at(-1)?.[0];
    expect(lastUpstreamUrl).toBeInstanceOf(URL);
    expect(
      lastUpstreamUrl instanceof URL ? `${lastUpstreamUrl.pathname}${lastUpstreamUrl.search}` : '',
    ).toBe(`/api/v1/${allowed.at(-1)}?limit=20`);

    const denied = [
      `worlds/${worldId}/simulation`,
      `worlds/${worldId}/simulation/schedule/not-a-uuid`,
      `worlds/${worldId}/simulation/schedule/${scheduleId}/history`,
      `worlds/${worldId}/simulation/batches/export`,
      `worlds/${worldId}/simulation/leases`,
    ];
    for (const path of denied) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status, path).toBe(404);
    }

    const directMutation = `worlds/${worldId}/simulation/advance`;
    const mutationResponse = await POST(
      new Request(`http://localhost/api/v1/${directMutation}`, { body: '{}', method: 'POST' }),
      { params: Promise.resolve({ path: directMutation.split('/') }) },
    );
    expect(mutationResponse.status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(allowed.length);
  });

  it('allows only the bounded economy, wallet, asset, and offer read routes', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal('fetch', upstream);
    const walletId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
    const allowed = [
      `worlds/${worldId}/economy/summary`,
      `worlds/${worldId}/economy/currencies`,
      `worlds/${worldId}/economy/wallets`,
      `worlds/${worldId}/economy/wallets/${walletId}/transactions`,
      `worlds/${worldId}/assets`,
      `worlds/${worldId}/assets/asset:founding-seal`,
      `worlds/${worldId}/assets/asset-kind:founding-seal`,
      `worlds/${worldId}/asset-transfer-offers`,
    ];

    for (const path of allowed) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}?limit=100`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status, path).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(allowed.length);
    const lastUpstreamUrl = upstream.mock.calls.at(-1)?.[0];
    expect(lastUpstreamUrl).toBeInstanceOf(URL);
    expect(
      lastUpstreamUrl instanceof URL ? `${lastUpstreamUrl.pathname}${lastUpstreamUrl.search}` : '',
    ).toBe(`/api/v1/${allowed.at(-1)}?limit=100`);

    const denied = [
      `worlds/${worldId}/economy`,
      `worlds/${worldId}/economy/repair-plans/${walletId}`,
      `worlds/${worldId}/economy/wallets/not-a-uuid/transactions`,
      `worlds/${worldId}/economy/wallets/${walletId}/transactions/export`,
      `worlds/${worldId}/assets/not-an-asset-key`,
      `worlds/${worldId}/assets/asset:founding-seal/history`,
      `worlds/${worldId}/asset-transfer-offers/${walletId}`,
      `worlds/${worldId}/asset-transfer-offers/export`,
    ];
    for (const path of denied) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status, path).toBe(404);
    }
    expect(upstream).toHaveBeenCalledTimes(allowed.length);

    const deniedMutations = [
      `worlds/${worldId}/economy/initialize`,
      `worlds/${worldId}/economy/reconcile`,
      `worlds/${worldId}/economy/repair-plans/${walletId}/approvals`,
      `worlds/${worldId}/assets/asset:founding-seal/transfer`,
      `worlds/${worldId}/asset-transfer-offers`,
      `worlds/${worldId}/asset-transfer-offers/${walletId}/accept`,
    ];
    for (const path of deniedMutations) {
      const response = await POST(
        new Request(`http://localhost/api/v1/${path}`, { body: '{}', method: 'POST' }),
        { params: Promise.resolve({ path: path.split('/') }) },
      );
      expect(response.status, path).toBe(404);
    }
    expect(upstream).toHaveBeenCalledTimes(allowed.length);
  });

  it('allows every exact commerce read without opening commerce subpaths or mutations', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal('fetch', upstream);
    const businessId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
    const listingId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
    const allowed = [
      `worlds/${worldId}/economy/resources`,
      `worlds/${worldId}/economy/recipes`,
      `worlds/${worldId}/economy/inventories`,
      `worlds/${worldId}/economy/businesses`,
      `worlds/${worldId}/economy/facilities`,
      `worlds/${worldId}/economy/employment/offers`,
      `worlds/${worldId}/economy/businesses/${businessId}/employment-candidates`,
      `worlds/${worldId}/economy/employment/contracts`,
      `worlds/${worldId}/economy/employment/jobs`,
      `worlds/${worldId}/economy/production-runs`,
      `worlds/${worldId}/economy/market/listings`,
      `worlds/${worldId}/economy/market/trades`,
      `worlds/${worldId}/economy/market/listings/${listingId}/purchase-preview`,
      `worlds/${worldId}/economy/transactions`,
      `worlds/${worldId}/economy/treasury`,
      `worlds/${worldId}/economy/tax-assessments`,
      `worlds/${worldId}/economy/reconciliation`,
    ];

    for (const path of allowed) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status, path).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(allowed.length);

    const denied = [
      `worlds/${worldId}/economy/resources/export`,
      `worlds/${worldId}/economy/transactions/${listingId}`,
      `worlds/${worldId}/economy/transactions/export`,
      `worlds/${worldId}/economy/businesses/not-a-uuid/employment-candidates`,
      `worlds/${worldId}/economy/businesses/${businessId}/employment-candidates/export`,
      `worlds/${worldId}/economy/market/listings/not-a-uuid/purchase-preview`,
      `worlds/${worldId}/economy/market/listings/${listingId}/purchase`,
      `worlds/${worldId}/economy/tax-assessments/${listingId}`,
      `worlds/${worldId}/economy/treasury/export`,
      `worlds/${worldId}/economy/reconciliation/repair`,
      `worlds/${worldId}/economy/employment/payroll`,
    ];
    for (const path of denied) {
      const response = await GET(new Request(`http://localhost/api/v1/${path}`), {
        params: Promise.resolve({ path: path.split('/') }),
      });
      expect(response.status, path).toBe(404);
    }
    expect(upstream).toHaveBeenCalledTimes(allowed.length);

    for (const path of [
      `worlds/${worldId}/economy/transactions`,
      `worlds/${worldId}/economy/market/listings/${listingId}/purchase-preview`,
    ]) {
      const response = await POST(
        new Request(`http://localhost/api/v1/${path}`, { body: '{}', method: 'POST' }),
        { params: Promise.resolve({ path: path.split('/') }) },
      );
      expect(response.status, path).toBe(404);
    }
    expect(upstream).toHaveBeenCalledTimes(allowed.length);
  });

  it('allows exact compilation mutations without opening arbitrary run subpaths', async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        rowVersion: 1,
        runId: '018f8652-3cb6-7d52-904b-cce7901d7e31',
        stage: 'queued',
        status: 'queued',
      }),
    );
    vi.stubGlobal('fetch', upstream);
    const runId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
    const paths = [
      `worlds/${worldId}/compilations`,
      `worlds/${worldId}/compilations/${runId}/cancel`,
      `worlds/${worldId}/compilations/${runId}/retry`,
    ];
    for (const path of paths) {
      const response = await POST(
        new Request(`http://localhost/api/v1/${path}`, {
          body: '{}',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        { params: Promise.resolve({ path: path.split('/') }) },
      );
      expect(response.status, path).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(paths.length);

    const unsafe = `worlds/${worldId}/compilations/${runId}/force-activate`;
    const response = await POST(
      new Request(`http://localhost/api/v1/${unsafe}`, { body: '{}', method: 'POST' }),
      { params: Promise.resolve({ path: unsafe.split('/') }) },
    );
    expect(response.status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(paths.length);
  });
});
