-- Per-channel membership for PRIVATE-category channels.
-- See plans/channel-category-role-permissions.md.
--
-- Rows exist ONLY for channels in private categories (creator + directly-added
-- members). Public/uncategorized channels imply access via server membership;
-- threads inherit their parent channel's audience and never get their own rows.
-- Not yet deployed → no backfill; new visibility rules apply going forward.

CREATE TABLE community_channel_member (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL
);

-- One membership row per (channel, user).
CREATE UNIQUE INDEX uq_channel_member ON community_channel_member(channel_id, user_id);

-- Reverse lookup: which private channels a user belongs to (viewer-scoped tree).
CREATE INDEX idx_channel_member_user ON community_channel_member(user_id);
