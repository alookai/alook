-- Community schema unification (2/5): DMs become channels.
-- See plans/community-schema-unification.md.
--
-- Every DM (community_dm_conversation) becomes a community_channel row with
-- type='dm', reusing its existing id (so messages/read_state/seq that already
-- point at the DM id need no id remap). Its two participants become
-- relation='access' community_channel_member rows.
--
-- community_channel must be rebuilt because server_id is currently NOT NULL and
-- a DM has no server. `name` is also made nullable (DMs have no name). The
-- rebuild + the self-referential parent_channel_id FK + the many dependent
-- tables require deferred FK checks for the whole batch.

PRAGMA defer_foreign_keys=ON;

-- 1. Rebuild community_channel with server_id AND name nullable.
CREATE TABLE community_channel_new (
  id TEXT PRIMARY KEY,
  server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES community_category(id) ON DELETE SET NULL,
  name TEXT,
  type TEXT NOT NULL DEFAULT 'text',
  topic TEXT DEFAULT '',
  position INTEGER DEFAULT 0,
  forum_tags TEXT,
  parent_channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
  creator_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  message_count INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  parent_message_id TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO community_channel_new (
  id, server_id, category_id, name, type, topic, position, forum_tags,
  parent_channel_id, creator_id, message_count, archived, parent_message_id,
  last_message_at, created_at
)
SELECT
  id, server_id, category_id, name, type, topic, position, forum_tags,
  parent_channel_id, creator_id, message_count, archived, parent_message_id,
  last_message_at, created_at
FROM community_channel;

DROP TABLE community_channel;
ALTER TABLE community_channel_new RENAME TO community_channel;

-- Recreate every index the rename dropped.
CREATE INDEX idx_channel_server_position ON community_channel(server_id, position);
CREATE INDEX idx_channel_server_last_message ON community_channel(server_id, last_message_at);
CREATE INDEX idx_channel_parent ON community_channel(parent_channel_id);
CREATE UNIQUE INDEX idx_channel_parent_message
  ON community_channel(parent_message_id)
  WHERE parent_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_community_channel_parent_message
  ON community_channel(parent_channel_id, parent_message_id)
  WHERE parent_channel_id IS NOT NULL AND parent_message_id IS NOT NULL;
-- DMs have parent_channel_id NULL (pass the WHERE), but server_id NULL and name
-- NULL — SQLite treats NULLs as distinct in unique indexes, so (NULL, NULL)
-- never collides. Safe: do not "fix" this by excluding DMs.
CREATE UNIQUE INDEX idx_channel_server_name
  ON community_channel(server_id, name)
  WHERE parent_channel_id IS NULL;

-- 2. One type='dm' channel per DM conversation, reusing the DM's id.
--    message_count is counted from dm_conversation_id HERE — 0069 has not yet
--    re-pointed those message rows onto channel_id.
INSERT OR IGNORE INTO community_channel (
  id, server_id, category_id, name, type, topic, position, forum_tags,
  parent_channel_id, creator_id, message_count, archived, parent_message_id,
  last_message_at, created_at
)
SELECT
  dm.id, NULL, NULL, NULL, 'dm', '', 0, NULL,
  NULL, NULL,
  (SELECT COUNT(*) FROM community_message m WHERE m.dm_conversation_id = dm.id),
  0, NULL,
  dm.last_message_at, dm.created_at
FROM community_dm_conversation dm;

-- 3. DM participants → relation='access' member rows. Emit a row per non-NULL
--    participant; an orphan (deleted-user) participant simply gets no row.
INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT lower(hex(randomblob(16))), dm.id, dm.user1_id, 'access', 'added', NULL, dm.created_at
FROM community_dm_conversation dm
WHERE dm.user1_id IS NOT NULL;

INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT lower(hex(randomblob(16))), dm.id, dm.user2_id, 'access', 'added', NULL, dm.created_at
FROM community_dm_conversation dm
WHERE dm.user2_id IS NOT NULL;

-- community_dm_conversation is NOT dropped here — community_message and
-- community_read_state still FK it until 0069.
