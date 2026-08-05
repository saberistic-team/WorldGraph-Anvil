const CONNECTION_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
  'ETIMEDOUT',
  '57P01',
  '57P02',
  '57P03',
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function operatorFailureMessage(
  error: unknown,
  databaseConnectionInterrupted: boolean,
): string {
  const code = errorCode(error);
  if (
    databaseConnectionInterrupted ||
    (code !== undefined && (code.startsWith('08') || CONNECTION_ERROR_CODES.has(code)))
  ) {
    return 'The operator database connection was interrupted.';
  }
  return error instanceof Error ? error.message : 'Operator command failed.';
}
