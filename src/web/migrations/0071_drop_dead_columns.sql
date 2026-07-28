-- Community schema unification (5/5): drop dead columns.
-- See plans/community-schema-unification.md.
--
-- community_server_member.nickname — scaffolded, never written (uniformly NULL);
-- display/search/self-rename resolve against user.name.
-- community_attachment.kind — the R2 routing kind lives in buildMediaKey, not
-- this column; the DB column is redundant. The pending-lookup index drops kind
-- from its tuple.

PRAGMA defer_foreign_keys=ON;

-- 1. Rebuild community_server_member without nickname.
CREATE TABLE community_server_member_new (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  rail_order INTEGER DEFAULT 0,
  joined_at TEXT NOT NULL
);

INSERT INTO community_server_member_new (id, server_id, user_id, role, rail_order, joined_at)
SELECT id, server_id, user_id, role, rail_order, joined_at
FROM community_server_member;

DROP TABLE community_server_member;
ALTER TABLE community_server_member_new RENAME TO community_server_member;

CREATE UNIQUE INDEX uq_server_member_server_user ON community_server_member(server_id, user_id);
CREATE INDEX idx_server_member_user ON community_server_member(user_id);
CREATE INDEX idx_server_member_user_rail_order ON community_server_member(user_id, rail_order);
CREATE INDEX idx_server_member_server_joined ON community_server_member(server_id, joined_at);

-- 2. Rebuild community_attachment without kind.
CREATE TABLE community_attachment_new (
  id            TEXT PRIMARY KEY,
  message_id    TEXT REFERENCES community_message(id) ON DELETE CASCADE,
  uploader_id   TEXT NOT NULL,
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

INSERT INTO community_attachment_new (
  id, message_id, uploader_id, target_id, r2_key,
  filename, content_type, size, width, height, position, created_at
)
SELECT
  id, message_id, uploader_id, target_id, r2_key,
  filename, content_type, size, width, height, position, created_at
FROM community_attachment;

DROP TABLE community_attachment;
ALTER TABLE community_attachment_new RENAME TO community_attachment;

CREATE INDEX idx_attachment_message ON community_attachment(message_id, position);
CREATE INDEX idx_attachment_pending_uploader
  ON community_attachment(uploader_id, target_id)
  WHERE message_id IS NULL;
