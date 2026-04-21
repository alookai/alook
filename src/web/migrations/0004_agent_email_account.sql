CREATE TABLE IF NOT EXISTS agent_email_account (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  email_address TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',

  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_username TEXT NOT NULL,
  imap_password TEXT NOT NULL,
  imap_tls INTEGER NOT NULL DEFAULT 1,

  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_username TEXT NOT NULL,
  smtp_password TEXT NOT NULL,
  smtp_tls INTEGER NOT NULL DEFAULT 1,

  poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
  last_synced_uid TEXT NOT NULL DEFAULT '0',
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  error_message TEXT NOT NULL DEFAULT '',

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_account_agent_ws ON agent_email_account(agent_id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS email_account_agent_email ON agent_email_account(agent_id, email_address);
