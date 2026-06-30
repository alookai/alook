import { eq, and, sql } from "drizzle-orm";
import { communityMessage, communityChannel } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { escapeLikePattern } from "../../../utils/sql-like";

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
    dmConversationId?: string;
    serverId?: string;
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  if (opts.serverId) {
    return searchMessagesInServer(db, {
      query: opts.query,
      serverId: opts.serverId,
      limit,
    });
  }

  const pattern = `%${escapeLikePattern(opts.query)}%`;
  const conditions = [sql`${communityMessage.content} LIKE ${pattern} ESCAPE '\\'`];
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
    .where(and(...conditions))
    .limit(limit);
}

export async function searchMessagesInServer(
  db: Database,
  opts: {
    query: string;
    serverId: string;
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const pattern = `%${escapeLikePattern(opts.query)}%`;
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
        sql`${communityMessage.content} LIKE ${pattern} ESCAPE '\\'`,
        eq(communityChannel.serverId, opts.serverId)
      )
    )
    .limit(limit);
}
