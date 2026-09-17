CREATE TABLE community_funnel_analytics_event (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CONSTRAINT ck_community_funnel_analytics_event_name
    CHECK (event_name IN ('runtime_connected', 'first_agent_reply_persisted', 'invited_human_joined')),
  conversation_type TEXT,
  source_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  CONSTRAINT ck_community_funnel_analytics_conversation_type CHECK (
    (event_name = 'first_agent_reply_persisted' AND conversation_type IN ('dm', 'channel', 'thread'))
    OR (event_name != 'first_agent_reply_persisted' AND conversation_type IS NULL)
  )
);

CREATE UNIQUE INDEX uq_community_funnel_analytics_dedupe
  ON community_funnel_analytics_event(dedupe_key);

CREATE INDEX idx_community_funnel_analytics_owner_claimed_created
  ON community_funnel_analytics_event(owner_user_id, claimed_at, created_at);
