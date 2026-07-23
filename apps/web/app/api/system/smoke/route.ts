import { callApi, proxyFailure, proxyResponse } from '../../../lib/api';

export async function POST(request: Request): Promise<Response> {
  try {
    const authorization = request.headers.get('authorization');
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!authorization || !idempotencyKey) {
      return Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Authorization and idempotency key are required.',
            requestId: crypto.randomUUID(),
          },
        },
        { status: 400 },
      );
    }
    return proxyResponse(
      await callApi('/api/v1/system/smoke-jobs', {
        body: '{}',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        method: 'POST',
      }),
    );
  } catch {
    return proxyFailure();
  }
}
