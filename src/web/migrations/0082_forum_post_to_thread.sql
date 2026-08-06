-- phase2 forum≡thread, step5: migrate every existing forum_post channel into
-- "a message in its forum + a thread opened on that message" — the exact
-- shape the send-into-forum path (step3) produces going forward. A
-- forum_post's `display_title` becomes the content of a brand-new opener
-- message landing in the forum itself; the forum_post channel row then
-- type-flips to `thread`, rooted on that new opener via `parent_message_id`.
--
-- TYPE-FLIP, not new-thread+move-messages: the forum_post row's `id` is kept
-- (only its `type`/`parent_message_id` change) so any existing reference to
-- that channel id stays pointed at the same row. Its existing M messages
-- (opener body + replies) are untouched — their `channel_id` already points
-- at this row's id, which now simply IS a thread, so they become the
-- thread's messages with zero rows rewritten.
--
-- The live send path's message insert hardcodes `created_at = now` with no
-- historical-timestamp override, which would forge every migrated message's
-- time as "whenever this migration ran" — real history corruption. That path
-- is NOT used here. Only ONE new row needs inventing at all (the opener), and
-- this migration mints it directly with the forum_post's OWN creation
-- time/creator as the opener's created_at/author_id: display_title was
-- itself written at that moment, so that timestamp is the correct one for
-- "when was this title given," not "whenever this backfill executed."
--
-- Deterministic id `'mig_opener_' || <forum_post channel id>` (not a random
-- id) so step 4 below can point `parent_message_id` at the exact row step 1
-- inserted for THIS forum_post, with no content/timestamp-based re-lookup
-- that could ambiguously match more than one row.
--
-- IDEMPOTENT ACROSS RE-RUNS: every step's WHERE clause keys off
-- `type = 'forum_post'`. Step 4 flips that type away, so re-running this same
-- migration a second time matches zero rows in every step — a safe no-op,
-- not a double-insert.
--
-- EXCLUDED (deliberately, pending a separate decision): forum_post rows with
-- `creator_id IS NULL` (the row's creator account was hard-deleted after
-- posting). `community_message.author_id` is NOT NULL, so no opener message
-- can be minted for one of these without inventing an author that never
-- existed — the same class of historical-data forgery the created_at fix
-- above exists to avoid. Left as `forum_post` untouched; a live scan
-- determines whether this case has any real rows before it needs an answer.
--
-- M=0 orphans (a forum_post with zero messages — a pre-existing, non-atomic
-- artifact of the old create path, unrelated to this migration) fall out of
-- these SAME statements with no special-case branch: step 1 still inserts
-- the new opener from display_title and step 4 still flips the row to
-- `type='thread'` rooted on that opener — the result is one opener message +
-- an empty thread, an entirely ordinary state (any message can open a thread
-- nobody has replied to yet).

-- 1. One new opener message per forum_post, landing in the forum (the parent
--    channel) — matches the live send path's model: an opener lives in the
--    addressed channel, the thread is a separate row. `seq` is assigned
--    directly against the target forum's current counter via ROW_NUMBER,
--    safe without CAS/atomicity because migrations run single-threaded
--    offline, unlike the live path's concurrent-writer claim.
INSERT INTO community_message (
  id, author_id, content, type, mention_type, reply_to_id, embeds,
  created_at, channel_id, seq, friendship_id, client_nonce
)
SELECT
  'mig_opener_' || fp.id,
  fp.creator_id,
  COALESCE(fp.display_title, ''),
  'default',
  NULL, NULL, NULL,
  fp.created_at,
  fp.parent_channel_id,
  COALESCE((SELECT s.next_seq FROM community_message_seq s WHERE s.channel_id = fp.parent_channel_id), 0)
    + ROW_NUMBER() OVER (PARTITION BY fp.parent_channel_id ORDER BY fp.created_at, fp.id),
  NULL, NULL
FROM community_channel AS fp
WHERE fp.type = 'forum_post' AND fp.creator_id IS NOT NULL;

-- 2. Advance each affected forum's seq counter by however many openers step 1
--    just claimed for it, so the next REAL send into that forum claims a
--    fresh seq with no collision — mirrors claimNextSeq's own upsert shape.
--    `excluded.next_seq` is the per-forum opener COUNT this SELECT computed
--    (the value that would have been inserted), not the pre-existing row's
--    value — SQLite's standard UPSERT reference for exactly this case.
INSERT INTO community_message_seq (channel_id, next_seq)
SELECT
  fp.parent_channel_id,
  COUNT(*)
FROM community_channel AS fp
WHERE fp.type = 'forum_post' AND fp.creator_id IS NOT NULL
GROUP BY fp.parent_channel_id
ON CONFLICT(channel_id) DO UPDATE SET
  next_seq = next_seq + excluded.next_seq;

-- 3. Bump each affected forum's own message_count/last_message_at for the new
--    opener(s), the same bookkeeping a live message insert does.
--    last_message_at only ADVANCES, never regresses: a historical opener's
--    created_at could predate the forum's current last_message_at if the
--    forum has had newer, unrelated activity since. SQLite's multi-arg
--    scalar max() returns NULL if EITHER argument is NULL, so a forum with
--    no prior last_message_at (NULL) must be COALESCEd to the new value
--    directly rather than compared against NULL.
UPDATE community_channel
SET
  message_count = message_count + (
    SELECT COUNT(*) FROM community_channel fp
    WHERE fp.type = 'forum_post' AND fp.parent_channel_id = community_channel.id AND fp.creator_id IS NOT NULL
  ),
  last_message_at = CASE
    WHEN last_message_at IS NULL THEN (
      SELECT MAX(fp.created_at) FROM community_channel fp
      WHERE fp.type = 'forum_post' AND fp.parent_channel_id = community_channel.id AND fp.creator_id IS NOT NULL
    )
    ELSE MAX(
      last_message_at,
      (SELECT MAX(fp.created_at) FROM community_channel fp
       WHERE fp.type = 'forum_post' AND fp.parent_channel_id = community_channel.id AND fp.creator_id IS NOT NULL)
    )
  END
WHERE id IN (
  SELECT DISTINCT parent_channel_id FROM community_channel
  WHERE type = 'forum_post' AND creator_id IS NOT NULL
);

-- 4. Type-flip: the forum_post row itself becomes the thread, rooted on the
--    opener message step 1 minted for it (deterministic id, no ambiguity).
--    `parent_channel_id` is left untouched — already points at the forum,
--    exactly where a natively-opened thread's parent_channel_id would point.
--
--    `name` MUST also be rederived here, not left as the old forum_post
--    slug: createMessageWithThread's live path (create-channels.ts) sets a
--    thread's `name` from the opener content, trimmed and truncated to
--    MAX_CHANNEL_NAME_LENGTH (100) — NOT from any slug. A migrated thread
--    that kept its old slug in `name` would be a structural difference from
--    a natively-created thread (which never has a slug-shaped name), not
--    merely an old-vs-fresh content difference — exactly what the
--    migration-equivalence requirement forbids. TRIM+CASE mirrors the live
--    path's `trim() || "thread"` fallback (an empty/whitespace-only
--    display_title falls back to the literal "thread", never an empty
--    string); SUBSTR(...,1,100) mirrors its `.slice(0, MAX_CHANNEL_NAME_LENGTH)`.
UPDATE community_channel
SET
  type = 'thread',
  parent_message_id = 'mig_opener_' || id,
  name = SUBSTR(
    CASE WHEN TRIM(COALESCE(display_title, '')) = '' THEN 'thread' ELSE TRIM(display_title) END,
    1, 100
  )
WHERE type = 'forum_post' AND creator_id IS NOT NULL;

-- 5. Enroll participants on each newly-flipped thread — enroll is independent
--    social data; it does not appear automatically just because the row's
--    type changed. As of migration 0067, the notify/participant set lives on
--    `community_channel_member` with `relation='notify'` (the standalone
--    community_thread_participant table from 0058/0060/0061 no longer
--    exists — folded into this table). Seeded the same way 0060/0061 seeded
--    pre-existing threads/posts: distinct message authors ("spoke") + the
--    row's own creator (may not have posted, but always "spoke" the opener
--    here). INSERT OR IGNORE against uq_channel_member(channel_id, user_id,
--    relation), so re-running is a no-op (also naturally satisfied by step 4
--    already having flipped the type away on any second run).
INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT DISTINCT
  lower(hex(randomblob(16))),
  t.id,
  msg.author_id,
  'notify',
  'spoke',
  NULL,
  t.created_at
FROM community_channel AS t
JOIN community_message AS msg ON msg.channel_id = t.id
WHERE t.type = 'thread' AND t.parent_message_id = 'mig_opener_' || t.id;

INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at)
SELECT
  lower(hex(randomblob(16))),
  t.id,
  t.creator_id,
  'notify',
  'spoke',
  NULL,
  t.created_at
FROM community_channel AS t
WHERE t.type = 'thread' AND t.creator_id IS NOT NULL AND t.parent_message_id = 'mig_opener_' || t.id;
