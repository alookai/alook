-- Canonical forum-post deletion is rooted at the opener message. Before the
-- FK is added, prove every child-channel relation is the supported one-level
-- shape. Abort on anomalies; never filter, repair, or silently drop a row.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE _channel_parent_message_audit (dummy INTEGER);
CREATE TRIGGER _channel_parent_message_audit_trg
  BEFORE INSERT ON _channel_parent_message_audit
  WHEN EXISTS (
    SELECT 1
    FROM community_channel AS child
    LEFT JOIN community_channel AS parent
      ON parent.id = child.parent_channel_id
    LEFT JOIN community_message AS opener
      ON opener.id = child.parent_message_id
    WHERE
      (child.type = 'thread'
       OR child.parent_channel_id IS NOT NULL
       OR child.parent_message_id IS NOT NULL)
      AND (
        child.type != 'thread'
        OR child.parent_channel_id IS NULL
        OR child.parent_message_id IS NULL
        OR parent.id IS NULL
        OR parent.parent_channel_id IS NOT NULL
        OR parent.type NOT IN ('text', 'forum')
        OR opener.id IS NULL
        OR opener.channel_id != child.parent_channel_id
        OR child.server_id IS NOT parent.server_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'community_channel parent_message_id audit failed');
END;
INSERT INTO _channel_parent_message_audit (dummy) VALUES (1);
DROP TRIGGER _channel_parent_message_audit_trg;
DROP TABLE _channel_parent_message_audit;

-- Native column evolution avoids DROP/CREATE of community_channel. Rebuilding
-- that root table would fire its existing ON DELETE CASCADE children inside a
-- D1 migration even with defer_foreign_keys enabled (the failure 0068 had to
-- work around). The temporary column starts nullable as SQLite requires for a
-- REFERENCES column added to a populated table.
ALTER TABLE community_channel
  ADD COLUMN parent_message_id_cascade TEXT
  REFERENCES community_message(id) ON DELETE CASCADE;

UPDATE community_channel
SET parent_message_id_cascade = parent_message_id;

-- Every index that names or predicates on the old column must be removed
-- before SQLite will DROP it, then recreated byte-for-byte on the renamed FK.
DROP INDEX IF EXISTS idx_channel_parent_message;
DROP INDEX IF EXISTS uq_community_channel_parent_message;
DROP INDEX IF EXISTS idx_channel_forum_created;

ALTER TABLE community_channel DROP COLUMN parent_message_id;
ALTER TABLE community_channel
  RENAME COLUMN parent_message_id_cascade TO parent_message_id;

CREATE UNIQUE INDEX idx_channel_parent_message
  ON community_channel(parent_message_id)
  WHERE parent_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_community_channel_parent_message
  ON community_channel(parent_channel_id, parent_message_id)
  WHERE parent_channel_id IS NOT NULL AND parent_message_id IS NOT NULL;
CREATE INDEX idx_channel_forum_created
  ON community_channel(parent_channel_id, created_at DESC, id DESC)
  WHERE type = 'thread' AND archived = 0 AND parent_message_id IS NOT NULL;

-- `PRAGMA foreign_key_check` returning rows would not itself fail a migration,
-- so turn it into the same one-shot hard assertion used for the preflight.
CREATE TABLE _channel_parent_message_fk_check (dummy INTEGER);
CREATE TRIGGER _channel_parent_message_fk_check_trg
  BEFORE INSERT ON _channel_parent_message_fk_check
  WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check)
BEGIN
  SELECT RAISE(ABORT, 'community_channel parent_message_id foreign key check failed');
END;
INSERT INTO _channel_parent_message_fk_check (dummy) VALUES (1);
DROP TRIGGER _channel_parent_message_fk_check_trg;
DROP TABLE _channel_parent_message_fk_check;
