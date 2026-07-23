import { Type, type Static } from '@sinclair/typebox';

export {
  PRIMITIVE_INDEX_QUEUE,
  PRIMITIVE_INDEX_SCHEMA_VERSION,
  PRIMITIVE_QUEUE_SCHEMA_VERSION,
  PrimitiveIndexRequestedSchema,
  type PrimitiveIndexRequested,
} from './catalog.js';
export {
  MANIFEST_GENERATION_QUEUE,
  ManifestGenerationRequestedSchema,
  type ManifestGenerationRequested,
} from './manifests.js';
export {
  WORLD_COMPILATION_QUEUE,
  WorldCompilationRequestedQueueSchema,
  type WorldCompilationRequestedQueue,
} from './compiler.js';

const SmokeMessageBase = {
  jobId: Type.String({ maxLength: 128, minLength: 1 }),
  requestId: Type.String({ format: 'uuid' }),
  schemaVersion: Type.Literal(1),
} as const;

export const SystemSmokeRequestedSchema = Type.Object(
  {
    ...SmokeMessageBase,
    type: Type.Literal('SystemSmokeRequested'),
  },
  { $id: 'SystemSmokeRequestedV1', additionalProperties: false },
);

export const SystemSmokeCompletedSchema = Type.Object(
  {
    ...SmokeMessageBase,
    completedAt: Type.String({ format: 'date-time' }),
    type: Type.Literal('SystemSmokeCompleted'),
  },
  { $id: 'SystemSmokeCompletedV1', additionalProperties: false },
);

export type SystemSmokeRequested = Static<typeof SystemSmokeRequestedSchema>;
export type SystemSmokeCompleted = Static<typeof SystemSmokeCompletedSchema>;

export const SYSTEM_SMOKE_QUEUE = 'system-smoke' as const;
export const WORKER_HEARTBEAT_KEY = 'worldgraph:system:worker:heartbeat' as const;
