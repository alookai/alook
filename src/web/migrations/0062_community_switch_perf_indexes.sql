-- Perf: two indexes on the community server-switch path.
-- See plans/community-switch-perf-optimization.md (WS4).
--
-- Both tables are small today, so the immediate win is marginal — this is
-- correctness insurance as membership/invite counts grow. Idempotent.

-- 1. `listServerInvites` (invite.ts) filters WHERE server_id with only a PK and
--    the token UNIQUE, so it currently full-scans the invite table.
CREATE INDEX IF NOT EXISTS idx_server_invite_server
  ON community_server_invite(server_id);

-- 2. `listMembersPaginated` (member.ts) does WHERE server_id ORDER BY (joined_at,
--    id). The (server_id, user_id) unique serves the equality filter but not the
--    sort, so the members page is a filesort. This composite serves both.
CREATE INDEX IF NOT EXISTS idx_server_member_server_joined
  ON community_server_member(server_id, joined_at);
