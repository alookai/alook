CREATE TABLE automation_access_code (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_automation_code_owner ON automation_access_code(owner_id);
CREATE TABLE automation_access_permission (
  code_id TEXT NOT NULL REFERENCES automation_access_code(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  request_limit INTEGER NOT NULL CHECK (request_limit >= 1 AND request_limit = CAST(request_limit AS INTEGER)),
  period TEXT NOT NULL CHECK (period IN ('hour', 'day')),
  PRIMARY KEY (code_id, permission),
  CHECK ((period = 'hour' AND request_limit <= 64) OR (period = 'day' AND request_limit <= 1536))
);
