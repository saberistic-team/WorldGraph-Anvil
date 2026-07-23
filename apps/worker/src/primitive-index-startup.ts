import { PRIMITIVE_INDEX_SCHEMA_VERSION } from '@worldgraph/contracts';

import type {
  PrimitiveIndexJobDiscovery,
  PrimitiveIndexRepository,
} from './primitive-index-repository.js';

const MAX_DISCOVERY_JOBS = 10_000;
const MAX_CONSECUTIVE_NO_PROGRESS_BATCHES = 8;

export interface PrimitiveIndexJobDiscoveryRepository {
  ensureCurrentJobs(
    providerConfigurationId: string,
    indexSchemaVersion: number,
    limit: number,
  ): Promise<PrimitiveIndexJobDiscovery>;
}

/**
 * Adds only missing side-by-side jobs for the selected profile. Existing
 * pending, completed, failed, or disabled jobs are never reset.
 */
export async function reconcilePrimitiveIndexJobs(
  repository: PrimitiveIndexJobDiscoveryRepository,
  providerConfigurationId: string,
  batchSize: number,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 250) {
    throw new Error('PRIMITIVE_INDEX_DISCOVERY_CONFIGURATION_INVALID');
  }
  let inserted = 0;
  let consecutiveNoProgress = 0;
  while (inserted < MAX_DISCOVERY_JOBS) {
    const result = await repository.ensureCurrentJobs(
      providerConfigurationId,
      PRIMITIVE_INDEX_SCHEMA_VERSION,
      batchSize,
    );
    if (
      !Number.isSafeInteger(result.inserted) ||
      result.inserted < 0 ||
      result.inserted > batchSize ||
      !Number.isSafeInteger(result.remaining) ||
      result.remaining < 0
    ) {
      throw new Error('PRIMITIVE_INDEX_DISCOVERY_RESULT_INVALID');
    }
    inserted += result.inserted;
    if (result.remaining === 0) return inserted;
    consecutiveNoProgress = result.inserted === 0 ? consecutiveNoProgress + 1 : 0;
    if (consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS_BATCHES) break;
  }
  throw new Error('PRIMITIVE_INDEX_DISCOVERY_LIMIT_EXCEEDED');
}

export function supportsPrimitiveIndexJobDiscovery(
  repository: PrimitiveIndexRepository,
): repository is PrimitiveIndexRepository & PrimitiveIndexJobDiscoveryRepository {
  return typeof repository.ensureCurrentJobs === 'function';
}
