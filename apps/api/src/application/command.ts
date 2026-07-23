import { createHash } from 'node:crypto';

import {
  COMMAND_SCHEMA_VERSION,
  canonicalJson,
  type CommandEnvelope,
  type IdGenerator,
} from '@worldgraph/contracts';

export interface BuildCommandInput {
  action: string;
  actorUserId: string;
  expectedRowVersion?: number;
  idempotencyKey: string;
  payload: object;
  requestId: string;
  resourceId?: string;
}

export function requestHash(input: object): Buffer {
  return createHash('sha256').update(canonicalJson(input)).digest();
}

export function buildCommand(
  input: BuildCommandInput,
  idGenerator: IdGenerator,
): CommandEnvelope & { requestHashBytes: Buffer } {
  const requestHashBytes = requestHash({
    action: input.action,
    ...(input.expectedRowVersion ? { expectedRowVersion: input.expectedRowVersion } : {}),
    payload: input.payload,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
  });
  const commandId = idGenerator.next();
  const command = {
    action: input.action,
    actorUserId: input.actorUserId,
    commandId,
    correlationId: input.requestId,
    ...(input.expectedRowVersion ? { expectedRowVersion: input.expectedRowVersion } : {}),
    idempotencyKey: input.idempotencyKey,
    requestHash: requestHashBytes.toString('hex'),
    requestId: input.requestId,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    schemaVersion: COMMAND_SCHEMA_VERSION,
  } as CommandEnvelope & { requestHashBytes: Buffer };
  Object.defineProperty(command, 'requestHashBytes', {
    enumerable: false,
    value: requestHashBytes,
    writable: false,
  });
  return command;
}
