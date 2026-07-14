-- Per-bot audit trail for the /community/me/bots activity modal.
-- Rows are one of three kinds — cli_invocation, tool_call, thinking.
-- Retention: rolling last 500 per bot, pruned at write time in ws-do.
-- FK cascades on the user row so a HARD delete removes activity rows;
-- production uses soft-delete (user.deleted_at set), so the query layer
-- filters to `user.deleted_at IS NULL` on reads (see queries/community/bot-audit-log.ts).

CREATE TABLE community_bot_activity_event (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  session_id TEXT,
  launch_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Composite index: page reads AND retention prune ordering.
-- (bot_id, created_at DESC, id DESC) matches both the read query's ORDER BY
-- and the retention prune's tie-breaker (see plan §Retention). The `id DESC`
-- tail ensures same-millisecond ties break deterministically so paginated
-- cursors stay stable.
CREATE INDEX idx_bot_activity_event_bot_created
  ON community_bot_activity_event(bot_id, created_at DESC, id DESC);
