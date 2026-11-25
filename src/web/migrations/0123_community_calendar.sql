CREATE TABLE IF NOT EXISTS community_calendar_event (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at_ms INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  time_zone TEXT NOT NULL,
  recurrence_json TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  next_run_at_ms INTEGER,
  source_message_id TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_calendar_event_owner_created
  ON community_calendar_event (owner_user_id, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_community_calendar_event_owner_next_run
  ON community_calendar_event (owner_user_id, next_run_at_ms)
  WHERE next_run_at_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_community_calendar_event_creator_id_lookup
  ON community_calendar_event (created_by_user_id);

CREATE TABLE IF NOT EXISTS community_calendar_run (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES community_calendar_event(id) ON DELETE CASCADE,
  event_version INTEGER NOT NULL,
  bot_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  scheduled_at_ms INTEGER NOT NULL,
  source_message_id TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  description_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  acked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_community_calendar_run_event_scheduled
  ON community_calendar_run (event_id, scheduled_at_ms);

CREATE INDEX IF NOT EXISTS idx_community_calendar_run_owner_status_scheduled
  ON community_calendar_run (owner_user_id, status, scheduled_at_ms);

CREATE INDEX IF NOT EXISTS idx_community_calendar_run_bot_id_lookup
  ON community_calendar_run (bot_user_id);
