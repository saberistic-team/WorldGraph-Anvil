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

const validatorCache = new WeakMap<object, Validator<unknown>>();

function issuesFrom(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    keyword: error.keyword,
    message: error.message ?? 'Invalid value.',
    path: error.instancePath || '/',
  }));
}

function compileValidator<T>(schema: AnySchema, allErrors: boolean): ValidateFunction<T> {
  const ajv = new Ajv2020({
    allErrors,
    allowUnionTypes: false,
    discriminator: true,
    removeAdditional: false,
    strict: true,
  });
  addFormats(ajv);
  return ajv.compile<T>(schema) as ValidateFunction<T>;
}

export function createValidator<T>(schema: AnySchema): Validator<T> {
  const cacheKey = typeof schema === 'object' && schema !== null ? schema : null;
  const cached = cacheKey === null ? undefined : validatorCache.get(cacheKey);
  if (cached !== undefined) return cached as Validator<T>;

  const fastValidate = compileValidator<T>(schema, false);
  let detailedValidate: ValidateFunction<T> | undefined;
  const detailed = (): ValidateFunction<T> => {
    detailedValidate ??= compileValidator<T>(schema, true);
    return detailedValidate;
  };

  const validator: Validator<T> = {
    assert(value: unknown): asserts value is T {
      if (!fastValidate(value)) {
        const validate = detailed();
        validate(value);
        throw new TypeError(JSON.stringify(issuesFrom(validate.errors)));
      }
    },
    is(value: unknown): value is T {
      return fastValidate(value);
    },
    issues(value: unknown): ValidationIssue[] {
      const validate = detailed();
      validate(value);
      return issuesFrom(validate.errors);
    },
  };
  if (cacheKey !== null) validatorCache.set(cacheKey, validator);
  return validator;
}
