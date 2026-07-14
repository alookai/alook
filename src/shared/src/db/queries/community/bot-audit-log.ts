/**
 * Bot activity audit log — per-bot append-only event log with 500-row-per-bot
 * retention. Rows are inserted via ws-do (single writer), read from the web
 * API's owner-scoped GET route, and pruned in the same D1 batch as the insert.
 *
 * Every read filters to `user.deletedAt IS NULL` on the joined bot user row
 * so a soft-deleted bot's activity is not surfaced (see plan §Data model).
 */

import { and, desc, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { communityBotActivityEvent } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
export const AUDIT_LOG_MAX_ROWS_PER_BOT = 500;

export type BotActivityEventRow = {
  id: string;
  botId: string;
  sessionId: string | null;
  launchId: string | null;
  kind: string;
  payload: string;
  createdAt: string;
};

export type BotActivityEventInput = {
  botId: string;
  sessionId?: string | null;
  launchId?: string | null;
  kind: "cli_invocation" | "tool_call" | "thinking";
  payload: string;
};

/**
 * Insert + retention prune in a single D1 batch. This is the writer ws-do
 * calls on every inbound `bot_audit_event` frame. Returns the inserted row
 * (or null if the INSERT didn't land — treat as "don't broadcast").
 */
export async function insertBotActivityEventAndPrune(
  db: Database,
  data: BotActivityEventInput
): Promise<{ id: string; createdAt: string } | null> {
  const insert = insertBotActivityEventStatement(db, data);
  const prune = pruneBotActivityEventsStatement(db, data.botId);
  const results = (await db.batch([insert, prune] as any)) as any[];
  const insertResult = results?.[0];
  const rows: Array<{ id: string; createdAt: string }> = Array.isArray(insertResult)
    ? insertResult
    : Array.isArray(insertResult?.rows)
    ? insertResult.rows
    : [];
  return rows[0] ?? null;
}

/**
 * Insert a single event. Prefer the atomic batch (insert + prune) invoked from
 * ws-do; this is exposed as a Drizzle statement builder so ws-do can compose
 * it into a `db.batch([...])` call.
 */
export function insertBotActivityEventStatement(
  db: Database,
  data: BotActivityEventInput
) {
  return db
    .insert(communityBotActivityEvent)
    .values({
      botId: data.botId,
      sessionId: data.sessionId ?? null,
      launchId: data.launchId ?? null,
      kind: data.kind,
      payload: data.payload,
    })
    .returning({
      id: communityBotActivityEvent.id,
      createdAt: communityBotActivityEvent.createdAt,
    });
}

/**
 * Delete rows older than the top-500 (by createdAt DESC, id DESC) for a bot.
 * Uses a `NOT IN (subquery)` shape built via Drizzle operators so the returned
 * value is a real Drizzle statement that composes into `db.batch([...])` —
 * `db.run(sql\`...\`)` returns a Promise, which is NOT batchable and would
 * throw `Cannot read properties of undefined (reading 'bind')` when D1's
 * batch adapter tries to call `.bind()` on it.
 */
export function pruneBotActivityEventsStatement(db: Database, botId: string) {
  const keepTopN = db
    .select({ id: communityBotActivityEvent.id })
    .from(communityBotActivityEvent)
    .where(eq(communityBotActivityEvent.botId, botId))
    .orderBy(desc(communityBotActivityEvent.createdAt), desc(communityBotActivityEvent.id))
    .limit(AUDIT_LOG_MAX_ROWS_PER_BOT);
  return db
    .delete(communityBotActivityEvent)
    .where(
      and(
        eq(communityBotActivityEvent.botId, botId),
        notInArray(communityBotActivityEvent.id, keepTopN)
      )
    );
}

/**
 * List events for a bot, newest first, with composite cursor pagination on
 * `(createdAt DESC, id DESC)`.
 *
 * The list is filtered to bots that are still live (`user.deletedAt IS NULL`);
 * a soft-deleted bot returns an empty list even if raw rows remain.
 */
export async function listBotActivityEvents(
  db: Database,
  opts: {
    botId: string;
    beforeCreatedAt?: string;
    beforeId?: string;
    limit?: number;
  }
): Promise<BotActivityEventRow[]> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conds = [
    eq(communityBotActivityEvent.botId, opts.botId),
    isNull(user.deletedAt),
  ];
  if (opts.beforeCreatedAt !== undefined && opts.beforeId !== undefined) {
    conds.push(
      or(
        lt(communityBotActivityEvent.createdAt, opts.beforeCreatedAt),
        and(
          eq(communityBotActivityEvent.createdAt, opts.beforeCreatedAt),
          lt(communityBotActivityEvent.id, opts.beforeId)
        )
      )!
    );
  } else if (opts.beforeCreatedAt !== undefined) {
    conds.push(lt(communityBotActivityEvent.createdAt, opts.beforeCreatedAt));
  }

  const rows = await db
    .select({
      id: communityBotActivityEvent.id,
      botId: communityBotActivityEvent.botId,
      sessionId: communityBotActivityEvent.sessionId,
      launchId: communityBotActivityEvent.launchId,
      kind: communityBotActivityEvent.kind,
      payload: communityBotActivityEvent.payload,
      createdAt: communityBotActivityEvent.createdAt,
    })
    .from(communityBotActivityEvent)
    .innerJoin(user, eq(user.id, communityBotActivityEvent.botId))
    .where(and(...conds))
    .orderBy(desc(communityBotActivityEvent.createdAt), desc(communityBotActivityEvent.id))
    .limit(limit);

  return rows;
}
