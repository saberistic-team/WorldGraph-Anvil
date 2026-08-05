import { createHash } from 'node:crypto';

import { canonicalJson } from '@worldgraph/contracts';

/**
 * Hashes the exact, server-validated governance command transport document used
 * for recent-credential issuance and consumption.
 */
export function governanceRecentCredentialCommandHashV1(command: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(command), 'utf8').digest();
}
