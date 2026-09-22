ALTER TABLE community_mention
  ADD COLUMN is_explicit INTEGER NOT NULL DEFAULT 0 CHECK (is_explicit IN (0, 1));

-- Before this column existed, every non-broadcast mention row necessarily came
-- from an explicit @handle. A historical @everyone row may also have contained
-- an explicit handle, but that provenance was not persisted and cannot be
-- reconstructed safely after a rename. New writes always persist the exact bit.
UPDATE community_mention
SET is_explicit = 1
WHERE kind = 'mention'
  AND message_id IN (
    SELECT id
    FROM community_message
    WHERE mention_type IS NULL OR mention_type <> 'everyone'
  );
