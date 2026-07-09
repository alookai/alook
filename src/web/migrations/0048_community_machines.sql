-- community_machine_token — pairing tokens. The id IS the user-visible token.
CREATE TABLE community_machine_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_community_machine_token_user_status ON community_machine_token(user_id, status);

-- community_machine — one user, one machine. Status is derived from last_seen_at.
CREATE TABLE community_machine (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  machine_uuid TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  os_release TEXT NOT NULL DEFAULT '',
  daemon_version TEXT NOT NULL DEFAULT '',
  metadata TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, machine_uuid)
);
CREATE INDEX idx_community_machine_user_last_seen ON community_machine(user_id, last_seen_at);
CREATE INDEX idx_community_machine_user_updated ON community_machine(user_id, updated_at);
