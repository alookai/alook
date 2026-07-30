-- My-bots "last refresh-context" indicator (Gus request): surface on each bot
-- how long ago it last refreshed its context. A "refresh context" is either a
-- self-initiated `nap` or an owner-triggered `session_reset` — both reset the
-- agent's working context, so they share one unified timestamp.
--
-- Written at the SAME chokepoint that records the nap/session_reset audit event
-- (the delivery-confirmed moment), and NOWHERE else — a single write point makes
-- it a monotonic historical-fact timestamp that can never drift from the audit
-- log or the live FSM state (it does not reflect FSM state; it records that a
-- refresh happened). NULL = the bot has never napped/reset.
--
-- On the bot's `user` row (a bot is a `user` with isBot=true), so the existing
-- owner-scoped bot list carries it with no extra join.

ALTER TABLE user ADD COLUMN lastRefreshContextAt TEXT;

-- Companion counter: how many messages the agent has HANDLED within the current
-- context (this nap/reset lifecycle). Incremented once per message that
-- actually triggered a wake (folded into the existing per-message wake_trigger
-- write, post-gate — so gate-filtered messages the agent never woke for are NOT
-- counted, matching the "how many did it handle" intent). Reset to 0 at the
-- same nap/session_reset chokepoint that stamps lastRefreshContextAt.
ALTER TABLE user ADD COLUMN handledMessageCount INTEGER NOT NULL DEFAULT 0;
