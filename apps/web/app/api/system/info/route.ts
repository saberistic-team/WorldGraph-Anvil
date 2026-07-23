import { callApi, proxyFailure, proxyResponse } from '../../../lib/api';

export async function GET(): Promise<Response> {
  try {
    return proxyResponse(await callApi('/api/v1/system/info'));
  } catch {
    return proxyFailure();
  }
}
