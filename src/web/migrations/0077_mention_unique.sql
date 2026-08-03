-- Natural idempotency key for community_mention: a message mentions a given
-- user in a given kind AT MOST once. This makes `createMentions` retry-safe
-- (onConflictDoNothing on this key), so a transient replay under `withD1Retry`
-- re-inserts only the missing rows instead of double-inserting — a duplicate
-- mention row would otherwise silently inflate the unread count (list has no
-- distinct; unread counts read=0 rows) and duplicate the inbox entry.
--
-- All three columns are NOT NULL, so a plain UNIQUE index suffices (no partial).
--
-- Self-guarding: the normal send flow calls createMentions once per message, so
-- collisions are not expected — but in case any historical duplicate rows exist
-- (a pre-armor double-insert on a transient), collapse each (message_id,
-- user_id, kind) group to its lowest rowid BEFORE adding the unique, so the
-- migration is safe to apply without a separate precondition step. Keeps the
-- oldest row; drops the accidental duplicates (they carry no distinct state —
-- `read` is per (user, message), reconciled on next read).
DELETE FROM community_mention
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM community_mention
  GROUP BY message_id, user_id, kind
);

CREATE UNIQUE INDEX uq_mention_message_user_kind
  ON community_mention(message_id, user_id, kind);
