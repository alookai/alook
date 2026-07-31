-- My-bots activity heatmap (Gus /Gus/working #608): replace the single
-- "Handled N msgs" lifecycle counter with a GitHub-style 30-day contribution
-- grid — per bot, per calendar day, how many messages it HANDLED (woke for)
-- and SENT.
--
-- Data source is a per-day rollup table, NOT an aggregate of existing tables:
-- community_bot_activity_event is a rolling 500-row/bot audit log (8 event
-- kinds share the budget) so a busy bot prunes 30-day-old rows within days;
-- and aggregating community_message for sent would need a (author_id,
-- created_at) index on the hottest table. The rollup avoids both.
--
-- Each counter is bumped +1 by an upsert that RIDES an existing write batch
-- (handled → the wake_trigger audit batch; sent → the community_message insert
-- batch), so there is no new hot-path round-trip. `day` is a UTC YYYY-MM-DD key
-- from a single shared helper so both upserts agree on the boundary. Unlike the
-- handledMessageCount column dropped below, this is a CALENDAR fact — never
-- zeroed on nap/reset, never touched by the FSM. Read is the last 30 days per
-- bot (<=30 rows, covered by the PK), so no rolling prune is needed.
CREATE TABLE community_bot_daily_activity (
  bot_id        TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,
  handled_count INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, day)
);

-- Drop the lifecycle counter this heatmap replaces. `lastRefreshContextAt`
-- stays — it is a separate "last refresh N ago" indicator, still written at the
-- nap/session_reset audit chokepoint. Deploy code that stops reading/writing
-- handledMessageCount BEFORE running this migration.
ALTER TABLE user DROP COLUMN handledMessageCount;
