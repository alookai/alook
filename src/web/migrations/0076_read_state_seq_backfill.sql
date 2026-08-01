-- Read-model seq unification (ref/id §3.4b read-state seq). The inbox unread
-- predicate switched from the createdAt timestamp compare
-- (`channel.lastMessageAt > read_state.last_read_at`) to a seq compare
-- (`EXISTS(message.seq > read_state.last_read_seq)`) — the SAME ruler the agent
-- inbox already uses — collapsing the bot(seq)/human(createdAt) two-cursor drift
-- onto one. `last_read_seq` already exists (default 0, migration 0053) and was
-- maintained only by createMessage's author watermark + agent ack; the human
-- read routes (mark-read / mark-all) did NOT write it. Those routes now DO, but
-- every EXISTING read-state row written by a human path still carries
-- `last_read_seq = 0` while its `last_read_message_id` points at the real
-- message the user read up to. Under the new predicate a 0 cursor = whole
-- channel unread = mass "zombie" unread. This backfill fixes those rows.
--
-- EXACT, not reset (product red line — migrate, don't reset; already-read stays
-- read): every row's invariant is `last_read_at === getMessage(last_read_message_id).createdAt`
-- and `last_read_message_id` is populated, so the correct seq is a precise join
-- on the message id — no timestamp fuzzing, no "everyone re-reads once".
--
-- Rows the seq-aware writers touched (author watermark / ack) already have a
-- correct `last_read_seq`; the monotone spirit is preserved because we only ever
-- map to the seq of the message the row already points at (never regress).
--
-- IDEMPOTENT: derives `last_read_seq` from the authoritative `last_read_message_id`
-- (which all read writers set unconditionally), so re-running yields the same
-- value. This is why the DEPLOY runs it TWICE — once here, and once AGAIN after
-- the daemon restart — to zero the deploy-window phantom: any human read that
-- lands after the migration but before the new code is live still advances
-- `last_read_message_id` (old code writes it) but not `last_read_seq`; the
-- post-restart re-run maps those freshly-advanced message ids to their seq,
-- eliminating the transient window phantom rather than leaving it to self-heal.
--
-- DEAD-TARGET GUARD (Aigneis/Melly gate-catch): a human historical row can carry
-- `last_read_seq = 0` (never written by the pre-gap-close human paths) AND a
-- `last_read_message_id` pointing at a HARD-DELETED message. hardDelete only
-- reverts the AUTHOR's own read-state row (`user_id = msg.author_id`), so a
-- NON-author reader keeps a dangling pointer. If this backfill only mapped
-- live-target rows and left the dead-target ones at 0, the new predicate
-- `EXISTS(seq > COALESCE(last_read_seq,0))` = `seq > 0` = WHOLE CHANNEL UNREAD =
-- zombie — the exact opposite of "already-read stays read". So the dead/missing
-- target case COALESCEs to the channel's latest seq (`community_message_seq.next_seq`
-- = the most recently issued seq, NOT next_seq-1) — conservatively "all read",
-- satisfying the invariant "result seq >= true read position, never <". A NULL
-- last_read_message_id is excluded by the WHERE (no row exists to map / it takes
-- the no-read-state path); this guard is for a NON-null id whose message is gone.
UPDATE community_read_state
SET last_read_seq = COALESCE(
  (SELECT m.seq FROM community_message m WHERE m.id = community_read_state.last_read_message_id),
  (SELECT s.next_seq FROM community_message_seq s WHERE s.channel_id = community_read_state.channel_id),
  last_read_seq
)
WHERE last_read_message_id IS NOT NULL;
