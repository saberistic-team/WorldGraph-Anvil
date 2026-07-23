import { Type, type Static } from '@sinclair/typebox';

import { MembershipStatusSchema, WorldRoleSchema } from './authority.js';
import { DisplayNameSchema, EmailSchema } from './identity.js';
import { MANIFEST_SCHEMA_VERSION } from './versions.js';

export const WorldLifecycleSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('manifest_approved'),
  Type.Literal('compiling'),
  Type.Literal('active'),
  Type.Literal('compile_failed'),
]);
export const WorldNameSchema = Type.String({
  maxLength: 100,
  minLength: 2,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$',
});
export const WorldSlugSchema = Type.String({
  maxLength: 63,
  minLength: 3,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
});

export const WorldSchema = Type.Object(
  {
    createdAt: Type.String({ format: 'date-time' }),
    activeWorldVersionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    currentApprovedManifestRevisionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    id: Type.String({ format: 'uuid' }),
    lifecycle: WorldLifecycleSchema,
    manifestSchemaVersion: Type.Union([Type.Literal(MANIFEST_SCHEMA_VERSION), Type.Null()]),
    name: WorldNameSchema,
    // A platform administrator may inspect a specifically addressed world without
    // acquiring world membership. `null` preserves that distinction instead of
    // fabricating an in-world role.
    role: Type.Union([WorldRoleSchema, Type.Null()]),
    rowVersion: Type.Integer({ minimum: 1 }),
    slug: WorldSlugSchema,
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export const MembershipSchema = Type.Object(
  {
    joinedAt: Type.String({ format: 'date-time' }),
    role: WorldRoleSchema,
    rowVersion: Type.Integer({ minimum: 1 }),
    status: MembershipStatusSchema,
    user: Type.Object(
      {
        displayName: Type.Union([DisplayNameSchema, Type.Null()]),
        id: Type.String({ format: 'uuid' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const InvitationSchema = Type.Object(
  {
    createdAt: Type.String({ format: 'date-time' }),
    email: EmailSchema,
    expiresAt: Type.String({ format: 'date-time' }),
    id: Type.String({ format: 'uuid' }),
    intendedRole: Type.Union([Type.Literal('player'), Type.Literal('observer')]),
    rowVersion: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('accepted'),
      Type.Literal('revoked'),
      Type.Literal('expired'),
    ]),
  },
  { additionalProperties: false },
);

export const CursorPageSchema = <T>(item: T) =>
  Type.Object(
    {
      items: Type.Array(item as never, { maxItems: 100 }),
      nextCursor: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
    },
    { additionalProperties: false },
  );

export const CreateWorldRequestSchema = Type.Object(
  { name: WorldNameSchema, slug: Type.Optional(WorldSlugSchema) },
  { additionalProperties: false },
);
export const RenameWorldRequestSchema = Type.Object(
  { expectedRowVersion: Type.Integer({ minimum: 1 }), name: WorldNameSchema },
  { additionalProperties: false },
);
export const CreateInvitationRequestSchema = Type.Object(
  {
    email: EmailSchema,
    expiresIn: Type.Integer({ maximum: 604800, minimum: 900 }),
    role: Type.Union([Type.Literal('player'), Type.Literal('observer')]),
  },
  { additionalProperties: false },
);
export const AcceptInvitationRequestSchema = Type.Object(
  { rawToken: Type.String({ maxLength: 128, minLength: 32 }) },
  { additionalProperties: false },
);
export const ChangeMembershipRoleRequestSchema = Type.Object(
  {
    expectedRowVersion: Type.Integer({ minimum: 1 }),
    role: Type.Union([
      Type.Literal('administrator'),
      Type.Literal('player'),
      Type.Literal('observer'),
    ]),
  },
  { additionalProperties: false },
);
export const RemoveMembershipRequestSchema = Type.Object(
  { expectedRowVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export const CreatorOverrideRequestSchema = Type.Object(
  {
    action: Type.Literal('membership.force_demote_administrator'),
    confirmation: Type.Literal('USE CREATOR OVERRIDE'),
    expectedRowVersion: Type.Integer({ minimum: 1 }),
    reason: Type.String({ maxLength: 500, minLength: 10 }),
    targetUserId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

export type AcceptInvitationRequest = Static<typeof AcceptInvitationRequestSchema>;
export type ChangeMembershipRoleRequest = Static<typeof ChangeMembershipRoleRequestSchema>;
export type CreateInvitationRequest = Static<typeof CreateInvitationRequestSchema>;
export type CreateWorldRequest = Static<typeof CreateWorldRequestSchema>;
export type CreatorOverrideRequest = Static<typeof CreatorOverrideRequestSchema>;
export type Invitation = Static<typeof InvitationSchema>;
export type Membership = Static<typeof MembershipSchema>;
export type RemoveMembershipRequest = Static<typeof RemoveMembershipRequestSchema>;
export type RenameWorldRequest = Static<typeof RenameWorldRequestSchema>;
export type World = Static<typeof WorldSchema>;
