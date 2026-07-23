import { describe, expect, it } from 'vitest';

import { fieldId } from './validation-focus';

describe('fieldId', () => {
  it('focuses dependency fields through draft-wrapped JSON pointers', () => {
    expect(fieldId('/draft/dependencies/12/parameterMapping')).toBe(
      'dependency-12-parameterMapping',
    );
  });

  it('focuses the owning root field for nested schema issues', () => {
    expect(fieldId('/parameterSchema/properties/population/minimum')).toBe(
      'primitive-parameterSchema',
    );
  });

  it('falls back to the editor for unknown or escaped fields', () => {
    expect(fieldId('/draft/custom~1field')).toBe('primitive-editor');
    expect(fieldId('')).toBe('primitive-editor');
  });
});
