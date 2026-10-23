CREATE TABLE community_bot_creation_request (
  id TEXT PRIMARY KEY NOT NULL,
  requester_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES community_message(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  bots TEXT NOT NULL CHECK (json_valid(bots)),
  decision_nonce TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_bot_creation_requester ON community_bot_creation_request(requester_id, created_at);
CREATE INDEX idx_bot_creation_owner ON community_bot_creation_request(owner_id, created_at);
