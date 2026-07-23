import type { CompiledWorldV1 } from '@worldgraph/contracts';
import { PROJECTION_SCHEMA_VERSION, canonicalJson } from '@worldgraph/contracts';

import { WORLD_PROJECTION_CHECKSUM_DOMAIN_V1, hashesEqual, sha256CanonicalV1 } from './hash.js';
import type { WorldProjectionV1 } from './types.js';

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createWorldProjectionV1(input: {
  activeWorldVersionId: string;
  compiledWorld: Pick<CompiledWorldV1, 'controllers' | 'entities' | 'relationships'>;
  stateRevision?: string;
  worldId: string;
  worldVersionNumber: string;
}): WorldProjectionV1 {
  return {
    activeWorldVersionId: input.activeWorldVersionId,
    controllers: [...input.compiledWorld.controllers]
      .map((controller) => canonicalClone(controller))
      .sort((left, right) =>
        left.entityLogicalKey === right.entityLogicalKey
          ? compareCanonicalStrings(left.principalKey, right.principalKey)
          : compareCanonicalStrings(left.entityLogicalKey, right.entityLogicalKey),
      ),
    entities: [...input.compiledWorld.entities]
      .map((entity) => ({ ...canonicalClone(entity), entityVersion: '1' }))
      .sort((left, right) => compareCanonicalStrings(left.logicalKey, right.logicalKey)),
    projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
    relationships: [...input.compiledWorld.relationships]
      .map((relationship) => canonicalClone(relationship))
      .sort((left, right) => compareCanonicalStrings(left.logicalKey, right.logicalKey)),
    stateRevision: input.stateRevision ?? '0',
    worldId: input.worldId,
    worldVersionNumber: input.worldVersionNumber,
  };
}

export function canonicalWorldProjectionChecksumMaterialV1(projection: WorldProjectionV1) {
  return {
    activeWorldVersionId: projection.activeWorldVersionId,
    controllers: [...projection.controllers].sort((left, right) =>
      left.entityLogicalKey === right.entityLogicalKey
        ? compareCanonicalStrings(left.principalKey, right.principalKey)
        : compareCanonicalStrings(left.entityLogicalKey, right.entityLogicalKey),
    ),
    domain: WORLD_PROJECTION_CHECKSUM_DOMAIN_V1,
    entities: [...projection.entities].sort((left, right) =>
      compareCanonicalStrings(left.logicalKey, right.logicalKey),
    ),
    projectionSchemaVersion: projection.projectionSchemaVersion,
    relationships: [...projection.relationships].sort((left, right) =>
      compareCanonicalStrings(left.logicalKey, right.logicalKey),
    ),
    stateRevision: projection.stateRevision,
    worldId: projection.worldId,
    worldVersionNumber: projection.worldVersionNumber,
  };
}

export function computeWorldProjectionChecksumV1(projection: WorldProjectionV1): string {
  return sha256CanonicalV1(canonicalWorldProjectionChecksumMaterialV1(projection));
}

export function compareWorldProjectionV1(
  live: WorldProjectionV1,
  replayed: WorldProjectionV1,
): { equal: boolean; liveChecksum: string; replayChecksum: string } {
  const liveChecksum = computeWorldProjectionChecksumV1(live);
  const replayChecksum = computeWorldProjectionChecksumV1(replayed);
  return { equal: hashesEqual(liveChecksum, replayChecksum), liveChecksum, replayChecksum };
}
