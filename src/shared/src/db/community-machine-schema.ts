import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { user } from "./schema";
import type { CommunityMachineRuntime } from "../community-ws-events";

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
