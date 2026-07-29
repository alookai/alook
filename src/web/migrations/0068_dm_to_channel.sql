-- CANDIDATE FIX (2/5): DMs become channels, WITHOUT cascade data loss.
--
-- D1 enforces FK on every migration and PRAGMA foreign_keys=OFF is a no-op
-- inside its per-file transaction (confirmed: CF docs + real wrangler test).
-- defer_foreign_keys defers VALIDATION, not the ON DELETE CASCADE ACTION that
-- fires the instant `DROP TABLE community_channel` runs. So the fix is
-- structural ordering: strip every cascade child's FK to a plain TEXT column
-- BEFORE dropping the parent (nothing to cascade to), then restore the FK.
--
-- This file now owns the FULL channel + message + read_state rebuild plus all
-- child strip/restore. 0069 shrinks to dropping the orphaned dm_conversation.

PRAGMA defer_foreign_keys=ON;

-- ============================================================================
-- PHASE 1 — STRIP: rebuild each cascade child with plain-TEXT FK columns
-- (no REFERENCES to channel/message), bottom-up so each old-table DROP
-- cascades to nothing.
-- ============================================================================

-- 1a. message-children → plain message_id (pin also holds channel_id).
CREATE TABLE community_reaction_stage (
  id TEXT PRIMARY KEY, message_id TEXT, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO community_reaction_stage SELECT id, message_id, user_id, emoji, created_at FROM community_reaction;
DROP TABLE community_reaction;
ALTER TABLE community_reaction_stage RENAME TO community_reaction;

CREATE TABLE community_mention_stage (
  id TEXT PRIMARY KEY, message_id TEXT, user_id TEXT NOT NULL, read INTEGER DEFAULT 0, kind TEXT NOT NULL DEFAULT 'mention'
);
INSERT INTO community_mention_stage SELECT id, message_id, user_id, read, kind FROM community_mention;
DROP TABLE community_mention;
ALTER TABLE community_mention_stage RENAME TO community_mention;

CREATE TABLE community_pin_stage (
  id TEXT PRIMARY KEY, channel_id TEXT, message_id TEXT, pinned_by TEXT, created_at TEXT NOT NULL
);
INSERT INTO community_pin_stage SELECT id, channel_id, message_id, pinned_by, created_at FROM community_pin;
DROP TABLE community_pin;
ALTER TABLE community_pin_stage RENAME TO community_pin;

CREATE TABLE community_bot_approval_request_stage (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL, server_id TEXT,
  requested_by_user_id TEXT NOT NULL, dm_message_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, resolved_at TEXT
);
INSERT INTO community_bot_approval_request_stage
  SELECT id, bot_id, kind, server_id, requested_by_user_id, dm_message_id, status, created_at, resolved_at
  FROM community_bot_approval_request;
DROP TABLE community_bot_approval_request;
ALTER TABLE community_bot_approval_request_stage RENAME TO community_bot_approval_request;

-- community_attachment: strip message_id FK now; 0071 rebuilds it (drops kind)
-- and restores the FK there.
CREATE TABLE community_attachment_stage (
  id TEXT PRIMARY KEY, message_id TEXT, uploader_id TEXT NOT NULL, kind TEXT NOT NULL,
  target_id TEXT NOT NULL, r2_key TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT,
  size INTEGER, width INTEGER, height INTEGER, position INTEGER, created_at TEXT NOT NULL
);
INSERT INTO community_attachment_stage
  SELECT id, message_id, uploader_id, kind, target_id, r2_key, filename, content_type, size, width, height, position, created_at
  FROM community_attachment;
DROP TABLE community_attachment;
ALTER TABLE community_attachment_stage RENAME TO community_attachment;

-- 1b. channel-children → plain channel_id. Repoint DM scope onto channel_id
-- (COALESCE) for message + read_state, dropping dm_conversation_id/flags/CHECK.
CREATE TABLE community_channel_member_stage (
  id TEXT PRIMARY KEY, channel_id TEXT, user_id TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'access',
  source TEXT NOT NULL DEFAULT 'added', added_by TEXT, added_at TEXT NOT NULL
);
INSERT INTO community_channel_member_stage SELECT id, channel_id, user_id, relation, source, added_by, added_at FROM community_channel_member;
DROP TABLE community_channel_member;
ALTER TABLE community_channel_member_stage RENAME TO community_channel_member;

CREATE TABLE community_notification_setting_stage (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, server_id TEXT, channel_id TEXT, level TEXT NOT NULL DEFAULT 'all'
);
INSERT INTO community_notification_setting_stage SELECT id, user_id, server_id, channel_id, level FROM community_notification_setting;
DROP TABLE community_notification_setting;
ALTER TABLE community_notification_setting_stage RENAME TO community_notification_setting;

CREATE TABLE community_read_state_stage (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT, last_read_at TEXT NOT NULL,
  last_read_message_id TEXT, last_read_seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO community_read_state_stage (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
  SELECT id, user_id, COALESCE(channel_id, dm_conversation_id), last_read_at, last_read_message_id, last_read_seq FROM community_read_state;
DROP TABLE community_read_state;
ALTER TABLE community_read_state_stage RENAME TO community_read_state;

-- 1c. community_message itself → staged plain channel_id. Old-table DROP now
-- cascades to nothing (its children stripped above).
CREATE TABLE community_message_stage (
  id TEXT PRIMARY KEY, channel_id TEXT, author_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'default', mention_type TEXT, reply_to_id TEXT, embeds TEXT,
  seq INTEGER NOT NULL DEFAULT 0, friendship_id TEXT, created_at TEXT NOT NULL
);
INSERT INTO community_message_stage (id, channel_id, author_id, content, type, mention_type, reply_to_id, embeds, seq, friendship_id, created_at)
  SELECT id, COALESCE(channel_id, dm_conversation_id), author_id, content, type, mention_type, reply_to_id, embeds, seq, friendship_id, created_at
  FROM community_message;
DROP TABLE community_message;
ALTER TABLE community_message_stage RENAME TO community_message;

-- Snapshot per-channel message counts BEFORE the channel rebuild, to guard
-- against a repeat of the DM-masks-server-loss bug.
CREATE TABLE _msg_count_by_channel AS
  SELECT channel_id, COUNT(*) AS n FROM community_message GROUP BY channel_id;

-- ============================================================================
-- PHASE 2 — REBUILD ROOT: community_channel (nullable server_id/name), built
-- directly in its FINAL shape INCLUDING the self-referential parent_channel_id
-- FK. That self-FK is itself an ON DELETE CASCADE child of community_channel: a
-- table with a self cascade FK cannot survive the drop-old-swap-new idiom,
-- because the NEW table's self-FK resolves by name to the OLD table during the
-- drop and cascade-deletes every thread / forum_post row (parent_channel_id
-- non-null). PRAGMA defer_foreign_keys does NOT suppress the cascade ACTION, and
-- foreign_keys=OFF is a no-op inside D1's transaction — so the only lever is
-- data: insert with parent_channel_id NULLED so the drop matches nothing, then
-- restore parent_channel_id via a plain UPDATE after the swap (no drop → no
-- cascade; the self-FK is satisfiable since every parent points at a row in
-- this same table, validated at COMMIT under defer_foreign_keys).
-- ============================================================================
CREATE TABLE _channel_parent (id TEXT PRIMARY KEY, parent_channel_id TEXT);
INSERT INTO _channel_parent (id, parent_channel_id)
  SELECT id, parent_channel_id FROM community_channel WHERE parent_channel_id IS NOT NULL;

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
-- parent_channel_id inserted as NULL on purpose (restored post-swap below).
INSERT INTO community_channel_new (
  id, server_id, category_id, name, type, topic, position, forum_tags,
  parent_channel_id, creator_id, message_count, archived, parent_message_id, last_message_at, created_at
)
SELECT id, server_id, category_id, name, type, topic, position, forum_tags,
  NULL, creator_id, message_count, archived, parent_message_id, last_message_at, created_at
FROM community_channel;

-- One type='dm' channel per DM conversation, reusing the dm id, counting from
-- the (already-repointed) message rows.
INSERT OR IGNORE INTO community_channel_new (
  id, server_id, category_id, name, type, topic, position, forum_tags,
  parent_channel_id, creator_id, message_count, archived, parent_message_id, last_message_at, created_at
)
SELECT dm.id, NULL, NULL, NULL, 'dm', '', 0, NULL, NULL, NULL,
  (SELECT COUNT(*) FROM community_message m WHERE m.channel_id = dm.id),
  0, NULL, dm.last_message_at, dm.created_at
FROM community_dm_conversation dm;

-- Old channel rows are deleted here; the new table's parent_channel_id is all
-- NULL, so this cascade matches nothing (threads/forum_posts survive).
DROP TABLE community_channel;
ALTER TABLE community_channel_new RENAME TO community_channel;

-- Restore parent_channel_id now that the table is stable (plain UPDATE, no
-- drop, no cascade). Parents live in this same table → FK valid at COMMIT.
UPDATE community_channel
  SET parent_channel_id = (SELECT parent_channel_id FROM _channel_parent WHERE _channel_parent.id = community_channel.id)
  WHERE id IN (SELECT id FROM _channel_parent);
DROP TABLE _channel_parent;

CREATE INDEX idx_channel_server_position ON community_channel(server_id, position);
CREATE INDEX idx_channel_server_last_message ON community_channel(server_id, last_message_at);
CREATE INDEX idx_channel_parent ON community_channel(parent_channel_id);
CREATE UNIQUE INDEX idx_channel_parent_message ON community_channel(parent_message_id) WHERE parent_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_community_channel_parent_message
  ON community_channel(parent_channel_id, parent_message_id)
  WHERE parent_channel_id IS NOT NULL AND parent_message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_channel_server_name ON community_channel(server_id, name) WHERE parent_channel_id IS NULL;

-- DM participant access rows.
INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT lower(hex(randomblob(16))), dm.id, dm.user1_id, 'access', 'added', NULL, dm.created_at
FROM community_dm_conversation dm WHERE dm.user1_id IS NOT NULL;
INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT lower(hex(randomblob(16))), dm.id, dm.user2_id, 'access', 'added', NULL, dm.created_at
FROM community_dm_conversation dm WHERE dm.user2_id IS NOT NULL;

-- ============================================================================
-- PHASE 3 — RESTORE: rebuild each staged child into FINAL shape with the real
-- FK re-attached, top-down so each staged DROP cascades to nothing.
-- ============================================================================

-- 3a. community_message final (channel_id NOT NULL, FK→channel).
CREATE TABLE community_message_new (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'default',
  mention_type TEXT,
  reply_to_id TEXT,
  embeds TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  friendship_id TEXT REFERENCES community_friendship(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
INSERT INTO community_message_new SELECT id, channel_id, author_id, content, type, mention_type, reply_to_id, embeds, seq, friendship_id, created_at FROM community_message;

-- Per-channel row-count guard: ABORT if any pre-rebuild channel lost messages.
CREATE TABLE _msg_guard (dummy INTEGER);
CREATE TRIGGER _msg_guard_trg BEFORE INSERT ON _msg_guard
WHEN EXISTS (
  SELECT 1 FROM _msg_count_by_channel b
  LEFT JOIN (SELECT channel_id, COUNT(*) n FROM community_message_new GROUP BY channel_id) a
    ON a.channel_id = b.channel_id
  WHERE COALESCE(a.n,0) <> b.n
)
BEGIN SELECT RAISE(ABORT, 'community_message per-channel row loss'); END;
INSERT INTO _msg_guard VALUES (1);
DROP TRIGGER _msg_guard_trg;
DROP TABLE _msg_guard;
DROP TABLE _msg_count_by_channel;

DROP TABLE community_message;
ALTER TABLE community_message_new RENAME TO community_message;
CREATE INDEX idx_message_channel_created ON community_message(channel_id, created_at);
CREATE INDEX idx_message_channel_mention_created ON community_message(channel_id, mention_type, created_at);
CREATE UNIQUE INDEX uq_community_message_channel_seq ON community_message(channel_id, seq) WHERE seq > 0;
CREATE INDEX idx_message_friendship ON community_message(friendship_id) WHERE friendship_id IS NOT NULL;

-- 3b. channel-children final (FK→channel).
CREATE TABLE community_read_state_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  last_read_message_id TEXT,
  last_read_seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO community_read_state_new SELECT id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq FROM community_read_state;
DROP TABLE community_read_state;
ALTER TABLE community_read_state_new RENAME TO community_read_state;
CREATE INDEX idx_read_state_user ON community_read_state(user_id);
CREATE UNIQUE INDEX idx_read_state_user_channel ON community_read_state(user_id, channel_id);

CREATE TABLE community_channel_member_new (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'access',
  source TEXT NOT NULL DEFAULT 'added',
  added_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL
);
INSERT INTO community_channel_member_new SELECT id, channel_id, user_id, relation, source, added_by, added_at FROM community_channel_member;
DROP TABLE community_channel_member;
ALTER TABLE community_channel_member_new RENAME TO community_channel_member;
CREATE UNIQUE INDEX uq_channel_member ON community_channel_member(channel_id, user_id, relation);
CREATE INDEX idx_channel_member_user ON community_channel_member(user_id);

CREATE TABLE community_notification_setting_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'all',
  CHECK ((server_id IS NOT NULL AND channel_id IS NULL) OR (server_id IS NULL AND channel_id IS NOT NULL))
);
INSERT INTO community_notification_setting_new SELECT id, user_id, server_id, channel_id, level FROM community_notification_setting;
DROP TABLE community_notification_setting;
ALTER TABLE community_notification_setting_new RENAME TO community_notification_setting;
CREATE INDEX idx_notification_setting_user ON community_notification_setting(user_id);
CREATE UNIQUE INDEX idx_notification_setting_user_server ON community_notification_setting(user_id, server_id) WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX idx_notification_setting_user_channel ON community_notification_setting(user_id, channel_id) WHERE channel_id IS NOT NULL;

-- 3c. message-children final (FK→message). pin has dual FK (channel+message).
CREATE TABLE community_reaction_new (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);
INSERT INTO community_reaction_new SELECT id, message_id, user_id, emoji, created_at FROM community_reaction;
DROP TABLE community_reaction;
ALTER TABLE community_reaction_new RENAME TO community_reaction;
CREATE INDEX idx_reaction_message ON community_reaction(message_id);

CREATE TABLE community_mention_new (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  read INTEGER DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'mention'
);
INSERT INTO community_mention_new SELECT id, message_id, user_id, read, kind FROM community_mention;
DROP TABLE community_mention;
ALTER TABLE community_mention_new RENAME TO community_mention;
CREATE INDEX idx_mention_user_read ON community_mention(user_id, read);
CREATE INDEX idx_mention_message ON community_mention(message_id);

CREATE TABLE community_pin_new (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  pinned_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id, message_id)
);
INSERT INTO community_pin_new SELECT id, channel_id, message_id, pinned_by, created_at FROM community_pin;
DROP TABLE community_pin;
ALTER TABLE community_pin_new RENAME TO community_pin;
CREATE INDEX idx_pin_channel ON community_pin(channel_id);

CREATE TABLE community_bot_approval_request_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  dm_message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
INSERT INTO community_bot_approval_request_new SELECT id, bot_id, kind, server_id, requested_by_user_id, dm_message_id, status, created_at, resolved_at FROM community_bot_approval_request;
DROP TABLE community_bot_approval_request;
ALTER TABLE community_bot_approval_request_new RENAME TO community_bot_approval_request;
CREATE UNIQUE INDEX uq_community_bot_approval_pending_join ON community_bot_approval_request(bot_id, server_id) WHERE kind = 'join_server' AND status = 'pending';
CREATE UNIQUE INDEX uq_community_bot_approval_pending_friend ON community_bot_approval_request(bot_id, requested_by_user_id) WHERE kind = 'friend' AND status = 'pending';
CREATE INDEX idx_community_bot_approval_bot ON community_bot_approval_request(bot_id, status);
