import { v7 as uuidv7 } from 'uuid';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface RandomSource {
  next(): number;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  public next(): string {
    return uuidv7();
  }
}
