import { createHash } from 'node:crypto';

/**
 * Integer-only xorshift32. Seed expansion is SHA-256 and output is defined as
 * unsigned 32-bit arithmetic, so its vectors are stable across JS runtimes.
 */
export class DeterministicPrng {
  private state: number;

  public constructor(seed: string) {
    const digest = createHash('sha256').update(`worldgraph-prng-v1\0${seed}`, 'utf8').digest();
    this.state = digest.readUInt32LE(0) || 0x6d2b79f5;
  }

  public nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  public nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
      throw new RangeError('PRNG bound must be a positive safe integer no greater than 2^32.');
    }
    const range = 0x1_0000_0000;
    const ceiling = range - (range % maxExclusive);
    let value = this.nextUint32();
    while (value >= ceiling) value = this.nextUint32();
    return value % maxExclusive;
  }
}
