-- Community bots — first-class community identities owned by users, bound to
-- a paired machine + runtime. See plans/community-bots.md.

-- 1. Extend user with bot fields.
--    isBot / ownerUserId are internal columns (never exposed to non-owners).
--    deletedAt is the tombstone marker for BOTH bots and humans.
ALTER TABLE user ADD COLUMN isBot INTEGER NOT NULL DEFAULT 0;
-- Self-referencing FK on ADD COLUMN is tolerated by SQLite; ON DELETE clause
-- defaults to NO ACTION so the DB refuses to delete an owner with live bots.
-- Any future user-delete path MUST call assertNoLiveBots to fail early.
ALTER TABLE user ADD COLUMN ownerUserId TEXT REFERENCES user(id);
ALTER TABLE user ADD COLUMN deletedAt TEXT;
CREATE INDEX idx_user_ownerUserId_isBot ON user(ownerUserId, isBot);

-- 2. community_bot_binding — one row per live bot; ties the bot user to a
--    machine and runtime. machine_id RESTRICT so a raw machine delete errors
--    while bots exist.
CREATE TABLE community_bot_binding (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES community_machine(id) ON DELETE RESTRICT,
  runtime TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_community_bot_binding_machine ON community_bot_binding(machine_id);

-- 3. community_bot_approval_request — DM-anchored approval workflow. Owner
--    sees these in their DM with the bot; they render as approve/deny cards.
CREATE TABLE community_bot_approval_request (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- "join_server" | "friend"
  server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  dm_message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- "pending" | "approved" | "denied"
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
-- Partial unique — at most one pending join_server request per (bot, server).
CREATE UNIQUE INDEX uq_community_bot_approval_pending_join
  ON community_bot_approval_request(bot_id, server_id)
  WHERE kind = 'join_server' AND status = 'pending';
-- Partial unique — at most one pending friend request per (bot, requester).
CREATE UNIQUE INDEX uq_community_bot_approval_pending_friend
  ON community_bot_approval_request(bot_id, requested_by_user_id)
  WHERE kind = 'friend' AND status = 'pending';
CREATE INDEX idx_community_bot_approval_bot
  ON community_bot_approval_request(bot_id, status);

-- 4. Runner-key correctness fixes.
--    a) Dedupe existing live rows before creating the partial unique index.
--       Keep the earliest (min created_at, ties broken by min id); revoke the
--       rest so the unique index can be created without conflict.
UPDATE community_agent_runner_key AS victim
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE victim.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM community_agent_runner_key AS earlier
    WHERE earlier.machine_id = victim.machine_id
      AND earlier.agent_id = victim.agent_id
      AND earlier.revoked_at IS NULL
      AND (
        earlier.created_at < victim.created_at
        OR (earlier.created_at = victim.created_at AND earlier.id < victim.id)
      )
  );
-- b) Partial unique on (machine, agent) among live rows.
CREATE UNIQUE INDEX uq_community_agent_runner_key_machine_agent_active
  ON community_agent_runner_key(machine_id, agent_id)
  WHERE revoked_at IS NULL;

-- 5. Relax community_audit_log.server_id to nullable so bot-lifecycle events
--    (created/updated/deleted, friend request/approve/deny) — which have no
--    server scope — can be recorded without violating the FK. Existing
--    server-scoped rows are unchanged. SQLite ALTER COLUMN is only available
--    via table rebuild.
CREATE TABLE community_audit_log__new (
  id TEXT PRIMARY KEY,
  server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  changes TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO community_audit_log__new
  (id, server_id, actor_id, action, target_type, target_id, changes, reason, created_at)
  SELECT id, server_id, actor_id, action, target_type, target_id, changes, reason, created_at
  FROM community_audit_log;
DROP TABLE community_audit_log;
ALTER TABLE community_audit_log__new RENAME TO community_audit_log;
CREATE INDEX idx_audit_log_server_created ON community_audit_log(server_id, created_at);
CREATE INDEX idx_audit_log_server_action ON community_audit_log(server_id, action);
-- User-scoped index for bot-lifecycle rows (server_id IS NULL).
CREATE INDEX idx_audit_log_actor_created ON community_audit_log(actor_id, created_at);
