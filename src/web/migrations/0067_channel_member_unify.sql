-- Community schema unification (1/5): merge the membership tables.
-- See plans/community-schema-unification.md.
--
-- `community_channel_member` gains two axes on one table:
--   relation — access | notify. `access` rows gate private units (a channel in
--              a private category, a forum, a DM); `notify` rows are the
--              thread/forum_post participant set (formerly community_thread_participant).
--   source   — mention | spoke | added. How the membership arose.
-- A user may hold BOTH an access and a notify row for the same channel, so the
-- unique key becomes (channel_id, user_id, relation), not (channel_id, user_id).
--
-- SQLite can't add a column with a new unique constraint or drop the old
-- (channel_id, user_id) unique in place, so the table is rebuilt-and-swapped.
-- The swap drops attached indexes, recreated below.

PRAGMA defer_foreign_keys=ON;

-- 1. Rebuild community_channel_member with relation + source.
CREATE TABLE community_channel_member_new (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'access',
  source TEXT NOT NULL DEFAULT 'added',
  added_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL
);

-- Existing rows were the access set — tag them relation='access', source='added'.
INSERT INTO community_channel_member_new (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT id, channel_id, user_id, 'access', 'added', added_by, added_at
FROM community_channel_member;

DROP TABLE community_channel_member;
ALTER TABLE community_channel_member_new RENAME TO community_channel_member;

CREATE UNIQUE INDEX uq_channel_member
  ON community_channel_member(channel_id, user_id, relation);
CREATE INDEX idx_channel_member_user
  ON community_channel_member(user_id);

-- 2. Migrate community_thread_participant rows into notify member rows. Fresh
--    row ids; added_by is NULL (participation was never attributed to an
--    adder). INSERT OR IGNORE against the new unique key is idempotent.
INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT
  lower(hex(randomblob(16))),
  thread_channel_id,
  user_id,
  'notify',
  source,
  NULL,
  added_at
FROM community_thread_participant;

-- 3. Drop the folded-in table.
DROP TABLE community_thread_participant;
