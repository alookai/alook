-- Make machine_token.workspace_id nullable so tokens can be created before workspace exists.
-- The workspace is created when the daemon actually registers.

-- SQLite doesn't support ALTER COLUMN, so we recreate the table.
CREATE TABLE machine_token_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO machine_token_new SELECT * FROM machine_token;
DROP TABLE machine_token;
ALTER TABLE machine_token_new RENAME TO machine_token;
CREATE INDEX idx_machine_token ON machine_token(token);
