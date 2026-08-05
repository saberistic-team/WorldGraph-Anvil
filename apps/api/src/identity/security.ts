import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { hash, verify, type Options } from '@node-rs/argon2';

const TOKEN_BYTES = 32;
function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

export interface PasswordHashOptions {
  memoryCost: number;
  parallelism: number;
  timeCost: number;
}

export const PRODUCTION_PASSWORD_HASH_OPTIONS: PasswordHashOptions = {
  memoryCost: 19_456,
  parallelism: 1,
  timeCost: 2,
};

export const TEST_PASSWORD_HASH_OPTIONS: PasswordHashOptions = {
  memoryCost: 1_024,
  parallelism: 1,
  timeCost: 1,
};

export function normalizeEmail(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function normalizeDisplayName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < 1 || normalized.length > 80 || containsControlCharacters(normalized)) {
    throw new IdentityInputError('Display name must contain 1 to 80 printable characters.');
  }
  return normalized;
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < 12 || password.length > 128 || containsControlCharacters(password)) {
    throw new IdentityInputError('Password must contain 12 to 128 printable characters.');
  }
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9\s]/u].filter((rule) =>
    rule.test(password),
  ).length;
  if (password.length < 20 && classes < 3) {
    throw new IdentityInputError(
      'Password must be at least 20 characters or contain three character classes.',
    );
  }
}

export class IdentityInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdentityInputError';
  }
}

export class Argon2idPasswordHasher {
  private readonly options: Options;

  public constructor(
    pepper: string,
    options: PasswordHashOptions = PRODUCTION_PASSWORD_HASH_OPTIONS,
  ) {
    this.options = {
      algorithm: 2,
      memoryCost: options.memoryCost,
      outputLen: 32,
      parallelism: options.parallelism,
      secret: Buffer.from(pepper, 'utf8'),
      timeCost: options.timeCost,
      version: 1,
    };
  }

  public async hash(password: string): Promise<string> {
    assertPasswordPolicy(password);
    return hash(password, this.options);
  }

  public async verify(encodedHash: string, password: string): Promise<boolean> {
    if (password.length > 128) return false;
    try {
      return await verify(encodedHash, password, this.options);
    } catch {
      return false;
    }
  }
}

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSecret(secret: string, pepper: string, domain: string): Buffer {
  return createHmac('sha256', pepper).update(domain).update('\0').update(secret).digest();
}

export function deriveInvitationToken(invitationId: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update('worldgraph.invitation.v1\0')
    .update(invitationId)
    .digest('base64url');
}

export function secretsMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

const ALLOWED_AUDIT_KEYS = new Set([
  'approvalExpiresAt',
  'approvalIssuedAt',
  'authorityReasonCode',
  'authorityRuleId',
  'bindingHash',
  'commandId',
  'commandRequestHash',
  'commandType',
  'credentialResult',
  'method',
  'newRole',
  'override',
  'previousRole',
  'registrationMode',
  'sessionId',
]);

export function redactAuditMetadata(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([key, value]) =>
          ALLOWED_AUDIT_KEYS.has(key) &&
          (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'),
      )
      .slice(0, 20)
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 200) : value]),
  );
}
