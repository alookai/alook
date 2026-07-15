-- Thread participant / notification set.
-- See plans/nested-membership-model.md (Phase C).
--
-- A thread (community_channel row of type "thread") is the NOTIFICATION
-- dimension, not access: any member of its parent channel can READ it. This
-- table records who gets NOTIFIED (mention pings + inbox unread) for new thread
-- activity. `source` = how they joined (mention | spoke | added). Admins are
-- NOT auto-added. Muting a thread is the outer channel-header notification
-- level (per-layer), NOT a column here — participation is add/leave only.

CREATE TABLE community_thread_participant (
  id TEXT PRIMARY KEY,
  thread_channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'mention',
  added_at TEXT NOT NULL
);

-- One participant row per (thread, user).
CREATE UNIQUE INDEX uq_thread_participant ON community_thread_participant(thread_channel_id, user_id);

-- Reverse lookup: which threads a user participates in (inbox unread scoping).
CREATE INDEX idx_thread_participant_user ON community_thread_participant(user_id);
