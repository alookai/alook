-- Community daemon refactor: drop and recreate the four community tables
-- with hashed credentials, machineId-bound pairing tokens, and a machine
-- row shape that no longer depends on the token-derived machine_uuid.
--
-- Safe to drop-and-recreate because migration 0048 has not shipped to any
-- environment where user data is worth preserving; if that changes, this
-- migration must be replaced with a create-copy-drop-rename rebuild.

DROP TABLE IF EXISTS community_agent_runner_key;
DROP TABLE IF EXISTS community_machine_credential;
DROP TABLE IF EXISTS community_machine_token;
DROP TABLE IF EXISTS community_machine;

-- community_machine — one paired machine. machine.id is opaque and stable
-- across credential rotation (reconnect keeps the same machine.id).
CREATE TABLE community_machine (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  os_release TEXT NOT NULL DEFAULT '',
  daemon_version TEXT NOT NULL DEFAULT '',
  metadata TEXT,
  available_runtimes TEXT NOT NULL DEFAULT '[]',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_community_machine_user_last_seen
  ON community_machine(user_id, last_seen_at);
CREATE INDEX idx_community_machine_user_updated
  ON community_machine(user_id, updated_at);

-- community_machine_token — pairing tokens.
-- machine_id is nullable: null == first-pair token, non-null == reconnect
-- token bound to an existing machine row.
CREATE TABLE community_machine_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  machine_id TEXT REFERENCES community_machine(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_community_machine_token_user_status
  ON community_machine_token(user_id, status);
-- At most one pending token per user. Partial index; enforces the
-- "createPairingToken fails if a pending one already exists" invariant
-- without requiring userland lookup-then-insert.
CREATE UNIQUE INDEX uq_community_machine_token_user_pending
  ON community_machine_token(user_id)
  WHERE status = 'pending';

-- community_machine_credential — long-lived daemon Bearer credential.
-- The plaintext bearer (`cmk_...`) is returned to the daemon ONCE by
-- /activate; server persists only sha256(bearer). `do_name` is the DO
-- name suffix (first 32 hex chars of the hash) used by revoke to reach
-- the live WS DO for force-close.
CREATE TABLE community_machine_credential (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES community_machine(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE,
  do_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_community_machine_credential_user
  ON community_machine_credential(user_id);
CREATE INDEX idx_community_machine_credential_machine
  ON community_machine_credential(machine_id);

-- community_agent_runner_key — per-agent runner key. Same hashing shape as
-- community_machine_credential; no data-plane consumer in v1 but persisted
-- so future runner-key WS paths can reuse the plumbing.
CREATE TABLE community_agent_runner_key (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES community_machine(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  runner_key_hash TEXT NOT NULL UNIQUE,
  do_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_community_agent_runner_key_machine_agent
  ON community_agent_runner_key(machine_id, agent_id);
