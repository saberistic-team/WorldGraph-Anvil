import type {
  ControllerIntentV1,
  DomainEventEnvelopeV1,
  LedgerEntryV1,
  RenameableWorldEntityType,
  WorldCommandEnvelopeV1,
  WorldCommandRejectionCode,
  WorldEntityRenamedPayloadV1,
  WorldEntityV1,
  WorldRelationshipV1,
} from '@worldgraph/contracts';

export type LedgerWorldEntityProjectionV1 = WorldEntityV1 & { entityVersion: string };

export interface WorldProjectionV1 {
  activeWorldVersionId: string;
  controllers: readonly ControllerIntentV1[];
  entities: readonly LedgerWorldEntityProjectionV1[];
  projectionSchemaVersion: 1;
  relationships: readonly WorldRelationshipV1[];
  stateRevision: string;
  worldId: string;
  worldVersionNumber: string;
}

export interface RenameWorldEntityDecisionStateV1 {
  entity: LedgerWorldEntityProjectionV1 | undefined;
  stateRevision: string;
  worldVersionNumber: string;
}

export interface RenameWorldEntityAcceptedDecisionV1 {
  accepted: true;
  aggregateId: string;
  aggregateType: 'world_entity';
  eventSchemaVersion: 1;
  eventType: 'WorldEntityRenamedV1';
  payload: WorldEntityRenamedPayloadV1;
}

export interface RenameWorldEntityRejectedDecisionV1 {
  accepted: false;
  currentStateRevision: string;
  rejectionCode: Extract<
    WorldCommandRejectionCode,
    | 'WORLD_VERSION_CONFLICT'
    | 'REVISION_CONFLICT'
    | 'AGGREGATE_VERSION_CONFLICT'
    | 'VALIDATION_FAILED'
    | 'ENTITY_NOT_FOUND'
    | 'ENTITY_TYPE_NOT_RENAMEABLE'
    | 'DISPLAY_NAME_UNCHANGED'
  >;
}

export type RenameWorldEntityDecisionV1 =
  RenameWorldEntityAcceptedDecisionV1 | RenameWorldEntityRejectedDecisionV1;

export interface CommandDecisionContextV1 {
  command: WorldCommandEnvelopeV1;
  state: RenameWorldEntityDecisionStateV1;
}

export interface LedgerVerificationSuccessV1 {
  entryCount: number;
  eventCount: number;
  lastEntryHash: string;
  lastLedgerSequence: string;
  valid: true;
  worldId: string | null;
}

export type LedgerVerificationFailureCodeV1 =
  | 'WORLD_MISMATCH'
  | 'LEDGER_SEQUENCE_GAP'
  | 'PREVIOUS_HASH_MISMATCH'
  | 'ENTRY_HASH_MISMATCH'
  | 'EVENT_MISSING'
  | 'EVENT_WORLD_MISMATCH'
  | 'EVENT_HASH_MISMATCH'
  | 'EVENT_SEQUENCE_GAP'
  | 'EVENT_LINK_DUPLICATE'
  | 'EVENT_UNLINKED';

export interface LedgerVerificationFailureV1 {
  actual: string | null;
  code: LedgerVerificationFailureCodeV1;
  expected: string | null;
  firstBadLedgerSequence: string;
  message: string;
  valid: false;
  worldId: string | null;
}

export type LedgerVerificationResultV1 = LedgerVerificationSuccessV1 | LedgerVerificationFailureV1;

export interface ReplayWorldProjectionInputV1 {
  events: readonly DomainEventEnvelopeV1[];
  genesisProjection: WorldProjectionV1;
}

export interface ReplayWorldProjectionResultV1 {
  checksum: string;
  eventCount: number;
  lastEventSequence: string;
  projection: WorldProjectionV1;
}

export interface LedgerExportV1 {
  entries: readonly LedgerEntryV1[];
  events: readonly DomainEventEnvelopeV1[];
  exportHash: string;
  fromLedgerSequence: string;
  ledgerSchemaVersion: 1;
  toLedgerSequence: string;
  worldId: string;
}

export const RENAMEABLE_WORLD_ENTITY_TYPES = [
  'district',
  'institution',
  'organization',
  'actor_blueprint',
  'player_character',
] as const satisfies readonly RenameableWorldEntityType[];
