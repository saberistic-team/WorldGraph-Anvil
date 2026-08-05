'use client';

export interface ApiFailure {
  code: string;
  details?: Record<string, unknown>;
  message: string;
  requestId?: string;
}

export class BrowserApiError extends Error {
  public constructor(
    public readonly failure: ApiFailure,
    public readonly status: number,
  ) {
    super(failure.message);
    this.name = 'BrowserApiError';
  }
}

function csrfCookie(): string | undefined {
  const entry = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('wg_csrf='));
  return entry ? decodeURIComponent(entry.slice('wg_csrf='.length)) : undefined;
}

export async function ensureCsrf(): Promise<string> {
  const existing = csrfCookie();
  if (existing) return existing;
  const response = await requestJson<{ csrfToken: string }>('/api/v1/auth/csrf', {
    method: 'POST',
  });
  return response.csrfToken;
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as {
    error?: ApiFailure;
  } & T;
  if (!response.ok) {
    throw new BrowserApiError(
      body.error ?? { code: 'REQUEST_FAILED', message: 'The request could not be completed.' },
      response.status,
    );
  }
  return body;
}

export async function mutateJson<T>(
  path: string,
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT',
  body: object = {},
  idempotencyKey = crypto.randomUUID(),
  additionalHeaders: Record<string, string> = {},
): Promise<T> {
  const csrf = await ensureCsrf();
  return requestJson<T>(path, {
    body: JSON.stringify(body),
    headers: {
      ...additionalHeaders,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-csrf-token': csrf,
    },
    method,
  });
}

export function safeReturnPath(value: string | null, fallback = '/worlds'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }
  return value;
}

export function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
