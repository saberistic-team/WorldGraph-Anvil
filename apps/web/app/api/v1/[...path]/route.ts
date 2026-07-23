import { callApi, proxyFailure, proxyResponse } from '../../../lib/api';

export const MAX_PROXY_BODY_BYTES = 160 * 1024;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const primitiveKey = '[a-z][a-z0-9]*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*){2,}';
const semver =
  '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const primitiveVersionPath = `primitives/${primitiveKey}/versions/${semver}`;
const adminPrimitiveVersionPath = `admin/${primitiveVersionPath}`;
const logicalKey = '(?=[^/]{3,240}(?:/|$))[a-z0-9]+(?::[a-z0-9][a-z0-9._-]*)+';
const economyStableKey = '(?=[^/]{3,240}(?:/|$))[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+';
const allowlist: Record<string, RegExp[]> = {
  DELETE: [new RegExp(`^worlds/${uuid}/memberships/${uuid}$`, 'u')],
  GET: [
    /^auth\/me$/u,
    new RegExp(`^manifest-generations/${uuid}$`, 'u'),
    /^primitives$/u,
    new RegExp(`^${primitiveVersionPath}$`, 'u'),
    new RegExp(`^${primitiveVersionPath}/dependencies$`, 'u'),
    /^worlds$/u,
    new RegExp(`^worlds/${uuid}$`, 'u'),
    new RegExp(`^worlds/${uuid}/memberships$`, 'u'),
    new RegExp(`^worlds/${uuid}/invitations$`, 'u'),
    new RegExp(`^worlds/${uuid}/authority/audit$`, 'u'),
    new RegExp(`^worlds/${uuid}/manifest-revisions$`, 'u'),
    new RegExp(`^worlds/${uuid}/manifest-revisions/diff$`, 'u'),
    new RegExp(`^worlds/${uuid}/manifest-revisions/${uuid}$`, 'u'),
    new RegExp(`^worlds/${uuid}/compilations/current$`, 'u'),
    new RegExp(`^worlds/${uuid}/compilations/${uuid}$`, 'u'),
    new RegExp(`^worlds/${uuid}/compilations/${uuid}/diagnostics$`, 'u'),
    new RegExp(`^worlds/${uuid}/compilations/${uuid}/artifact$`, 'u'),
    new RegExp(`^worlds/${uuid}/runtime-summary$`, 'u'),
    new RegExp(`^worlds/${uuid}/runtime-head$`, 'u'),
    new RegExp(`^worlds/${uuid}/history$`, 'u'),
    new RegExp(`^worlds/${uuid}/history/[0-9]{1,20}$`, 'u'),
    new RegExp(`^worlds/${uuid}/simulation/clock$`, 'u'),
    new RegExp(`^worlds/${uuid}/simulation/schedule$`, 'u'),
    new RegExp(`^worlds/${uuid}/simulation/schedule/${uuid}$`, 'u'),
    new RegExp(`^worlds/${uuid}/simulation/batches$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/summary$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/currencies$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/wallets$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/wallets/${uuid}/transactions$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/resources$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/recipes$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/inventories$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/businesses$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/facilities$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/employment/offers$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/businesses/${uuid}/employment-candidates$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/employment/contracts$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/employment/jobs$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/production-runs$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/market/listings$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/market/trades$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/market/listings/${uuid}/purchase-preview$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/transactions$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/treasury$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/tax-assessments$`, 'u'),
    new RegExp(`^worlds/${uuid}/economy/reconciliation$`, 'u'),
    new RegExp(`^worlds/${uuid}/assets$`, 'u'),
    new RegExp(`^worlds/${uuid}/assets/${economyStableKey}$`, 'u'),
    new RegExp(`^worlds/${uuid}/asset-transfer-offers$`, 'u'),
    new RegExp(`^commands/${uuid}$`, 'u'),
    new RegExp(`^worlds/${uuid}/entities$`, 'u'),
    new RegExp(`^worlds/${uuid}/entities/${logicalKey}$`, 'u'),
    new RegExp(`^worlds/${uuid}/entities/${logicalKey}/neighbors$`, 'u'),
    new RegExp(`^worlds/${uuid}/relationships$`, 'u'),
  ],
  PATCH: [
    new RegExp(`^worlds/${uuid}$`, 'u'),
    new RegExp(`^worlds/${uuid}/memberships/${uuid}$`, 'u'),
  ],
  POST: [
    /^auth\/(register|login|logout|csrf)$/u,
    /^primitive-retrievals$/u,
    /^admin\/primitives\/drafts$/u,
    new RegExp(`^${adminPrimitiveVersionPath}/(?:publish|deprecate|reindex)$`, 'u'),
    /^worlds$/u,
    /^invitations\/accept$/u,
    new RegExp(`^worlds/${uuid}/invitations$`, 'u'),
    new RegExp(`^worlds/${uuid}/invitations/${uuid}/revoke$`, 'u'),
    new RegExp(`^worlds/${uuid}/creator-overrides$`, 'u'),
    new RegExp(`^worlds/${uuid}/manifest-generations$`, 'u'),
    new RegExp(`^manifest-generations/${uuid}/cancel$`, 'u'),
    new RegExp(`^worlds/${uuid}/manifest-revisions$`, 'u'),
    new RegExp(`^worlds/${uuid}/manifest-revisions/${uuid}/(?:validate|approve)$`, 'u'),
    new RegExp(`^worlds/${uuid}/compilations$`, 'u'),
    new RegExp(`^worlds/${uuid}/compilations/${uuid}/(?:cancel|retry)$`, 'u'),
    new RegExp(`^worlds/${uuid}/commands$`, 'u'),
  ],
  PUT: [new RegExp(`^${adminPrimitiveVersionPath}/draft$`, 'u')],
};

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

function payloadTooLarge(): Response {
  return Response.json(
    {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `The request body exceeds ${MAX_PROXY_BODY_BYTES} bytes.`,
        requestId: crypto.randomUUID(),
      },
    },
    { headers: { 'cache-control': 'no-store' }, status: 413 },
  );
}

async function boundedBody(request: Request): Promise<string | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_PROXY_BODY_BYTES) return null;
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROXY_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = (await context.params).path.join('/');
  if (!allowlist[method]?.some((pattern) => pattern.test(path))) {
    return Response.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'The requested resource was not found.',
          requestId: crypto.randomUUID(),
        },
      },
      { status: 404 },
    );
  }
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'cookie', 'idempotency-key', 'x-csrf-token']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('origin', request.headers.get('origin') ?? new URL(request.url).origin);
  try {
    const hasBody = !['GET', 'HEAD'].includes(method);
    const init: RequestInit = {
      headers,
      method,
      redirect: 'manual',
    };
    if (hasBody) {
      const body = await boundedBody(request);
      if (body === null) return payloadTooLarge();
      init.body = body;
    }
    const response = await callApi(`/api/v1/${path}${new URL(request.url).search}`, init);
    return proxyResponse(response);
  } catch {
    return proxyFailure();
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;
