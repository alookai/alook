-- Post tags, migrated off the per-channel `community_channel.forum_tags` JSON
-- column onto a proper per-message table (phase2 forum≡thread, Gener #768 —
-- locked shape, not open). A post is now just a message (its opener) that
-- happens to have opened a thread; tags describe the CONTENT of that message,
-- not the channel/thread it lives in (Aigneis #696: a thread can be opened by
-- any message, so a channel/thread-level tags column would leak a tagging
-- capability onto every thread, not just posts — the field's mere presence on
-- a message row IS the "is this a tagged post" signal, no extra branch needed).
--
-- Existing `community_channel.forum_tags` JSON values get backfilled here at
-- the existing-data migration step (0082+) once the create/read paths this
-- table serves are live end-to-end; this migration is schema-only, no data
-- movement (new-door∥old-door discipline — old column stays untouched and
-- readable until the backfill + verification completes).
CREATE TABLE community_message_tag (
  id         TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL
);

-- Toggle idempotency: adding a tag already present is a no-op, not a
-- duplicate row (mirrors community_message_mark's uq_mark_user_message).
CREATE UNIQUE INDEX uq_message_tag ON community_message_tag(message_id, tag);

-- Tag-first (per Blondie's #271 ruling): the read pattern is "find messages
-- with tag X" (the forum ?tag= filter), not "find tags for message X" — the
-- filter is always applied on top of an already-resolved, membership-gated
-- channel's message set (Aigneis #646/#647 red-line: never a bare cross-
-- channel tag search — that would hand a bot an existence-probe, "which
-- channels have this tag").
CREATE INDEX idx_message_tag_tag ON community_message_tag(tag, message_id);
