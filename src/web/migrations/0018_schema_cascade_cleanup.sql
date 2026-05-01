-- Fix FK cascade behavior for agent and workspace_file_request tables:
-- 1. agent.runtime_id: NOT NULL + ON DELETE CASCADE — agent cannot exist without runtime
-- 2. agent.owner_id: ON DELETE CASCADE — deleting user deletes their agents
-- 3. workspace_file_request: add composite FK to agent(id, workspace_id) ON DELETE CASCADE

PRAGMA foreign_keys = OFF;

-- Rebuild agent table with corrected FK constraints
CREATE TABLE agent_new (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
  runtime_mode TEXT NOT NULL DEFAULT 'local',
  runtime_config TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'idle',
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 6,
  owner_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  tools TEXT,
  triggers TEXT,
  email_handle TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id, workspace_id)
);

-- Clean up orphan agents with NULL runtime_id (previously set by deleteRuntimesByDaemonId)
DELETE FROM agent WHERE runtime_id IS NULL;

INSERT INTO agent_new SELECT * FROM agent;

DROP TABLE agent;

ALTER TABLE agent_new RENAME TO agent;

-- Rebuild workspace_file_request with composite FK to agent
CREATE TABLE workspace_file_request_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  request_type TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '.',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent(id, workspace_id) ON DELETE CASCADE
);

INSERT INTO workspace_file_request_new SELECT * FROM workspace_file_request;

DROP TABLE workspace_file_request;

ALTER TABLE workspace_file_request_new RENAME TO workspace_file_request;

CREATE INDEX idx_wfr_workspace_status ON workspace_file_request(workspace_id, status);

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
