import { describe, expect, it } from 'vitest';

import { CommandEnvelopeSchema, createValidator } from '@worldgraph/contracts';
import { SequenceIdGenerator } from '@worldgraph/test-utils';

import { buildCommand, requestHash } from './command.js';

describe('application command envelope', () => {
  it('hashes canonical payloads and binds action/resource/version', () => {
    expect(requestHash({ a: 1, b: 2 })).toEqual(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toEqual(requestHash({ a: 2 }));
    const command = buildCommand(
      {
        action: 'world.rename',
        actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        expectedRowVersion: 2,
        idempotencyKey: 'rename-123',
        payload: { name: 'New name' },
        requestId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        resourceId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
      },
      new SequenceIdGenerator(['018f8652-3cb6-7d52-904b-cce7901d7e28']),
    );
    expect(command.schemaVersion).toBe(1);
    expect(command.requestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(createValidator(CommandEnvelopeSchema).is(command)).toBe(true);
    const otherRoute = buildCommand(
      {
        action: 'primitive.version.reindex',
        actorUserId: command.actorUserId,
        expectedRowVersion: 2,
        idempotencyKey: command.idempotencyKey,
        payload: {
          body: { expectedRowVersion: 2 },
          route: { key: 'worldgraph.resource.energy', version: '1.0.0' },
        },
        requestId: command.requestId,
      },
      new SequenceIdGenerator(['018f8652-3cb6-7d52-904b-cce7901d7e29']),
    );
    const anotherRoute = buildCommand(
      {
        action: 'primitive.version.reindex',
        actorUserId: command.actorUserId,
        expectedRowVersion: 2,
        idempotencyKey: command.idempotencyKey,
        payload: {
          body: { expectedRowVersion: 2 },
          route: { key: 'worldgraph.currency.closed-loop-credits', version: '1.0.0' },
        },
        requestId: command.requestId,
      },
      new SequenceIdGenerator(['018f8652-3cb6-7d52-904b-cce7901d7e30']),
    );
    expect(otherRoute.requestHash).not.toBe(anotherRoute.requestHash);
    expect(createValidator(CommandEnvelopeSchema).is(otherRoute)).toBe(true);
  });
});
