import { describe, expect, it } from 'vitest';

import { operatorFailureMessage } from './operator-errors.js';

describe('operator failure redaction', () => {
  it('preserves bounded operator errors', () => {
    expect(operatorFailureMessage(new Error('--world must be a UUID.'), false)).toBe(
      '--world must be a UUID.',
    );
  });

  it('redacts connection failures and observer-confirmed interruptions', () => {
    const secret = 'postgres://operator:secret@example.internal/worldgraph';
    const refused = Object.assign(new Error(`connect ECONNREFUSED ${secret}`), {
      code: 'ECONNREFUSED',
    });
    const sqlState = Object.assign(new Error(`connection failure ${secret}`), { code: '08006' });

    for (const message of [
      operatorFailureMessage(refused, false),
      operatorFailureMessage(sqlState, false),
      operatorFailureMessage(new Error(secret), true),
    ]) {
      expect(message).toBe('The operator database connection was interrupted.');
      expect(message).not.toContain(secret);
    }
  });
});
