export const primitiveKinds = [
  'government',
  'election',
  'currency',
  'tax',
  'resource',
  'production_recipe',
  'terrain',
  'district',
  'building',
  'organization',
  'office',
  'legal_right',
  'player_role',
  'visual_style',
  'simulation_rule',
  'event_template',
] as const;

export type PrimitiveKind = (typeof primitiveKinds)[number];
export type PrimitiveIndexState =
  | 'completed'
  | 'dead'
  | 'disabled'
  | 'failed'
  | 'not_requested'
  | 'pending'
  | 'queued'
  | 'running'
  | 'stale';

export interface PrimitiveDependency {
  dependencyFamilyId?: string;
  key: string;
  parameterMapping?: Record<string, unknown>;
  required: boolean;
  resolvedContentHash?: string | null;
  resolvedVersion: string | null;
  resolvedVersionId?: string | null;
  versionRange: string;
}

export interface PrimitiveListItem {
  contentHash: string;
  createdAt: string;
  displayName: string;
  id: string;
  indexErrorCode: string | null;
  indexState: PrimitiveIndexState;
  key: string;
  kind: PrimitiveKind;
  lifecycle: 'deprecated' | 'draft' | 'published';
  publishedAt: string | null;
  rowVersion: number;
  tags: string[];
  updatedAt: string;
  version: string;
}

export interface PrimitiveVersion extends PrimitiveListItem {
  behaviorRef: string | null;
  compatibility: Record<string, unknown>;
  defaults: Record<string, unknown>;
  deprecatedAt: string | null;
  deprecationReason: string | null;
  dependencies: PrimitiveDependency[];
  documentation: string;
  parameterSchema: Record<string, unknown>;
  primitiveSchemaVersion: number;
  provenance: Record<string, unknown>;
  visualHints: Record<string, unknown>;
}

export interface RankReason {
  lexicalRank: number | null;
  lexicalScore: number | null;
  matchedTags: string[];
  matchedTerms: string[];
  score: number;
  tagRank: number | null;
  tagScore: number | null;
  vectorRank: number | null;
  vectorSimilarity: number | null;
}

export interface RetrievalResult {
  dependencyClosure: Array<{
    contentHash?: string;
    familyId?: string;
    key: string;
    primitiveVersionId?: string;
    version: string;
  }>;
  index: {
    contentHash: string;
    indexSchemaVersion: number;
    lastErrorCode: string | null;
    model: string | null;
    provider: string | null;
    providerConfigurationId: string | null;
    status: PrimitiveIndexState;
  };
  primitive: PrimitiveListItem;
  rank: number;
  reason: RankReason;
}

export interface RetrievalResponse {
  normalizedQueryHash: string;
  provider: {
    configurationId: string | null;
    degradedReason: string | null;
    model: string | null;
    name: string | null;
    semanticAvailable: boolean;
  };
  ranking: {
    k: number;
    strategy: string;
    weights: { lexical: number; tag: number; vector: number };
  };
  results: RetrievalResult[];
  retrievalRunId: string;
  warnings: Array<{ code: string; message: string }>;
}

export interface ValidationIssue {
  code: string;
  message: string;
  pointer: string;
}

export function primitivePath(primitive: Pick<PrimitiveListItem, 'key' | 'version'>): string {
  return `/primitives/${encodeURIComponent(primitive.key)}/versions/${encodeURIComponent(primitive.version)}`;
}

export function adminPrimitivePath(primitive: Pick<PrimitiveListItem, 'key' | 'version'>): string {
  return `/api/v1/admin/primitives/${encodeURIComponent(primitive.key)}/versions/${encodeURIComponent(primitive.version)}`;
}

function primitiveCandidate(value: unknown): PrimitiveVersion | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof value.key === 'string' &&
    'version' in value &&
    typeof value.version === 'string'
  ) {
    return value as PrimitiveVersion;
  }
  return null;
}

export function unwrapPrimitive(value: unknown): PrimitiveVersion {
  const direct = primitiveCandidate(value);
  if (direct) return direct;
  if (typeof value === 'object' && value !== null) {
    const envelope = value as Record<string, unknown>;
    for (const key of ['primitive', 'draft', 'version']) {
      const candidate = primitiveCandidate(envelope[key]);
      if (candidate) return candidate;
    }
  }
  return value as PrimitiveVersion;
}
