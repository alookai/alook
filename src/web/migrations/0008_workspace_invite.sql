CREATE TABLE workspace_invite (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  used_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_workspace_invite_token ON workspace_invite(token);
CREATE INDEX idx_workspace_invite_workspace ON workspace_invite(workspace_id);
