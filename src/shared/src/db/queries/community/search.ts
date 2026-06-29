import { sql, eq, and, inArray } from "drizzle-orm";
import { communityMessage, communityChannel } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const DEFAULT_LIMIT = 50;

/** Sanitize user input for FTS5 MATCH — removes special operators and wraps as a phrase. */
function sanitizeFtsQuery(query: string): string {
  return '"' + query.replace(/["\-*()^~]/g, " ").replace(/\s+/g, " ").trim() + '"';
}

export async function searchMessages(
  db: Database,
  opts: {
    query: string;
    channelId?: string;
    dmConversationId?: string;
    serverId?: string;
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const sanitized = sanitizeFtsQuery(opts.query);

  // FTS5 requires raw SQL — no Drizzle ORM equivalent exists
  let ftsResults: { id: string }[];
  try {
    ftsResults = await db.all<{ id: string }>(
      sql`SELECT id FROM community_message_fts WHERE community_message_fts MATCH ${sanitized} LIMIT ${limit}`
    );
  } catch {
    return [];
  }

  if (ftsResults.length === 0) return [];

  const ids = ftsResults.map((r) => r.id);

  // If serverId filter, use the server-scoped function
  if (opts.serverId) {
    return searchMessagesInServer(db, {
      query: opts.query,
      serverId: opts.serverId,
      ids,
    });
  }

  // Fetch full messages with author info using ORM, with scope filters in SQL
  const conditions = [inArray(communityMessage.id, ids)];
  if (opts.channelId) {
    conditions.push(eq(communityMessage.channelId, opts.channelId));
  }
  if (opts.dmConversationId) {
    conditions.push(eq(communityMessage.dmConversationId, opts.dmConversationId));
  }

  return db
    .select({
      message: communityMessage,
      author: user,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(...conditions));
}

export async function searchMessagesInServer(
  db: Database,
  opts: {
    query: string;
    serverId: string;
    ids?: string[];
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  let ids = opts.ids;
  if (!ids) {
    const sanitized = sanitizeFtsQuery(opts.query);
    let ftsResults: { id: string }[];
    try {
      ftsResults = await db.all<{ id: string }>(
        sql`SELECT id FROM community_message_fts WHERE community_message_fts MATCH ${sanitized} LIMIT ${limit}`
      );
    } catch {
      return [];
    }
    if (ftsResults.length === 0) return [];
    ids = ftsResults.map((r) => r.id);
  }

  return db
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
    .where(
      and(
        inArray(communityMessage.id, ids),
        eq(communityChannel.serverId, opts.serverId)
      )
    );
}
