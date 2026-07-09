-- Migration: Merge community_thread into community_channel
-- Threads and forum posts become child channels

-- Step 1: Add new columns to community_channel
ALTER TABLE community_channel ADD COLUMN parent_channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE;
ALTER TABLE community_channel ADD COLUMN creator_id TEXT REFERENCES user(id) ON DELETE SET NULL;
ALTER TABLE community_channel ADD COLUMN message_count INTEGER DEFAULT 0;
ALTER TABLE community_channel ADD COLUMN archived INTEGER DEFAULT 0;
ALTER TABLE community_channel ADD COLUMN parent_message_id TEXT;

-- Step 2: Migrate thread data into channels
INSERT INTO community_channel (
  id,
  server_id,
  name,
  type,
  parent_channel_id,
  creator_id,
  message_count,
  archived,
  parent_message_id,
  last_message_at,
  created_at,
  topic,
  position,
  category_id,
  forum_tags
)
SELECT
  t.id,
  c.server_id,
  t.name,
  t.kind,
  t.channel_id,
  t.creator_id,
  t.message_count,
  t.archived,
  t.parent_message_id,
  t.last_message_at,
  t.created_at,
  '', -- topic (default empty)
  0, -- position (child channels don't use position)
  NULL, -- category_id (child channels don't have categories)
  t.tags -- forum_tags (preserved from thread tags)
FROM community_thread t
JOIN community_channel c ON c.id = t.channel_id;

-- Step 3: Recreate community_message without thread_id, migrating data in-place
-- Use COALESCE(channel_id, thread_id) to unify into channel_id without triggering old CHECK
CREATE TABLE community_message_new (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'default',
  mention_type TEXT,
  reply_to_id TEXT,
  embeds TEXT,
  flags INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
  dm_conversation_id TEXT REFERENCES community_dm_conversation(id) ON DELETE CASCADE,
  CHECK (
    (channel_id IS NOT NULL AND dm_conversation_id IS NULL) OR
    (channel_id IS NULL AND dm_conversation_id IS NOT NULL)
  )
);

INSERT INTO community_message_new (
  id, author_id, content, type, mention_type, reply_to_id,
  embeds, flags, created_at, channel_id, dm_conversation_id
)
SELECT
  id, author_id, content, type, mention_type, reply_to_id,
  embeds, flags, created_at, COALESCE(channel_id, thread_id), dm_conversation_id
FROM community_message;

DROP TABLE community_message;
ALTER TABLE community_message_new RENAME TO community_message;

CREATE INDEX idx_message_channel_created ON community_message(channel_id, created_at);
CREATE INDEX idx_message_channel_mention_created ON community_message(channel_id, mention_type, created_at);
CREATE INDEX idx_message_dm_created ON community_message(dm_conversation_id, created_at);

-- Step 4: Recreate community_read_state without thread_id
CREATE TABLE community_read_state_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
  dm_conversation_id TEXT REFERENCES community_dm_conversation(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  last_read_message_id TEXT,
  CHECK (
    (channel_id IS NOT NULL AND dm_conversation_id IS NULL) OR
    (channel_id IS NULL AND dm_conversation_id IS NOT NULL)
  )
);

INSERT INTO community_read_state_new (
  id, user_id, channel_id, dm_conversation_id, last_read_at, last_read_message_id
)
SELECT
  id, user_id, COALESCE(channel_id, thread_id), dm_conversation_id, last_read_at, last_read_message_id
FROM community_read_state;

DROP TABLE community_read_state;
ALTER TABLE community_read_state_new RENAME TO community_read_state;

CREATE INDEX idx_read_state_user ON community_read_state(user_id);
CREATE UNIQUE INDEX idx_read_state_user_channel ON community_read_state(user_id, channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX idx_read_state_user_dm ON community_read_state(user_id, dm_conversation_id) WHERE dm_conversation_id IS NOT NULL;

-- Step 7: Drop community_thread table
DROP TABLE community_thread;

-- Step 8: Add new indexes to community_channel
CREATE INDEX idx_channel_parent ON community_channel(parent_channel_id);
CREATE UNIQUE INDEX idx_channel_parent_message ON community_channel(parent_message_id) WHERE parent_message_id IS NOT NULL;

-- Step 9: Add creator_id to community_category
ALTER TABLE community_category ADD COLUMN creator_id TEXT REFERENCES user(id) ON DELETE SET NULL;
