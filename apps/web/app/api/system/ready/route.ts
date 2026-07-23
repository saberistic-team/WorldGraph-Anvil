import { callApi, proxyFailure, proxyResponse } from '../../../lib/api';

export async function GET(): Promise<Response> {
  try {
    return proxyResponse(await callApi('/health/ready'));
  } catch {
    return proxyFailure();
  }
}
