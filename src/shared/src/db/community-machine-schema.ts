import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { user } from "./schema";
import type { CommunityMachineRuntime } from "../community-ws-events";

export const DIAGNOSTIC_REPORT_FAILURE_CODES = [
  "offline",
  "timeout",
  "upload_conflict",
  "invalid_upload",
  "diagnostics_unavailable",
  "collector_busy",
  "bot_not_bound",
  "collection_failed",
  "local_artifact_invalid",
  "bundle_too_large",
  "upload_failed",
  "internal_error",
] as const;

export type DiagnosticReportFailureCode =
  (typeof DIAGNOSTIC_REPORT_FAILURE_CODES)[number];

export type DiagnosticReportStatus = "pending" | "uploaded" | "failed";

// community_diagnostic_report — immutable authorization and collection
// snapshot for one owner-requested diagnostic bundle. Deliberately has no
// foreign keys: bot soft-delete, unbind, and machine deletion must not erase
// or pin the audit/status record after the atomic create snapshot is taken.
export const communityDiagnosticReport = sqliteTable(
  "community_diagnostic_report",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => "dbr_" + nanoid()),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: text("agent_id").notNull(),
    machineId: text("machine_id").notNull(),
    clientNonce: text("client_nonce").notNull(),
    rateBucket: integer("rate_bucket").notNull(),
    status: text("status").$type<DiagnosticReportStatus>().notNull().default("pending"),
    failureCode: text("failure_code").$type<DiagnosticReportFailureCode>(),
    fromMs: integer("from_ms").notNull(),
    createdAt: integer("created_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
    completedAt: integer("completed_at"),
    r2Key: text("r2_key"),
    sha256: text("sha256"),
    sizeBytes: integer("size_bytes"),
    uploadedAt: integer("uploaded_at"),
    objectExpiresAt: integer("object_expires_at"),
  },
  (t) => [
    index("idx_community_diagnostic_report_owner_created").on(
      t.ownerUserId,
      t.createdAt
    ),
    index("idx_community_diagnostic_report_machine_status_deadline").on(
      t.machineId,
      t.status,
      t.deadlineAt
    ),
    uniqueIndex("uq_community_diagnostic_report_owner_nonce").on(
      t.ownerUserId,
      t.clientNonce
    ),
    uniqueIndex("uq_community_diagnostic_report_owner_agent_pending")
      .on(t.ownerUserId, t.agentId)
      .where(sql`status = 'pending'`),
    uniqueIndex("uq_community_diagnostic_report_owner_rate_bucket").on(
      t.ownerUserId,
      t.rateBucket
    ),
    check(
      "ck_community_diagnostic_report_id",
      sql`length(${t.id}) > 4 AND substr(${t.id}, 1, 4) = 'dbr_' AND ${t.id} NOT GLOB '*[^A-Za-z0-9_-]*'`
    ),
    check(
      "ck_community_diagnostic_report_nonce",
      sql`length(${t.clientNonce}) BETWEEN 16 AND 64 AND ${t.clientNonce} NOT GLOB '*[^A-Za-z0-9_-]*'`
    ),
    check(
      "ck_community_diagnostic_report_required_epochs",
      sql`typeof(${t.fromMs}) = 'integer' AND ${t.fromMs} BETWEEN 0 AND 9007199254740991
        AND typeof(${t.createdAt}) = 'integer' AND ${t.createdAt} BETWEEN 0 AND 9007199254740991
        AND typeof(${t.deadlineAt}) = 'integer' AND ${t.deadlineAt} BETWEEN 0 AND 9007199254740991
        AND ${t.fromMs} = ${t.createdAt} - 86400000
        AND ${t.deadlineAt} = ${t.createdAt} + 600000`
    ),
    check(
      "ck_community_diagnostic_report_rate_bucket",
      sql`typeof(${t.rateBucket}) = 'integer'
        AND ${t.rateBucket} BETWEEN 0 AND 9007199254740991
        AND ${t.rateBucket} = CAST(${t.createdAt} / 60000 AS INTEGER)`
    ),
    check(
      "ck_community_diagnostic_report_nullable_epochs",
      sql`(${t.completedAt} IS NULL OR (typeof(${t.completedAt}) = 'integer' AND ${t.completedAt} BETWEEN 0 AND 9007199254740991))
        AND (${t.uploadedAt} IS NULL OR (typeof(${t.uploadedAt}) = 'integer' AND ${t.uploadedAt} BETWEEN 0 AND 9007199254740991))
        AND (${t.objectExpiresAt} IS NULL OR (typeof(${t.objectExpiresAt}) = 'integer' AND ${t.objectExpiresAt} BETWEEN 0 AND 9007199254740991))`
    ),
    check(
      "ck_community_diagnostic_report_size",
      sql`${t.sizeBytes} IS NULL OR (typeof(${t.sizeBytes}) = 'integer' AND ${t.sizeBytes} BETWEEN 1 AND 10485760)`
    ),
    check(
      "ck_community_diagnostic_report_sha256",
      sql`${t.sha256} IS NULL OR (length(${t.sha256}) = 64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*')`
    ),
    check(
      "ck_community_diagnostic_report_state",
      sql`(
          ${t.status} = 'pending'
          AND ${t.failureCode} IS NULL AND ${t.completedAt} IS NULL
          AND ${t.r2Key} IS NULL AND ${t.sha256} IS NULL AND ${t.sizeBytes} IS NULL
          AND ${t.uploadedAt} IS NULL AND ${t.objectExpiresAt} IS NULL
        ) OR (
          ${t.status} = 'failed'
          AND ${t.failureCode} IN ('offline', 'timeout', 'upload_conflict', 'invalid_upload', 'diagnostics_unavailable', 'collector_busy', 'bot_not_bound', 'collection_failed', 'local_artifact_invalid', 'bundle_too_large', 'upload_failed', 'internal_error')
          AND ${t.completedAt} IS NOT NULL
          AND ${t.completedAt} >= ${t.createdAt}
          AND ${t.r2Key} IS NULL AND ${t.sha256} IS NULL AND ${t.sizeBytes} IS NULL
          AND ${t.uploadedAt} IS NULL AND ${t.objectExpiresAt} IS NULL
        ) OR (
          ${t.status} = 'uploaded'
          AND ${t.failureCode} IS NULL AND ${t.completedAt} IS NOT NULL
          AND ${t.completedAt} >= ${t.createdAt}
          AND ${t.r2Key} IS NOT NULL
          AND ${t.r2Key} = 'bug-reports/' || ${t.ownerUserId} || '/' || ${t.id} || '.ndjson.gz'
          AND ${t.sha256} IS NOT NULL AND ${t.sizeBytes} IS NOT NULL
          AND ${t.uploadedAt} IS NOT NULL AND ${t.objectExpiresAt} IS NOT NULL
          AND ${t.completedAt} = ${t.uploadedAt}
          AND ${t.objectExpiresAt} = ${t.uploadedAt} + 604800000
        )`
    ),
  ]
);

// community_machine_token — pairing tokens. The id IS the user-visible
// token string (cmt_<nanoid(32)>). machine_id is set on reconnect tokens
// so /activate can look up the existing machine row instead of creating
// a new one.
export const communityMachineToken = sqliteTable(
  "community_machine_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => "cmt_" + nanoid(32)),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    machineId: text("machine_id"),
    status: text("status").notNull().default("pending"), // pending | active | revoked
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [
    index("idx_community_machine_token_user_status").on(t.userId, t.status),
    // Partial unique — at most one pending token per user. Enforced at DB
    // level so createPairingToken doesn't need lookup-then-insert.
    uniqueIndex("uq_community_machine_token_user_pending")
      .on(t.userId)
      .where(sql`status = 'pending'`),
  ]
);

// community_machine — one paired machine. `id` is opaque and stable across
// credential rotation (reconnect preserves it). `available_runtimes` is a
// non-null JSON array; empty list means the daemon reported no runtimes.
export const communityMachine = sqliteTable(
  "community_machine",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => "cm_" + nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull().default(""),
    hostname: text("hostname").notNull().default(""),
    platform: text("platform").notNull().default(""),
    arch: text("arch").notNull().default(""),
    osRelease: text("os_release").notNull().default(""),
    daemonVersion: text("daemon_version").notNull().default(""),
    metadata: text("metadata"),
    availableRuntimes: text("available_runtimes", { mode: "json" })
      .$type<CommunityMachineRuntime[]>()
      .notNull()
      .default([]),
    // status is the source of truth for machine presence — written by the
    // WsDurableObject on accept / webSocketClose / alarm. Not derived from
    // last_seen_at anymore (see plans/community-machine-presence-fix.md).
    status: text("status").notNull().default("offline"),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    index("idx_community_machine_user_last_seen").on(t.userId, t.lastSeenAt),
    index("idx_community_machine_user_updated").on(t.userId, t.updatedAt),
    index("idx_community_machine_user_status").on(t.userId, t.status),
  ]
);

// community_machine_credential — long-lived daemon Bearer credential.
// The plaintext bearer (`cmk_<nanoid(32)>`) is returned to the daemon
// once by /activate; the server persists only sha256(bearer) in
// `credential_hash` (full 64 hex) plus a 32-hex `do_name` prefix used by
// revoke to reach the live WS DO.
export const communityMachineCredential = sqliteTable(
  "community_machine_credential",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => "cmkid_" + nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    machineId: text("machine_id")
      .notNull()
      .references(() => communityMachine.id, { onDelete: "cascade" }),
    credentialHash: text("credential_hash").notNull().unique(),
    doName: text("do_name").notNull().unique(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    index("idx_community_machine_credential_user").on(t.userId),
    index("idx_community_machine_credential_machine").on(t.machineId),
  ]
);

// community_bot_binding — per-bot (userId is a bot's user row) machine +
// runtime pairing. One row per live bot. `machineId` is RESTRICT so a raw
// DB delete of a machine with bots errors; application layer cascades UX-side.
// On bot soft-delete, the binding row is explicitly deleted (soft-delete does
// not remove the user row, so the FK CASCADE from user does not fire).
export const communityBotBinding = sqliteTable(
  "community_bot_binding",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    machineId: text("machine_id")
      .notNull()
      .references(() => communityMachine.id, { onDelete: "restrict" }),
    runtime: text("runtime").notNull(),
    instruction: text("instruction").notNull().default(""),
    // Full launchable model id (e.g. "claude-opus-4-6"), or NULL for the
    // runtime's default. Kind is derived from the catalog at read time, never
    // stored. Hand-maintained in lockstep with migration 0063 (no drizzle-kit
    // generate in this repo).
    modelName: text("model_name"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_community_bot_binding_machine").on(t.machineId)]
);

// community_agent_runner_key — per-agent runner key. Same hashing shape
// as community_machine_credential; no data-plane consumer in v1.
export const communityAgentRunnerKey = sqliteTable(
  "community_agent_runner_key",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => "crkid_" + nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    machineId: text("machine_id")
      .notNull()
      .references(() => communityMachine.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    runnerKeyHash: text("runner_key_hash").notNull().unique(),
    doName: text("do_name").notNull().unique(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    index("idx_community_agent_runner_key_machine_agent").on(t.machineId, t.agentId),
  ]
);
