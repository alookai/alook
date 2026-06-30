import { sqliteTable, text, index, unique } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { user } from "./schema";

// community_machine_token — pairing tokens. The `id` value IS the user-visible
// token string (cmt_<nanoid(32)>). Single source of truth; the daemon copies
// the id verbatim from the pair sheet and passes it on the WS upgrade URL.
export const communityMachineToken = sqliteTable(
  "community_machine_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => "cmt_" + nanoid(32)),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending | active | revoked
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [index("idx_community_machine_token_user_status").on(t.userId, t.status)]
);

// community_machine — one user, one machine. Status is derived purely from
// last_seen_at on read.
export const communityMachine = sqliteTable(
  "community_machine",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => "cm_" + nanoid()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    machineUuid: text("machine_uuid").notNull(),
    displayName: text("display_name").notNull().default(""),
    hostname: text("hostname").notNull().default(""),
    platform: text("platform").notNull().default(""),
    arch: text("arch").notNull().default(""),
    osRelease: text("os_release").notNull().default(""),
    daemonVersion: text("daemon_version").notNull().default(""),
    metadata: text("metadata"),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    unique("uq_community_machine_user_uuid").on(t.userId, t.machineUuid),
    index("idx_community_machine_user_last_seen").on(t.userId, t.lastSeenAt),
    index("idx_community_machine_user_updated").on(t.userId, t.updatedAt),
  ]
);
