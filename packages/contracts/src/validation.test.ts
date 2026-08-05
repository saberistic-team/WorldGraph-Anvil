import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { createValidator } from './validation.js';

describe('contract validator', () => {
  it('caches by exact schema identity while preserving boolean and detailed validation', () => {
    const schema = Type.Object(
      {
        label: Type.String({ minLength: 1 }),
        nested: Type.Object(
          { count: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    );
    const validator = createValidator(schema);
    const invalid = { extra: true, label: '', nested: { count: 0, extra: true } };

    expect(createValidator(schema)).toBe(validator);
    expect(createValidator(structuredClone(schema))).not.toBe(validator);
    expect(validator.is({ label: 'valid', nested: { count: 1 } })).toBe(true);
    expect(validator.is(invalid)).toBe(false);

    const issues = validator.issues(invalid);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'additionalProperties', path: '/' }),
        expect.objectContaining({ keyword: 'minLength', path: '/label' }),
        expect.objectContaining({ keyword: 'additionalProperties', path: '/nested' }),
        expect.objectContaining({ keyword: 'minimum', path: '/nested/count' }),
      ]),
    );
    expect(issues).toHaveLength(4);
    expect(() => validator.assert(invalid)).toThrow(JSON.stringify(issues));
  });
});
