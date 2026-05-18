-- Migration: Add greylist table and sender_trust field to emails
-- Part of the greylist/drafts feature

-- 1. Create agent_greylist table (mirrors agent_whitelist structure)
CREATE TABLE IF NOT EXISTS agent_greylist (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, workspace_id, email),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent(id, workspace_id) ON DELETE CASCADE
);

-- 2. Add sender_trust column to emails table
ALTER TABLE emails ADD COLUMN sender_trust TEXT NOT NULL DEFAULT 'untrusted';

-- 3. Backfill sender_trust from is_whitelisted
UPDATE emails SET sender_trust = 'trusted' WHERE is_whitelisted = 1;
