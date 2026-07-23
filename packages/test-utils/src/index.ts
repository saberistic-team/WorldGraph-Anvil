import type { Clock, IdGenerator, RandomSource } from '@worldgraph/contracts';

export class FixedClock implements Clock {
  public constructor(private current: Date) {}

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  public now(): Date {
    return new Date(this.current);
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private index = 0;

  public constructor(private readonly ids: readonly string[]) {}

  public next(): string {
    const value = this.ids[this.index];
    if (!value) throw new Error('The deterministic ID sequence is exhausted.');
    this.index += 1;
    return value;
  }
}

export class XorShift32 implements RandomSource {
  private state: number;

  public constructor(seed: number) {
    if (!Number.isInteger(seed) || seed === 0)
      throw new TypeError('Seed must be a non-zero integer.');
    this.state = seed | 0;
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value | 0;
    return (value >>> 0) / 4_294_967_296;
  }
}
