-- community_server
CREATE TABLE community_server (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

-- community_category
CREATE TABLE community_category (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  private INTEGER DEFAULT 0,
  UNIQUE(server_id, name)
);

-- community_channel
CREATE TABLE community_channel (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES community_category(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  topic TEXT DEFAULT '',
  position INTEGER DEFAULT 0,
  forum_tags TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_channel_server_position ON community_channel(server_id, position);
CREATE INDEX idx_channel_server_last_message ON community_channel(server_id, last_message_at);

-- community_dm_conversation
CREATE TABLE community_dm_conversation (
  id TEXT PRIMARY KEY,
  user1_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  user2_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user1_id, user2_id)
);
CREATE INDEX idx_dm_conversation_user1_last_message ON community_dm_conversation(user1_id, last_message_at);
CREATE INDEX idx_dm_conversation_user2_last_message ON community_dm_conversation(user2_id, last_message_at);

-- community_thread
CREATE TABLE community_thread (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  parent_message_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'thread',
  tags TEXT,
  creator_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  archived INTEGER DEFAULT 0,
  last_message_at TEXT,
  message_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(parent_message_id)
);
CREATE INDEX idx_thread_channel_archived_last_message ON community_thread(channel_id, archived, last_message_at);

-- community_message (with CHECK constraint)
CREATE TABLE community_message (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'default',
  mention_type TEXT,
  reply_to_id TEXT,
  thread_id TEXT REFERENCES community_thread(id) ON DELETE CASCADE,
  embeds TEXT,
  flags INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
  dm_conversation_id TEXT REFERENCES community_dm_conversation(id) ON DELETE CASCADE,
  CHECK (
    (channel_id IS NOT NULL AND dm_conversation_id IS NULL AND thread_id IS NULL) OR
    (channel_id IS NULL AND dm_conversation_id IS NOT NULL AND thread_id IS NULL) OR
    (channel_id IS NULL AND dm_conversation_id IS NULL AND thread_id IS NOT NULL)
  )
);
CREATE INDEX idx_message_channel_created ON community_message(channel_id, created_at);
CREATE INDEX idx_message_channel_mention_created ON community_message(channel_id, mention_type, created_at);
CREATE INDEX idx_message_dm_created ON community_message(dm_conversation_id, created_at);
CREATE INDEX idx_message_thread_created ON community_message(thread_id, created_at);

-- community_server_member
CREATE TABLE community_server_member (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  nickname TEXT,
  rail_order INTEGER DEFAULT 0,
  joined_at TEXT NOT NULL,
  UNIQUE(server_id, user_id)
);
CREATE INDEX idx_server_member_user ON community_server_member(user_id);
CREATE INDEX idx_server_member_user_rail_order ON community_server_member(user_id, rail_order);

-- community_server_folder
CREATE TABLE community_server_folder (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER DEFAULT 0
);
CREATE INDEX idx_server_folder_user_position ON community_server_folder(user_id, position);

-- community_server_folder_item (composite PK)
CREATE TABLE community_server_folder_item (
  folder_id TEXT NOT NULL REFERENCES community_server_folder(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  PRIMARY KEY (folder_id, server_id)
);
CREATE INDEX idx_server_folder_item_folder_position ON community_server_folder_item(folder_id, position);

-- community_server_invite
CREATE TABLE community_server_invite (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  max_uses INTEGER,
  uses INTEGER DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- community_friendship
CREATE TABLE community_friendship (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  blocker_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(requester_id, addressee_id)
);
CREATE INDEX idx_friendship_addressee_status ON community_friendship(addressee_id, status);
CREATE INDEX idx_friendship_requester_status ON community_friendship(requester_id, status);

-- community_read_state (with CHECK constraint)
CREATE TABLE community_read_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
  dm_conversation_id TEXT REFERENCES community_dm_conversation(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES community_thread(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  last_read_message_id TEXT,
  CHECK (
    (channel_id IS NOT NULL AND dm_conversation_id IS NULL AND thread_id IS NULL) OR
    (channel_id IS NULL AND dm_conversation_id IS NOT NULL AND thread_id IS NULL) OR
    (channel_id IS NULL AND dm_conversation_id IS NULL AND thread_id IS NOT NULL)
  )
);
CREATE INDEX idx_read_state_user ON community_read_state(user_id);
-- Partial unique indexes for nullable-column uniqueness
CREATE UNIQUE INDEX idx_read_state_user_channel ON community_read_state(user_id, channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX idx_read_state_user_dm ON community_read_state(user_id, dm_conversation_id) WHERE dm_conversation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_read_state_user_thread ON community_read_state(user_id, thread_id) WHERE thread_id IS NOT NULL;

-- community_reaction
CREATE TABLE community_reaction (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX idx_reaction_message ON community_reaction(message_id);

-- community_attachment
CREATE TABLE community_attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachment_message ON community_attachment(message_id);

-- community_pin
CREATE TABLE community_pin (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  pinned_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id, message_id)
);
CREATE INDEX idx_pin_channel ON community_pin(channel_id);

-- community_mention
CREATE TABLE community_mention (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  read INTEGER DEFAULT 0
);
CREATE INDEX idx_mention_user_read ON community_mention(user_id, read);
CREATE INDEX idx_mention_message ON community_mention(message_id);

-- community_user_profile (userId is PK)
CREATE TABLE community_user_profile (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  about_me TEXT DEFAULT '',
  banner_color TEXT
);

-- community_notification_setting (with CHECK constraint)
CREATE TABLE community_notification_setting (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'all',
  CHECK (
    (server_id IS NOT NULL AND channel_id IS NULL) OR
    (server_id IS NULL AND channel_id IS NOT NULL)
  )
);
CREATE INDEX idx_notification_setting_user ON community_notification_setting(user_id);
CREATE UNIQUE INDEX idx_notification_setting_user_server ON community_notification_setting(user_id, server_id) WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX idx_notification_setting_user_channel ON community_notification_setting(user_id, channel_id) WHERE channel_id IS NOT NULL;

-- community_audit_log
CREATE TABLE community_audit_log (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  changes TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_log_server_created ON community_audit_log(server_id, created_at);
CREATE INDEX idx_audit_log_server_action ON community_audit_log(server_id, action);

-- FTS5 virtual table for message search
CREATE VIRTUAL TABLE community_message_fts USING fts5(
  id UNINDEXED,
  channel_id UNINDEXED,
  dm_conversation_id UNINDEXED,
  thread_id UNINDEXED,
  content,
  tokenize='unicode61'
);

-- FTS5 sync triggers
CREATE TRIGGER community_message_fts_insert AFTER INSERT ON community_message BEGIN
  INSERT INTO community_message_fts(id, channel_id, dm_conversation_id, thread_id, content)
  VALUES (new.id, new.channel_id, new.dm_conversation_id, new.thread_id, new.content);
END;

CREATE TRIGGER community_message_fts_update AFTER UPDATE OF content ON community_message BEGIN
  DELETE FROM community_message_fts WHERE id = old.id;
  INSERT INTO community_message_fts(id, channel_id, dm_conversation_id, thread_id, content)
  VALUES (new.id, new.channel_id, new.dm_conversation_id, new.thread_id, new.content);
END;

CREATE TRIGGER community_message_fts_delete AFTER DELETE ON community_message BEGIN
  DELETE FROM community_message_fts WHERE id = old.id;
END;
