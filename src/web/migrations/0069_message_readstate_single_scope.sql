-- CANDIDATE FIX (3/5): message + read_state were rebuilt in 0068 (folded there
-- to keep the cascade-safe strip/restore in one place). This file now only
-- drops the tables that 0068 made orphaned.
PRAGMA defer_foreign_keys=ON;

-- community_dm_conversation: after 0068, message.channel_id and
-- read_state.channel_id no longer reference it; nothing else does either.
DROP TABLE community_dm_conversation;

-- Dead FTS table (triggers died with 0045; search uses LIKE, not MATCH).
DROP TABLE IF EXISTS community_message_fts;
