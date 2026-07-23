import type { SimulationErrorCode } from '@worldgraph/contracts';

export class SimulationDomainError extends Error {
  public readonly code: SimulationErrorCode;

  public constructor(code: SimulationErrorCode, message: string) {
    super(message);
    this.name = 'SimulationDomainError';
    this.code = code;
  }
}
