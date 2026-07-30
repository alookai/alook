-- Mutation-idempotency (plans/mutation-idempotency.md): give community_message
-- a client-supplied idempotency key so a resend of the SAME logical message
-- (retry over a response-losing gateway) is deduped server-side instead of
-- inserting a duplicate row.
--
-- A logical send generates one `client_nonce` and reuses it across retries.
-- The server dedupes on (author_id, client_nonce) BEFORE claiming a seq, so a
-- deduped resend returns the first row (no new seq, no duplicate WS fan-out).
-- NULL nonce = legacy / no-nonce send = today's behavior (never deduped),
-- which is why the unique index is PARTIAL (only enforced when non-null).

ALTER TABLE community_message ADD COLUMN client_nonce TEXT;

-- Partial unique index: at most one message per (author, nonce). Only rows
-- WITH a nonce are constrained — legacy/null-nonce rows are unaffected and can
-- coexist freely. This is the actual dedup backstop the onConflict relies on.
CREATE UNIQUE INDEX uq_message_author_client_nonce
  ON community_message(author_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
