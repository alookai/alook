import type Sqlite from "better-sqlite3";

export function createMachinePlanTables(sqlite: Sqlite.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS community_machine (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '',
      os_release TEXT NOT NULL DEFAULT '', daemon_version TEXT NOT NULL DEFAULT '', time_zone TEXT,
      metadata TEXT, available_runtimes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'offline',
      last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS test_machine_owner ON community_machine(user_id);
    CREATE TABLE IF NOT EXISTS community_machine_credential (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE,
      do_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS community_agent_runner_key (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      runner_key_hash TEXT NOT NULL UNIQUE, do_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT
    );
  `);
}
