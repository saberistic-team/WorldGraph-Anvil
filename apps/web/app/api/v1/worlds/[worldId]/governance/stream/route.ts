import { API_PROXY_TIMEOUT_MS, callApi, proxyFailure } from '../../../../../../lib/api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface RouteContext {
  params: Promise<{ worldId: string }>;
}

/**
 * A dedicated streaming boundary: the generic API proxy intentionally buffers
 * JSON bodies and therefore cannot safely carry server-sent governance notices.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { worldId } = await context.params;
  if (!UUID_PATTERN.test(worldId)) {
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

  const headers = new Headers({ accept: 'text/event-stream' });
  for (const name of ['cookie', 'last-event-id']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('origin', request.headers.get('origin') ?? new URL(request.url).origin);

  const after = new URL(request.url).searchParams.get('after');
  const upstreamPath =
    after === null
      ? `/api/v1/worlds/${worldId}/governance/stream`
      : `/api/v1/worlds/${worldId}/governance/stream?after=${encodeURIComponent(after)}`;

  try {
    const upstream = await callApi(
      upstreamPath,
      { headers, method: 'GET', redirect: 'manual' },
      API_PROXY_TIMEOUT_MS,
    );
    const responseHeaders = new Headers({
      'cache-control': 'no-cache, no-store',
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'x-accel-buffering': 'no',
    });
    return new Response(upstream.body, {
      headers: responseHeaders,
      status: upstream.status,
    });
  } catch {
    return proxyFailure();
  }
}
