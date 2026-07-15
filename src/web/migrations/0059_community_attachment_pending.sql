-- Rebuild community_attachment for the agent-attachment-pipeline plan:
--   * message_id becomes nullable (pending rows written by `attachment upload`
--     before the send that links them).
--   * Adds uploader_id, kind, target_id, r2_key, position — send-time validation
--     is a single indexed lookup, no URL parsing.
--   * Drops `url` — routable URL is derived from `r2_key` on read.
--
-- Human-composer path always inserts with message_id set (attachments write
-- after `createMessage`, see message-handler.ts). The agent-flow is the only
-- writer of `message_id = NULL` rows.

CREATE TABLE community_attachment_new (
  id            TEXT PRIMARY KEY,
  message_id    TEXT REFERENCES community_message(id) ON DELETE CASCADE,
  uploader_id   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size          INTEGER,
  width         INTEGER,
  height        INTEGER,
  position      INTEGER,
  created_at    TEXT NOT NULL
);

-- Backfill from the old table. `/api/community/media/` is 21 characters and
-- SQLite SUBSTR() is 1-indexed and inclusive of the start, so `start = 22`
-- returns everything after the trailing slash — matches `buildMediaKey` output
-- (no leading slash). Threads flatten to `kind = "channel"` per resolve-ref.
INSERT INTO community_attachment_new (
  id, message_id, uploader_id, kind, target_id, r2_key,
  filename, content_type, size, width, height, position, created_at
)
SELECT
  a.id,
  a.message_id,
  m.author_id,
  CASE WHEN m.channel_id IS NOT NULL THEN 'channel' ELSE 'dm' END,
  COALESCE(m.channel_id, m.dm_conversation_id),
  SUBSTR(a.url, 22),
  a.filename, a.content_type, a.size, a.width, a.height,
  ROW_NUMBER() OVER (PARTITION BY a.message_id ORDER BY a.created_at) - 1,
  a.created_at
FROM community_attachment a
JOIN community_message m ON m.id = a.message_id;

-- Backfill-loss assertion: SQLite's RAISE() is only valid inside a trigger,
-- so wrap the count-compare in a one-shot trigger fired by an insert into a
-- sentinel table. Every existing row is FK NOT NULL to community_message with
-- ON DELETE CASCADE today, so no orphans should exist — this catches any
-- anomaly and aborts the migration rather than silently dropping rows.
CREATE TABLE _attachment_backfill_check (dummy INTEGER);
CREATE TRIGGER _attachment_backfill_check_trg
  BEFORE INSERT ON _attachment_backfill_check
  WHEN (SELECT COUNT(*) FROM community_attachment) != (SELECT COUNT(*) FROM community_attachment_new)
BEGIN
  SELECT RAISE(ABORT, 'community_attachment backfill row loss');
END;
INSERT INTO _attachment_backfill_check (dummy) VALUES (1);
DROP TRIGGER _attachment_backfill_check_trg;
DROP TABLE _attachment_backfill_check;

DROP TABLE community_attachment;
ALTER TABLE community_attachment_new RENAME TO community_attachment;
CREATE INDEX idx_attachment_message ON community_attachment(message_id, position);
CREATE INDEX idx_attachment_pending_uploader
  ON community_attachment(uploader_id, kind, target_id)
  WHERE message_id IS NULL;
