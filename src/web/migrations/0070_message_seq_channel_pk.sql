-- Community schema unification (4/5): reseat the seq allocator on channel_id.
-- See plans/community-schema-unification.md.
--
-- community_message_seq drops the 'channel:<id>' / 'dm:<id>' scope_key string
-- PK for a channel_id PK (now one scope). Backfill strips the prefix from the
-- old key — both channel: and dm: rows map to a channel id.
--
-- The old table had NO FK, so orphan rows (channel:<deleted-id>) can exist.
-- The new channel_id FK would abort the whole batch at commit on a backfilled
-- orphan, so the backfill filters to LIVE channels. INSERT OR IGNORE alone
-- would dedupe but not drop orphans.

PRAGMA defer_foreign_keys=ON;

CREATE TABLE community_message_seq_new (
  channel_id TEXT PRIMARY KEY REFERENCES community_channel(id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL
);

INSERT OR IGNORE INTO community_message_seq_new (channel_id, next_seq)
SELECT
  SUBSTR(scope_key, INSTR(scope_key, ':') + 1),
  next_seq
FROM community_message_seq
WHERE SUBSTR(scope_key, INSTR(scope_key, ':') + 1) IN (SELECT id FROM community_channel);

DROP TABLE community_message_seq;
ALTER TABLE community_message_seq_new RENAME TO community_message_seq;
