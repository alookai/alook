import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";

// `ownerUserId` is a real, already-applied self-referencing FK — see
// `src/web/migrations/0050_community_bots.sql` (`ownerUserId TEXT REFERENCES
// user(id)`, no `ON DELETE` clause, so SQLite/D1 default to `NO ACTION`: the
// DB refuses to delete an owner while they still have bot rows pointing at
// them). `.references()` below is a type-level sync with that DDL, not a new
// constraint — do not generate a migration for it. Any future user-delete
// path should still call `assertNoLiveBots` (see `queries/community/bot.ts`)
// to fail early with a clear error before hitting the FK.
export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    name: text("name").notNull().default(""),
    email: text("email").unique().notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" }),
    image: text("image"),
    avatarVersion: integer("avatarVersion").notNull().default(0),
    avatarObjectKey: text("avatarObjectKey"),
    createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
    isBot: integer("isBot", { mode: "boolean" }).notNull().default(false),
    ownerUserId: text("ownerUserId").references((): AnySQLiteColumn => user.id, { onDelete: "no action" }),
    deletedAt: text("deletedAt"),
    discriminator: text("discriminator").notNull().default("0000"),
    // For bots: ISO timestamp of the last "refresh context" (a `nap` or an
    // owner `session_reset` — both reset the agent's working context). Written
    // only at the nap/session_reset audit chokepoint, so it's a monotonic
    // historical fact that never drifts from the audit log. NULL = never
    // refreshed. Surfaced in the my-bots list as "last refreshed N ago".
    lastRefreshContextAt: text("lastRefreshContextAt"),
  },
  (t) => [
    index("idx_user_isBot_deletedAt_id_lookup").on(t.isBot, t.deletedAt, t.id),
    index("idx_user_pending_deletion").on(t.isBot, t.updatedAt, t.id).where(sql`${t.deletedAt} IS NOT NULL`),
    index("idx_user_ownerUserId_isBot").on(t.ownerUserId, t.isBot)]
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey().$defaultFn(() => nanoid()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    expiresAt: text("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_session_token_expires").on(t.token, t.expiresAt)]
);

export const account = sqliteTable("account", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt"),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  scope: text("scope"),
  idToken: text("idToken"),
  password: text("password"),
  createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => [
    index("idx_account_providerId_accountId_lookup").on(t.providerId, t.accountId),
  ]);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey().$defaultFn(() => nanoid()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updatedAt").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => [
    index("idx_verification_identifier_lookup").on(t.identifier),
    index("idx_verification_value_lookup").on(t.value),
    index("idx_verification_expiresAt_lookup").on(t.expiresAt),
  ]);

export type { NativeOauthProvider, NativeOauthPlatform, NativeOauthFailureCode } from "../lib/native-oauth-contract";
import type { NativeOauthProvider, NativeOauthPlatform, NativeOauthFailureCode } from "../lib/native-oauth-contract";

export const NATIVE_OAUTH_STATUSES = [
  "pending",
  "opened",
  "ready",
  "exchanging",
  "consumed",
  "failed",
  "cancelled",
  "replaced",
] as const;
export type NativeOauthStatus = (typeof NATIVE_OAUTH_STATUSES)[number];

export const nativeOauthAttempt = sqliteTable(
  "native_oauth_attempt",
  {
    id: text("id").primaryKey(),
    instanceKeyHash: text("instance_key_hash").notNull(),
    stateHash: text("state_hash").notNull(),
    pkceChallenge: text("pkce_challenge").notNull(),
    provider: text("provider").$type<NativeOauthProvider>().notNull(),
    platform: text("platform").$type<NativeOauthPlatform>().notNull(),
    redirectPath: text("redirect_path").notNull(),
    status: text("status").$type<NativeOauthStatus>().notNull().default("pending"),
    handoffCodeHash: text("handoff_code_hash"),
    handoffExpiresAt: integer("handoff_expires_at"),
    authKind: text("auth_kind").$type<"signin" | "signup">(),
    failureCode: text("failure_code").$type<NativeOauthFailureCode>(),
    attemptExpiresAt: integer("attempt_expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    openedAt: integer("opened_at"),
    readyAt: integer("ready_at"),
    consumedAt: integer("consumed_at"),
    failedAt: integer("failed_at"),
    cancelledAt: integer("cancelled_at"),
    replacedAt: integer("replaced_at"),
  },
  (t) => [
    index("idx_native_oauth_attempt_attempt_expires_at_lookup").on(t.attemptExpiresAt),
    index("idx_native_oauth_attempt_instance_status").on(
      t.instanceKeyHash,
      t.status,
    ),
    index("idx_native_oauth_attempt_id_status_expiry").on(
      t.id,
      t.status,
      t.attemptExpiresAt,
    ),
    index("idx_native_oauth_attempt_terminal_cleanup").on(
      t.status,
      t.updatedAt,
    ),
    uniqueIndex("uq_native_oauth_attempt_instance_live")
      .on(t.instanceKeyHash)
      .where(sql`status IN ('pending', 'opened', 'ready', 'exchanging')`),
    uniqueIndex("uq_native_oauth_attempt_handoff_hash")
      .on(t.handoffCodeHash)
      .where(sql`handoff_code_hash IS NOT NULL`),
    check(
      "ck_native_oauth_attempt_id",
      sql`length(${t.id}) BETWEEN 22 AND 64 AND ${t.id} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      "ck_native_oauth_attempt_hashes",
      sql`length(${t.instanceKeyHash}) = 64 AND ${t.instanceKeyHash} NOT GLOB '*[^0-9a-f]*'
        AND length(${t.stateHash}) = 64 AND ${t.stateHash} NOT GLOB '*[^0-9a-f]*'
        AND length(${t.pkceChallenge}) = 43 AND ${t.pkceChallenge} NOT GLOB '*[^A-Za-z0-9_-]*'
        AND (${t.handoffCodeHash} IS NULL OR (length(${t.handoffCodeHash}) = 64 AND ${t.handoffCodeHash} NOT GLOB '*[^0-9a-f]*'))`,
    ),
    check(
      "ck_native_oauth_attempt_enums",
      sql`${t.provider} IN ('github', 'google', 'apple')
        AND ${t.platform} IN ('macos', 'windows', 'linux', 'ios', 'android')
        AND ${t.status} IN ('pending', 'opened', 'ready', 'exchanging', 'consumed', 'failed', 'cancelled', 'replaced')
        AND (${t.authKind} IS NULL OR ${t.authKind} IN ('signin', 'signup'))
        AND (${t.failureCode} IS NULL OR ${t.failureCode} IN ('access_denied', 'provider_error', 'oauth_callback_failed', 'start_failed', 'invalid_handoff'))`,
    ),
    check(
      "ck_native_oauth_attempt_redirect",
      sql`length(${t.redirectPath}) BETWEEN 1 AND 2048
        AND substr(${t.redirectPath}, 1, 1) = '/'
        AND substr(${t.redirectPath}, 1, 2) <> '//'
        AND instr(${t.redirectPath}, char(92)) = 0`,
    ),
    check(
      "ck_native_oauth_attempt_epochs",
      sql`typeof(${t.createdAt}) = 'integer' AND ${t.createdAt} BETWEEN 0 AND 9007199254740991
        AND typeof(${t.updatedAt}) = 'integer' AND ${t.updatedAt} BETWEEN ${t.createdAt} AND 9007199254740991
        AND typeof(${t.attemptExpiresAt}) = 'integer' AND ${t.attemptExpiresAt} = ${t.createdAt} + 600000
        AND (${t.handoffExpiresAt} IS NULL OR (typeof(${t.handoffExpiresAt}) = 'integer' AND ${t.handoffExpiresAt} <= ${t.attemptExpiresAt}))`,
    ),
    check(
      "ck_native_oauth_attempt_state",
      sql`(
          ${t.status} = 'pending'
          AND ${t.openedAt} IS NULL AND ${t.readyAt} IS NULL AND ${t.consumedAt} IS NULL
          AND ${t.failedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.replacedAt} IS NULL
          AND ${t.handoffCodeHash} IS NULL AND ${t.handoffExpiresAt} IS NULL
          AND ${t.authKind} IS NULL AND ${t.failureCode} IS NULL
        ) OR (
          ${t.status} = 'opened'
          AND ${t.openedAt} IS NOT NULL AND ${t.readyAt} IS NULL AND ${t.consumedAt} IS NULL
          AND ${t.failedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.replacedAt} IS NULL
          AND ${t.handoffCodeHash} IS NULL AND ${t.handoffExpiresAt} IS NULL
          AND ${t.authKind} IS NULL AND ${t.failureCode} IS NULL
        ) OR (
          ${t.status} IN ('ready', 'exchanging')
          AND ${t.openedAt} IS NOT NULL AND ${t.readyAt} IS NOT NULL AND ${t.consumedAt} IS NULL
          AND ${t.failedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.replacedAt} IS NULL
          AND ${t.handoffCodeHash} IS NOT NULL AND ${t.handoffExpiresAt} IS NOT NULL
          AND ${t.handoffExpiresAt} = ${t.readyAt} + 120000
          AND ${t.authKind} IS NOT NULL AND ${t.failureCode} IS NULL
        ) OR (
          ${t.status} = 'consumed'
          AND ${t.openedAt} IS NOT NULL AND ${t.readyAt} IS NOT NULL AND ${t.consumedAt} IS NOT NULL
          AND ${t.failedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.replacedAt} IS NULL
          AND ${t.handoffCodeHash} IS NOT NULL AND ${t.handoffExpiresAt} IS NOT NULL
          AND ${t.authKind} IS NOT NULL AND ${t.failureCode} IS NULL
        ) OR (
          ${t.status} = 'failed'
          AND ${t.consumedAt} IS NULL AND ${t.failedAt} IS NOT NULL
          AND ${t.cancelledAt} IS NULL AND ${t.replacedAt} IS NULL
          AND ${t.failureCode} IS NOT NULL
        ) OR (
          ${t.status} = 'cancelled'
          AND ${t.consumedAt} IS NULL AND ${t.cancelledAt} IS NOT NULL
          AND ${t.failedAt} IS NULL AND ${t.replacedAt} IS NULL
          AND ${t.failureCode} IS NULL
        ) OR (
          ${t.status} = 'replaced'
          AND ${t.consumedAt} IS NULL AND ${t.replacedAt} IS NOT NULL
          AND ${t.failedAt} IS NULL AND ${t.cancelledAt} IS NULL
          AND ${t.failureCode} IS NULL
        )`,
    ),
  ],
);
