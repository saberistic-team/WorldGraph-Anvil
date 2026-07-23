import { ApplicationError } from '../application/errors.js';

const CONTROL_CHARACTER = /\p{Cc}/u;

export function normalizeCreatorOverrideReason(value: string): string {
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < 10 || normalized.length > 500 || CONTROL_CHARACTER.test(value)) {
    throw new ApplicationError(
      'VALIDATION_FAILED',
      'The override reason must contain 10 to 500 printable characters.',
      400,
    );
  }
  return normalized;
}
