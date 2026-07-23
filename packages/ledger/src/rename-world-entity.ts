import type {
  RenameableWorldEntityType,
  WorldCommandEnvelopeV1,
  WorldEntityRenamedEventV1,
} from '@worldgraph/contracts';

import type {
  LedgerWorldEntityProjectionV1,
  RenameWorldEntityDecisionStateV1,
  RenameWorldEntityDecisionV1,
  WorldProjectionV1,
} from './types.js';
import { isLedgerPublicTextSafeV1 } from './privacy.js';

function nextDecimalString(value: string): string {
  return (BigInt(value) + 1n).toString();
}

function entityDisplayName(entity: LedgerWorldEntityProjectionV1): string | undefined {
  switch (entity.entityType) {
    case 'district':
    case 'institution':
    case 'organization':
    case 'actor_blueprint':
    case 'player_character':
      return entity.state.name;
    default:
      return undefined;
  }
}

function isCanonicalDisplayName(value: string): boolean {
  return (
    value === value.normalize('NFC') && value === value.trim() && isLedgerPublicTextSafeV1(value)
  );
}

export function decideRenameWorldEntityV1(
  command: WorldCommandEnvelopeV1,
  state: RenameWorldEntityDecisionStateV1,
): RenameWorldEntityDecisionV1 {
  if (command.expectedWorldVersion !== state.worldVersionNumber) {
    return {
      accepted: false,
      currentStateRevision: state.stateRevision,
      rejectionCode: 'WORLD_VERSION_CONFLICT',
    };
  }
  if (command.expectedStateRevision !== state.stateRevision) {
    return {
      accepted: false,
      currentStateRevision: state.stateRevision,
      rejectionCode: 'REVISION_CONFLICT',
    };
  }
  if (!state.entity || state.entity.logicalKey !== command.payload.entityKey) {
    return {
      accepted: false,
      currentStateRevision: state.stateRevision,
      rejectionCode: 'ENTITY_NOT_FOUND',
    };
  }
  if (command.expectedAggregateVersion !== state.entity.entityVersion) {
    return {
      accepted: false,
      currentStateRevision: state.stateRevision,
      rejectionCode: 'AGGREGATE_VERSION_CONFLICT',
    };
  }

  const previousDisplayName = entityDisplayName(state.entity);
  if (!previousDisplayName) {
    return {
      accepted: false,
      currentStateRevision: state.stateRevision,
      rejectionCode: 'ENTITY_TYPE_NOT_RENAMEABLE',
    };
  }
  if (!isCanonicalDisplayName(command.payload.newDisplayName)) {
    return {
      accepted: false,
      currentStateRevision: state.stateRevision,
      rejectionCode: 'VALIDATION_FAILED',
    };
  }
  if (previousDisplayName === command.payload.newDisplayName) {
    return {
      accepted: false,
      currentStateRevision: state.stateRevision,
      rejectionCode: 'DISPLAY_NAME_UNCHANGED',
    };
  }

  return {
    accepted: true,
    aggregateId: state.entity.logicalKey,
    aggregateType: 'world_entity',
    eventSchemaVersion: 1,
    eventType: 'WorldEntityRenamedV1',
    payload: {
      entityKey: state.entity.logicalKey,
      entityType: state.entity.entityType as RenameableWorldEntityType,
      entityVersion: nextDecimalString(state.entity.entityVersion),
      newDisplayName: command.payload.newDisplayName,
      previousDisplayName,
    },
  };
}

function renamedEntity(
  entity: LedgerWorldEntityProjectionV1,
  event: WorldEntityRenamedEventV1,
): LedgerWorldEntityProjectionV1 {
  switch (entity.entityType) {
    case 'district':
    case 'institution':
    case 'organization':
    case 'actor_blueprint':
    case 'player_character':
      return {
        ...entity,
        entityVersion: event.payload.entityVersion,
        state: { ...entity.state, name: event.payload.newDisplayName },
      } as LedgerWorldEntityProjectionV1;
    default:
      throw new Error(`Entity type ${entity.entityType} cannot be renamed.`);
  }
}

export function reduceWorldEntityRenamedV1(
  projection: WorldProjectionV1,
  event: WorldEntityRenamedEventV1,
): WorldProjectionV1 {
  const index = projection.entities.findIndex(
    (entity) => entity.logicalKey === event.payload.entityKey,
  );
  if (index < 0) throw new Error(`Replay entity not found: ${event.payload.entityKey}`);

  const entity = projection.entities[index]!;
  if (entity.entityType !== event.payload.entityType) {
    throw new Error(`Replay entity type mismatch at ${event.payload.entityKey}.`);
  }
  const currentName = entityDisplayName(entity);
  if (currentName === undefined) {
    throw new Error(`Replay entity is not renameable: ${event.payload.entityKey}`);
  }
  if (currentName !== event.payload.previousDisplayName) {
    throw new Error(`Replay previous display name mismatch at ${event.payload.entityKey}.`);
  }
  if (nextDecimalString(entity.entityVersion) !== event.payload.entityVersion) {
    throw new Error(`Replay aggregate version mismatch at ${event.payload.entityKey}.`);
  }
  const entities = [...projection.entities];
  entities[index] = renamedEntity(entity, event);
  return {
    ...projection,
    entities,
  };
}
