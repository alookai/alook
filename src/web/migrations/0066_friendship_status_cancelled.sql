-- Widen community_friendship.status to allow 'cancelled'. See
-- plans/friend-cancel-card-cleanup.md.
--
-- A requester withdrawing a still-pending request soft-cancels the row
-- (status='cancelled') instead of hard-deleting it, so a gating owner's
-- approval card rehydrates to a non-actionable "cancelled" chip rather than
-- pointing at a deleted row. 'cancelled' is terminal (sets resolvedAt),
-- distinct from 'superseded' (replaced by a newer request).
--
-- SQLite can't ALTER a CHECK constraint, so community_friendship is
-- recreated-and-swapped (same shape as migration 0065, only the CHECK widens).
-- The swap drops every attached index, so all three are recreated below.
-- community_message.friendship_id references this table by name; the RENAME
-- keeps that FK resolving. `PRAGMA defer_foreign_keys=ON` keeps FKs from firing
-- mid-swap (the whole file runs as one D1 batch transaction).

PRAGMA defer_foreign_keys=ON;

-- 1. Recreate-and-swap with the widened status CHECK.
CREATE TABLE community_friendship_new (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','blocked','denied','superseded','cancelled')),
  needs_owner_approval TEXT REFERENCES user(id),
  blocker_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
INSERT INTO community_friendship_new
  (id, requester_id, addressee_id, status, needs_owner_approval, blocker_id, created_at, updated_at, resolved_at)
  SELECT id, requester_id, addressee_id, status, needs_owner_approval, blocker_id, created_at, updated_at, resolved_at
  FROM community_friendship;
DROP TABLE community_friendship;
ALTER TABLE community_friendship_new RENAME TO community_friendship;

-- 2. Recreate the indexes the swap dropped (identical to 0065).
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
