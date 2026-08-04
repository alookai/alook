-- Forum-post slug uniqueness + display-title capture (forum createPost, trait
-- model B4b). Pairs with the B4a-core pure-create collision policy: the
-- bump-retry loop's race-safety DEPENDS on this partial unique index catching a
-- concurrent duplicate slug — without it a race silently double-inserts. So this
-- migration and the B4a create code MUST ship together (ship-order constraint).
--
-- A forum post is a `forum_post` child channel addressed by a NAME ANCHOR
-- `/server/<forum>/<post-slug>`. That anchor only resolves if the slug (`name`)
-- is unique WITHIN its parent forum: two posts sharing a slug make
-- resolve-by-name ambiguous and read/send/ack on the post 400.
--
-- Scope: `type='forum_post'` ONLY, NOT a blanket (parent_channel_id, name) unique
-- over all children. A THREAD is also a child channel, but a thread's name is
-- auto-derived from its root message (display-only) and threads address by
-- `parent_message_id` (uq_community_channel_parent_message, 0052) — never by name
-- — so duplicate thread names are legal and a blanket unique would wrongly reject
-- them. Uniqueness belongs only on the type that addresses by name.
--
-- Case-sensitive (plain `name`, no COLLATE NOCASE): the forum-post resolver and
-- dedupe (getChildChannelByName / dedupeChildChannelSlug) compare names with a
-- plain `eq`, so the DB ruler must fold identically or it drifts from resolution
-- — the same index/resolver alignment migration 0075 established for top-level
-- names (there both NOCASE; here both case-sensitive). Consistency with the
-- resolver is the invariant, not the fold.
--
-- APPLY PREREQUISITE: zero duplicate (parent_channel_id, name) among forum_post
-- rows. Verified clean against live remote D1 on 2026-08-04 (Gener's online scan:
-- 0 duplicate slugs), so the index builds directly — no dedup pre-step needed.
-- Re-scan before applying to any OTHER environment:
--   SELECT parent_channel_id, name, COUNT(*) c FROM community_channel
--   WHERE type='forum_post' GROUP BY parent_channel_id, name HAVING c > 1;
-- and resolve any collision by RENAME (a forum_post row owns its post's messages,
-- so never delete) before this index will build.

-- 1. Display-only original title, captured pre-slugify at create time. Nullable;
--    only forum_post CREATE writes it (createForumPost). Never an addressing
--    axis — no index, duplicates legal, does not participate in slug dedupe.
--    Existing rows stay NULL.
ALTER TABLE community_channel ADD COLUMN display_title TEXT;

-- 2. Per-forum unique slug, forum_post only — the address anchor's uniqueness,
--    and what makes pure-create's bump-retry race-safe.
CREATE UNIQUE INDEX idx_forum_post_parent_name
  ON community_channel(parent_channel_id, name)
  WHERE type = 'forum_post';
