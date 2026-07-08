-- lastReadSeq on community_read_state — shared per-user cursor for humans
-- and bots (bots ARE users invariant). Only the agent `ack` route and the
-- author read-watermark upsert inside createMessage populate this; existing
-- human-only read routes (mark-all-read, thread read, DM read) intentionally
-- do not maintain it — see plans/community-agent-cli-bridge.md design §4.
ALTER TABLE community_read_state ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0;
