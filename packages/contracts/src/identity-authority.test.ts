import { describe, expect, it } from 'vitest';

import { createValidator } from './validation.js';
import {
  ApplicationNotificationSchema,
  CommandEnvelopeSchema,
  CreateInvitationRequestSchema,
  RecentCredentialProofSchema,
  RegisterRequestSchema,
} from './index.js';

describe('identity and authority contracts', () => {
  it('bounds password and invite privilege inputs', () => {
    const registration = createValidator(RegisterRequestSchema);
    const invitation = createValidator(CreateInvitationRequestSchema);
    expect(registration.is({ email: 'a@example.test', password: 'correct horse battery' })).toBe(
      true,
    );
    expect(registration.is({ email: 'a@example.test', password: 'short' })).toBe(false);
    expect(invitation.is({ email: 'b@example.test', expiresIn: 3600, role: 'administrator' })).toBe(
      false,
    );
  });

  it('requires the versioned idempotent command identity', () => {
    const command = createValidator(CommandEnvelopeSchema);
    expect(
      command.is({
        action: 'world.create',
        actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        commandId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        correlationId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        idempotencyKey: 'request-123',
        requestHash: 'a'.repeat(64),
        requestId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
        schemaVersion: 1,
      }),
    ).toBe(true);
  });

  it('keeps recent-credential responses opaque and password-free', () => {
    const proof = createValidator(RecentCredentialProofSchema);
    expect(
      proof.is({
        expiresAt: '2026-07-21T12:05:00.000Z',
        proofToken: 'opaque-proof-token-with-sufficient-length',
      }),
    ).toBe(true);
    expect(
      proof.is({ expiresAt: '2026-07-21T12:05:00.000Z', password: 'must-not-be-returned' }),
    ).toBe(false);
  });

  it('runtime-validates each typed application notification payload', () => {
    const notification = createValidator(ApplicationNotificationSchema);
    expect(
      notification.is({
        id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        occurredAt: '2026-07-21T12:00:00.000Z',
        payload: {
          actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          role: 'administrator',
          targetUserId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
          worldId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
        },
        schemaVersion: 1,
        type: 'MembershipRoleChanged',
      }),
    ).toBe(true);
    expect(
      notification.is({
        id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        occurredAt: '2026-07-21T12:00:00.000Z',
        payload: { rawToken: 'must-never-be-a-notification-field' },
        schemaVersion: 1,
        type: 'InvitationCreated',
      }),
    ).toBe(false);
    expect(
      notification.is({
        id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        occurredAt: '2026-07-21T12:00:00.000Z',
        payload: {
          actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          contentHash: 'a'.repeat(64),
          indexSchemaVersion: 1,
          primitiveVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
          providerConfigurationId: 'disabled-v1',
        },
        schemaVersion: 1,
        type: 'PrimitiveIndexRequested',
      }),
    ).toBe(true);
    expect(
      notification.is({
        id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        occurredAt: '2026-07-21T12:00:00.000Z',
        payload: {
          primitiveVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
          rawQuery: 'private text',
        },
        schemaVersion: 1,
        type: 'PrimitiveIndexRequested',
      }),
    ).toBe(false);
  });
});
