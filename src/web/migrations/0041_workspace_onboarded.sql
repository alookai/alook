ALTER TABLE workspace ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0;

-- Mark existing workspaces as onboarded (they were created before this feature)
UPDATE workspace SET onboarded = 1;
