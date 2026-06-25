import { sql, eq, and, inArray } from "drizzle-orm";
import { communityMessage, communityChannel } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const DEFAULT_LIMIT = 50;

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

  // FTS5 requires raw SQL — no Drizzle ORM equivalent exists
  const ftsResults = await db.all<{ id: string }>(
    sql`SELECT id FROM community_message_fts WHERE community_message_fts MATCH ${opts.query} LIMIT ${limit}`
  );

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

  // Fetch full messages with author info using ORM
  const results = await db
    .select({
      message: communityMessage,
      author: user,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(inArray(communityMessage.id, ids));

  // Apply additional filters in application layer
  return results.filter((r) => {
    if (opts.channelId && r.message.channelId !== opts.channelId) return false;
    if (
      opts.dmConversationId &&
      r.message.dmConversationId !== opts.dmConversationId
    )
      return false;
    return true;
  });
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
    const ftsResults = await db.all<{ id: string }>(
      sql`SELECT id FROM community_message_fts WHERE community_message_fts MATCH ${opts.query} LIMIT ${limit}`
    );
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
