-- Case-insensitive top-level channel names (ref/id §4 + chore #52-59). The
-- per-server unique index on `(server_id, name)` was case-SENSITIVE, so
-- `general` and `General` were two addressable channels and a ref that only
-- differed in case 404'd. Rebuild it with `COLLATE NOCASE` so the DB uniqueness
-- ruler matches the case-insensitive name resolution + dedup (all three now
-- share SQLite's NOCASE fold — see resolveChannelByNameForMember /
-- getChildChannelByName / resolveServerByNameForMember / dedupeChildChannelSlug,
-- which use `COLLATE NOCASE` in SQL rather than a JS fold that could drift).
--
-- APPLY PREREQUISITE: zero case-collisions under the NOCASE fold — i.e. no two
-- top-level channels in the same server whose names differ only by case.
-- Verified against the live remote D1 on 2026-07-31 (Gener's online scan: 0
-- rows). If applying to ANY OTHER environment, re-scan first:
--   SELECT server_id, LOWER(name), COUNT(*) FROM community_channel
--   WHERE parent_channel_id IS NULL GROUP BY server_id, LOWER(name) HAVING COUNT(*) > 1;
-- and resolve collisions (rename/merge) before this index will build.
--
-- Known scope (path A): SQLite NOCASE folds ASCII A-Z only, so non-ASCII case
-- (e.g. `Café`/`café`) is NOT folded — treated as distinct, CONSISTENTLY across
-- index + resolve + dedup (consistency is the invariant; folding non-ASCII is a
-- follow-up requiring an app-layer Unicode fold + folded column, out of scope).

DROP INDEX IF EXISTS idx_channel_server_name;
CREATE UNIQUE INDEX idx_channel_server_name
  ON community_channel(server_id, name COLLATE NOCASE)
  WHERE parent_channel_id IS NULL;
