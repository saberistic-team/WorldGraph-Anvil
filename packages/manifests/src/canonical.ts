import { createHash } from 'node:crypto';

import {
  MANIFEST_GENERATOR_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  canonicalJson,
  type WorldManifestV1,
} from '@worldgraph/contracts';

import type { ManifestCatalogSnapshot } from './catalog.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeManifestPrompt(prompt: string): string {
  return prompt.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function canonicalManifestJson(manifest: WorldManifestV1): string {
  return canonicalJson(manifest);
}

export function manifestContentHash(manifest: WorldManifestV1): string {
  return sha256(canonicalManifestJson(manifest));
}

export function canonicalCatalogSnapshot(snapshot: ManifestCatalogSnapshot): string {
  return canonicalJson({
    primitives: [...snapshot.primitives]
      .sort((left, right) => {
        const leftIdentity = `${left.key}@${left.version}`;
        const rightIdentity = `${right.key}@${right.version}`;
        return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
      })
      .map((primitive) => ({
        behaviorRef: primitive.behaviorRef,
        compatibility: primitive.compatibility,
        contentHash: primitive.contentHash,
        defaults: primitive.defaults,
        dependencies: [...primitive.dependencies]
          .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
          .map((dependency) => ({
            key: dependency.key,
            required: dependency.required,
            versionRange: dependency.versionRange,
          })),
        key: primitive.key,
        kind: primitive.kind,
        lifecycle: primitive.lifecycle,
        parameterSchema: primitive.parameterSchema,
        version: primitive.version,
        versionId: primitive.versionId,
      })),
  });
}

export function manifestCatalogSnapshotHash(snapshot: ManifestCatalogSnapshot): string {
  return sha256(canonicalCatalogSnapshot(snapshot));
}

export function manifestGenerationInputHash(input: {
  catalog: ManifestCatalogSnapshot;
  expectedParentContentHash?: string | null;
  parentRevisionId?: string | null;
  prompt: string;
  providerConfigurationId?: string | null;
  seed: string;
}): string {
  const parent = manifestGenerationParentScope(input);
  return sha256(
    canonicalJson({
      catalogSnapshotHash: manifestCatalogSnapshotHash(input.catalog),
      generatorSchemaVersion: MANIFEST_GENERATOR_SCHEMA_VERSION,
      normalizedPrompt: normalizeManifestPrompt(input.prompt),
      ...parent,
      promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
      providerConfigurationId: input.providerConfigurationId ?? null,
      seed: input.seed.normalize('NFC'),
    }),
  );
}

export function manifestGenerationRequestHash(input: {
  expectedParentContentHash?: string | null;
  parentRevisionId?: string | null;
  prompt: string;
  providerConfigurationId: string;
  seed?: string | null;
}): string {
  const seed = resolveManifestGenerationSeed(input);
  const parent = manifestGenerationParentScope(input);
  return sha256(
    canonicalJson({
      generatorSchemaVersion: MANIFEST_GENERATOR_SCHEMA_VERSION,
      normalizedPrompt: normalizeManifestPrompt(input.prompt),
      ...parent,
      promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
      providerConfigurationId: input.providerConfigurationId ?? null,
      seed,
    }),
  );
}

function manifestGenerationParentScope(input: {
  expectedParentContentHash?: string | null;
  parentRevisionId?: string | null;
}): { expectedParentContentHash: string | null; parentRevisionId: string | null } {
  const expectedParentContentHash = input.expectedParentContentHash ?? null;
  const parentRevisionId = input.parentRevisionId ?? null;
  if ((expectedParentContentHash === null) !== (parentRevisionId === null)) {
    throw new TypeError('Parent revision ID and expected content hash must be supplied together.');
  }
  if (expectedParentContentHash !== null && !/^[a-f0-9]{64}$/u.test(expectedParentContentHash)) {
    throw new TypeError('Expected parent content hash is invalid.');
  }
  if (
    parentRevisionId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      parentRevisionId,
    )
  ) {
    throw new TypeError('Parent revision ID is invalid.');
  }
  return { expectedParentContentHash, parentRevisionId };
}

export function resolveManifestGenerationSeed(input: {
  prompt: string;
  providerConfigurationId: string;
  seed?: string | null;
}): string {
  if (input.seed !== undefined && input.seed !== null) {
    const seed = input.seed.normalize('NFC');
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(seed)) {
      throw new TypeError('Manifest generation seed is invalid.');
    }
    return seed;
  }
  const requestScope = canonicalJson({
    generatorSchemaVersion: MANIFEST_GENERATOR_SCHEMA_VERSION,
    normalizedPrompt: normalizeManifestPrompt(input.prompt),
    promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
    providerConfigurationId: input.providerConfigurationId.normalize('NFC'),
  });
  return `request-${sha256(requestScope).slice(0, 32)}`;
}
