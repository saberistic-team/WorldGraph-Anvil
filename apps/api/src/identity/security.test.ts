import { describe, expect, it } from 'vitest';

import {
  Argon2idPasswordHasher,
  assertPasswordPolicy,
  deriveInvitationToken,
  generateOpaqueToken,
  hashSecret,
  IdentityInputError,
  normalizeDisplayName,
  normalizeEmail,
  redactAuditMetadata,
  TEST_PASSWORD_HASH_OPTIONS,
} from './security.js';

describe('identity security primitives', () => {
  const pepper = 'test-only-auth-pepper-32-characters-long';

  it('normalizes email and applies bounded password policy', () => {
    expect(normalizeEmail('  Alice@EXAMPLE.test ')).toBe('alice@example.test');
    expect(() => assertPasswordPolicy('short')).toThrowError(IdentityInputError);
    expect(() => assertPasswordPolicy('abcdefghijkl')).toThrowError(IdentityInputError);
    expect(() => assertPasswordPolicy('long passphrase with words')).not.toThrow();
    expect(() => assertPasswordPolicy('A'.repeat(129))).toThrowError(IdentityInputError);
    expect(() => normalizeDisplayName('   ')).toThrowError(IdentityInputError);
  });

  it('hashes with Argon2id and a pepper without exposing the password', async () => {
    const hasher = new Argon2idPasswordHasher(pepper, TEST_PASSWORD_HASH_OPTIONS);
    const encoded = await hasher.hash('Correct horse battery staple');
    expect(encoded).toMatch(/^\$argon2id\$/u);
    expect(encoded).not.toContain('Correct');
    await expect(hasher.verify(encoded, 'Correct horse battery staple')).resolves.toBe(true);
    await expect(hasher.verify(encoded, 'Wrong horse battery staple')).resolves.toBe(false);
  });

  it('uses 256-bit opaque tokens, domain-separated hashes, and deterministic invite recovery', () => {
    expect(Buffer.from(generateOpaqueToken(), 'base64url')).toHaveLength(32);
    expect(hashSecret('same', pepper, 'session')).not.toEqual(hashSecret('same', pepper, 'csrf'));
    expect(deriveInvitationToken('018f8652-3cb6-7d52-904b-cce7901d7e25', pepper)).toBe(
      deriveInvitationToken('018f8652-3cb6-7d52-904b-cce7901d7e25', pepper),
    );
  });

  it('redacts all credential material from audit metadata', () => {
    expect(
      redactAuditMetadata({
        csrfToken: 'secret',
        inviteLink: 'secret',
        approvalExpiresAt: '2026-08-03T12:15:00.000Z',
        approvalIssuedAt: '2026-08-03T12:00:00.000Z',
        commandId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
        commandRequestHash: 'a'.repeat(64),
        commandType: 'RepairGovernanceResultV1',
        method: 'password',
        password: 'secret',
        registrationMode: 'closed_alpha_local',
        safe: 'not-allowlisted',
      }),
    ).toEqual({
      approvalExpiresAt: '2026-08-03T12:15:00.000Z',
      approvalIssuedAt: '2026-08-03T12:00:00.000Z',
      commandId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
      commandRequestHash: 'a'.repeat(64),
      commandType: 'RepairGovernanceResultV1',
      method: 'password',
      registrationMode: 'closed_alpha_local',
    });
  });
});
