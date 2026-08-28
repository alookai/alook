/**
 * Community bots — first-class community identities owned by users, bound to
 * a paired machine + runtime.
 *
 * ── Ownership scoping invariant ─────────────────────────────────────────────
 *
 * Every read/write on bot state MUST scope by `ownerUserId` in its WHERE
 * clause. No post-hoc ownership checks anywhere.
 *
 * D1 batches do NOT roll back on zero-row matches — only on statement error.
 * A multi-statement batch where statement 1 no-ops on
 * `WHERE id = :botId AND ownerUserId = :ctx.userId` while statements 2/3 use
 * plain `WHERE userId = :botId` would let a cross-owner call vandalize the
 * victim's state. Every batch statement carries the `ownerUserId` predicate
 * independently, via subquery.
 *
 * After each batch, inspect the primary statement's `changes`. Zero rows →
 * return null / 404 at the route. The victim's state must be untouched.
 */

import { aliasedTable, and, count, eq, exists, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { user } from "../../schema";
import {
  communityBotBinding,
  communityAgentRunnerKey,
} from "../../community-machine-schema";
import {
  communityBotApprovalRequest,
  communityServerMember,
  communityUserProfile,
  communityReadState,
  communityBotDailyActivity,
  communityBotActivityEvent,
} from "../../community-schema";
import { communityMachine } from "../../community-machine-schema";
import type { Database } from "../../index";
import { communityBotSyntheticEmail } from "../../../constants";
import { withUniqueDiscriminator } from "../user";
import { nanoid } from "nanoid";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";

// ─── Types ──────────────────────────────────────────────────────────────────

export type BotRow = {
  id: string;
  name: string;
  discriminator: string;
  image: string | null;
  ownerUserId: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /**
   * ISO timestamp of the bot's last "refresh context" (a `nap` or owner
   * `session_reset`), or null if it has never refreshed. Written only at the
   * nap/session_reset audit chokepoint — a monotonic historical fact.
   */
  lastRefreshContextAt: string | null;
};

export type BotBinding = {
  userId: string;
  machineId: string;
  runtime: string;
  instruction: string;
  modelName: string | null;
  createdAt: string;
};

export class OwnerHasBotsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerHasBotsError";
  }
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * List live bots owned by `ownerId`. Filters `isBot=true AND deletedAt IS NULL`.
 * Joined against `communityBotBinding` for machine/runtime overlay.
 */
export async function listBotsForOwner(
  db: Database,
  ownerId: string
): Promise<Array<BotRow & { machineId: string; runtime: string; modelName: string | null }>> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      discriminator: user.discriminator,
      image: user.image,
      ownerUserId: user.ownerUserId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastRefreshContextAt: user.lastRefreshContextAt,
      description: communityBotBinding.instruction,
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
      modelName: communityBotBinding.modelName,
    })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .where(
      and(
        eq(user.isBot, true),
        eq(user.ownerUserId, ownerId),
        isNull(user.deletedAt)
      )
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    discriminator: r.discriminator,
    image: r.image,
    ownerUserId: r.ownerUserId!,
    description: r.description ?? "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRefreshContextAt: r.lastRefreshContextAt ?? null,
    machineId: r.machineId,
    runtime: r.runtime,
    modelName: r.modelName ?? null,
  }));
}

/**
 * Get a bot iff it's owned by `ownerId`. Returns null on any mismatch — this
 * is the ownership-scoping gate for every bot-mutating route.
 */
export async function getBotOwnedBy(
  db: Database,
  botId: string,
  ownerId: string
): Promise<(BotRow & { machineId: string | null; runtime: string | null; modelName: string | null }) | null> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      discriminator: user.discriminator,
      image: user.image,
      ownerUserId: user.ownerUserId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastRefreshContextAt: user.lastRefreshContextAt,
      description: communityBotBinding.instruction,
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
      modelName: communityBotBinding.modelName,
    })
    .from(user)
    .leftJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .where(
      and(
        eq(user.id, botId),
        eq(user.isBot, true),
        eq(user.ownerUserId, ownerId),
        isNull(user.deletedAt)
      )
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    discriminator: r.discriminator,
    image: r.image,
    ownerUserId: r.ownerUserId!,
    description: r.description ?? "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRefreshContextAt: r.lastRefreshContextAt ?? null,
    machineId: r.machineId ?? null,
    runtime: r.runtime ?? null,
    modelName: r.modelName ?? null,
  };
}

/**
 * Public-read projection for the canonical bot-avatar door.
 *
 * This is the deliberate non-owner exception: authenticated server members
 * and DM peers may render a live bot's avatar. The predicate still fails
 * closed for missing, human, and tombstoned user rows, and the projection is
 * intentionally limited to the two fields the door needs.
 */
export async function getLiveBotAvatar(
  db: Database,
  botId: string
): Promise<{ id: string; image: string | null } | null> {
  const rows = await db
    .select({ id: user.id, image: user.image })
    .from(user)
    .where(
      and(
        eq(user.id, botId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Cheap ownership probe used by ack/error paths. */
export async function countLiveBotsForOwner(
  db: Database,
  ownerId: string
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(user)
    .where(
      and(
        eq(user.isBot, true),
        eq(user.ownerUserId, ownerId),
        isNull(user.deletedAt)
      )
    );
  return rows[0]?.n ?? 0;
}

/** Get bot binding by userId. Returns null if none. */
export async function getBotBinding(
  db: Database,
  botId: string
): Promise<{ machineId: string; runtime: string; modelName: string | null } | null> {
  const rows = await db
    .select({
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
      modelName: communityBotBinding.modelName,
    })
    .from(communityBotBinding)
    .where(eq(communityBotBinding.userId, botId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { machineId: r.machineId, runtime: r.runtime, modelName: r.modelName ?? null };
}

/**
 * Combined lookup: bot's machine binding + owner userId. Used by ws-do's audit
 * event handler to (a) verify the frame originates from the machine that owns
 * the bot, and (b) address the owner-only fan-out.
 * Returns null if the bot is unknown, soft-deleted, or unbound.
 */
export async function getBotBindingWithOwner(
  db: Database,
  botId: string
): Promise<{ machineId: string; runtime: string; ownerUserId: string; name: string; discriminator: string } | null> {
  const rows = await db
    .select({
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
      ownerUserId: user.ownerUserId,
      // Bot's display identity — carried on typing fan-out so the client
      // renders the name without a roster lookup. Free: this join already
      // reads the `user` row.
      name: user.name,
      discriminator: user.discriminator,
    })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .where(
      and(
        eq(user.id, botId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    )
    .limit(1);
  const r = rows[0];
  if (!r || !r.ownerUserId) return null;
  return { machineId: r.machineId, runtime: r.runtime, ownerUserId: r.ownerUserId, name: r.name, discriminator: r.discriminator };
}

/**
 * Wake-dispatch candidate filter — one D1 hit. Given a message's `recipients`
 * (all fanout recipients, human + bot) and the `channelId` it landed in,
 * returns only the bots among them that are (a) live (`!deletedAt`), (b) bound
 * to a machine, and (c) actually behind `newSeq` per their own `lastReadSeq`
 * for that channel (`NULL` read-state row counts as "never read", i.e.
 * behind). A bot that's already caught up (e.g. it just authored `newSeq`
 * itself, or acked out-of-band) is filtered out here so the producer never
 * enqueues a wasted wake.
 */
export async function findWakeCandidates(
  db: Database,
  opts: {
    recipients: string[];
    channelId: string;
    newSeq: number;
  }
): Promise<Array<{ botUserId: string; name: string | null; machineId: string; runtime: string }>> {
  if (opts.recipients.length === 0) return [];
  const scopeCond = eq(communityReadState.channelId, opts.channelId);

  // `recipients` is a message's fan-out audience — unbounded for a large public
  // channel. Chunk the `inArray` for D1's 100-param limit; no order/limit, and
  // the seq filter runs in JS below, so concat is loss-free.
  const rows = (
    await Promise.all(
      chunk(opts.recipients, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({
            botUserId: user.id,
            name: user.name,
            machineId: communityBotBinding.machineId,
            runtime: communityBotBinding.runtime,
            lastReadSeq: communityReadState.lastReadSeq,
          })
          .from(user)
          .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
          .leftJoin(communityReadState, and(eq(communityReadState.userId, user.id), scopeCond))
          .where(
            and(
              inArray(user.id, ids),
              eq(user.isBot, true),
              isNull(user.deletedAt)
            )
          )
      )
    )
  ).flat();

  return rows
    .filter((r) => (r.lastReadSeq ?? 0) < opts.newSeq)
    .map((r) => ({ botUserId: r.botUserId, name: r.name, machineId: r.machineId, runtime: r.runtime }));
}

/**
 * Discriminated bot-state lookup for the unread-wake rebuild path
 * (`buildUnreadWakeCommand`). A single D1 hit that distinguishes exactly why
 * a bot isn't wake-able (missing / soft-deleted / no machine binding) from
 * the happy path — the caller `ack()`s the queue item for every non-`ready`
 * state, never `retry()`s a permanent miss.
 */
export type BotWakeContext =
  | { state: "bot_missing" }
  | { state: "bot_deleted" }
  | { state: "bot_unbound" }
  | {
      state: "ready";
      botUserId: string;
      name: string;
      discriminator: string;
      machineId: string;
      runtime: string;
      modelName: string | null;
      ownerUserId: string | null;
    };

export async function getBotWakeContext(db: Database, botUserId: string): Promise<BotWakeContext> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      discriminator: user.discriminator,
      isBot: user.isBot,
      deletedAt: user.deletedAt,
      ownerUserId: user.ownerUserId,
      machineId: communityBotBinding.machineId,
      runtime: communityBotBinding.runtime,
      modelName: communityBotBinding.modelName,
    })
    .from(user)
    .leftJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .where(eq(user.id, botUserId))
    .limit(1);
  const r = rows[0];
  if (!r || !r.isBot) return { state: "bot_missing" };
  if (r.deletedAt) return { state: "bot_deleted" };
  if (!r.machineId || !r.runtime) return { state: "bot_unbound" };
  return {
    state: "ready",
    botUserId: r.id,
    name: r.name,
    discriminator: r.discriminator,
    machineId: r.machineId,
    runtime: r.runtime,
    modelName: r.modelName ?? null,
    ownerUserId: r.ownerUserId,
  };
}

/**
 * Bots bound to this machine — daemon cold-start warmup uses this, AND batch
 * reset (`machine:reset_all`) enumerates the same binding set. `runtime` +
 * `modelName` come off the binding row (the runtime pairing) so a caller can
 * build a per-agent RuntimeConfig without a second query (batch reset needs
 * them; warmup ignores the extra fields).
 */
export async function listBotsForMachine(
  db: Database,
  machineId: string
): Promise<
  Array<{
    id: string;
    name: string;
    discriminator: string;
    description: string;
    ownerName: string;
    ownerDiscriminator: string;
    runtime: string;
    modelName: string | null;
  }>
> {
  // Guard against orphaned bots: if a future flow soft-deletes an owner user
  // without cascading their bots, don't hand them to the daemon for warmup.
  const owner = aliasedTable(user, "owner");
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      discriminator: user.discriminator,
      description: communityBotBinding.instruction,
      ownerName: owner.name,
      ownerDiscriminator: owner.discriminator,
      runtime: communityBotBinding.runtime,
      modelName: communityBotBinding.modelName,
    })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .innerJoin(owner, eq(owner.id, user.ownerUserId))
    .where(
      and(
        eq(communityBotBinding.machineId, machineId),
        eq(user.isBot, true),
        isNull(user.deletedAt),
        isNull(owner.deletedAt)
      )
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    discriminator: r.discriminator,
    description: r.description ?? "",
    ownerName: r.ownerName,
    ownerDiscriminator: r.ownerDiscriminator,
    runtime: r.runtime,
    modelName: r.modelName ?? null,
  }));
}

/**
 * List server ids the bot is currently a member of. Used before soft-delete
 * so the caller can fan out MEMBER_LEAVE for each server.
 */
export async function listBotServerMemberships(
  db: Database,
  botId: string,
  ownerId: string
): Promise<string[]> {
  const rows = await db
    .select({ serverId: communityServerMember.serverId })
    .from(communityServerMember)
    .innerJoin(user, eq(user.id, communityServerMember.userId))
    .where(
      and(
        eq(communityServerMember.userId, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true)
      )
    );
  return rows.map((r) => r.serverId);
}

/** Machine-delete UX preflight: which bots would cascade? */
export async function listBotsBoundToMachine(
  db: Database,
  machineId: string,
  ownerId: string
): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: user.id, name: user.name })
    .from(user)
    .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
    .where(
      and(
        eq(communityBotBinding.machineId, machineId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    );
}

// ─── Writes ────────────────────────────────────────────────────────────────

export type CreateBotInput = {
  ownerId: string;
  name: string;
  description?: string;
  machineId: string;
  runtime: string;
  image?: string | null;
  modelName?: string | null;
};

/**
 * Atomic bot creation. Three statements:
 *   1. INSERT `user` (isBot=true, ownerUserId, synthetic email, image).
 *   2. INSERT `community_bot_binding` (machineId + runtime).
 *   3. INSERT `community_user_profile` (aboutMe = description).
 *
 * Batched so all commit or none. `withUniqueDiscriminator` wraps the WHOLE
 * batch (not just statement 1) — a discriminator collision retries all three
 * statements together so the binding/profile rows always land alongside the
 * user row that actually won the discriminator. Returns the bot row.
 */
export async function createBot(
  db: Database,
  data: CreateBotInput
): Promise<{ botId: string; name: string; discriminator: string; description: string; image: string | null }> {
  const botId = nanoid();
  const email = communityBotSyntheticEmail(botId);
  const nowIso = new Date().toISOString();
  const description = data.description ?? "";

  const discriminator = await withUniqueDiscriminator(
    db,
    { id: botId, name: data.name },
    async (discriminator) => {
      // Three-statement batch. D1 rolls back all on any error.
      const stmt1 = db.insert(user).values({
        id: botId,
        name: data.name,
        email,
        emailVerified: true,
        image: data.image ?? null,
        isBot: true,
        ownerUserId: data.ownerId,
        discriminator,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      const stmt2 = db.insert(communityBotBinding).values({
        userId: botId,
        machineId: data.machineId,
        runtime: data.runtime,
        instruction: description,
        modelName: data.modelName ?? null,
        createdAt: nowIso,
      });
      // Match updateBot's upsert semantics — reincarnation paths (nanoid collision
      // aside, future flows that recycle a botId) shouldn't roll the batch back on
      // a profile PK conflict.
      const stmt3 = db
        .insert(communityUserProfile)
        .values({ userId: botId, aboutMe: description })
        .onConflictDoUpdate({
          target: communityUserProfile.userId,
          set: { aboutMe: description },
        });
      await db.batch([stmt1, stmt2, stmt3] as any);
      return discriminator;
    }
  );

  return {
    botId,
    name: data.name,
    discriminator,
    description,
    image: data.image ?? null,
  };
}

/**
 * Update bot fields. UPDATE predicate carries `ownerUserId + isBot + deletedAt IS NULL`
 * so a cross-owner call is a no-op with zero rows changed.
 * Returns the updated row, or null if the predicate matched zero rows.
 */
export async function updateBot(
  db: Database,
  botId: string,
  ownerId: string,
  data: { name?: string; description?: string; image?: string | null }
): Promise<{ botId: string; name: string; discriminator: string; description: string; image: string | null } | null> {
  const set: { name?: string; image?: string | null; updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (data.name !== undefined) set.name = data.name;
  if (data.image !== undefined) set.image = data.image;

  let rows: Array<{ id: string; name: string; discriminator: string; image: string | null }>;
  if (data.description !== undefined) {
    const ownerScopedIds = db
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          eq(user.id, botId),
          eq(user.ownerUserId, ownerId),
          eq(user.isBot, true),
          isNull(user.deletedAt)
        )
      );
    const ownerScopedBindingIds = db
      .select({ id: communityBotBinding.userId })
      .from(communityBotBinding)
      .where(inArray(communityBotBinding.userId, ownerScopedIds));
    const s1 = db
      .update(communityBotBinding)
      .set({ instruction: data.description })
      .where(inArray(communityBotBinding.userId, ownerScopedIds))
      .returning({ userId: communityBotBinding.userId });
    const s2 = db
      .update(user)
      .set(set)
      .where(
        and(
          eq(user.id, botId),
          eq(user.ownerUserId, ownerId),
          eq(user.isBot, true),
          isNull(user.deletedAt),
          inArray(user.id, ownerScopedBindingIds)
        )
      )
      .returning({ id: user.id, name: user.name, discriminator: user.discriminator, image: user.image });
    const results = (await db.batch([s1, s2] as any)) as any[];
    const bindingRows = Array.isArray(results?.[0]) ? results[0] : [];
    rows = Array.isArray(results?.[1]) ? results[1] : [];
    if (bindingRows.length === 0) rows = [];
  } else {
    rows = await db
      .update(user)
      .set(set)
      .where(
        and(
          eq(user.id, botId),
          eq(user.ownerUserId, ownerId),
          eq(user.isBot, true),
          isNull(user.deletedAt)
        )
      )
      .returning({ id: user.id, name: user.name, discriminator: user.discriminator, image: user.image });
  }

  if (rows.length === 0) return null;

  let description = data.description ?? "";
  if (data.description === undefined) {
    const bindingRows = await db
      .select({ instruction: communityBotBinding.instruction })
      .from(communityBotBinding)
      .where(eq(communityBotBinding.userId, botId))
      .limit(1);
    description = bindingRows[0]?.instruction ?? "";
  }

  return {
    botId: rows[0]!.id,
    name: rows[0]!.name,
    discriminator: rows[0]!.discriminator,
    description,
    image: rows[0]!.image,
  };
}

/**
 * Update a bot's stored model name. Owner-scoped in the WHERE clause via the
 * sanctioned `ownerScopedIds` subquery (see §Ownership scoping invariant) — a
 * cross-owner `botId` is a no-op, not a leak.
 *
 * Returns whether a binding row was actually written. `getBotOwnedBy` 404s a
 * missing/cross-owner bot before this runs, but a bot with NO binding row
 * (unbound / never paired) still passes that check while this UPDATE matches
 * zero rows — the caller must NOT report a model as saved in that case (it
 * wasn't). Detection uses `RETURNING` (reliable in D1, as `softDeleteBot`
 * relies on) rather than the driver-specific `meta.changes` that "can flip a
 * real success into a 404".
 */
export async function updateBotModel(
  db: Database,
  botId: string,
  ownerId: string,
  modelName: string | null
): Promise<boolean> {
  const ownerScopedIds = db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.id, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    );
  const rows = await db
    .update(communityBotBinding)
    .set({ modelName })
    .where(inArray(communityBotBinding.userId, ownerScopedIds))
    .returning({ userId: communityBotBinding.userId });
  return rows.length > 0;
}

export async function updateBotRuntime(
  db: Database,
  botId: string,
  ownerId: string,
  runtime: string,
  modelName: string | null
): Promise<boolean> {
  const ownerScopedIds = db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.id, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    );
  const rows = await db
    .update(communityBotBinding)
    .set({ runtime, modelName })
    .where(inArray(communityBotBinding.userId, ownerScopedIds))
    .returning({ userId: communityBotBinding.userId });
  return rows.length > 0;
}

/**
 * Record a context refresh on a bot: stamp `lastRefreshContextAt`. Called at —
 * and ONLY at — the audit chokepoints that record a context refresh: `nap`,
 * `session_reset`, and `provider_changed`. Keeping this the single write
 * point is what makes the field a monotonic historical fact that never drifts
 * from the audit log or the live FSM. Scoped to `isBot=true` and not
 * soft-deleted; the caller has already authorized the action (runner-key for
 * nap, owner for reset/switch), so no ownerUserId predicate here. `now` is injected so
 * callers pass the same instant they wrote the audit row.
 */
export async function touchBotRefreshContext(
  db: Database,
  botId: string,
  now: string
): Promise<void> {
  await db
    .update(user)
    .set({ lastRefreshContextAt: now })
    .where(and(eq(user.id, botId), eq(user.isBot, true), isNull(user.deletedAt)));
}

/**
 * Batchable Awake stamp for a reliable audit insert. The exact audit row must
 * exist with the same validated completion timestamp, so a duplicate event-id
 * retry cannot move Awake or create an audit/timestamp split. The monotonic
 * predicate also prevents a delayed reset from overwriting a newer wake/reset.
 */
export function touchBotRefreshContextForAuditEventStatement(
  db: Database,
  botId: string,
  eventId: string,
  createdAt: string,
) {
  const exactInsertedEvent = db
    .select({ id: communityBotActivityEvent.id })
    .from(communityBotActivityEvent)
    .where(and(
      eq(communityBotActivityEvent.id, eventId),
      eq(communityBotActivityEvent.botId, botId),
      eq(communityBotActivityEvent.createdAt, createdAt),
    ));
  return db
    .update(user)
    .set({ lastRefreshContextAt: createdAt })
    .where(and(
      eq(user.id, botId),
      eq(user.isBot, true),
      isNull(user.deletedAt),
      or(isNull(user.lastRefreshContextAt), lt(user.lastRefreshContextAt, createdAt)),
      exists(exactInsertedEvent),
    ));
}

/**
 * Drizzle statement that bumps a bot's per-day activity rollup by one, for the
 * my-bots heatmap. `column` selects which counter — `handled` (rides the
 * wake_trigger audit batch, one bump per message the bot woke for) or `sent`
 * (rides the community_message insert batch, one bump per message the bot
 * sends). Exposed as a statement builder (not an awaited write) so it composes
 * into the SAME `db.batch([...])` as that existing write — no new hot-path
 * round-trip. `day` MUST come from `utcDayKey` (the single day-boundary source)
 * so handled and sent for the same calendar day land in the same `(botId, day)`
 * row. Sharing the host batch's all-or-nothing fate is acceptable: a dropped +1
 * on a D1 blip is far cheaper than a per-message extra round-trip.
 *
 * Unlike the retired `handledMessageCount`, this rollup is a CALENDAR fact — it
 * is never zeroed on nap/reset and never touched by the FSM.
 */
export function bumpBotDailyActivityStatement(
  db: Database,
  botId: string,
  day: string,
  column: "handled" | "sent"
) {
  const isHandled = column === "handled";
  return db
    .insert(communityBotDailyActivity)
    .values({
      botId,
      day,
      handledCount: isHandled ? 1 : 0,
      sentCount: isHandled ? 0 : 1,
    })
    .onConflictDoUpdate({
      target: [communityBotDailyActivity.botId, communityBotDailyActivity.day],
      set: isHandled
        ? { handledCount: sql`${communityBotDailyActivity.handledCount} + 1` }
        : { sentCount: sql`${communityBotDailyActivity.sentCount} + 1` },
    });
}

export interface BotDailyActivityRow {
  day: string;
  handledCount: number;
  sentCount: number;
}

/**
 * Read a bot's per-day activity for the heatmap: rows with `day >= sinceDay`,
 * ascending. At most ~30 rows (the caller passes `sinceDay = today - 29`),
 * covered by the `(botId, day)` PK. A bot with no activity yet returns `[]`
 * (the caller/FE pads the missing days to zero cells — an empty array is the
 * normal new-bot path, not an error).
 */
export async function getBotDailyActivity(
  db: Database,
  botId: string,
  sinceDay: string
): Promise<BotDailyActivityRow[]> {
  const rows = await db
    .select({
      day: communityBotDailyActivity.day,
      handledCount: communityBotDailyActivity.handledCount,
      sentCount: communityBotDailyActivity.sentCount,
    })
    .from(communityBotDailyActivity)
    .where(
      and(
        eq(communityBotDailyActivity.botId, botId),
        gte(communityBotDailyActivity.day, sinceDay)
      )
    )
    .orderBy(communityBotDailyActivity.day);
  return rows;
}

/**
 * Batch read of per-day activity for ALL of an owner's bots in a single query,
 * so the my-bots list attaches heatmaps without N+1. Rows are scoped to bots
 * the caller owns (join on `user.ownerUserId`, isBot, not soft-deleted) and to
 * `day >= sinceDay`. Returns a Map keyed by botId → that bot's rows (ascending
 * day); a bot with no activity is simply absent from the map (the caller
 * defaults it to `[]`).
 */
export async function getBotDailyActivityForOwner(
  db: Database,
  ownerId: string,
  sinceDay: string
): Promise<Map<string, BotDailyActivityRow[]>> {
  const rows = await db
    .select({
      botId: communityBotDailyActivity.botId,
      day: communityBotDailyActivity.day,
      handledCount: communityBotDailyActivity.handledCount,
      sentCount: communityBotDailyActivity.sentCount,
    })
    .from(communityBotDailyActivity)
    .innerJoin(user, eq(user.id, communityBotDailyActivity.botId))
    .where(
      and(
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true),
        isNull(user.deletedAt),
        gte(communityBotDailyActivity.day, sinceDay)
      )
    )
    .orderBy(communityBotDailyActivity.day);
  const byBot = new Map<string, BotDailyActivityRow[]>();
  for (const r of rows) {
    const list = byBot.get(r.botId) ?? [];
    list.push({ day: r.day, handledCount: r.handledCount, sentCount: r.sentCount });
    byBot.set(r.botId, list);
  }
  return byBot;
}

/**
 * Soft-delete a bot atomically:
 *   1. UPDATE `user` set deletedAt (scoped by ownerUserId + isBot).
 *   2. DELETE `community_server_member` rows (scoped by ownerUserId subquery).
 *   3. UPDATE `community_agent_runner_key` set revokedAt (scoped by ownerUserId subquery).
 *   4. DELETE `community_bot_binding` (scoped by ownerUserId subquery).
 *
 * Every statement carries the `ownerUserId` predicate via subquery — see
 * §Ownership scoping invariant. Returns true iff step 1 changed a row.
 */
export async function softDeleteBot(
  db: Database,
  botId: string,
  ownerId: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  // Ownership-scoping subquery — used by every statement so a cross-owner
  // botId is a no-op across the whole batch.
  const ownerScopedIds = db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.id, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true)
      )
    );

  // Use RETURNING on the primary UPDATE so we can portably detect whether the
  // soft-delete landed — driver-specific `meta.changes` shapes differ between
  // D1 (`.meta.changes`), the libsql/sqlite test driver (rows[]), and future
  // shims, and mis-reads can flip a real success into a 404.
  const s1 = db
    .update(user)
    .set({ deletedAt: nowIso, updatedAt: nowIso })
    .where(
      and(
        eq(user.id, botId),
        eq(user.ownerUserId, ownerId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    )
    .returning({ id: user.id });
  const s2 = db
    .delete(communityServerMember)
    .where(inArray(communityServerMember.userId, ownerScopedIds));
  const s3 = db
    .update(communityAgentRunnerKey)
    .set({ revokedAt: nowIso })
    .where(
      and(
        eq(communityAgentRunnerKey.agentId, botId),
        isNull(communityAgentRunnerKey.revokedAt),
        inArray(communityAgentRunnerKey.userId, ownerScopedIds)
      )
    );
  const s4 = db
    .delete(communityBotBinding)
    .where(inArray(communityBotBinding.userId, ownerScopedIds));

  const results = (await db.batch([s1, s2, s3, s4] as any)) as any[];
  // With RETURNING, statement 1 returns an array of matched rows. Zero rows
  // means the predicate didn't match (cross-owner or already-tombstoned).
  const firstRows = Array.isArray(results?.[0]) ? results[0] : [];
  return firstRows.length > 0;
}

/**
 * Ship a real guard so future user-delete plumbing has a clear failure mode.
 * Throws `OwnerHasBotsError` when a user still has live bots. No callers
 * today; called by any future delete-endpoint before it fires.
 */
export async function assertNoLiveBots(
  db: Database,
  userId: string
): Promise<void> {
  const n = await countLiveBotsForOwner(db, userId);
  if (n > 0) {
    throw new OwnerHasBotsError(
      `user ${userId} has ${n} live bots; delete them first`
    );
  }
}

// ─── Approval requests ──────────────────────────────────────────────────────

// After migration 0065 the friend kind is gone (folded into
// community_friendship). Only join_server approval workflows remain.
export type ApprovalKind = "join_server";
export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalRequestRow = {
  id: string;
  botId: string;
  kind: ApprovalKind;
  serverId: string | null;
  requestedByUserId: string;
  dmMessageId: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
};

export async function getApprovalRequest(
  db: Database,
  id: string
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .select()
    .from(communityBotApprovalRequest)
    .where(eq(communityBotApprovalRequest.id, id))
    .limit(1);
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

export async function listPendingApprovalsForBot(
  db: Database,
  botId: string
): Promise<ApprovalRequestRow[]> {
  return (await db
    .select()
    .from(communityBotApprovalRequest)
    .where(
      and(
        eq(communityBotApprovalRequest.botId, botId),
        eq(communityBotApprovalRequest.status, "pending")
      )
    )) as ApprovalRequestRow[];
}

/**
 * Look up pending join_server approval for a given (botId, serverId). Used
 * as an idempotency guard before we write a duplicate DM card.
 */
export async function findPendingJoinRequest(
  db: Database,
  botId: string,
  serverId: string
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .select()
    .from(communityBotApprovalRequest)
    .where(
      and(
        eq(communityBotApprovalRequest.botId, botId),
        eq(communityBotApprovalRequest.serverId, serverId),
        eq(communityBotApprovalRequest.kind, "join_server"),
        eq(communityBotApprovalRequest.status, "pending")
      )
    )
    .limit(1);
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

/**
 * Statement-returning insert. Application layer enforces the
 * `kind = "join_server" ⇔ serverId != null` invariant (SQLite CHECK can't
 * cross-reference other tables cleanly). After migration 0065 only
 * `kind='join_server'` is supported — the friend flow lives in
 * `community_friendship`.
 */
export function createApprovalRequestStatement(
  db: Database,
  data: {
    botId: string;
    kind: ApprovalKind;
    serverId: string | null;
    requestedByUserId: string;
    dmMessageId: string;
  }
) {
  if (data.kind === "join_server" && !data.serverId) {
    throw new Error("createApprovalRequest: join_server requires serverId");
  }
  return db.insert(communityBotApprovalRequest).values({
    botId: data.botId,
    kind: data.kind,
    serverId: data.serverId,
    requestedByUserId: data.requestedByUserId,
    dmMessageId: data.dmMessageId,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
}

export async function resolveApprovalRequest(
  db: Database,
  id: string,
  status: "approved" | "denied"
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .update(communityBotApprovalRequest)
    .set({ status, resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(communityBotApprovalRequest.id, id),
        eq(communityBotApprovalRequest.status, "pending")
      )
    )
    .returning();
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

/**
 * Lookup an approval request row by its DM message id. Used by the DM card
 * hydrator to render approve/deny/approved/denied variants.
 */
export async function getApprovalRequestByDmMessageId(
  db: Database,
  dmMessageId: string
): Promise<ApprovalRequestRow | null> {
  const rows = await db
    .select()
    .from(communityBotApprovalRequest)
    .where(eq(communityBotApprovalRequest.dmMessageId, dmMessageId))
    .limit(1);
  return (rows[0] as ApprovalRequestRow | undefined) ?? null;
}

// ─── Machine cascade helpers ─────────────────────────────────────────────

/**
 * Verify a machine belongs to `ownerId` — used by /api/community/bots create
 * to gate machine ownership + look up available runtimes.
 */
export async function getMachineForOwner(
  db: Database,
  machineId: string,
  ownerId: string
): Promise<{
  id: string;
  availableRuntimes: Array<{
    id: string;
    version?: string;
    status?: "healthy" | "unhealthy";
    lastError?: string;
    lastErrorAt?: string;
  }>;
} | null> {
  const rows = await db
    .select({
      id: communityMachine.id,
      availableRuntimes: communityMachine.availableRuntimes,
    })
    .from(communityMachine)
    .where(and(eq(communityMachine.id, machineId), eq(communityMachine.userId, ownerId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  // Normalize: legacy rows store `string[]`, current rows store
  // `{id, version?, status?, lastError?, lastErrorAt?}[]`. Drop empty ids so
  // the route's `.includes()` / `.find()` checks can't be fooled by `""`.
  const raw = (r.availableRuntimes ?? []) as Array<unknown>;
  const normalized: Array<{
    id: string;
    version?: string;
    status?: "healthy" | "unhealthy";
    lastError?: string;
    lastErrorAt?: string;
  }> = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.length > 0) normalized.push({ id: entry });
    } else if (entry && typeof entry === "object") {
      const obj = entry as {
        id?: unknown;
        version?: unknown;
        status?: unknown;
        lastError?: unknown;
        lastErrorAt?: unknown;
      };
      if (typeof obj.id === "string" && obj.id.length > 0) {
        const status =
          obj.status === "unhealthy" ? "unhealthy" : obj.status === "healthy" ? "healthy" : undefined;
        normalized.push({
          id: obj.id,
          ...(typeof obj.version === "string" ? { version: obj.version } : {}),
          ...(status ? { status } : {}),
          ...(typeof obj.lastError === "string" ? { lastError: obj.lastError } : {}),
          ...(typeof obj.lastErrorAt === "string" ? { lastErrorAt: obj.lastErrorAt } : {}),
        });
      }
    }
  }
  return { id: r.id, availableRuntimes: normalized };
}
