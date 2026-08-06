-- phase2 forum≡thread, step 6's real remaining scope (missed when 992c9868
-- deleted forum_post from the type union — Aigneis/Ingaborg caught the gap
-- during the terminal census): drops the two migration-0078 columns +
-- their partial unique index, now that 0082 has migrated every existing
-- forum_post row (and its display_title/forum_tags) into the new
-- message/message_tags model.
--
-- ⚠ DEPLOY ORDERING (not enforced by file-number order alone — see
-- red-line 6): this migration MUST NOT ship in the same deploy window as
-- 0082. It must only run after 0082 has been confirmed applied AND
-- verified in production (e.g. migrated-message-count / migrated-tag-count
-- cross-checked against the pre-migration forum_post/forum_tags counts).
-- Once this runs, display_title/forum_tags are physically gone — there is
-- no rollback path if 0082 turns out to have had a bug that needs a rerun.

-- 1. The partial unique index scoped to `type = 'forum_post'` — a WHERE
--    clause that, after 992c9868, can never match another row again (the
--    type no longer exists in the application's StoredChannelType union).
--    Dead structure, not merely unused.
DROP INDEX IF EXISTS idx_forum_post_parent_name;

-- 2. display_title — the pre-slugify original title, captured only by the
--    now-deleted create-forum-post.ts. 0082 already copied every row's
--    value into its new opener message's content before this point.
ALTER TABLE community_channel DROP COLUMN display_title;

-- 3. forum_tags — the per-channel JSON tag list. 0082 already expanded
--    every row's value into community_message_tag rows before this point.
ALTER TABLE community_channel DROP COLUMN forum_tags;
