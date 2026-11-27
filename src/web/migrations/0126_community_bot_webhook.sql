CREATE TABLE IF NOT EXISTS community_bot_webhook (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  bot_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  signing_secret_enc TEXT,
  event_filter_json TEXT,
  instruction TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_triggered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_bot_webhook_owner_bot
  ON community_bot_webhook (owner_user_id, bot_user_id, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_community_bot_webhook_bot
  ON community_bot_webhook (bot_user_id);

CREATE TABLE IF NOT EXISTS community_bot_webhook_delivery (
  id TEXT PRIMARY KEY NOT NULL,
  webhook_id TEXT NOT NULL REFERENCES community_bot_webhook(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  bot_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  external_delivery_id TEXT,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  dispatched_at_ms INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_community_bot_webhook_delivery_ext
  ON community_bot_webhook_delivery (webhook_id, external_delivery_id)
  WHERE external_delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_community_bot_webhook_delivery_bot_pending
  ON community_bot_webhook_delivery (bot_user_id, status, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_community_bot_webhook_delivery_webhook_created
  ON community_bot_webhook_delivery (webhook_id, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_community_bot_webhook_delivery_owner
  ON community_bot_webhook_delivery (owner_user_id);
