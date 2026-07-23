import { createHash } from 'node:crypto';

import { SIMULATION_PRNG_ALGORITHM_VERSION, canonicalJson } from '@worldgraph/contracts';

import { parseNonNegativeInt64V1 } from './arithmetic.js';

export interface SimulationPrngSubstreamInputV1 {
  readonly processType: string;
  readonly processVersion: string;
  readonly stableProcessKey: string;
  readonly tick: string;
  readonly worldSeed: string;
}

export const SIMULATION_PRNG_DOMAIN_V1 = 'worldgraph.simulation.prng.v1' as const;
export const SIMULATION_WORLD_SEED_HASH_DOMAIN_V1 = 'worldgraph.simulation.world-seed.v1' as const;

export function computeSimulationWorldSeedHashV1(worldSeed: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(worldSeed)) {
    throw new TypeError('World seed is not in the canonical bounded seed format.');
  }
  return createHash('sha256')
    .update(canonicalJson({ domain: SIMULATION_WORLD_SEED_HASH_DOMAIN_V1, worldSeed }), 'utf8')
    .digest('hex');
}

export function simulationScheduleProcessKeyV1(scheduleSequence: string | bigint): string {
  const sequence = parseNonNegativeInt64V1(scheduleSequence, 'schedule sequence');
  if (sequence === 0n) throw new RangeError('Schedule sequence must be positive.');
  return `schedule:${sequence.toString()}`;
}

export function deriveSimulationPrngSubstreamSeedV1(input: SimulationPrngSubstreamInputV1): string {
  parseNonNegativeInt64V1(input.tick, 'PRNG tick');
  return createHash('sha256')
    .update(
      canonicalJson({
        algorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
        domain: SIMULATION_PRNG_DOMAIN_V1,
        processType: input.processType,
        processVersion: input.processVersion,
        stableProcessKey: input.stableProcessKey,
        tick: input.tick,
        worldSeed: input.worldSeed,
      }),
      'utf8',
    )
    .digest('hex');
}

/** Integer-only xorshift32 with SHA-256 domain-separated substream expansion. */
export class SimulationPrngV1 {
  private state: number;

  public constructor(input: SimulationPrngSubstreamInputV1) {
    const seed = deriveSimulationPrngSubstreamSeedV1(input);
    const initial = Buffer.from(seed, 'hex').readUInt32LE(0);
    this.state = initial || 0x6d2b79f5;
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
