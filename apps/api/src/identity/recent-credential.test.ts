import { governanceRecentCredentialCommandHashV1 } from '@worldgraph/governance-command';
import { describe, expect, it, vi } from 'vitest';

import {
  PostgresRepository,
  type ActorRecord,
  type RecentCredentialProofWrite,
} from '../repositories/postgres-repository.js';
import { IdentityService } from './service.js';
import type { Argon2idPasswordHasher } from './security.js';

const userId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const sessionId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const now = new Date('2026-08-03T12:00:00.000Z');
const password = 'correct horse battery';

const actor: ActorRecord = {
  csrfHash: Buffer.alloc(32, 1),
  session: {
    absoluteExpiresAt: '2026-08-03T13:00:00.000Z',
    id: sessionId,
    idleExpiresAt: '2026-08-03T12:30:00.000Z',
  },
  user: {
    displayName: 'Operator',
    email: 'operator@example.test',
    id: userId,
    platformRole: 'platform_admin',
    rowVersion: 1,
    status: 'active',
  },
};

const command = {
  commandId,
  expectedAggregateVersion: '0',
  expectedStateRevision: '4',
  expectedTick: '10',
  expectedWorldVersion: '1',
  idempotencyKey: 'repair-governance-result-0001',
  payload: {
    approvalId: null,
    confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
    expectedCurrentResultChecksum: 'a'.repeat(64),
    reason: 'Recompute the frozen ballots and append linked evidence.',
    repairKind: 'proposal_recount',
    replacementResultChecksum: 'b'.repeat(64),
    sourceResultId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
  },
  schemaVersion: 1,
  type: 'RepairGovernanceResultV1',
} as const;
const completeCommand = { ...command, actorMode: 'administrator' } as const;

describe('recent credential service', () => {
  it('issues an opaque, short-lived proof bound to the exact server-validated command', async () => {
    const writes: RecentCredentialProofWrite[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const repository = repositoryStub({
      audits,
      proofWrites: writes,
      verifyPassword: true,
    });
    const service = identityService(repository, true);

    const proof = await service.reauthenticate(
      actor,
      { command, password, worldId },
      '018f8652-3cb6-7d52-904b-cce7901d7e26',
    );

    expect(proof.expiresAt).toBe('2026-08-03T12:05:00.000Z');
    expect(proof.proofToken).toHaveLength(43);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      commandId,
      commandType: 'RepairGovernanceResultV1',
      sessionId,
      userId,
      worldId,
    });
    expect(writes[0]?.commandRequestHash).toEqual(
      governanceRecentCredentialCommandHashV1(completeCommand),
    );
    expect(audits[0]).toMatchObject({
      metadata: {
        commandRequestHash:
          governanceRecentCredentialCommandHashV1(completeCommand).toString('hex'),
      },
    });
    expect(writes[0]?.proofHash).toHaveLength(32);
    expect(JSON.stringify({ audits, writes })).not.toContain(password);
    expect(JSON.stringify({ audits, writes })).not.toContain(proof.proofToken);
  });

  it('returns one generic failure and audits no password when verification fails', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const repository = repositoryStub({ audits, proofWrites: [], verifyPassword: false });
    const service = identityService(repository, false);

    await expect(
      service.reauthenticate(
        actor,
        { command, password: 'incorrect password value', worldId },
        '018f8652-3cb6-7d52-904b-cce7901d7e26',
      ),
    ).rejects.toMatchObject({ code: 'REAUTHENTICATION_FAILED', statusCode: 401 });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain('incorrect password value');
  });

  it('distinguishes a missing proof from malformed evidence without trusting a caller hash', () => {
    const service = identityService(repositoryStub({ audits: [], proofWrites: [] }), true);

    expect(() => service.governanceRecentCredential(actor, undefined, command)).toThrowError(
      expect.objectContaining({ code: 'RECENT_CREDENTIAL_REQUIRED' }),
    );
    expect(() => service.governanceRecentCredential(actor, 'short', command)).toThrowError(
      expect.objectContaining({ code: 'RECENT_CREDENTIAL_INVALID' }),
    );
    const evidence = service.governanceRecentCredential(actor, 'p'.repeat(43), command);
    expect(evidence).toMatchObject({ sessionId, userId });
    expect(evidence.commandRequestHash).toEqual(
      governanceRecentCredentialCommandHashV1(completeCommand),
    );
  });

  it('maps an issuance authorization race to the stable opaque proof error', async () => {
    const databaseDetail = 'private session mismatch from SECURITY DEFINER';
    const executor = {
      query: vi.fn(async () => {
        throw Object.assign(new Error(databaseDetail), { code: '42501', detail: databaseDetail });
      }),
    };
    const repository = new PostgresRepository({} as never, executor);

    await expect(
      repository.issueRecentCredentialProof({
        auditRecordId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        commandId,
        commandRequestHash: Buffer.alloc(32, 1),
        commandType: command.type,
        expiresAt: new Date('2026-08-03T12:05:00.000Z'),
        id: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        proofHash: Buffer.alloc(32, 2),
        requestId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
        sessionId,
        userId,
        verifiedAt: now,
        worldId,
      }),
    ).rejects.toMatchObject({
      code: 'RECENT_CREDENTIAL_INVALID',
      message: 'The recent-credential proof could not be issued.',
      statusCode: 403,
    });
  });
});

function repositoryStub(input: {
  audits: Array<Record<string, unknown>>;
  proofWrites: RecentCredentialProofWrite[];
  verifyPassword?: boolean;
}): PostgresRepository {
  const repository = {
    findCredential: vi.fn(async () => ({ passwordHash: 'encoded', user: actor.user })),
    getWorld: vi.fn(async () => ({ id: worldId })),
    insertAudit: vi.fn(async (audit: Record<string, unknown>) => {
      input.audits.push(audit);
    }),
    issueRecentCredentialProof: vi.fn(async (write: RecentCredentialProofWrite) => {
      input.proofWrites.push(write);
    }),
    transaction: vi.fn(async (operation: (value: PostgresRepository) => Promise<unknown>) =>
      operation(repository as unknown as PostgresRepository),
    ),
  };
  return repository as unknown as PostgresRepository;
}

function identityService(repository: PostgresRepository, verifyPassword: boolean): IdentityService {
  let nextId = 30;
  return new IdentityService(
    repository,
    {
      authPepper: 'test-auth-pepper-that-is-at-least-thirty-two-characters',
      governanceStepUpTtlSeconds: 300,
      sessionAbsoluteTtlSeconds: 3_600,
      sessionIdleTtlSeconds: 1_800,
    } as never,
    { now: () => now },
    { next: () => `018f8652-3cb6-7d52-904b-${String(nextId++).padStart(12, '0')}` },
    {
      hash: vi.fn(async () => 'dummy'),
      verify: vi.fn(async () => verifyPassword),
    } as unknown as Argon2idPasswordHasher,
    { publish: vi.fn(async () => undefined) },
  );
}
