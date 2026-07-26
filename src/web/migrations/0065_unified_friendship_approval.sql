-- Unified friendship approval gate. See plans/agent-friendship-approval-gate.md.
--
-- Folds the `kind='friend'` half of `community_bot_approval_request` into
-- `community_friendship`. Pending vs accepted becomes a column value, not a
-- table split. Two new columns:
--   needsOwnerApproval — whose owner-approval this row currently waits on
--                        (null = no gate / human↔human).
--   resolvedAt         — terminal timestamp for accepted/denied/superseded.
-- `status` gains 'denied' and 'superseded' (both terminal).
--
-- SQLite can't ALTER a CHECK constraint, so `community_friendship` is
-- recreated-and-swapped. The swap drops every attached index, so they're
-- recreated below. `PRAGMA defer_foreign_keys=ON` keeps the FKs from firing
-- mid-swap (the whole file runs as one D1 batch transaction).

PRAGMA defer_foreign_keys=ON;

-- 1. Recreate-and-swap community_friendship with the widened status CHECK plus
--    the two new columns.
CREATE TABLE community_friendship_new (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','blocked','denied','superseded')),
  needs_owner_approval TEXT REFERENCES user(id),
  blocker_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
INSERT INTO community_friendship_new
  (id, requester_id, addressee_id, status, blocker_id, created_at, updated_at)
  SELECT id, requester_id, addressee_id, status, blocker_id, created_at, updated_at
  FROM community_friendship;
DROP TABLE community_friendship;
ALTER TABLE community_friendship_new RENAME TO community_friendship;

-- 2. Recreate indexes on the renamed table. The swap dropped every attached
--    index. `uq_friendship_active` replaces the old direction-sensitive
--    `UNIQUE (requester_id, addressee_id)` with a direction-agnostic partial
--    unique over the unordered pair, scoped to the two live statuses.
CREATE UNIQUE INDEX uq_friendship_active
  ON community_friendship(
    MIN(requester_id, addressee_id),
    MAX(requester_id, addressee_id)
  )
  WHERE status IN ('pending','accepted');
CREATE INDEX idx_friendship_addressee_status
  ON community_friendship(addressee_id, status);
CREATE INDEX idx_friendship_requester_status
  ON community_friendship(requester_id, status);

-- 3. Back-reference on the DM message row so approval cards are self-describing.
--    ON DELETE SET NULL: unfriending hard-deletes the friendship; the card
--    message falls back to its stored text (historical, non-actionable).
ALTER TABLE community_message
  ADD COLUMN friendship_id TEXT REFERENCES community_friendship(id) ON DELETE SET NULL;

-- 4. Index the new FK. Partial (friendship_id IS NOT NULL) — supports the two
--    hot paths (hydrateApprovalsForDmMessages batch join,
--    listMessagesReferencingFriendship fanout) without bloating the ordinary
--    message index set.
CREATE INDEX idx_message_friendship
  ON community_message(friendship_id)
  WHERE friendship_id IS NOT NULL;

-- 5. Backfill the kind='friend' approval rows into community_friendship.
--    Pending: requester=requested_by, addressee=bot, gate on bot owner.
INSERT INTO community_friendship
  (id, requester_id, addressee_id, status, needs_owner_approval, created_at, updated_at)
  SELECT
    'fr_' || bar.id,
    bar.requested_by_user_id,
    bar.bot_id,
    'pending',
    bot.ownerUserId,
    bar.created_at,
    bar.created_at
  FROM community_bot_approval_request AS bar
  INNER JOIN user AS bot ON bot.id = bar.bot_id
  WHERE bar.kind = 'friend' AND bar.status = 'pending';

--    Denied: carry the terminal state + resolved timestamp.
INSERT INTO community_friendship
  (id, requester_id, addressee_id, status, needs_owner_approval, created_at, updated_at, resolved_at)
  SELECT
    'fr_' || bar.id,
    bar.requested_by_user_id,
    bar.bot_id,
    'denied',
    NULL,
    bar.created_at,
    bar.created_at,
    bar.resolved_at
  FROM community_bot_approval_request AS bar
  WHERE bar.kind = 'friend' AND bar.status = 'denied';

--    Stamp the DM card messages with their new friendship id (pending + denied;
--    approved rows already have a real accepted community_friendship row from
--    the old approve-route, so nothing to stamp for those).
UPDATE community_message
  SET friendship_id = (
    SELECT 'fr_' || bar.id
    FROM community_bot_approval_request AS bar
    WHERE bar.dm_message_id = community_message.id
      AND bar.kind = 'friend'
      AND bar.status IN ('pending','denied')
  )
  WHERE id IN (
    SELECT dm_message_id
    FROM community_bot_approval_request
    WHERE kind = 'friend' AND status IN ('pending','denied')
  );

-- 6. Delete the migrated friend approval rows. join_server rows are untouched.
DELETE FROM community_bot_approval_request WHERE kind = 'friend';
