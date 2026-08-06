import { eq, and, inArray } from "drizzle-orm";
import { communityMessageTag } from "../../community-schema";
import type { Database } from "../../index";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";

// Idempotent add. UNIQUE(messageId, tag) makes re-adding the same tag a
// no-op, so `onConflictDoNothing` keeps this safe to call twice without a
// 409 round-trip (mirrors mark.ts's markMessage).
export async function addMessageTag(
  db: Database,
  data: { messageId: string; tag: string }
) {
  await db
    .insert(communityMessageTag)
    .values({ messageId: data.messageId, tag: data.tag })
    .onConflictDoNothing({
      target: [communityMessageTag.messageId, communityMessageTag.tag],
    });
}

export async function removeMessageTag(
  db: Database,
  data: { messageId: string; tag: string }
) {
  const [deleted] = await db
    .delete(communityMessageTag)
    .where(
      and(
        eq(communityMessageTag.messageId, data.messageId),
        eq(communityMessageTag.tag, data.tag)
      )
    )
    .returning();
  return deleted ?? null;
}

// This message's own tag set, unordered (callers sort if they need a
// display order — no natural order on a tag set).
export async function listTagsForMessage(
  db: Database,
  messageId: string
): Promise<string[]> {
  const rows = await db
    .select({ tag: communityMessageTag.tag })
    .from(communityMessageTag)
    .where(eq(communityMessageTag.messageId, messageId));
  return rows.map((r) => r.tag);
}

// Batch variant for a post-list render (avoid N+1) — one row per
// (messageId, tag) pair; caller groups by messageId.
export async function listTagsForMessages(
  db: Database,
  messageIds: string[]
): Promise<{ messageId: string; tag: string }[]> {
  if (messageIds.length === 0) return [];
  const chunks = chunk(messageIds, D1_MAX_IN_PARAMS);
  const results = await Promise.all(
    chunks.map((ids) =>
      db
        .select({ messageId: communityMessageTag.messageId, tag: communityMessageTag.tag })
        .from(communityMessageTag)
        .where(inArray(communityMessageTag.messageId, ids))
    )
  );
  return results.flat();
}

// Filter an ALREADY-RESOLVED, membership-gated message id set down to those
// carrying `tag` (the forum `?tag=` filter). `candidateMessageIds` MUST come
// from a caller that has already scoped to one channel's message set — this
// function does NOT accept a bare tag with no candidate scope, so it can
// never become a cross-channel "which channels have this tag" existence
// probe (Aigneis #646/#647 red-line).
export async function filterMessageIdsByTag(
  db: Database,
  candidateMessageIds: string[],
  tag: string
): Promise<string[]> {
  if (candidateMessageIds.length === 0) return [];
  const chunks = chunk(candidateMessageIds, D1_MAX_IN_PARAMS);
  const results = await Promise.all(
    chunks.map((ids) =>
      db
        .select({ messageId: communityMessageTag.messageId })
        .from(communityMessageTag)
        .where(and(eq(communityMessageTag.tag, tag), inArray(communityMessageTag.messageId, ids)))
    )
  );
  return results.flat().map((r) => r.messageId);
}
