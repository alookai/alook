ALTER TABLE emails ADD COLUMN mailbox TEXT NOT NULL DEFAULT 'inbox';

UPDATE emails
SET mailbox = 'sent'
WHERE direction = 'outbound' AND status = 'sent';

UPDATE emails
SET mailbox = 'inbox'
WHERE direction = 'inbound' AND is_whitelisted = 1;

UPDATE emails
SET mailbox = 'untrust'
WHERE direction = 'inbound' AND is_whitelisted = 0;

CREATE INDEX IF NOT EXISTS idx_emails_agent_ws_mailbox
ON emails(agent_id, workspace_id, mailbox);
