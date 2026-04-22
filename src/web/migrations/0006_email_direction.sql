-- Add direction column to emails table (inbound/outbound)
ALTER TABLE emails ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound';

-- Backfill: emails sent FROM an @alook.ai address are outbound
UPDATE emails SET direction = 'outbound' WHERE from_email LIKE '%@alook.ai';

-- Backfill: emails sent FROM a custom SMTP account are also outbound
UPDATE emails SET direction = 'outbound'
WHERE direction = 'inbound'
  AND from_email IN (SELECT email_address FROM agent_email_account);

-- Index for folder queries (inbox/sent/rejected all filter by agent_id + workspace_id + direction)
CREATE INDEX IF NOT EXISTS idx_emails_agent_ws_dir ON emails(agent_id, workspace_id, direction);
