-- Migration: add `kind` to community_mention so we can separate reply-mentions
-- from explicit @-mentions in the inbox UI.
ALTER TABLE community_mention ADD COLUMN kind TEXT NOT NULL DEFAULT 'mention';
