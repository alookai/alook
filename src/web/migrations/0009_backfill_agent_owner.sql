-- Backfill agent.owner_id for existing agents that have NULL owner_id.
-- Sets it to the workspace owner (member with role = 'owner').
-- This is required because getAgent now filters by visibility/access control,
-- and agents with NULL owner_id + private visibility would be invisible.
UPDATE agent
SET owner_id = (
  SELECT m.user_id FROM member m
  WHERE m.workspace_id = agent.workspace_id AND m.role = 'owner'
  LIMIT 1
)
WHERE agent.owner_id IS NULL;
