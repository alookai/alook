ALTER TABLE community_bot_webhook
  ADD COLUMN category TEXT NOT NULL DEFAULT 'webhook';

ALTER TABLE community_bot_webhook
  ADD COLUMN transport TEXT NOT NULL DEFAULT 'cloud_webhook';

ALTER TABLE community_bot_webhook
  ADD COLUMN config_json TEXT;

ALTER TABLE community_bot_webhook
  ADD COLUMN outbound_creds_enc TEXT;

UPDATE community_bot_webhook
  SET category = 'im'
  WHERE provider = 'slack';

ALTER TABLE community_bot_private_inbox
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound';

ALTER TABLE community_bot_private_inbox
  ADD COLUMN sender_id TEXT;

ALTER TABLE community_bot_private_inbox
  ADD COLUMN sender_label TEXT;

ALTER TABLE community_bot_private_inbox
  ADD COLUMN chat_label TEXT;

CREATE TABLE IF NOT EXISTS community_bot_im_reply_ref (
  bot_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES community_bot_webhook(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  target_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (bot_user_id, ref)
);

CREATE INDEX IF NOT EXISTS idx_community_bot_im_reply_ref_trigger_expires
  ON community_bot_im_reply_ref (trigger_id, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_community_bot_im_reply_ref_owner
  ON community_bot_im_reply_ref (owner_user_id);
