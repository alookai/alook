CREATE TABLE product_analytics_event (
  id TEXT PRIMARY KEY NOT NULL,
  event_name TEXT NOT NULL,
  actor_user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
  source_id TEXT,
  dedupe_key TEXT NOT NULL,
  client_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  method TEXT,
  account_kind TEXT,
  cta_name TEXT,
  failure_stage TEXT,
  created_at TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivery_reason TEXT,
  attempted_at TEXT
);
CREATE UNIQUE INDEX uq_product_analytics_dedupe ON product_analytics_event(dedupe_key);
CREATE INDEX idx_product_analytics_actor_server_event ON product_analytics_event(actor_user_id, server_id, event_name);
