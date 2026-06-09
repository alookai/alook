-- Add registration source tracking columns to the user table.
-- Captures where the user came from (UTM params + referrer) at signup time.

ALTER TABLE user ADD COLUMN utm_source TEXT;
ALTER TABLE user ADD COLUMN utm_medium TEXT;
ALTER TABLE user ADD COLUMN utm_campaign TEXT;
ALTER TABLE user ADD COLUMN referrer TEXT;
