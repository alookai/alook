ALTER TABLE channel ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE channel SET position = (
  SELECT COUNT(*) FROM channel AS c2
  WHERE c2.workspace_id = channel.workspace_id
    AND c2.created_at < channel.created_at
);
