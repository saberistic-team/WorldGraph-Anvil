import { Type, type Static } from '@sinclair/typebox';

import {
  GovernanceAuditPageV1Schema,
  GovernanceCandidacyPageV1Schema,
  GovernanceCharterViewV1Schema,
  GovernanceElectionPageV1Schema,
  GovernanceElectionReceiptViewV1Schema,
  GovernanceElectionResultViewV1Schema,
  GovernanceInstitutionPageV1Schema,
  GovernanceLawPageV1Schema,
  GovernanceOfficePageV1Schema,
  GovernanceOfficeTermPageV1Schema,
  GovernanceProposalPageV1Schema,
  GovernanceProposalReceiptViewV1Schema,
  GovernanceProposalResultViewV1Schema,
  GovernanceUiCapabilitiesViewV1Schema,
  GovernanceVersionSchema,
  SafeGovernanceEventPayloadV1Schema,
} from '@worldgraph/contracts';

export {
  GovernanceAuditPageV1Schema,
  GovernanceCandidacyPageV1Schema,
  GovernanceCharterViewV1Schema,
  GovernanceElectionPageV1Schema,
  GovernanceElectionReceiptViewV1Schema,
  GovernanceElectionResultViewV1Schema,
  GovernanceInstitutionPageV1Schema,
  GovernanceLawPageV1Schema,
  GovernanceOfficePageV1Schema,
  GovernanceOfficeTermPageV1Schema,
  GovernanceProposalPageV1Schema,
  GovernanceProposalReceiptViewV1Schema,
  GovernanceProposalResultViewV1Schema,
  GovernanceUiCapabilitiesViewV1Schema,
};

export const GovernanceWorldParamsSchema = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

export const GovernanceProposalParamsSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    proposalId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

export const GovernanceElectionParamsSchema = Type.Object(
  {
    electionId: Type.String({ format: 'uuid' }),
    id: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

export const GovernancePageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 1_024, minLength: 1 })),
    limit: Type.Optional(
      Type.Union([
        Type.Integer({ maximum: 100, minimum: 1 }),
        Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const GovernanceStreamQuerySchema = Type.Object(
  {
    after: Type.Optional(GovernanceVersionSchema),
  },
  { additionalProperties: false },
);

export const GovernanceRealtimeMessageV1Schema = Type.Object(
  {
    aggregateId: Type.String({ maxLength: 240, minLength: 1 }),
    aggregateType: Type.String({
      maxLength: 80,
      minLength: 1,
      pattern: '^[a-z][a-z0-9._-]*$',
    }),
    aggregateVersion: GovernanceVersionSchema,
    eventCursor: GovernanceVersionSchema,
    eventType: Type.String({
      maxLength: 120,
      minLength: 3,
      pattern: '^[A-Z][A-Za-z0-9]*V[1-9][0-9]*$',
    }),
    occurredAt: Type.String({ format: 'date-time' }),
    payload: SafeGovernanceEventPayloadV1Schema,
    resultingStateRevision: GovernanceVersionSchema,
    worldId: Type.String({ format: 'uuid' }),
  },
  { $id: 'GovernanceRealtimeMessageV1', additionalProperties: false },
);

export const GovernanceStreamBatchV1Schema = Type.Object(
  {
    events: Type.Array(GovernanceRealtimeMessageV1Schema, { maxItems: 100 }),
    nextCursor: GovernanceVersionSchema,
  },
  { $id: 'GovernanceStreamBatchV1', additionalProperties: false },
);

export type GovernancePageQuery = Static<typeof GovernancePageQuerySchema>;
export type GovernanceStreamQuery = Static<typeof GovernanceStreamQuerySchema>;
export type GovernanceRealtimeMessageV1 = Static<typeof GovernanceRealtimeMessageV1Schema>;
export type GovernanceStreamBatchV1 = Static<typeof GovernanceStreamBatchV1Schema>;
