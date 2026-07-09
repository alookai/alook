-- Migration: drop community_inbox_dismissal
-- The Inbox "For You" tab is removed; the dismissal table is no longer read
-- or written by any code path. Indexes drop implicitly with the table under
-- SQLite, but we drop them explicitly first to make the intent obvious.

DROP INDEX IF EXISTS idx_inbox_dismissal_user;
DROP INDEX IF EXISTS uq_inbox_dismissal_user_event;
DROP TABLE IF EXISTS community_inbox_dismissal;
