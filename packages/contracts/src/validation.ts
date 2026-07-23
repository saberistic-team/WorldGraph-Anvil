import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export interface ValidationIssue {
  keyword: string;
  message: string;
  path: string;
}

export interface Validator<T> {
  assert(value: unknown): asserts value is T;
  issues(value: unknown): ValidationIssue[];
  is(value: unknown): value is T;
}

function issuesFrom(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    keyword: error.keyword,
    message: error.message ?? 'Invalid value.',
    path: error.instancePath || '/',
  }));
}

export function createValidator<T>(schema: AnySchema): Validator<T> {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: false,
    discriminator: true,
    removeAdditional: false,
    strict: true,
  });
  addFormats(ajv);
  const validate = ajv.compile<T>(schema) as ValidateFunction<T>;

  return {
    assert(value: unknown): asserts value is T {
      if (!validate(value)) {
        throw new TypeError(JSON.stringify(issuesFrom(validate.errors)));
      }
    },
    is(value: unknown): value is T {
      return validate(value);
    },
    issues(value: unknown): ValidationIssue[] {
      validate(value);
      return issuesFrom(validate.errors);
    },
  };
}
