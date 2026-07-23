import type { ErrorCode } from '@worldgraph/contracts';

export class EconomyDomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'EconomyDomainError';
  }
}
