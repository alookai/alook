import { eq, and, inArray, sql } from "drizzle-orm";
import { communityMessage, communityChannel } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { escapeLikePattern } from "../../../utils/sql-like";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";

const DEFAULT_LIMIT = 50;

const FTS_KEYWORDS = new Set(["and", "or", "not", "near"]);

/** Sanitize user input for FTS5 MATCH — each term gets prefix matching with implicit AND. */
export function sanitizeFtsQuery(query: string): string {
  const terms = query
    .replace(/["\-*()^~{}[\]:.!?,;@#$%&/\\]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !FTS_KEYWORDS.has(t.toLowerCase()));
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"*`).join(" ");
}

export async function searchMessages(
  db: Database,
  opts: {
    query: string;
    channelId?: string;
    serverId?: string;
    // Scope for the server branch — the caller's visible channel ids
    // (public/uncategorized ∪ private-where-member). Enforced in SQL so
    // private-channel content never leaks into server-wide search results.
    visibleChannelIds?: string[];
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  if (opts.serverId) {
    return searchMessagesInServer(db, {
      query: opts.query,
      serverId: opts.serverId,
      visibleChannelIds: opts.visibleChannelIds,
      limit,
    });
  }

  const pattern = `%${escapeLikePattern(opts.query)}%`;
  const conditions = [sql`${communityMessage.content} LIKE ${pattern} ESCAPE '\\'`];
  if (opts.channelId) {
    conditions.push(eq(communityMessage.channelId, opts.channelId));
  }

  return db
    .select({
      message: communityMessage,
      author: user,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(...conditions))
    .limit(limit);
}

export async function searchMessagesInServer(
  db: Database,
  opts: {
    query: string;
    serverId: string;
    // The caller's visible channel ids — scopes the search so private-channel
    // content the viewer can't see never appears. `undefined` means "not
    // scoped" (internal/trusted callers only); the community search route
    // ALWAYS passes it. An empty array yields zero results.
    visibleChannelIds?: string[];
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  if (opts.visibleChannelIds && opts.visibleChannelIds.length === 0) return [];

  const pattern = `%${escapeLikePattern(opts.query)}%`;
  const baseConditions = [
    sql`${communityMessage.content} LIKE ${pattern} ESCAPE '\\'`,
    eq(communityChannel.serverId, opts.serverId),
  ];

  const runQuery = (extra: ReturnType<typeof inArray>[] = []) =>
    db
      .select({
        message: communityMessage,
        author: user,
      })
      .from(communityMessage)
      .innerJoin(user, eq(communityMessage.authorId, user.id))
      .innerJoin(
        communityChannel,
        eq(communityMessage.channelId, communityChannel.id)
      )
      .where(and(...baseConditions, ...extra))
      .limit(limit);

  if (!opts.visibleChannelIds) return runQuery();

  // D1 caps a statement at 100 bound params; `visibleChannelIds` is unbounded.
  // Chunk the `inArray` and merge. There's no ORDER BY contract today, so plain
  // concat+slice would bias toward early-chunk channels (a match in a late chunk
  // gets dropped once an early chunk fills `limit`). Sort the merged rows by
  // createdAt desc before slicing → a defensible "most-recent matches" rule
  // instead of chunk-order bias. `createdAt` is in the projection.
  const chunks = chunk(opts.visibleChannelIds, D1_MAX_IN_PARAMS);
  const merged = (
    await Promise.all(
      chunks.map((ids) => runQuery([inArray(communityMessage.channelId, ids)]))
    )
  ).flat();
  merged.sort((a, b) => (a.message.createdAt < b.message.createdAt ? 1 : -1));
  return merged.slice(0, limit);
}
