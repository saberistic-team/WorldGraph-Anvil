const apiBaseUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
// This exceeds the registry's three-second semantic deadline and the API's default ten-second
// request deadline, while still bounding a stalled internal dependency.
export const API_PROXY_TIMEOUT_MS = 12_000;
export const ARTIFACT_PROXY_TIMEOUT_MS = 30_000;

export async function callApi(
  path: string,
  init?: RequestInit,
  timeoutMs = API_PROXY_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(new URL(path, apiBaseUrl), {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function proxyFailure(): Response {
  return Response.json(
    {
      error: {
        code: 'API_UNAVAILABLE',
        message: 'The API is temporarily unavailable.',
        requestId: crypto.randomUUID(),
      },
    },
    { headers: { 'cache-control': 'no-store' }, status: 503 },
  );
}

export async function proxyResponse(response: Response): Promise<Response> {
  const body = response.status === 204 ? null : await response.text();
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
  });
  for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(body, {
    headers,
    status: response.status,
  });
}
