import { Type, type Static } from '@sinclair/typebox';

export const EmailSchema = Type.String({ format: 'email', maxLength: 254, minLength: 3 });
export const PasswordSchema = Type.String({ maxLength: 128, minLength: 12 });
export const DisplayNameSchema = Type.String({
  maxLength: 80,
  minLength: 1,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$',
});

export const PlatformRoleSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('platform_admin'),
]);
export const UserStatusSchema = Type.Union([Type.Literal('active'), Type.Literal('disabled')]);

export const SafeUserSchema = Type.Object(
  {
    displayName: Type.Union([DisplayNameSchema, Type.Null()]),
    email: EmailSchema,
    id: Type.String({ format: 'uuid' }),
    platformRole: PlatformRoleSchema,
    rowVersion: Type.Integer({ minimum: 1 }),
    status: UserStatusSchema,
  },
  { additionalProperties: false },
);

export const SessionViewSchema = Type.Object(
  {
    absoluteExpiresAt: Type.String({ format: 'date-time' }),
    id: Type.String({ format: 'uuid' }),
    idleExpiresAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export const AuthenticatedSessionSchema = Type.Object(
  { session: SessionViewSchema, user: SafeUserSchema },
  { additionalProperties: false },
);

export const RegisterRequestSchema = Type.Object(
  {
    displayName: Type.Optional(DisplayNameSchema),
    email: EmailSchema,
    password: PasswordSchema,
  },
  { additionalProperties: false },
);

export const LoginRequestSchema = Type.Object(
  { email: EmailSchema, password: PasswordSchema },
  { additionalProperties: false },
);

export const CsrfResponseSchema = Type.Object(
  { csrfToken: Type.String({ maxLength: 128, minLength: 32 }) },
  { additionalProperties: false },
);

export type AuthenticatedSession = Static<typeof AuthenticatedSessionSchema>;
export type LoginRequest = Static<typeof LoginRequestSchema>;
export type PlatformRole = Static<typeof PlatformRoleSchema>;
export type RegisterRequest = Static<typeof RegisterRequestSchema>;
export type SafeUser = Static<typeof SafeUserSchema>;
export type SessionView = Static<typeof SessionViewSchema>;
export type UserStatus = Static<typeof UserStatusSchema>;
