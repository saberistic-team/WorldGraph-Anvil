const SAFE_INDEX_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,99}$/u;

/** Display only bounded stable codes; never surface provider/database error text. */
export function sanitizedIndexError(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && SAFE_INDEX_ERROR_CODE.test(value)
    ? value
    : 'INDEX_FAILURE_REDACTED';
}
