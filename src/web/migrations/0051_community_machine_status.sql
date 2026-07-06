-- community_machine.status — explicit online/offline column.
-- Before this migration, status was derived on read from last_seen_at.
-- See plans/community-machine-presence-fix.md.

-- 1. Add the column with a safe default. Existing rows land as offline.
ALTER TABLE community_machine ADD COLUMN status TEXT NOT NULL DEFAULT 'offline';

-- 2. Index for future filtered reads by presence.
CREATE INDEX idx_community_machine_user_status ON community_machine(user_id, status);

-- 3. Backfill for daemons currently connected across the deploy. CF Worker
--    deploys do NOT force daemon reconnects; hibernated sockets carry across
--    and never re-emit `ready` on their own. Without this backfill, a live
--    daemon would render offline until its next reconnect (potentially hours).
--
--    IMPORTANT: last_seen_at is written as ISO-8601 with a trailing Z
--    (e.g. 2026-07-06T12:34:56.789Z) while datetime('now', '…') returns
--    'YYYY-MM-DD HH:MM:SS'. Wrap BOTH sides in datetime() so the comparison
--    normalizes to the same textual form. Do NOT drop either datetime() wrapper
--    — the raw strings will not compare correctly.
-- NOTE: `-90 seconds` mirrors COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS in
-- src/shared/src/constants.ts (90_000ms at time of writing). This migration
-- is one-shot and already checksummed, so we do NOT parameterize it — if the
-- runtime constant changes later, dev/CI environments running fresh migrations
-- will backfill against the old 90s window. That's acceptable for a one-shot
-- backfill; the runtime alarm path re-converges within one heartbeat cycle.
UPDATE community_machine
SET status = 'online'
WHERE last_seen_at IS NOT NULL
  AND datetime(last_seen_at) > datetime('now', '-90 seconds');
