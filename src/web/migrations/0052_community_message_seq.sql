-- Per-channel/DM message sequencing via an atomic counter table.
-- See plans/community-agent-cli-bridge.md design §3.
--
-- `seq` is per-scope (channel or DM), monotonic, unique, but NOT guaranteed
-- gap-free (see design §3 for why a rare gap is an accepted trade-off, not a
-- bug). Existing rows are backfilled to seq = 0, a sentinel excluded from the
-- partial unique indexes below and treated as "not addressable by seq" by
-- the agent API's `resolve`/`read` routes.

-- 1. Counter table. One row per scope; `next_seq` holds the most recently
--    issued value (NOT "the next value to hand out", despite the name —
--    see design §7's `getLatestSeqForScope` note).
CREATE TABLE community_message_seq (
  scope_key TEXT PRIMARY KEY,     -- 'channel:<id>' or 'dm:<id>'
  next_seq INTEGER NOT NULL
);

-- 2. seq column on community_message. Legacy rows default to 0 (sentinel).
ALTER TABLE community_message ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

-- 3. Uniqueness, excluding the legacy seq=0 sentinel.
CREATE UNIQUE INDEX uq_community_message_channel_seq
  ON community_message(channel_id, seq)
  WHERE channel_id IS NOT NULL AND seq > 0;

CREATE UNIQUE INDEX uq_community_message_dm_seq
  ON community_message(dm_conversation_id, seq)
  WHERE dm_conversation_id IS NOT NULL AND seq > 0;

-- 4. Prevents concurrent thread auto-create (resolve-ref.ts) from racing to
--    insert two thread channel rows for the same parent message.
CREATE UNIQUE INDEX uq_community_channel_parent_message
  ON community_channel(parent_channel_id, parent_message_id)
  WHERE parent_channel_id IS NOT NULL AND parent_message_id IS NOT NULL;
