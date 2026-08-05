import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { WorldRoleSchema } from './authority.js';
import { IdempotencyKeySchema } from './commands.js';
import { GOVERNANCE_SCHEMA_VERSION, GOVERNANCE_SEED_PLAN_SCHEMA_VERSION } from './versions.js';

export {
  GOVERNANCE_POLICY_SCHEMA_VERSION,
  GOVERNANCE_SCHEMA_VERSION,
  GOVERNANCE_SEED_PLAN_SCHEMA_VERSION,
} from './versions.js';
export const GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION = 'proposal_yes_no_v1' as const;
export const GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION = 'election_plurality_v1' as const;
export const GOVERNANCE_POLICY_MAX_DEPTH = 3 as const;
export const GOVERNANCE_POLICY_MAX_NODES = 64 as const;
export const GOVERNANCE_POLICY_MAX_OPERANDS = 8 as const;

export const GovernanceUuidSchema = Type.String({ format: 'uuid' });
export const GovernanceHashSchema = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
export const GovernanceTickSchema = Type.String({
  maxLength: 19,
  minLength: 1,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
export const GovernancePositiveTickSchema = Type.String({
  maxLength: 19,
  minLength: 1,
  pattern: '^[1-9][0-9]{0,18}$',
});
export const GovernanceVersionSchema = GovernanceTickSchema;
export const GovernancePositiveVersionSchema = GovernancePositiveTickSchema;
export const GovernanceStableKeySchema = Type.String({
  maxLength: 240,
  minLength: 3,
  pattern: '^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$',
});
export const GovernanceCodeSchema = Type.String({
  maxLength: 100,
  minLength: 1,
  pattern: '^[a-z][a-z0-9._-]*$',
});
export const GovernanceTitleSchema = Type.String({
  maxLength: 160,
  minLength: 1,
  pattern: '^(?! )(?!.* $)[^\\u0000-\\u001F\\u007F-\\u009F]+$',
});
export const GovernanceSummarySchema = Type.String({
  maxLength: 1_000,
  minLength: 1,
  pattern: '^(?! )(?!.* $)[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]+$',
});
export const GovernanceBodySchema = Type.String({
  maxLength: 12_000,
  minLength: 1,
  pattern:
    '^(?! )[^\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]*[^\\s\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]$',
});
export const GovernanceReasonSchema = Type.String({
  maxLength: 1_000,
  minLength: 8,
  pattern: '^(?! )(?!.* $)[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]+$',
});
export const GovernanceAuditReasonCodeSchema = Type.String({
  maxLength: 120,
  minLength: 1,
  pattern: '^[A-Z][A-Z0-9_]*$',
});
export const GovernanceUnsignedMinorSchema = Type.String({
  maxLength: 19,
  minLength: 1,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
export const GovernancePositiveMinorSchema = Type.String({
  maxLength: 19,
  minLength: 1,
  pattern: '^[1-9][0-9]{0,18}$',
});
export const GovernanceBasisPointsSchema = Type.Integer({ maximum: 10_000, minimum: 0 });
export const GovernanceThresholdBasisPointsSchema = Type.Integer({
  maximum: 10_000,
  minimum: 1,
});

export const GovernanceActorModeSchema = Type.Union([
  Type.Literal('in_world'),
  Type.Literal('creator'),
  Type.Literal('administrator'),
  Type.Literal('system'),
]);
export const GovernanceBallotModeSchema = Type.Union([
  Type.Literal('public'),
  Type.Literal('secret'),
]);
export const GovernancePublicBallotDisclosureSchema = Type.Union([
  Type.Literal('aggregate_only'),
  Type.Literal('choice_totals'),
  Type.Literal('voter_and_choice'),
]);
export const GovernanceBallotPolicyV1Schema = Type.Union(
  [
    Type.Object(
      {
        ballotMode: Type.Literal('public'),
        disclosure: GovernancePublicBallotDisclosureSchema,
        replacementAllowed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ballotMode: Type.Literal('secret'),
        disclosure: Type.Literal('aggregate_only'),
        replacementAllowed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ],
  {},
);

export const GovernanceProposalStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('sponsoring'),
  Type.Literal('debate'),
  Type.Literal('scheduled'),
  Type.Literal('open'),
  Type.Literal('closing'),
  Type.Literal('tallied'),
  Type.Literal('certified'),
  Type.Literal('enacted'),
  Type.Literal('rejected'),
  Type.Literal('withdrawn'),
  Type.Literal('passed_but_enactment_failed'),
]);
export const GovernanceElectionStatusSchema = Type.Union([
  Type.Literal('nominations_scheduled'),
  Type.Literal('nominations_open'),
  Type.Literal('voting_scheduled'),
  Type.Literal('open'),
  Type.Literal('closing'),
  Type.Literal('tallied'),
  Type.Literal('certified'),
  Type.Literal('cancelled'),
]);
export const GovernanceTermStatusSchema = Type.Union([
  Type.Literal('scheduled'),
  Type.Literal('active'),
  Type.Literal('ended'),
  Type.Literal('removed'),
  Type.Literal('superseded_by_repair'),
]);
export const GovernanceLawStatusSchema = Type.Union([
  Type.Literal('scheduled'),
  Type.Literal('active'),
  Type.Literal('repealed'),
  Type.Literal('expired'),
  Type.Literal('superseded'),
]);
export const GovernanceInstitutionStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('suspended'),
  Type.Literal('retired'),
]);
export const GovernanceProposalChoiceSchema = Type.Union([
  Type.Literal('yes'),
  Type.Literal('no'),
  Type.Literal('abstain'),
]);
export const GovernanceElectionTieRuleSchema = Type.Union([
  Type.Literal('vacancy'),
  Type.Literal('stable_key'),
]);

export interface GovernancePolicyAllV1 {
  kind: 'all';
  operands: GovernancePolicyExpressionV1[];
}
export interface GovernancePolicyAnyV1 {
  kind: 'any';
  operands: GovernancePolicyExpressionV1[];
}
export interface GovernancePolicyNotV1 {
  kind: 'not';
  operand: GovernancePolicyExpressionV1;
}
export interface GovernancePolicyActorModeV1 {
  kind: 'actor_mode';
  mode: GovernanceActorMode;
}
export interface GovernancePolicyMembershipRoleV1 {
  kind: 'membership_role';
  role: string;
}
export interface GovernancePolicyHoldsOfficeV1 {
  kind: 'holds_office';
  officeKey: string;
}
export interface GovernancePolicyMemberOfOrganizationV1 {
  kind: 'member_of_organization';
  organizationKey: string;
}
export interface GovernancePolicyActionV1 {
  action: string;
  kind: 'action';
}
export interface GovernancePolicyResourceV1 {
  kind: 'resource';
  resourceKey: string | null;
  resourceType: string;
}
export interface GovernancePolicyTickAtOrAfterV1 {
  kind: 'tick_at_or_after';
  tick: string;
}
export interface GovernancePolicyTickBeforeV1 {
  kind: 'tick_before';
  tick: string;
}
export interface GovernancePolicyTickBetweenV1 {
  fromTick: string;
  kind: 'tick_between';
  untilTick: string;
}
export type GovernancePolicyExpressionV1 =
  | GovernancePolicyAllV1
  | GovernancePolicyAnyV1
  | GovernancePolicyNotV1
  | GovernancePolicyActorModeV1
  | GovernancePolicyMembershipRoleV1
  | GovernancePolicyHoldsOfficeV1
  | GovernancePolicyMemberOfOrganizationV1
  | GovernancePolicyActionV1
  | GovernancePolicyResourceV1
  | GovernancePolicyTickAtOrAfterV1
  | GovernancePolicyTickBeforeV1
  | GovernancePolicyTickBetweenV1;

const GovernancePolicyLeafSchemas = [
  Type.Object(
    { kind: Type.Literal('actor_mode'), mode: GovernanceActorModeSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('membership_role'), role: GovernanceCodeSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('holds_office'), officeKey: GovernanceStableKeySchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('member_of_organization'),
      organizationKey: GovernanceStableKeySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: GovernanceCodeSchema, kind: Type.Literal('action') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('resource'),
      resourceKey: Type.Union([GovernanceStableKeySchema, Type.Null()]),
      resourceType: GovernanceCodeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('tick_at_or_after'), tick: GovernanceTickSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('tick_before'), tick: GovernanceTickSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      fromTick: GovernanceTickSchema,
      kind: Type.Literal('tick_between'),
      untilTick: GovernanceTickSchema,
    },
    { additionalProperties: false },
  ),
] as const;

function governancePolicyBranchSchema(child: TSchema | null): TSchema {
  const variants: TSchema[] = [...GovernancePolicyLeafSchemas];
  if (child !== null) {
    variants.push(
      Type.Object(
        {
          kind: Type.Literal('all'),
          operands: Type.Array(child, {
            maxItems: GOVERNANCE_POLICY_MAX_OPERANDS,
            minItems: 1,
          }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('any'),
          operands: Type.Array(child, {
            maxItems: GOVERNANCE_POLICY_MAX_OPERANDS,
            minItems: 1,
          }),
        },
        { additionalProperties: false },
      ),
      Type.Object({ kind: Type.Literal('not'), operand: child }, { additionalProperties: false }),
    );
  }
  return Type.Unsafe({
    discriminator: { propertyName: 'kind' },
    oneOf: variants,
    type: 'object',
  });
}

function governancePolicyExpressionSchema(schemaId: string) {
  const definitions: Record<string, TSchema> = {
    depth0: governancePolicyBranchSchema(null),
  };
  for (let depth = 1; depth <= GOVERNANCE_POLICY_MAX_DEPTH; depth += 1) {
    // Use the policy schema's absolute identifier. A local `#/$defs/...` reference becomes
    // relative to an enclosing Fastify response schema when the policy is embedded.
    definitions[`depth${depth}`] = governancePolicyBranchSchema(
      Type.Unsafe({ $ref: `${schemaId}#/$defs/depth${depth - 1}` }),
    );
  }
  return Type.Unsafe<GovernancePolicyExpressionV1>({
    ...definitions[`depth${GOVERNANCE_POLICY_MAX_DEPTH}`],
    $defs: definitions,
    $id: schemaId,
  });
}

export const GovernancePolicyExpressionV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:direct',
);

const CreateLawPolicyV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:proposal-create-law',
);
const AmendLawPolicyV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:proposal-amend-law',
);
const GovernanceSeedInstitutionPowerPolicyV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:seed-institution-power',
);
const GovernanceSeedOfficePowerPolicyV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:seed-office-power',
);
const GovernanceSeedOfficeEligibilityPolicyV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:seed-office-eligibility',
);
const GovernanceSeedLawPolicyV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:seed-law',
);
const GovernanceSeedCharterPolicyV1Schema = governancePolicyExpressionSchema(
  'urn:worldgraph:governance-policy:v1:seed-charter',
);

export const GovernancePolicyEvaluationContextV1Schema = Type.Object(
  {
    action: GovernanceCodeSchema,
    actorMode: GovernanceActorModeSchema,
    heldOfficeKeys: Type.Array(GovernanceStableKeySchema, {
      maxItems: 64,
      uniqueItems: true,
    }),
    membershipRoles: Type.Array(GovernanceCodeSchema, { maxItems: 32, uniqueItems: true }),
    organizationKeys: Type.Array(GovernanceStableKeySchema, {
      maxItems: 64,
      uniqueItems: true,
    }),
    resourceKey: Type.Union([GovernanceStableKeySchema, Type.Null()]),
    resourceType: GovernanceCodeSchema,
    tick: GovernanceTickSchema,
  },
  { $id: 'GovernancePolicyEvaluationContextV1', additionalProperties: false },
);

export const GovernancePolicyDecisionReasonSchema = Type.Union([
  Type.Literal('POLICY_ALLOWED'),
  Type.Literal('POLICY_NOT_SATISFIED'),
  Type.Literal('POLICY_SCHEMA_INVALID'),
  Type.Literal('POLICY_LIMIT_EXCEEDED'),
  Type.Literal('POLICY_CONTEXT_INVALID'),
  Type.Literal('POLICY_EVALUATION_ERROR'),
]);
export const GovernancePolicyDecisionV1Schema = Type.Object(
  {
    allowed: Type.Boolean(),
    evaluatedNodes: Type.Integer({ maximum: GOVERNANCE_POLICY_MAX_NODES, minimum: 0 }),
    reasonCode: GovernancePolicyDecisionReasonSchema,
  },
  { $id: 'GovernancePolicyDecisionV1', additionalProperties: false },
);

const ProposalActionCommon = {
  actionSchemaVersion: Type.Literal(1),
} as const;

export const CreateLawProposalActionV1Schema = Type.Object(
  {
    ...ProposalActionCommon,
    actionType: Type.Literal('create_law'),
    effectiveFromTick: GovernanceTickSchema,
    effectiveUntilTick: Type.Union([GovernanceTickSchema, Type.Null()]),
    lawKey: GovernanceStableKeySchema,
    policy: CreateLawPolicyV1Schema,
    summary: GovernanceSummarySchema,
    targetCharterVersion: GovernancePositiveVersionSchema,
    title: GovernanceTitleSchema,
  },
  { additionalProperties: false },
);
export const AmendLawProposalActionV1Schema = Type.Object(
  {
    ...ProposalActionCommon,
    actionType: Type.Literal('amend_law'),
    effectiveFromTick: GovernanceTickSchema,
    effectiveUntilTick: Type.Union([GovernanceTickSchema, Type.Null()]),
    expectedLawVersion: GovernancePositiveVersionSchema,
    lawId: GovernanceUuidSchema,
    policy: AmendLawPolicyV1Schema,
    summary: GovernanceSummarySchema,
    title: GovernanceTitleSchema,
  },
  { additionalProperties: false },
);
export const RepealLawProposalActionV1Schema = Type.Object(
  {
    ...ProposalActionCommon,
    actionType: Type.Literal('repeal_law'),
    effectiveAtTick: GovernanceTickSchema,
    expectedLawVersion: GovernancePositiveVersionSchema,
    lawId: GovernanceUuidSchema,
    reason: GovernanceReasonSchema,
  },
  { additionalProperties: false },
);
export const UpdateTaxProposalActionV1Schema = Type.Object(
  {
    ...ProposalActionCommon,
    actionType: Type.Literal('update_tax'),
    effectiveFromTick: GovernanceTickSchema,
    expectedTaxPolicyVersion: GovernancePositiveVersionSchema,
    newRateBps: GovernanceBasisPointsSchema,
    taxPolicyId: GovernanceUuidSchema,
  },
  { additionalProperties: false },
);
export const AuthorizePublicProjectProposalActionV1Schema = Type.Object(
  {
    ...ProposalActionCommon,
    actionType: Type.Literal('authorize_public_project'),
    amountMinor: GovernancePositiveMinorSchema,
    budgetKey: GovernanceStableKeySchema,
    currencyId: GovernanceUuidSchema,
    description: GovernanceSummarySchema,
    effectiveAtTick: GovernanceTickSchema,
    projectKey: GovernanceStableKeySchema,
    treasuryWalletId: GovernanceUuidSchema,
  },
  { additionalProperties: false },
);
export const AppointOfficeholderProposalActionV1Schema = Type.Object(
  {
    ...ProposalActionCommon,
    actionType: Type.Literal('appoint_officeholder'),
    expectedOfficeVersion: GovernancePositiveVersionSchema,
    holderEntityKey: GovernanceStableKeySchema,
    officeId: GovernanceUuidSchema,
    seatIndex: Type.Integer({ maximum: 63, minimum: 0 }),
    termEndsAtTick: GovernanceTickSchema,
    termStartsAtTick: GovernanceTickSchema,
  },
  { additionalProperties: false },
);
export const ApproveWorldPatchProposalActionV1Schema = Type.Object(
  {
    ...ProposalActionCommon,
    actionType: Type.Literal('approve_world_patch'),
    effectiveAtTick: GovernanceTickSchema,
    expectedWorldVersion: GovernancePositiveVersionSchema,
    patchHash: GovernanceHashSchema,
    patchId: GovernanceUuidSchema,
  },
  { additionalProperties: false },
);
export const GovernanceProposalActionV1Schema = Type.Union(
  [
    CreateLawProposalActionV1Schema,
    AmendLawProposalActionV1Schema,
    RepealLawProposalActionV1Schema,
    UpdateTaxProposalActionV1Schema,
    AuthorizePublicProjectProposalActionV1Schema,
    AppointOfficeholderProposalActionV1Schema,
    ApproveWorldPatchProposalActionV1Schema,
  ],
  {},
);

export const GovernanceSeedInstitutionPowerV1Schema = Type.Object(
  {
    action: GovernanceCodeSchema,
    policy: GovernanceSeedInstitutionPowerPolicyV1Schema,
    resourceType: GovernanceCodeSchema,
  },
  { additionalProperties: false },
);
const GovernanceSeedOfficePowerV1Schema = Type.Object(
  {
    action: GovernanceCodeSchema,
    delegatedOrganizationEntityKeys: Type.Array(GovernanceStableKeySchema, {
      maxItems: 32,
      uniqueItems: true,
    }),
    policy: GovernanceSeedOfficePowerPolicyV1Schema,
    resourceType: GovernanceCodeSchema,
  },
  { additionalProperties: false },
);
export const GovernanceSeedInstitutionV1Schema = Type.Object(
  {
    displayName: GovernanceTitleSchema,
    institutionType: GovernanceCodeSchema,
    jurisdictionEntityKey: GovernanceStableKeySchema,
    powers: Type.Array(GovernanceSeedInstitutionPowerV1Schema, {
      maxItems: 64,
      uniqueItems: true,
    }),
    stableKey: GovernanceStableKeySchema,
    worldEntityKey: GovernanceStableKeySchema,
  },
  { $id: 'GovernanceSeedInstitutionV1', additionalProperties: false },
);
export const GovernanceSeedOfficeV1Schema = Type.Object(
  {
    ballotPolicy: GovernanceBallotPolicyV1Schema,
    displayName: GovernanceTitleSchema,
    electionCadenceTicks: GovernancePositiveTickSchema,
    eligibilityPolicy: GovernanceSeedOfficeEligibilityPolicyV1Schema,
    institutionKey: GovernanceStableKeySchema,
    powers: Type.Array(GovernanceSeedOfficePowerV1Schema, {
      maxItems: 32,
      uniqueItems: true,
    }),
    seats: Type.Integer({ maximum: 64, minimum: 1 }),
    stableKey: GovernanceStableKeySchema,
    termDurationTicks: GovernancePositiveTickSchema,
    tieRule: GovernanceElectionTieRuleSchema,
    transitionDelayTicks: GovernanceTickSchema,
  },
  { $id: 'GovernanceSeedOfficeV1', additionalProperties: false },
);
export const GovernanceSeedLawV1Schema = Type.Object(
  {
    effectiveFromTick: GovernanceTickSchema,
    effectiveUntilTick: Type.Union([GovernanceTickSchema, Type.Null()]),
    jurisdictionEntityKey: GovernanceStableKeySchema,
    policy: GovernanceSeedLawPolicyV1Schema,
    stableKey: GovernanceStableKeySchema,
    summary: GovernanceSummarySchema,
    title: GovernanceTitleSchema,
  },
  { $id: 'GovernanceSeedLawV1', additionalProperties: false },
);
export const GovernanceSeedProposalRulesV1Schema = Type.Object(
  {
    approvalThresholdBps: GovernanceThresholdBasisPointsSchema,
    ballotPolicy: GovernanceBallotPolicyV1Schema,
    debateTicks: GovernancePositiveTickSchema,
    minimumSponsors: Type.Integer({ maximum: 10_000, minimum: 0 }),
    quorumBps: GovernanceBasisPointsSchema,
    sponsorshipTicks: GovernancePositiveTickSchema,
    votingTicks: GovernancePositiveTickSchema,
  },
  { $id: 'GovernanceSeedProposalRulesV1', additionalProperties: false },
);
export const GovernanceSeedPlanV1Schema = Type.Object(
  {
    charter: Type.Object(
      {
        citizenEligibilityPolicy: GovernanceSeedCharterPolicyV1Schema,
        effectiveFromTick: GovernanceTickSchema,
        effectiveUntilTick: Type.Union([GovernanceTickSchema, Type.Null()]),
        proposalRules: GovernanceSeedProposalRulesV1Schema,
        stableKey: GovernanceStableKeySchema,
        summary: GovernanceSummarySchema,
        title: GovernanceTitleSchema,
      },
      { additionalProperties: false },
    ),
    governanceSeedPlanSchemaVersion: Type.Literal(GOVERNANCE_SEED_PLAN_SCHEMA_VERSION),
    initialLaws: Type.Array(GovernanceSeedLawV1Schema, { maxItems: 128 }),
    institutions: Type.Array(GovernanceSeedInstitutionV1Schema, {
      maxItems: 64,
      minItems: 1,
    }),
    offices: Type.Array(GovernanceSeedOfficeV1Schema, { maxItems: 64, minItems: 1 }),
  },
  { $id: 'GovernanceSeedPlanV1', additionalProperties: false },
);

const GovernanceCommandCommonFields = {
  commandId: GovernanceUuidSchema,
  expectedAggregateVersion: GovernanceVersionSchema,
  expectedStateRevision: GovernanceVersionSchema,
  expectedTick: GovernanceTickSchema,
  expectedWorldVersion: GovernancePositiveVersionSchema,
  idempotencyKey: IdempotencyKeySchema,
  schemaVersion: Type.Literal(GOVERNANCE_SCHEMA_VERSION),
} as const;

function governanceCommand<TType extends string, TPayload extends TSchema, TMode extends TSchema>(
  type: TType,
  payload: TPayload,
  actorMode: TMode,
) {
  return Type.Object(
    {
      ...GovernanceCommandCommonFields,
      actorMode,
      payload,
      type: Type.Literal(type),
    },
    { additionalProperties: false },
  );
}

const GovernanceInWorldModeSchema = Type.Literal('in_world');
const GovernanceSystemModeSchema = Type.Literal('system');
const GovernanceOperatorModeSchema = Type.Union([
  Type.Literal('creator'),
  Type.Literal('administrator'),
]);
const GovernanceInitializerModeSchema = Type.Union([
  Type.Literal('creator'),
  Type.Literal('administrator'),
  Type.Literal('system'),
]);

export const InitializeWorldGovernancePayloadV1Schema = Type.Object(
  {
    compiledWorldVersionId: GovernanceUuidSchema,
    seedPlanHash: GovernanceHashSchema,
  },
  { $id: 'InitializeWorldGovernancePayloadV1', additionalProperties: false },
);
export const InitializeWorldGovernanceV1Schema = governanceCommand(
  'InitializeWorldGovernanceV1',
  InitializeWorldGovernancePayloadV1Schema,
  GovernanceInitializerModeSchema,
);
export const AdoptGovernanceSeedPlanPayloadV1Schema = Type.Object(
  {
    adoptionReason: GovernanceReasonSchema,
    compiledWorldVersionId: GovernanceUuidSchema,
    seedPlan: GovernanceSeedPlanV1Schema,
    seedPlanHash: GovernanceHashSchema,
    sourceArtifactHash: GovernanceHashSchema,
  },
  { $id: 'AdoptGovernanceSeedPlanPayloadV1', additionalProperties: false },
);
export const AdoptGovernanceSeedPlanV1Schema = governanceCommand(
  'AdoptGovernanceSeedPlanV1',
  AdoptGovernanceSeedPlanPayloadV1Schema,
  GovernanceInitializerModeSchema,
);

export const CreateProposalPayloadV1Schema = Type.Object(
  {
    action: GovernanceProposalActionV1Schema,
    approvalThresholdBps: GovernanceThresholdBasisPointsSchema,
    ballotPolicy: GovernanceBallotPolicyV1Schema,
    body: GovernanceBodySchema,
    debateEndsAtTick: GovernanceTickSchema,
    institutionId: GovernanceUuidSchema,
    jurisdictionEntityKey: GovernanceStableKeySchema,
    minimumSponsors: Type.Integer({ maximum: 10_000, minimum: 0 }),
    proposalKey: GovernanceStableKeySchema,
    quorumBps: GovernanceBasisPointsSchema,
    sponsorshipEndsAtTick: GovernanceTickSchema,
    targetCharterVersion: GovernancePositiveVersionSchema,
    title: GovernanceTitleSchema,
    votingClosesAtTick: GovernanceTickSchema,
    votingOpensAtTick: GovernanceTickSchema,
  },
  { $id: 'CreateProposalPayloadV1', additionalProperties: false },
);
export const CreateProposalV1Schema = governanceCommand(
  'CreateProposalV1',
  CreateProposalPayloadV1Schema,
  GovernanceInWorldModeSchema,
);
export const SponsorProposalPayloadV1Schema = Type.Object(
  { expectedProposalVersion: GovernancePositiveVersionSchema, proposalId: GovernanceUuidSchema },
  { $id: 'SponsorProposalPayloadV1', additionalProperties: false },
);
export const SponsorProposalV1Schema = governanceCommand(
  'SponsorProposalV1',
  SponsorProposalPayloadV1Schema,
  GovernanceInWorldModeSchema,
);
export const WithdrawProposalPayloadV1Schema = Type.Object(
  {
    expectedProposalVersion: GovernancePositiveVersionSchema,
    proposalId: GovernanceUuidSchema,
    reason: GovernanceReasonSchema,
  },
  { $id: 'WithdrawProposalPayloadV1', additionalProperties: false },
);
export const WithdrawProposalV1Schema = governanceCommand(
  'WithdrawProposalV1',
  WithdrawProposalPayloadV1Schema,
  GovernanceInWorldModeSchema,
);

export const GovernanceEligibilitySnapshotReferenceV1Schema = Type.Object(
  {
    eligibleCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    policyChecksum: GovernanceHashSchema,
    snapshotChecksum: GovernanceHashSchema,
    snapshotId: GovernanceUuidSchema,
    sourceStateRevision: GovernanceVersionSchema,
  },
  { additionalProperties: false },
);
export const OpenProposalVotingPayloadV1Schema = Type.Object(
  {
    eligibilitySnapshot: GovernanceEligibilitySnapshotReferenceV1Schema,
    expectedProposalVersion: GovernancePositiveVersionSchema,
    occurrenceKey: GovernanceStableKeySchema,
    proposalId: GovernanceUuidSchema,
  },
  { $id: 'OpenProposalVotingPayloadV1', additionalProperties: false },
);
export const OpenProposalVotingV1Schema = governanceCommand(
  'OpenProposalVotingV1',
  OpenProposalVotingPayloadV1Schema,
  GovernanceSystemModeSchema,
);
export const CastProposalBallotPayloadV1Schema = Type.Object(
  {
    choice: GovernanceProposalChoiceSchema,
    eligibilitySnapshotId: GovernanceUuidSchema,
    expectedProposalVersion: GovernancePositiveVersionSchema,
    proposalId: GovernanceUuidSchema,
    replaceExisting: Type.Boolean(),
  },
  { $id: 'CastProposalBallotPayloadV1', additionalProperties: false },
);
export const CastProposalBallotV1Schema = governanceCommand(
  'CastProposalBallotV1',
  CastProposalBallotPayloadV1Schema,
  GovernanceInWorldModeSchema,
);
export const CloseAndTallyProposalPayloadV1Schema = Type.Object(
  {
    algorithmVersion: Type.Literal(GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION),
    eligibilitySnapshotId: GovernanceUuidSchema,
    expectedProposalVersion: GovernancePositiveVersionSchema,
    occurrenceKey: GovernanceStableKeySchema,
    proposalId: GovernanceUuidSchema,
  },
  { $id: 'CloseAndTallyProposalPayloadV1', additionalProperties: false },
);
export const CloseAndTallyProposalV1Schema = governanceCommand(
  'CloseAndTallyProposalV1',
  CloseAndTallyProposalPayloadV1Schema,
  GovernanceSystemModeSchema,
);
export const CertifyAndEnactProposalPayloadV1Schema = Type.Object(
  {
    enactmentKey: GovernanceStableKeySchema,
    expectedProposalVersion: GovernancePositiveVersionSchema,
    expectedResultChecksum: GovernanceHashSchema,
    proposalId: GovernanceUuidSchema,
    resultId: GovernanceUuidSchema,
  },
  { $id: 'CertifyAndEnactProposalPayloadV1', additionalProperties: false },
);
export const CertifyAndEnactProposalV1Schema = governanceCommand(
  'CertifyAndEnactProposalV1',
  CertifyAndEnactProposalPayloadV1Schema,
  GovernanceSystemModeSchema,
);

export const NominateCandidatePayloadV1Schema = Type.Object(
  {
    candidateEntityKey: GovernanceStableKeySchema,
    electionId: GovernanceUuidSchema,
    expectedElectionVersion: GovernancePositiveVersionSchema,
    officeId: GovernanceUuidSchema,
    statement: Type.Optional(GovernanceSummarySchema),
  },
  { $id: 'NominateCandidatePayloadV1', additionalProperties: false },
);
export const NominateCandidateV1Schema = governanceCommand(
  'NominateCandidateV1',
  NominateCandidatePayloadV1Schema,
  GovernanceInWorldModeSchema,
);
export const AcceptNominationPayloadV1Schema = Type.Object(
  {
    candidacyId: GovernanceUuidSchema,
    electionId: GovernanceUuidSchema,
    expectedCandidacyVersion: GovernancePositiveVersionSchema,
    expectedElectionVersion: GovernancePositiveVersionSchema,
  },
  { $id: 'AcceptNominationPayloadV1', additionalProperties: false },
);
export const AcceptNominationV1Schema = governanceCommand(
  'AcceptNominationV1',
  AcceptNominationPayloadV1Schema,
  GovernanceInWorldModeSchema,
);
export const OpenElectionPayloadV1Schema = Type.Object(
  {
    electionId: GovernanceUuidSchema,
    eligibilitySnapshot: GovernanceEligibilitySnapshotReferenceV1Schema,
    expectedElectionVersion: GovernancePositiveVersionSchema,
    occurrenceKey: GovernanceStableKeySchema,
  },
  { $id: 'OpenElectionPayloadV1', additionalProperties: false },
);
export const OpenElectionV1Schema = governanceCommand(
  'OpenElectionV1',
  OpenElectionPayloadV1Schema,
  GovernanceSystemModeSchema,
);
export const GovernanceElectionChoiceV1Schema = Type.Union(
  [
    Type.Object(
      { candidateKey: GovernanceStableKeySchema, choiceType: Type.Literal('candidate') },
      { additionalProperties: false },
    ),
    Type.Object({ choiceType: Type.Literal('abstain') }, { additionalProperties: false }),
  ],
  { $id: 'GovernanceElectionChoiceV1' },
);
export const CastElectionBallotPayloadV1Schema = Type.Object(
  {
    choice: GovernanceElectionChoiceV1Schema,
    electionId: GovernanceUuidSchema,
    eligibilitySnapshotId: GovernanceUuidSchema,
    expectedElectionVersion: GovernancePositiveVersionSchema,
    replaceExisting: Type.Boolean(),
  },
  { $id: 'CastElectionBallotPayloadV1', additionalProperties: false },
);
export const CastElectionBallotV1Schema = governanceCommand(
  'CastElectionBallotV1',
  CastElectionBallotPayloadV1Schema,
  GovernanceInWorldModeSchema,
);
export const CloseAndTallyElectionPayloadV1Schema = Type.Object(
  {
    algorithmVersion: Type.Literal(GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION),
    electionId: GovernanceUuidSchema,
    eligibilitySnapshotId: GovernanceUuidSchema,
    expectedElectionVersion: GovernancePositiveVersionSchema,
    occurrenceKey: GovernanceStableKeySchema,
  },
  { $id: 'CloseAndTallyElectionPayloadV1', additionalProperties: false },
);
export const CloseAndTallyElectionV1Schema = governanceCommand(
  'CloseAndTallyElectionV1',
  CloseAndTallyElectionPayloadV1Schema,
  GovernanceSystemModeSchema,
);
export const CertifyElectionPayloadV1Schema = Type.Object(
  {
    electionId: GovernanceUuidSchema,
    expectedElectionVersion: GovernancePositiveVersionSchema,
    expectedResultChecksum: GovernanceHashSchema,
    resultId: GovernanceUuidSchema,
    termTransitionKey: GovernanceStableKeySchema,
  },
  { $id: 'CertifyElectionPayloadV1', additionalProperties: false },
);
export const CertifyElectionV1Schema = governanceCommand(
  'CertifyElectionV1',
  CertifyElectionPayloadV1Schema,
  GovernanceSystemModeSchema,
);

export const AppointOfficeholderPayloadV1Schema = Type.Object(
  {
    expectedOfficeVersion: GovernancePositiveVersionSchema,
    holderEntityKey: GovernanceStableKeySchema,
    officeId: GovernanceUuidSchema,
    reason: GovernanceReasonSchema,
    seatIndex: Type.Integer({ maximum: 63, minimum: 0 }),
    termEndsAtTick: GovernanceTickSchema,
    termStartsAtTick: GovernanceTickSchema,
  },
  { additionalProperties: false },
);
export const AppointOfficeholderV1Schema = governanceCommand(
  'AppointOfficeholderV1',
  AppointOfficeholderPayloadV1Schema,
  GovernanceInWorldModeSchema,
);
export const RemoveOfficeholderPayloadV1Schema = Type.Object(
  {
    effectiveAtTick: GovernanceTickSchema,
    expectedTermVersion: GovernancePositiveVersionSchema,
    reason: GovernanceReasonSchema,
    termId: GovernanceUuidSchema,
  },
  { additionalProperties: false },
);
export const RemoveOfficeholderV1Schema = governanceCommand(
  'RemoveOfficeholderV1',
  RemoveOfficeholderPayloadV1Schema,
  GovernanceInWorldModeSchema,
);

const GovernanceOverrideCreateLawProposalActionV1Schema = Type.Object(
  {
    ...CreateLawProposalActionV1Schema.properties,
    policy: governancePolicyExpressionSchema(
      'urn:worldgraph:governance-policy:v1:override-create-law',
    ),
  },
  { additionalProperties: false },
);
const GovernanceOverrideAmendLawProposalActionV1Schema = Type.Object(
  {
    ...AmendLawProposalActionV1Schema.properties,
    policy: governancePolicyExpressionSchema(
      'urn:worldgraph:governance-policy:v1:override-amend-law',
    ),
  },
  { additionalProperties: false },
);
const GovernanceOverrideProposalActionV1Schema = Type.Union([
  GovernanceOverrideCreateLawProposalActionV1Schema,
  GovernanceOverrideAmendLawProposalActionV1Schema,
  RepealLawProposalActionV1Schema,
]);

export const GovernanceOverrideEffectV1Schema = Type.Union(
  [
    Type.Object(
      {
        effectType: Type.Literal('execute_proposal_action'),
        proposalAction: GovernanceOverrideProposalActionV1Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        effectType: Type.Literal('appoint_officeholder'),
        appointment: AppointOfficeholderPayloadV1Schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        effectType: Type.Literal('remove_officeholder'),
        removal: RemoveOfficeholderPayloadV1Schema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'GovernanceOverrideEffectV1' },
);
export const ExecuteCreatorOverridePayloadV1Schema = Type.Object(
  {
    approvalId: Type.Union([GovernanceUuidSchema, Type.Null()]),
    confirmation: Type.Literal('EXECUTE EXPLICIT GOVERNANCE OVERRIDE'),
    effect: GovernanceOverrideEffectV1Schema,
    impact: GovernanceSummarySchema,
    reason: GovernanceReasonSchema,
  },
  { $id: 'ExecuteCreatorOverridePayloadV1', additionalProperties: false },
);
export const ExecuteCreatorOverrideV1Schema = governanceCommand(
  'ExecuteCreatorOverrideV1',
  ExecuteCreatorOverridePayloadV1Schema,
  GovernanceOperatorModeSchema,
);
export const GovernanceRepairKindSchema = Type.Union([
  Type.Literal('proposal_recount'),
  Type.Literal('election_recount'),
  Type.Literal('certification_compensation'),
]);
export const RepairGovernanceResultPayloadV1Schema = Type.Object(
  {
    approvalId: Type.Union([GovernanceUuidSchema, Type.Null()]),
    confirmation: Type.Literal('APPEND LINKED GOVERNANCE REPAIR'),
    expectedCurrentResultChecksum: GovernanceHashSchema,
    reason: GovernanceReasonSchema,
    repairKind: GovernanceRepairKindSchema,
    replacementResultChecksum: GovernanceHashSchema,
    sourceResultId: GovernanceUuidSchema,
  },
  { $id: 'RepairGovernanceResultPayloadV1', additionalProperties: false },
);
export const RepairGovernanceResultV1Schema = governanceCommand(
  'RepairGovernanceResultV1',
  RepairGovernanceResultPayloadV1Schema,
  GovernanceOperatorModeSchema,
);

export const PublicGovernanceCommandRequestV1Schema = Type.Union(
  [
    InitializeWorldGovernanceV1Schema,
    AdoptGovernanceSeedPlanV1Schema,
    CreateProposalV1Schema,
    SponsorProposalV1Schema,
    WithdrawProposalV1Schema,
    CastProposalBallotV1Schema,
    NominateCandidateV1Schema,
    AcceptNominationV1Schema,
    CastElectionBallotV1Schema,
    AppointOfficeholderV1Schema,
    RemoveOfficeholderV1Schema,
    ExecuteCreatorOverrideV1Schema,
    RepairGovernanceResultV1Schema,
  ],
  { $id: 'PublicGovernanceCommandRequestV1' },
);
export const InternalGovernanceCommandRequestV1Schema = Type.Union(
  [
    OpenProposalVotingV1Schema,
    CloseAndTallyProposalV1Schema,
    CertifyAndEnactProposalV1Schema,
    OpenElectionV1Schema,
    CloseAndTallyElectionV1Schema,
    CertifyElectionV1Schema,
  ],
  { $id: 'InternalGovernanceCommandRequestV1' },
);
export const GovernanceCommandRequestV1Schema = Type.Union(
  [PublicGovernanceCommandRequestV1Schema, InternalGovernanceCommandRequestV1Schema],
  { $id: 'GovernanceCommandRequestV1' },
);

const ProposalPublicBallotEventCommonFields = {
  aggregateVersion: GovernancePositiveVersionSchema,
  ballotMode: Type.Literal('public'),
  eventType: Type.Literal('ProposalBallotRecordedPublicV1'),
  proposalId: GovernanceUuidSchema,
  turnoutCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
} as const;
export const ProposalBallotRecordedPublicEventV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...ProposalPublicBallotEventCommonFields,
        disclosure: Type.Literal('aggregate_only'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...ProposalPublicBallotEventCommonFields,
        abstainCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
        disclosure: Type.Literal('choice_totals'),
        noCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
        yesCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...ProposalPublicBallotEventCommonFields,
        choice: GovernanceProposalChoiceSchema,
        disclosure: Type.Literal('voter_and_choice'),
        receiptHash: GovernanceHashSchema,
        voterEntityKey: GovernanceStableKeySchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'ProposalBallotRecordedPublicEventV1' },
);
export const ProposalBallotRecordedSecretEventV1Schema = Type.Object(
  {
    aggregateVersion: GovernancePositiveVersionSchema,
    ballotMode: Type.Literal('secret'),
    disclosure: Type.Literal('aggregate_only'),
    eventType: Type.Literal('ProposalBallotRecordedSecretV1'),
    proposalId: GovernanceUuidSchema,
    receiptHash: GovernanceHashSchema,
  },
  { $id: 'ProposalBallotRecordedSecretEventV1', additionalProperties: false },
);
const ElectionPublicBallotEventCommonFields = {
  aggregateVersion: GovernancePositiveVersionSchema,
  ballotMode: Type.Literal('public'),
  electionId: GovernanceUuidSchema,
  eventType: Type.Literal('ElectionBallotRecordedPublicV1'),
  turnoutCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
} as const;
export const ElectionBallotRecordedPublicEventV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...ElectionPublicBallotEventCommonFields,
        disclosure: Type.Literal('aggregate_only'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...ElectionPublicBallotEventCommonFields,
        abstainCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
        candidateTotals: Type.Array(
          Type.Object(
            {
              candidateKey: GovernanceStableKeySchema,
              voteCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 128 },
        ),
        disclosure: Type.Literal('choice_totals'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...ElectionPublicBallotEventCommonFields,
        choice: GovernanceElectionChoiceV1Schema,
        disclosure: Type.Literal('voter_and_choice'),
        receiptHash: GovernanceHashSchema,
        voterEntityKey: GovernanceStableKeySchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'ElectionBallotRecordedPublicEventV1' },
);
export const ElectionBallotRecordedSecretEventV1Schema = Type.Object(
  {
    aggregateVersion: GovernancePositiveVersionSchema,
    ballotMode: Type.Literal('secret'),
    disclosure: Type.Literal('aggregate_only'),
    electionId: GovernanceUuidSchema,
    eventType: Type.Literal('ElectionBallotRecordedSecretV1'),
    receiptHash: GovernanceHashSchema,
  },
  { $id: 'ElectionBallotRecordedSecretEventV1', additionalProperties: false },
);
export const GovernanceLifecycleEventV1Schema = Type.Object(
  {
    aggregateId: GovernanceUuidSchema,
    aggregateType: Type.Union([Type.Literal('proposal'), Type.Literal('election')]),
    aggregateVersion: GovernancePositiveVersionSchema,
    eventType: Type.Literal('GovernanceLifecycleChangedV1'),
    occurredTick: GovernanceTickSchema,
    status: Type.Union([GovernanceProposalStatusSchema, GovernanceElectionStatusSchema]),
  },
  { $id: 'GovernanceLifecycleEventV1', additionalProperties: false },
);
export const WorldGovernanceInitializedEventV1Schema = Type.Object(
  {
    eventType: Type.Literal('WorldGovernanceInitializedV1'),
    seedPlanHash: GovernanceHashSchema,
    sourceWorldVersionId: GovernanceUuidSchema,
  },
  { $id: 'WorldGovernanceInitializedEventV1', additionalProperties: false },
);
export const GovernanceSeedPlanAdoptedEventV1Schema = Type.Object(
  {
    adoptionReasonHash: GovernanceHashSchema,
    eventType: Type.Literal('GovernanceSeedPlanAdoptedV1'),
    seedPlanHash: GovernanceHashSchema,
  },
  { $id: 'GovernanceSeedPlanAdoptedEventV1', additionalProperties: false },
);
export const GovernanceCandidacyChangedEventV1Schema = Type.Object(
  {
    candidacyId: GovernanceUuidSchema,
    electionId: GovernanceUuidSchema,
    eventType: Type.Literal('GovernanceCandidacyChangedV1'),
    status: Type.Union([Type.Literal('nominated'), Type.Literal('accepted')]),
  },
  { $id: 'GovernanceCandidacyChangedEventV1', additionalProperties: false },
);
export const GovernanceResultFinalizedEventV1Schema = Type.Object(
  {
    aggregateId: GovernanceUuidSchema,
    aggregateType: Type.Union([Type.Literal('proposal'), Type.Literal('election')]),
    eventType: Type.Literal('GovernanceResultFinalizedV1'),
    inputChecksum: GovernanceHashSchema,
    resultChecksum: GovernanceHashSchema,
    resultId: GovernanceUuidSchema,
  },
  { $id: 'GovernanceResultFinalizedEventV1', additionalProperties: false },
);
export const GovernanceLawVersionActivatedEventV1Schema = Type.Object(
  {
    effectiveFromTick: GovernanceTickSchema,
    eventType: Type.Literal('GovernanceLawVersionActivatedV1'),
    lawId: GovernanceUuidSchema,
    lawVersion: GovernancePositiveVersionSchema,
    sourceProposalId: Type.Union([GovernanceUuidSchema, Type.Null()]),
  },
  { $id: 'GovernanceLawVersionActivatedEventV1', additionalProperties: false },
);
export const GovernanceOfficeTermChangedEventV1Schema = Type.Object(
  {
    eventType: Type.Literal('GovernanceOfficeTermChangedV1'),
    officeId: GovernanceUuidSchema,
    seatIndex: Type.Integer({ maximum: 63, minimum: 0 }),
    status: GovernanceTermStatusSchema,
    termId: GovernanceUuidSchema,
  },
  { $id: 'GovernanceOfficeTermChangedEventV1', additionalProperties: false },
);
export const GovernanceOverrideExecutedEventV1Schema = Type.Object(
  {
    actorMode: GovernanceOperatorModeSchema,
    eventType: Type.Literal('GovernanceOverrideExecutedV1'),
    impactHash: GovernanceHashSchema,
    overrideId: GovernanceUuidSchema,
    reasonCode: GovernanceCodeSchema,
  },
  { $id: 'GovernanceOverrideExecutedEventV1', additionalProperties: false },
);
export const GovernanceRepairAppendedEventV1Schema = Type.Object(
  {
    eventType: Type.Literal('GovernanceRepairAppendedV1'),
    repairId: GovernanceUuidSchema,
    repairKind: GovernanceRepairKindSchema,
    replacementResultChecksum: GovernanceHashSchema,
    sourceResultId: GovernanceUuidSchema,
  },
  { $id: 'GovernanceRepairAppendedEventV1', additionalProperties: false },
);
export const SafeGovernanceEventPayloadV1Schema = Type.Union(
  [
    ProposalBallotRecordedPublicEventV1Schema,
    ProposalBallotRecordedSecretEventV1Schema,
    ElectionBallotRecordedPublicEventV1Schema,
    ElectionBallotRecordedSecretEventV1Schema,
    WorldGovernanceInitializedEventV1Schema,
    GovernanceSeedPlanAdoptedEventV1Schema,
    GovernanceCandidacyChangedEventV1Schema,
    GovernanceLifecycleEventV1Schema,
    GovernanceResultFinalizedEventV1Schema,
    GovernanceLawVersionActivatedEventV1Schema,
    GovernanceOfficeTermChangedEventV1Schema,
    GovernanceOverrideExecutedEventV1Schema,
    GovernanceRepairAppendedEventV1Schema,
  ],
  { $id: 'SafeGovernanceEventPayloadV1' },
);

const ReadCommonFields = {
  aggregateVersion: GovernancePositiveVersionSchema,
  worldId: GovernanceUuidSchema,
} as const;
export const GovernanceCharterViewV1Schema = Type.Object(
  {
    ...ReadCommonFields,
    checksum: GovernanceHashSchema,
    charterId: GovernanceUuidSchema,
    citizenEligibilityPolicy: GovernanceSeedCharterPolicyV1Schema,
    evaluatedAtTick: GovernanceTickSchema,
    effectiveFromTick: GovernanceTickSchema,
    effectiveUntilTick: Type.Union([GovernanceTickSchema, Type.Null()]),
    projectionRevision: GovernanceVersionSchema,
    proposalRules: GovernanceSeedProposalRulesV1Schema,
    stableKey: GovernanceStableKeySchema,
    summary: GovernanceSummarySchema,
    title: GovernanceTitleSchema,
    version: GovernancePositiveVersionSchema,
  },
  { $id: 'GovernanceCharterViewV1', additionalProperties: false },
);
export const GovernanceInstitutionViewV1Schema = Type.Object(
  {
    ...ReadCommonFields,
    displayName: GovernanceTitleSchema,
    institutionId: GovernanceUuidSchema,
    institutionType: GovernanceCodeSchema,
    jurisdictionEntityKey: GovernanceStableKeySchema,
    stableKey: GovernanceStableKeySchema,
    status: GovernanceInstitutionStatusSchema,
  },
  { $id: 'GovernanceInstitutionViewV1', additionalProperties: false },
);
export const GovernanceLawViewV1Schema = Type.Object(
  {
    ...ReadCommonFields,
    effectiveFromTick: GovernanceTickSchema,
    effectiveUntilTick: Type.Union([GovernanceTickSchema, Type.Null()]),
    lawId: GovernanceUuidSchema,
    lawVersion: GovernancePositiveVersionSchema,
    stableKey: GovernanceStableKeySchema,
    status: GovernanceLawStatusSchema,
    summary: GovernanceSummarySchema,
    title: GovernanceTitleSchema,
  },
  { $id: 'GovernanceLawViewV1', additionalProperties: false },
);
export const GovernanceOfficeViewV1Schema = Type.Object(
  {
    ...ReadCommonFields,
    displayName: GovernanceTitleSchema,
    institutionId: GovernanceUuidSchema,
    officeId: GovernanceUuidSchema,
    seats: Type.Integer({ maximum: 64, minimum: 1 }),
    stableKey: GovernanceStableKeySchema,
    termDurationTicks: GovernancePositiveTickSchema,
    tieRule: GovernanceElectionTieRuleSchema,
  },
  { $id: 'GovernanceOfficeViewV1', additionalProperties: false },
);
export const GovernanceOfficeTermViewV1Schema = Type.Object(
  {
    ...ReadCommonFields,
    endsAtTick: GovernanceTickSchema,
    holderEntityKey: GovernanceStableKeySchema,
    officeId: GovernanceUuidSchema,
    seatIndex: Type.Integer({ maximum: 63, minimum: 0 }),
    sourceId: GovernanceUuidSchema,
    sourceType: Type.Union([
      Type.Literal('election'),
      Type.Literal('appointment'),
      Type.Literal('initial'),
    ]),
    startsAtTick: GovernanceTickSchema,
    status: GovernanceTermStatusSchema,
    termId: GovernanceUuidSchema,
  },
  { $id: 'GovernanceOfficeTermViewV1', additionalProperties: false },
);
export const GovernanceProposalViewV1Schema = Type.Object(
  {
    ...ReadCommonFields,
    action: GovernanceProposalActionV1Schema,
    approvalThresholdBps: GovernanceThresholdBasisPointsSchema,
    ballotPolicy: GovernanceBallotPolicyV1Schema,
    body: GovernanceBodySchema,
    debateEndsAtTick: GovernanceTickSchema,
    eligibleCount: Type.Union([Type.Integer({ maximum: 1_000_000_000, minimum: 0 }), Type.Null()]),
    eligibilitySnapshotId: Type.Union([GovernanceUuidSchema, Type.Null()]),
    institutionId: GovernanceUuidSchema,
    proposalId: GovernanceUuidSchema,
    quorumBps: GovernanceBasisPointsSchema,
    sponsorshipEndsAtTick: GovernanceTickSchema,
    status: GovernanceProposalStatusSchema,
    title: GovernanceTitleSchema,
    turnoutCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    votingClosesAtTick: GovernanceTickSchema,
    votingOpensAtTick: GovernanceTickSchema,
  },
  { $id: 'GovernanceProposalViewV1', additionalProperties: false },
);
export const GovernanceProposalReceiptViewV1Schema = Type.Union(
  [
    Type.Object(
      {
        ballotMode: Type.Literal('public'),
        castAtTick: GovernanceTickSchema,
        choice: GovernanceProposalChoiceSchema,
        proposalId: GovernanceUuidSchema,
        receiptHash: GovernanceHashSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ballotMode: Type.Literal('secret'),
        castAtTick: GovernanceTickSchema,
        proposalId: GovernanceUuidSchema,
        receiptHash: GovernanceHashSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'GovernanceProposalReceiptViewV1' },
);
export const GovernanceProposalResultViewV1Schema = Type.Object(
  {
    abstainCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    certified: Type.Boolean(),
    eligibleCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    inputChecksum: GovernanceHashSchema,
    noCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    outcome: Type.Union([
      Type.Literal('passed'),
      Type.Literal('rejected_quorum'),
      Type.Literal('rejected_threshold'),
    ]),
    proposalId: GovernanceUuidSchema,
    resultChecksum: GovernanceHashSchema,
    resultId: GovernanceUuidSchema,
    turnoutCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    yesCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
  },
  { $id: 'GovernanceProposalResultViewV1', additionalProperties: false },
);
export const GovernanceCandidacyViewV1Schema = Type.Object(
  {
    aggregateVersion: GovernancePositiveVersionSchema,
    candidacyId: GovernanceUuidSchema,
    candidateEntityKey: GovernanceStableKeySchema,
    electionId: GovernanceUuidSchema,
    status: Type.Union([
      Type.Literal('nominated'),
      Type.Literal('accepted'),
      Type.Literal('withdrawn'),
      Type.Literal('ineligible'),
    ]),
  },
  { $id: 'GovernanceCandidacyViewV1', additionalProperties: false },
);
export const GovernanceElectionViewV1Schema = Type.Object(
  {
    ...ReadCommonFields,
    ballotPolicy: GovernanceBallotPolicyV1Schema,
    certificationAtTick: GovernanceTickSchema,
    electionId: GovernanceUuidSchema,
    eligibleCount: Type.Union([Type.Integer({ maximum: 1_000_000_000, minimum: 0 }), Type.Null()]),
    eligibilitySnapshotId: Type.Union([GovernanceUuidSchema, Type.Null()]),
    nominationClosesAtTick: GovernanceTickSchema,
    nominationOpensAtTick: GovernanceTickSchema,
    officeId: GovernanceUuidSchema,
    quorumBps: GovernanceBasisPointsSchema,
    status: GovernanceElectionStatusSchema,
    termStartsAtTick: GovernanceTickSchema,
    tieRule: GovernanceElectionTieRuleSchema,
    title: GovernanceTitleSchema,
    turnoutCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    votingClosesAtTick: GovernanceTickSchema,
    votingOpensAtTick: GovernanceTickSchema,
  },
  { $id: 'GovernanceElectionViewV1', additionalProperties: false },
);
export const GovernanceElectionReceiptViewV1Schema = Type.Union(
  [
    Type.Object(
      {
        ballotMode: Type.Literal('public'),
        castAtTick: GovernanceTickSchema,
        choice: GovernanceElectionChoiceV1Schema,
        electionId: GovernanceUuidSchema,
        receiptHash: GovernanceHashSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ballotMode: Type.Literal('secret'),
        castAtTick: GovernanceTickSchema,
        electionId: GovernanceUuidSchema,
        receiptHash: GovernanceHashSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'GovernanceElectionReceiptViewV1' },
);
export const GovernanceElectionCandidateTotalV1Schema = Type.Object(
  {
    candidateKey: GovernanceStableKeySchema,
    voteCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
  },
  { additionalProperties: false },
);
export const GovernanceElectionResultViewV1Schema = Type.Object(
  {
    abstainCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    candidateTotals: Type.Array(GovernanceElectionCandidateTotalV1Schema, { maxItems: 128 }),
    certified: Type.Boolean(),
    electionId: GovernanceUuidSchema,
    eligibleCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    inputChecksum: GovernanceHashSchema,
    outcome: Type.Union([
      Type.Literal('elected'),
      Type.Literal('vacant_no_quorum'),
      Type.Literal('vacant_no_votes'),
      Type.Literal('vacant_tie'),
    ]),
    resultChecksum: GovernanceHashSchema,
    resultId: GovernanceUuidSchema,
    tiedCandidateKeys: Type.Array(GovernanceStableKeySchema, {
      maxItems: 128,
      uniqueItems: true,
    }),
    turnoutCount: Type.Integer({ maximum: 1_000_000_000, minimum: 0 }),
    winnerCandidateKey: Type.Union([GovernanceStableKeySchema, Type.Null()]),
  },
  { $id: 'GovernanceElectionResultViewV1', additionalProperties: false },
);
export const GovernanceAuditViewV1Schema = Type.Object(
  {
    actorMode: GovernanceActorModeSchema,
    aggregateId: GovernanceUuidSchema,
    aggregateType: GovernanceCodeSchema,
    auditId: GovernanceUuidSchema,
    eventType: GovernanceCodeSchema,
    occurredAtTick: GovernanceTickSchema,
    reason: Type.Union([GovernanceReasonSchema, GovernanceAuditReasonCodeSchema, Type.Null()]),
  },
  { $id: 'GovernanceAuditViewV1', additionalProperties: false },
);
export const GovernanceUiCapabilityCodeV1Schema = Type.Union([
  Type.Literal('proposal.create'),
  Type.Literal('proposal.sponsor'),
  Type.Literal('proposal.withdraw'),
  Type.Literal('proposal.ballot.cast'),
  Type.Literal('candidate.nominate'),
  Type.Literal('candidate.accept'),
  Type.Literal('election.ballot.cast'),
  Type.Literal('office.appoint'),
  Type.Literal('office.remove'),
  Type.Literal('operator.override'),
  Type.Literal('operator.repair'),
]);
export const GovernanceUiCapabilityTargetTypeV1Schema = Type.Union([
  Type.Literal('world'),
  Type.Literal('institution'),
  Type.Literal('proposal'),
  Type.Literal('election'),
  Type.Literal('candidacy'),
  Type.Literal('office'),
  Type.Literal('office_term'),
]);
export const GovernanceUiCapabilityDecisionV1Schema = Type.Object(
  {
    allowed: Type.Boolean(),
    capability: GovernanceUiCapabilityCodeV1Schema,
    reasonCode: Type.String({ maxLength: 120, minLength: 1 }),
    resourceId: GovernanceUuidSchema,
    resourceType: GovernanceUiCapabilityTargetTypeV1Schema,
    ruleId: Type.String({ maxLength: 120, minLength: 1 }),
  },
  { additionalProperties: false },
);
export const GovernanceUiActorAuthorityStateV1Schema = Type.Union([
  Type.Literal('observer'),
  Type.Literal('player'),
  Type.Literal('officeholder'),
  Type.Literal('world_administrator'),
  Type.Literal('creator'),
  Type.Literal('platform_administrator'),
]);
export const GovernanceUiBallotEligibilityV1Schema = Type.Object(
  {
    ballotState: Type.Union([
      Type.Literal('not_cast'),
      Type.Literal('cast_replaceable'),
      Type.Literal('cast_final'),
    ]),
    eligible: Type.Boolean(),
    snapshotId: GovernanceUuidSchema,
    targetId: GovernanceUuidSchema,
    targetType: Type.Union([Type.Literal('proposal'), Type.Literal('election')]),
  },
  { additionalProperties: false },
);
export const GovernanceUiProposalTargetsV1Schema = Type.Object(
  {
    projectEntities: Type.Array(
      Type.Object(
        {
          displayName: Type.String({ maxLength: 160, minLength: 1 }),
          projectEntityId: GovernanceUuidSchema,
          projectKey: GovernanceStableKeySchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    taxPolicies: Type.Array(
      Type.Object(
        {
          currentRateBps: GovernanceBasisPointsSchema,
          currencyCode: Type.String({ maxLength: 12, minLength: 3 }),
          currencyId: GovernanceUuidSchema,
          currencyKey: GovernanceStableKeySchema,
          expectedPolicyVersion: GovernancePositiveVersionSchema,
          policyId: GovernanceUuidSchema,
          policyKey: GovernanceStableKeySchema,
          taxType: GovernanceCodeSchema,
          treasuryWalletId: GovernanceUuidSchema,
          treasuryWalletKey: GovernanceStableKeySchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    treasuries: Type.Array(
      Type.Object(
        {
          spendableMinor: GovernanceUnsignedMinorSchema,
          currencyCode: Type.String({ maxLength: 12, minLength: 3 }),
          currencyId: GovernanceUuidSchema,
          currencyKey: GovernanceStableKeySchema,
          currencyVersion: GovernancePositiveVersionSchema,
          treasuryWalletId: GovernanceUuidSchema,
          treasuryWalletKey: GovernanceStableKeySchema,
          treasuryWalletVersion: GovernancePositiveVersionSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);
export const GovernanceUiCapabilitiesViewV1Schema = Type.Object(
  {
    actor: Type.Object(
      {
        actorEntityId: Type.Union([GovernanceUuidSchema, Type.Null()]),
        actorEntityKey: Type.Union([GovernanceStableKeySchema, Type.Null()]),
        authorityState: GovernanceUiActorAuthorityStateV1Schema,
        membershipRole: WorldRoleSchema,
        platformRole: Type.Union([Type.Literal('platform_admin'), Type.Literal('user')]),
      },
      { additionalProperties: false },
    ),
    ballotEligibility: Type.Array(GovernanceUiBallotEligibilityV1Schema, { maxItems: 200 }),
    contractVersion: Type.Literal(1),
    decisions: Type.Array(GovernanceUiCapabilityDecisionV1Schema, { maxItems: 2_048 }),
    evaluatedAtTick: GovernanceTickSchema,
    proposalTargets: GovernanceUiProposalTargetsV1Schema,
    projectionRevision: GovernanceVersionSchema,
    worldId: GovernanceUuidSchema,
  },
  { $id: 'GovernanceUiCapabilitiesViewV1', additionalProperties: false },
);
export const GovernancePageMetadataV1Schema = Type.Object(
  {
    evaluatedAtTick: GovernanceTickSchema,
    nextCursor: Type.Union([Type.String({ maxLength: 512, minLength: 1 }), Type.Null()]),
    projectionRevision: GovernanceVersionSchema,
  },
  { $id: 'GovernancePageMetadataV1', additionalProperties: false },
);

function governancePage<TItem extends TSchema>(id: string, item: TItem) {
  return Type.Object(
    {
      items: Type.Array(item, { maxItems: 100 }),
      page: GovernancePageMetadataV1Schema,
    },
    { $id: id, additionalProperties: false },
  );
}

export const GovernanceInstitutionPageV1Schema = governancePage(
  'GovernanceInstitutionPageV1',
  GovernanceInstitutionViewV1Schema,
);
export const GovernanceLawPageV1Schema = governancePage(
  'GovernanceLawPageV1',
  GovernanceLawViewV1Schema,
);
export const GovernanceOfficePageV1Schema = governancePage(
  'GovernanceOfficePageV1',
  GovernanceOfficeViewV1Schema,
);
export const GovernanceOfficeTermPageV1Schema = governancePage(
  'GovernanceOfficeTermPageV1',
  GovernanceOfficeTermViewV1Schema,
);
export const GovernanceProposalPageV1Schema = governancePage(
  'GovernanceProposalPageV1',
  GovernanceProposalViewV1Schema,
);
export const GovernanceElectionPageV1Schema = governancePage(
  'GovernanceElectionPageV1',
  GovernanceElectionViewV1Schema,
);
export const GovernanceCandidacyPageV1Schema = governancePage(
  'GovernanceCandidacyPageV1',
  GovernanceCandidacyViewV1Schema,
);
export const GovernanceAuditPageV1Schema = governancePage(
  'GovernanceAuditPageV1',
  GovernanceAuditViewV1Schema,
);

export type GovernanceActorMode = Static<typeof GovernanceActorModeSchema>;
export type GovernanceBallotMode = Static<typeof GovernanceBallotModeSchema>;
export type GovernanceBallotPolicyV1 = Static<typeof GovernanceBallotPolicyV1Schema>;
export type GovernanceProposalStatus = Static<typeof GovernanceProposalStatusSchema>;
export type GovernanceElectionStatus = Static<typeof GovernanceElectionStatusSchema>;
export type GovernanceTermStatus = Static<typeof GovernanceTermStatusSchema>;
export type GovernanceLawStatus = Static<typeof GovernanceLawStatusSchema>;
export type GovernancePolicyEvaluationContextV1 = Static<
  typeof GovernancePolicyEvaluationContextV1Schema
>;
export type GovernancePolicyDecisionReason = Static<typeof GovernancePolicyDecisionReasonSchema>;
export type GovernancePolicyDecisionV1 = Static<typeof GovernancePolicyDecisionV1Schema>;
export type GovernanceProposalActionV1 = Static<typeof GovernanceProposalActionV1Schema>;
export type GovernanceSeedPlanV1 = Static<typeof GovernanceSeedPlanV1Schema>;
export type GovernanceProposalChoice = Static<typeof GovernanceProposalChoiceSchema>;
export type GovernanceElectionChoiceV1 = Static<typeof GovernanceElectionChoiceV1Schema>;
export type GovernanceElectionTieRule = Static<typeof GovernanceElectionTieRuleSchema>;
export type InitializeWorldGovernancePayloadV1 = Static<
  typeof InitializeWorldGovernancePayloadV1Schema
>;
export type AdoptGovernanceSeedPlanPayloadV1 = Static<
  typeof AdoptGovernanceSeedPlanPayloadV1Schema
>;
export type CreateProposalPayloadV1 = Static<typeof CreateProposalPayloadV1Schema>;
export type SponsorProposalPayloadV1 = Static<typeof SponsorProposalPayloadV1Schema>;
export type WithdrawProposalPayloadV1 = Static<typeof WithdrawProposalPayloadV1Schema>;
export type GovernanceEligibilitySnapshotReferenceV1 = Static<
  typeof GovernanceEligibilitySnapshotReferenceV1Schema
>;
export type OpenProposalVotingPayloadV1 = Static<typeof OpenProposalVotingPayloadV1Schema>;
export type CastProposalBallotPayloadV1 = Static<typeof CastProposalBallotPayloadV1Schema>;
export type CloseAndTallyProposalPayloadV1 = Static<typeof CloseAndTallyProposalPayloadV1Schema>;
export type CertifyAndEnactProposalPayloadV1 = Static<
  typeof CertifyAndEnactProposalPayloadV1Schema
>;
export type NominateCandidatePayloadV1 = Static<typeof NominateCandidatePayloadV1Schema>;
export type AcceptNominationPayloadV1 = Static<typeof AcceptNominationPayloadV1Schema>;
export type OpenElectionPayloadV1 = Static<typeof OpenElectionPayloadV1Schema>;
export type CastElectionBallotPayloadV1 = Static<typeof CastElectionBallotPayloadV1Schema>;
export type CloseAndTallyElectionPayloadV1 = Static<typeof CloseAndTallyElectionPayloadV1Schema>;
export type CertifyElectionPayloadV1 = Static<typeof CertifyElectionPayloadV1Schema>;
export type AppointOfficeholderPayloadV1 = Static<typeof AppointOfficeholderPayloadV1Schema>;
export type RemoveOfficeholderPayloadV1 = Static<typeof RemoveOfficeholderPayloadV1Schema>;
export type GovernanceOverrideEffectV1 = Static<typeof GovernanceOverrideEffectV1Schema>;
export type ExecuteCreatorOverridePayloadV1 = Static<typeof ExecuteCreatorOverridePayloadV1Schema>;
export type RepairGovernanceResultPayloadV1 = Static<typeof RepairGovernanceResultPayloadV1Schema>;
export type GovernanceCommandRequestV1 = Static<typeof GovernanceCommandRequestV1Schema>;
export type PublicGovernanceCommandRequestV1 = Static<
  typeof PublicGovernanceCommandRequestV1Schema
>;
export type InternalGovernanceCommandRequestV1 = Static<
  typeof InternalGovernanceCommandRequestV1Schema
>;
export type WorldGovernanceInitializedEventV1 = Static<
  typeof WorldGovernanceInitializedEventV1Schema
>;
export type GovernanceSeedPlanAdoptedEventV1 = Static<
  typeof GovernanceSeedPlanAdoptedEventV1Schema
>;
export type GovernanceCandidacyChangedEventV1 = Static<
  typeof GovernanceCandidacyChangedEventV1Schema
>;
export type SafeGovernanceEventPayloadV1 = Static<typeof SafeGovernanceEventPayloadV1Schema>;
export type GovernanceProposalViewV1 = Static<typeof GovernanceProposalViewV1Schema>;
export type GovernanceElectionViewV1 = Static<typeof GovernanceElectionViewV1Schema>;
export type GovernanceProposalResultViewV1 = Static<typeof GovernanceProposalResultViewV1Schema>;
export type GovernanceElectionResultViewV1 = Static<typeof GovernanceElectionResultViewV1Schema>;
export type GovernanceOfficeTermViewV1 = Static<typeof GovernanceOfficeTermViewV1Schema>;
export type GovernanceCharterViewV1 = Static<typeof GovernanceCharterViewV1Schema>;
export type GovernanceInstitutionViewV1 = Static<typeof GovernanceInstitutionViewV1Schema>;
export type GovernanceLawViewV1 = Static<typeof GovernanceLawViewV1Schema>;
export type GovernanceOfficeViewV1 = Static<typeof GovernanceOfficeViewV1Schema>;
export type GovernanceProposalReceiptViewV1 = Static<typeof GovernanceProposalReceiptViewV1Schema>;
export type GovernanceElectionReceiptViewV1 = Static<typeof GovernanceElectionReceiptViewV1Schema>;
export type GovernanceCandidacyViewV1 = Static<typeof GovernanceCandidacyViewV1Schema>;
export type GovernanceAuditViewV1 = Static<typeof GovernanceAuditViewV1Schema>;
export type GovernanceUiCapabilityCodeV1 = Static<typeof GovernanceUiCapabilityCodeV1Schema>;
export type GovernanceUiCapabilityDecisionV1 = Static<
  typeof GovernanceUiCapabilityDecisionV1Schema
>;
export type GovernanceUiActorAuthorityStateV1 = Static<
  typeof GovernanceUiActorAuthorityStateV1Schema
>;
export type GovernanceUiBallotEligibilityV1 = Static<typeof GovernanceUiBallotEligibilityV1Schema>;
export type GovernanceUiProposalTargetsV1 = Static<typeof GovernanceUiProposalTargetsV1Schema>;
export type GovernanceUiCapabilitiesViewV1 = Static<typeof GovernanceUiCapabilitiesViewV1Schema>;
export type GovernancePageMetadataV1 = Static<typeof GovernancePageMetadataV1Schema>;
export type GovernanceInstitutionPageV1 = Static<typeof GovernanceInstitutionPageV1Schema>;
export type GovernanceLawPageV1 = Static<typeof GovernanceLawPageV1Schema>;
export type GovernanceOfficePageV1 = Static<typeof GovernanceOfficePageV1Schema>;
export type GovernanceOfficeTermPageV1 = Static<typeof GovernanceOfficeTermPageV1Schema>;
export type GovernanceProposalPageV1 = Static<typeof GovernanceProposalPageV1Schema>;
export type GovernanceElectionPageV1 = Static<typeof GovernanceElectionPageV1Schema>;
export type GovernanceCandidacyPageV1 = Static<typeof GovernanceCandidacyPageV1Schema>;
export type GovernanceAuditPageV1 = Static<typeof GovernanceAuditPageV1Schema>;
