-- Backfill: give existing forum POSTS their own member roster.
-- See plans/nested-membership-model.md (Phase D).
--
-- Before the nested-membership model, a forum_post inherited its forum's
-- audience. Now a post owns its roster. Without this backfill, existing posts
-- under a private forum would have an empty roster → their members lose access
-- on deploy. Copy the FORUM's explicit community_channel_member rows onto each
-- child post.
--
-- IMPORTANT: copy only the forum's EXPLICIT member rows — NOT the resolved
-- audience (which would include server admins/creator). Admins/creator are
-- re-derived at query time; storing them as explicit post rows would make them
-- removable and mis-sourced.
--
-- Idempotent: INSERT OR IGNORE against the uq_channel_member unique index, so
-- re-running (or a post that already has some rows) is a no-op for existing
-- pairs. `hex(randomblob(16))` generates a fresh row id per copied membership.

INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, added_by, added_at)
SELECT
  lower(hex(randomblob(16))),
  post.id,
  fm.user_id,
  fm.added_by,
  fm.added_at
FROM community_channel AS post
JOIN community_channel AS forum ON forum.id = post.parent_channel_id
JOIN community_category AS cat ON cat.id = forum.category_id AND cat.private = 1
JOIN community_channel_member AS fm ON fm.channel_id = forum.id
WHERE post.type = 'forum_post';
