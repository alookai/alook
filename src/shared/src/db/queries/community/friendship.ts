import { eq, and, or, isNull, inArray } from "drizzle-orm";
import {
  communityFriendship,
  communityUserProfile,
  communityMessage,
  communityDmConversation,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { isAccepted, isBlocked as isBlockedStatus } from "../../../utils/friendship";
import { WS_EVENTS } from "../../../community-ws-events";
import type {
  CommunityWsEvent,
  FriendApprovalPayload,
  FriendApprovalProfile,
} from "../../../community-ws-events";
import { createOrGetDM } from "./dm";
import { createMessage, listMessagesReferencingFriendship } from "./message";
import { nanoid } from "nanoid";

function newFriendshipId(): string {
  return "fr_" + nanoid();
}

/**
 * A WS payload the friend-graph queries want fanned out. The query layer can't
 * reach `broadcastToUserSafe` (web-side fanout), so it returns descriptors the
 * route relays verbatim: `broadcastToUserSafe(b.userId, b.event)`.
 */
export type FriendshipBroadcast = { userId: string; event: CommunityWsEvent };

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Approval-card projection ────────────────────────────────────────────────

type ProfileWithFlags = FriendApprovalProfile & {
  isBot: boolean;
  ownerUserId: string | null;
};

async function loadProfiles(
  db: Database,
  ids: string[]
): Promise<Map<string, ProfileWithFlags>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      discriminator: user.discriminator,
      image: user.image,
      isBot: user.isBot,
      ownerUserId: user.ownerUserId,
    })
    .from(user)
    .where(inArray(user.id, unique));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        discriminator: r.discriminator,
        image: r.image,
        isBot: !!r.isBot,
        ownerUserId: r.ownerUserId,
      },
    ])
  );
}

function toCardStatus(status: string): FriendApprovalPayload["status"] {
  if (status === "accepted") return "approved";
  if (status === "denied") return "denied";
  if (status === "superseded") return "superseded";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

function toProfile(p: ProfileWithFlags): FriendApprovalProfile {
  return { id: p.id, name: p.name, discriminator: p.discriminator, image: p.image };
}

/**
 * Project the per-viewer `approval` payload for one friend-approval card.
 * `viewerId` is the human DM owner reading the card; `dmPeerIds` are the two
 * DM participants (owner + the owner's bot). Returns null if the friendship is
 * missing from `profiles` (defensive — should not happen for a stamped card).
 */
function projectApproval(
  friendship: {
    id: string;
    requesterId: string;
    addresseeId: string;
    status: string;
    needsOwnerApproval: string | null;
  },
  viewerId: string,
  dmPeerIds: string[],
  profiles: Map<string, ProfileWithFlags>
): FriendApprovalPayload | null {
  // The DM's bot peer is the participant that isn't the viewer.
  const botPeerId = dmPeerIds.find((id) => id !== viewerId) ?? viewerId;
  const botProfile = profiles.get(botPeerId);
  // The friendship's other party is whichever side isn't this DM's bot.
  const otherId =
    friendship.requesterId === botPeerId ? friendship.addresseeId : friendship.requesterId;
  const otherProfile = profiles.get(otherId);
  if (!botProfile || !otherProfile) return null;

  const status = toCardStatus(friendship.status);
  let waitingOn: FriendApprovalPayload["waitingOn"] = null;
  let waitingOnProfile: FriendApprovalProfile | null = null;

  if (friendship.status === "pending") {
    if (friendship.needsOwnerApproval === viewerId) {
      waitingOn = "you";
    } else if (friendship.needsOwnerApproval != null) {
      waitingOn = "other-owner";
      const p = profiles.get(friendship.needsOwnerApproval);
      waitingOnProfile = p ? toProfile(p) : null;
    } else {
      // Pending with no gate → J2 after owner approved: waiting on the human
      // addressee to accept.
      waitingOn = "addressee";
      const p = profiles.get(friendship.addresseeId);
      waitingOnProfile = p ? toProfile(p) : null;
    }
  }

  return {
    friendshipId: friendship.id,
    status,
    waitingOn,
    otherProfile: toProfile(otherProfile),
    botProfile: toProfile(botProfile),
    waitingOnProfile,
  };
}

/** Pending-state fallback content stored on a card message. */
function cardContent(otherName: string, botName: string): string {
  return `${otherName} wants to be friends with ${botName}. Approve?`;
}

/**
 * Build `DM_MESSAGE_UPDATED` broadcasts for every card referencing a
 * friendship. One event per (message, human-owner peer) — the bot peer has no
 * session, so it's skipped. Each carries the fresh per-viewer projection.
 */
async function buildCardUpdateBroadcasts(
  db: Database,
  friendship: {
    id: string;
    requesterId: string;
    addresseeId: string;
    status: string;
    needsOwnerApproval: string | null;
  }
): Promise<FriendshipBroadcast[]> {
  const refs = await listMessagesReferencingFriendship(db, friendship.id);
  if (refs.length === 0) return [];
  const allPeerIds = refs.flatMap((r) => r.peerUserIds);
  const profiles = await loadProfiles(db, [
    ...allPeerIds,
    friendship.requesterId,
    friendship.addresseeId,
    ...(friendship.needsOwnerApproval ? [friendship.needsOwnerApproval] : []),
  ]);
  const broadcasts: FriendshipBroadcast[] = [];
  for (const ref of refs) {
    // The human owner peer is the non-bot participant.
    const ownerId = ref.peerUserIds.find((id) => !profiles.get(id)?.isBot);
    if (!ownerId) continue;
    const approval = projectApproval(friendship, ownerId, ref.peerUserIds, profiles);
    if (!approval) continue;
    broadcasts.push({
      userId: ownerId,
      event: {
        type: WS_EVENTS.DM_MESSAGE_UPDATED,
        dmConversationId: ref.dmConversationId,
        messageId: ref.messageId,
        approval,
      },
    });
  }
  return broadcasts;
}

// Re-export from the client-safe constants module so existing
// `queries.communityFriendship.isSelfBotFriendship` call-sites keep working
// without any behavior change. Client-side components should import from
// `@alook/shared` directly instead of going through `queries`.
import {
  SELF_BOT_FRIENDSHIP_PREFIX,
  isSelfBotFriendship,
} from "../../../constants";
export { SELF_BOT_FRIENDSHIP_PREFIX, isSelfBotFriendship };

type FriendshipRow = typeof communityFriendship.$inferSelect;

/**
 * Look up any ACTIVE (pending | accepted | blocked) friendship row between two
 * users, in either direction. Terminal rows (denied / superseded) are excluded
 * — the direction-agnostic active constraint `uq_friendship_active` only covers
 * pending|accepted, and blocked is the other live relationship state, so those
 * three are the ones a fresh request must reckon with. A denied/superseded row
 * from a past attempt must NOT block a new request.
 */
async function findActive(
  db: Database,
  userA: string,
  userB: string,
): Promise<FriendshipRow | null> {
  const rows = await db
    .select()
    .from(communityFriendship)
    .where(
      and(
        inArray(communityFriendship.status, ["pending", "accepted", "blocked"]),
        or(
          and(
            eq(communityFriendship.requesterId, userA),
            eq(communityFriendship.addresseeId, userB),
          ),
          and(
            eq(communityFriendship.requesterId, userB),
            eq(communityFriendship.addresseeId, userA),
          ),
        ),
      ),
    );
  return rows[0] ?? null;
}

/** Bot? owner? — the two flags `sendRequest` needs to compute the gate. */
async function loadBotFlags(
  db: Database,
  ids: string[]
): Promise<Map<string, { isBot: boolean; ownerUserId: string | null; name: string }>> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select({
      id: user.id,
      isBot: user.isBot,
      ownerUserId: user.ownerUserId,
      name: user.name,
    })
    .from(user)
    .where(inArray(user.id, unique));
  return new Map(
    rows.map((r) => [r.id, { isBot: !!r.isBot, ownerUserId: r.ownerUserId, name: r.name }])
  );
}

export type SendRequestOutcome =
  | { kind: "auto_accepted"; friendship: FriendshipRow; broadcasts: FriendshipBroadcast[]; supersededIds: string[] }
  | {
      kind: "created";
      friendship: FriendshipRow;
      cardMessage?: { id: string; authorId: string; content: string; createdAt: string; approval: FriendApprovalPayload };
      broadcasts: FriendshipBroadcast[];
      /** Ids of rows this request superseded — the route logs
       *  `BOT_FRIEND_REQUEST_SUPERSEDED` for each. Empty on a first request. */
      supersededIds: string[];
    };

/**
 * Send a friend request — the single entry point for the human route AND the
 * agent route. Supersede-before-write lives here so every caller gets it
 * uniformly. See plans/agent-friendship-approval-gate.md §sendRequest.
 *
 * Throws `Error("blocked")` if a blocked row exists between the pair.
 * Throws `Error("already friends")` / `Error("friend request already sent")`
 * on the UNIQUE-conflict loser branch so the route can map them to 409s.
 */
export async function sendRequest(
  db: Database,
  data: { requesterId: string; addresseeId: string },
): Promise<SendRequestOutcome> {
  if (data.requesterId === data.addresseeId) {
    throw new Error("cannot friend yourself");
  }

  const existing = await findActive(db, data.requesterId, data.addresseeId);
  if (existing && isBlockedStatus(existing.status)) {
    throw new Error("blocked");
  }

  // Step 2: crossover auto-accept — only when the peer's pending row has no
  // owner gate. A bot-touched peer row still needs its gate to clear.
  if (
    existing &&
    existing.status === "pending" &&
    existing.requesterId === data.addresseeId &&
    existing.addresseeId === data.requesterId &&
    existing.needsOwnerApproval == null
  ) {
    const [updated] = await db
      .update(communityFriendship)
      .set({ status: "accepted", resolvedAt: nowIso(), updatedAt: nowIso() })
      .where(
        and(
          eq(communityFriendship.id, existing.id),
          eq(communityFriendship.status, "pending"),
        ),
      )
      .returning();
    if (updated) {
      // Notify the original requester (the peer) as if they'd been accepted,
      // and rehydrate any DM approval card referencing this row (a J2 card that
      // was "Approved — waiting on <addressee>" flips to "Approved").
      return {
        kind: "auto_accepted",
        friendship: updated,
        supersededIds: [],
        broadcasts: [
          {
            userId: updated.requesterId,
            event: { type: WS_EVENTS.FRIEND_ACCEPT, friendshipId: updated.id },
          },
          ...(await buildCardUpdateBroadcasts(db, updated)),
        ],
      };
    }
    // Lost the race — fall through to supersede+insert.
  }

  // Step 4: determine the owner gate.
  const flags = await loadBotFlags(db, [data.requesterId, data.addresseeId]);
  const requester = flags.get(data.requesterId);
  const addressee = flags.get(data.addresseeId);

  // Sibling bots (same owner) auto-accept with no gate and no card — the one
  // sibling path, shared by every caller. Delegate to `ensureSiblingBotFriendship`
  // (also called by the createBot backfill) so both entry points stay in sync.
  if (
    requester?.isBot &&
    addressee?.isBot &&
    requester.ownerUserId &&
    requester.ownerUserId === addressee.ownerUserId
  ) {
    const sib = await ensureSiblingBotFriendship(db, {
      botA: data.requesterId,
      botB: data.addresseeId,
    });
    if (sib.blocked) throw new Error("blocked");
    const friendship = await getFriendship(db, sib.friendshipId);
    if (!friendship) throw new Error("already friends");
    return { kind: "auto_accepted", friendship, broadcasts: [], supersededIds: [] };
  }

  let needsOwnerApproval: string | null = null;
  if (requester?.isBot) {
    needsOwnerApproval = requester.ownerUserId;
  } else if (addressee?.isBot) {
    needsOwnerApproval = addressee.ownerUserId;
  }

  // Step 3 + 5: supersede any active pending row (either direction) and insert
  // the fresh pending row in ONE arbiter batch. The partial unique index
  // `uq_friendship_active` is the concurrency arbiter — a racing caller's
  // INSERT surfaces a UNIQUE conflict.
  const supersededIds =
    existing && existing.status === "pending" ? [existing.id] : [];
  const supersedeStmt = db
    .update(communityFriendship)
    .set({ status: "superseded", resolvedAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        inArray(communityFriendship.status, ["pending"]),
        or(
          and(
            eq(communityFriendship.requesterId, data.requesterId),
            eq(communityFriendship.addresseeId, data.addresseeId),
          ),
          and(
            eq(communityFriendship.requesterId, data.addresseeId),
            eq(communityFriendship.addresseeId, data.requesterId),
          ),
        ),
      ),
    );
  const newId = newFriendshipId();
  const insertStmt = db
    .insert(communityFriendship)
    .values({
      id: newId,
      requesterId: data.requesterId,
      addresseeId: data.addresseeId,
      status: "pending",
      needsOwnerApproval,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning();

  let inserted: FriendshipRow;
  try {
    const results = (await db.batch([supersedeStmt, insertStmt] as any)) as any[];
    const rows = results[results.length - 1] as FriendshipRow[];
    inserted = rows[0]!;
  } catch (err) {
    // Step 6: UNIQUE-conflict loser — re-SELECT the surviving row and branch.
    const survivor = await findActive(db, data.requesterId, data.addresseeId);
    if (survivor && isAccepted(survivor.status)) {
      throw new Error("already friends");
    }
    if (survivor && survivor.status === "pending") {
      throw new Error("friend request already sent");
    }
    throw err;
  }

  // Broadcasts for any superseded card(s) — rehydrate as "Replaced".
  const broadcasts: FriendshipBroadcast[] = [];
  for (const id of supersededIds) {
    const superseded = await getFriendship(db, id);
    if (superseded) {
      broadcasts.push(...(await buildCardUpdateBroadcasts(db, superseded)));
    }
  }

  // Step 7/8: gate → DM card + DM_NEW_MESSAGE to owner; else FRIEND_REQUEST.
  if (needsOwnerApproval != null) {
    // The card lives in the gating owner's DM with THEIR bot. The bot is
    // whichever party is the bot owned by `needsOwnerApproval`.
    const botId =
      requester?.isBot && requester.ownerUserId === needsOwnerApproval
        ? data.requesterId
        : data.addresseeId;
    const otherId = botId === data.requesterId ? data.addresseeId : data.requesterId;
    const dm = await createOrGetDM(db, { userId1: botId, userId2: needsOwnerApproval });
    const profiles = await loadProfiles(db, [botId, otherId, needsOwnerApproval, inserted.addresseeId]);
    const botP = profiles.get(botId);
    const otherP = profiles.get(otherId);
    const content = cardContent(otherP?.name ?? "Someone", botP?.name ?? "your bot");
    const msg = await createMessage(db, {
      authorId: botId,
      dmConversationId: dm.id,
      content,
      friendshipId: inserted.id,
    });
    const approval =
      projectApproval(inserted, needsOwnerApproval, [botId, needsOwnerApproval], profiles) ?? undefined;
    broadcasts.push({
      userId: needsOwnerApproval,
      event: {
        type: WS_EVENTS.DM_NEW_MESSAGE,
        dmConversationId: dm.id,
        message: {
          id: msg.id,
          authorId: botId,
          authorName: botP?.name ?? "",
          content: msg.content,
          createdAt: msg.createdAt,
          ...(approval ? { approval } : {}),
        },
      },
    });
    return {
      kind: "created",
      friendship: inserted,
      cardMessage: approval
        ? { id: msg.id, authorId: botId, content: msg.content, createdAt: msg.createdAt, approval }
        : undefined,
      broadcasts,
      supersededIds,
    };
  }

  // No gate — ordinary human→human request.
  broadcasts.push({
    userId: data.addresseeId,
    event: {
      type: WS_EVENTS.FRIEND_REQUEST,
      friendship: {
        id: inserted.id,
        requesterId: inserted.requesterId,
        addresseeId: inserted.addresseeId,
        status: "pending",
        createdAt: inserted.createdAt,
      },
    },
  });
  return { kind: "created", friendship: inserted, broadcasts, supersededIds };
}

export type AcceptRequestResult =
  | { ok: false; reason: "not_pending" | "gated" }
  | { ok: true; friendship: FriendshipRow; broadcasts: FriendshipBroadcast[] };

/**
 * Accept a pending request. Permitted only for the addressee on an ungated row
 * (`needsOwnerApproval IS NULL`). Returns broadcasts: FRIEND_ACCEPT to the
 * requester plus DM_MESSAGE_UPDATED for every card referencing the row (flips a
 * J2 owner-approve card from "waiting on <addressee>" to "Approved").
 */
export async function acceptRequest(
  db: Database,
  data: { friendshipId: string; actorId: string }
): Promise<AcceptRequestResult> {
  const row = await getFriendship(db, data.friendshipId);
  if (!row || row.status !== "pending") return { ok: false, reason: "not_pending" };
  if (row.needsOwnerApproval != null) return { ok: false, reason: "gated" };
  if (row.addresseeId !== data.actorId) return { ok: false, reason: "gated" };

  const rows = await db
    .update(communityFriendship)
    .set({ status: "accepted", resolvedAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        eq(communityFriendship.id, data.friendshipId),
        eq(communityFriendship.status, "pending"),
        isNull(communityFriendship.needsOwnerApproval),
      ),
    )
    .returning();
  const updated = rows[0];
  if (!updated) return { ok: false, reason: "not_pending" };

  const broadcasts: FriendshipBroadcast[] = [
    {
      userId: updated.requesterId,
      event: { type: WS_EVENTS.FRIEND_ACCEPT, friendshipId: updated.id },
    },
    ...(await buildCardUpdateBroadcasts(db, updated)),
  ];
  return { ok: true, friendship: updated, broadcasts };
}

/**
 * Reject a pending request (human addressee/requester tearing down). Atomic on
 * `status='pending' AND needsOwnerApproval IS NULL` — a still-gated row can't
 * be rejected directly (target-consent guardrail). Returns the denied row plus
 * the DM_MESSAGE_UPDATED fanout for every card referencing it — symmetric with
 * `acceptRequest`, so a J2 owner-approve card flips from "waiting on
 * <addressee>" to "Denied" instead of lingering. `row` is null (broadcasts: [])
 * if the row is no longer an ungated pending row.
 */
export async function rejectRequest(
  db: Database,
  friendshipId: string
): Promise<{ row: FriendshipRow | null; broadcasts: FriendshipBroadcast[] }> {
  const rows = await db
    .update(communityFriendship)
    .set({ status: "denied", resolvedAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        eq(communityFriendship.id, friendshipId),
        eq(communityFriendship.status, "pending"),
        isNull(communityFriendship.needsOwnerApproval),
      ),
    )
    .returning();
  const row = rows[0] ?? null;
  if (!row) return { row: null, broadcasts: [] };
  return { row, broadcasts: await buildCardUpdateBroadcasts(db, row) };
}

export async function removeFriend(db: Database, friendshipId: string) {
  const rows = await db
    .delete(communityFriendship)
    .where(eq(communityFriendship.id, friendshipId))
    .returning();
  return rows[0]!;
}

export type BlockOutcome = {
  /** The fresh blocked row inserted by this call. */
  row: typeof communityFriendship.$inferSelect;
  /** Friendship id that was deleted to make room, if any. The route uses this
   *  to broadcast a `friend.remove` so the other side's UI stays consistent. */
  removedFriendshipId: string | null;
  /** DM_MESSAGE_UPDATED fanout for any approval card referencing a pending row
   *  this block soft-cancelled — a gating owner's Approve/Deny card or a J2
   *  "waiting on <addressee>" chip — so it rehydrates to a non-actionable
   *  "cancelled" chip instead of pointing at a now-gone row. Empty when the
   *  torn-down pending row had no card (or the block tore down nothing). */
  broadcasts: FriendshipBroadcast[];
}

export async function block(
  db: Database,
  data: { blockerId: string; targetId: string },
): Promise<BlockOutcome> {
  const existing = await findActive(db, data.blockerId, data.targetId);

  let removedFriendshipId: string | null = null;
  const broadcasts: FriendshipBroadcast[] = [];
  if (existing) {
    if (isBlockedStatus(existing.status)) {
      // Already blocked — keep it idempotent; just refresh `updatedAt` so
      // anyone re-issuing the block sees a current timestamp.
      const rows = await db
        .update(communityFriendship)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(communityFriendship.id, existing.id))
        .returning();
      return { row: rows[0]!, removedFriendshipId: null, broadcasts: [] };
    }
    if (existing.status === "pending") {
      // A pending row may carry a live approval card in the owner's DM — an
      // actionable Approve/Deny (gated), or a non-actionable "Approved —
      // waiting on <addressee>" chip after a J2 owner-approve (ungated, still
      // pending). Soft-cancel it (terminal, so it leaves the
      // `uq_friendship_active` predicate and the blocked row inserts cleanly)
      // and rehydrate the card to a "cancelled" chip, rather than hard-deleting
      // and orphaning it. Mirrors the withdraw path (cancelPendingRequest);
      // buildCardUpdateBroadcasts returns [] when no card references the row.
      const rows = await db
        .update(communityFriendship)
        .set({ status: "cancelled", resolvedAt: nowIso(), updatedAt: nowIso() })
        .where(eq(communityFriendship.id, existing.id))
        .returning();
      const cancelled = rows[0];
      if (cancelled) broadcasts.push(...(await buildCardUpdateBroadcasts(db, cancelled)));
    } else {
      // Accepted: no owner card to preserve. Wipe the row so the blocker's row
      // is the single source of truth instead of leaving a hybrid
      // status='blocked' entry whose requester/addressee ordering may not match
      // the blocker. Tell the route to broadcast friend.remove.
      await db
        .delete(communityFriendship)
        .where(eq(communityFriendship.id, existing.id));
      removedFriendshipId = existing.id;
    }
  }

  const rows = await db
    .insert(communityFriendship)
    .values({
      requesterId: data.blockerId,
      addresseeId: data.targetId,
      status: "blocked",
      blockerId: data.blockerId,
    })
    .returning();
  return { row: rows[0]!, removedFriendshipId, broadcasts };
}

export async function unblock(
  db: Database,
  data: { blockerId: string; targetId: string }
) {
  // Find the blocked row in either direction where blockerId matches
  const existing = await db
    .select()
    .from(communityFriendship)
    .where(
      and(
        eq(communityFriendship.status, "blocked"),
        eq(communityFriendship.blockerId, data.blockerId),
        or(
          and(
            eq(communityFriendship.requesterId, data.blockerId),
            eq(communityFriendship.addresseeId, data.targetId)
          ),
          and(
            eq(communityFriendship.requesterId, data.targetId),
            eq(communityFriendship.addresseeId, data.blockerId)
          )
        )
      )
    );

  if (!existing[0]) return null;

  const rows = await db
    .delete(communityFriendship)
    .where(eq(communityFriendship.id, existing[0].id))
    .returning();
  return rows[0]!;
}

export async function listFriends(db: Database, userId: string) {
  // Filter deletedAt IS NULL — a soft-deleted friend (bot or human) is hidden
  // from the friend list. Return shape MUST NOT include isBot/ownerUserId:
  // Bob's friend list must render zoe (someone else's bot) indistinguishably
  // from a human friend.
  const asRequester = await db
    .select({
      id: communityFriendship.id,
      friendUserId: user.id,
      friendName: user.name,
      friendEmail: user.email,
      friendImage: user.image,
      friendDiscriminator: user.discriminator,
      aboutMe: communityUserProfile.aboutMe,
      statusEmoji: communityUserProfile.statusEmoji,
      statusText: communityUserProfile.statusText,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.addresseeId))
    .leftJoin(communityUserProfile, eq(communityUserProfile.userId, user.id))
    .where(
      and(
        eq(communityFriendship.requesterId, userId),
        eq(communityFriendship.status, "accepted"),
        isNull(user.deletedAt)
      )
    );

  const asAddressee = await db
    .select({
      id: communityFriendship.id,
      friendUserId: user.id,
      friendName: user.name,
      friendEmail: user.email,
      friendImage: user.image,
      friendDiscriminator: user.discriminator,
      aboutMe: communityUserProfile.aboutMe,
      statusEmoji: communityUserProfile.statusEmoji,
      statusText: communityUserProfile.statusText,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.requesterId))
    .leftJoin(communityUserProfile, eq(communityUserProfile.userId, user.id))
    .where(
      and(
        eq(communityFriendship.addresseeId, userId),
        eq(communityFriendship.status, "accepted"),
        isNull(user.deletedAt)
      )
    );

  // Owner ↔ own-bot rows are surfaced here too — bots the caller owns must
  // appear in the Friends tab so the owner can DM / mention / @-them from
  // the same surface as any other friend. No real `communityFriendship` row
  // exists for these pairs; the id is prefixed `self-bot:` so callers can
  // detect + skip friendship-only actions (remove-friend, block).
  const ownBots = await db
    .select({
      botUserId: user.id,
      botName: user.name,
      botEmail: user.email,
      botImage: user.image,
      botDiscriminator: user.discriminator,
      aboutMe: communityUserProfile.aboutMe,
      statusEmoji: communityUserProfile.statusEmoji,
      statusText: communityUserProfile.statusText,
    })
    .from(user)
    .leftJoin(communityUserProfile, eq(communityUserProfile.userId, user.id))
    .where(
      and(
        eq(user.ownerUserId, userId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    );
  const ownBotRows = ownBots.map((b) => ({
    id: SELF_BOT_FRIENDSHIP_PREFIX + b.botUserId,
    friendUserId: b.botUserId,
    friendName: b.botName,
    friendEmail: b.botEmail,
    friendImage: b.botImage,
    friendDiscriminator: b.botDiscriminator,
    aboutMe: b.aboutMe,
    statusEmoji: b.statusEmoji,
    statusText: b.statusText,
  }));

  return [...asRequester, ...asAddressee, ...ownBotRows];
}

/**
 * Ids-only variant of `listFriends` — no name/email/image columns. Used on
 * hot paths that only need "who is this user's friend" (WS presence
 * fan-out via `ws-durable.ts`'s `getPresenceAudience`, and the
 * `/friends/presence` bulk-check route).
 *
 * DOES include the owner↔own-bot implicit friendship (same rule as
 * `areFriends`/`listFriends` — no real `communityFriendship` row exists for
 * the pair, but they act like friends everywhere), because both real
 * callers are presence checks and a bot's presence is meaningless without
 * its owner in the audience. An earlier revision deliberately excluded
 * these rows here (to match `listFriends`' "no join" cost-saving, not
 * realizing that trimmed the whole reason a bot's owner needs to be in this
 * list) — that's what caused a bot's owner to never learn about its own
 * presence, see plans/community-account-debt-fixes.md Fix 3 hotfix.
 */
export async function getFriendUserIds(db: Database, userId: string): Promise<string[]> {
  const [rows, selfBotRows] = await Promise.all([
    db
      .select({
        requesterId: communityFriendship.requesterId,
        addresseeId: communityFriendship.addresseeId,
      })
      .from(communityFriendship)
      .where(
        and(
          eq(communityFriendship.status, "accepted"),
          or(
            eq(communityFriendship.requesterId, userId),
            eq(communityFriendship.addresseeId, userId),
          ),
        ),
      ),
    db
      .select({ id: user.id, ownerUserId: user.ownerUserId })
      .from(user)
      .where(
        and(
          eq(user.isBot, true),
          or(eq(user.id, userId), eq(user.ownerUserId, userId)),
          isNull(user.deletedAt)
        )
      ),
  ]);
  const friendIds = rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId));
  const selfBotIds = selfBotRows
    .map((r) => (r.id === userId ? r.ownerUserId : r.id))
    .filter((id): id is string => !!id);

  // Filter out any side of the implicit friendship whose OWNER is
  // soft-deleted. The `selfBotRows` query already skips soft-deleted
  // BOT rows via `isNull(user.deletedAt)`, but a bot's owner may be
  // soft-deleted while the bot itself lives on. Without this second
  // filter, `getPresenceAudience(botId)` would keep including the
  // tombstoned owner's id forever — every presence flip would fire a
  // DO fetch to a dead account for the life of the binding.
  const otherSideIds = selfBotIds.filter((id) => id !== userId);
  if (otherSideIds.length === 0) {
    return [...new Set([...friendIds, ...selfBotIds])];
  }
  const liveOthers = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.id, otherSideIds), isNull(user.deletedAt)));
  const liveOtherSet = new Set(liveOthers.map((r) => r.id));
  const liveSelfBotIds = selfBotIds.filter((id) => liveOtherSet.has(id));
  return [...new Set([...friendIds, ...liveSelfBotIds])];
}

/**
 * Are two users in an `accepted` friendship? Direction-agnostic. Used by the
 * bot-server-add flow (friend-of-bot path) and DM peer allow-list.
 */
export async function areFriends(
  db: Database,
  userA: string,
  userB: string
): Promise<boolean> {
  // Owner ↔ own-bot is an implicit friendship (no row exists but they act
  // like friends everywhere). Check both directions so callers don't have to
  // know which side is the bot.
  const selfBotRows = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.isBot, true),
        or(
          and(eq(user.id, userA), eq(user.ownerUserId, userB)),
          and(eq(user.id, userB), eq(user.ownerUserId, userA))
        )
      )
    )
    .limit(1);
  if (selfBotRows.length > 0) return true;

  const rows = await db
    .select({ id: communityFriendship.id })
    .from(communityFriendship)
    .where(
      and(
        eq(communityFriendship.status, "accepted"),
        or(
          and(
            eq(communityFriendship.requesterId, userA),
            eq(communityFriendship.addresseeId, userB)
          ),
          and(
            eq(communityFriendship.requesterId, userB),
            eq(communityFriendship.addresseeId, userA)
          )
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function getFriendship(db: Database, friendshipId: string) {
  const rows = await db
    .select()
    .from(communityFriendship)
    .where(eq(communityFriendship.id, friendshipId));
  return rows[0] ?? null;
}

export async function isBlocked(
  db: Database,
  userId1: string,
  userId2: string
) {
  const rows = await db
    .select()
    .from(communityFriendship)
    .where(
      and(
        eq(communityFriendship.status, "blocked"),
        or(
          and(
            eq(communityFriendship.requesterId, userId1),
            eq(communityFriendship.addresseeId, userId2)
          ),
          and(
            eq(communityFriendship.requesterId, userId2),
            eq(communityFriendship.addresseeId, userId1)
          )
        )
      )
    );
  return rows.length > 0;
}

export async function listBlocked(db: Database, userId: string) {
  const asRequester = await db
    .select({
      id: communityFriendship.id,
      blockedUserId: user.id,
      blockedName: user.name,
      blockedImage: user.image,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.addresseeId))
    .where(
      and(
        eq(communityFriendship.requesterId, userId),
        eq(communityFriendship.status, "blocked"),
        eq(communityFriendship.blockerId, userId)
      )
    );

  const asAddressee = await db
    .select({
      id: communityFriendship.id,
      blockedUserId: user.id,
      blockedName: user.name,
      blockedImage: user.image,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.requesterId))
    .where(
      and(
        eq(communityFriendship.addresseeId, userId),
        eq(communityFriendship.status, "blocked"),
        eq(communityFriendship.blockerId, userId)
      )
    );

  return [...asRequester, ...asAddressee];
}

/**
 * The friend page's pending buckets for a human viewer. Direction-aware, one
 * row shape everywhere (no `source` tag). Every row carries
 * `needsOwnerApproval` so the UI can branch (actionable vs "Waiting on <owner>"
 * chip). See plans/agent-friendship-approval-gate.md §Read model.
 *
 * - incoming: act-on-me rows — `addresseeId=viewer AND status=pending AND
 *   needsOwnerApproval IS NULL`. A bot→human request only surfaces here once
 *   the requester's owner has approved (target-consent guardrail).
 * - outgoing: `requesterId=viewer AND status=pending`, PLUS the outgoing
 *   pendings of the viewer's own bots (`requesterId IN (viewer's bots)`), so a
 *   bot's request is legible without opening the DM.
 *
 * Rows gated purely on the viewer as another party's owner
 * (`needsOwnerApproval=viewer`, requester not one of the viewer's bots) are
 * decided via the DM approval card, not the pending page, so they are not
 * queried here.
 */
export async function listPending(db: Database, userId: string) {
  const ownBotIds = (
    await db
      .select({ id: user.id })
      .from(user)
      .where(
        and(eq(user.ownerUserId, userId), eq(user.isBot, true), isNull(user.deletedAt))
      )
  ).map((r) => r.id);

  const rowProjection = {
    id: communityFriendship.id,
    userId: user.id,
    name: user.name,
    discriminator: user.discriminator,
    image: user.image,
    aboutMe: communityUserProfile.aboutMe,
    statusEmoji: communityUserProfile.statusEmoji,
    statusText: communityUserProfile.statusText,
    createdAt: communityFriendship.createdAt,
    needsOwnerApproval: communityFriendship.needsOwnerApproval,
    requesterId: communityFriendship.requesterId,
  } as const;

  const incoming = await db
    .select(rowProjection)
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.requesterId))
    .leftJoin(communityUserProfile, eq(communityUserProfile.userId, user.id))
    .where(
      and(
        eq(communityFriendship.addresseeId, userId),
        eq(communityFriendship.status, "pending"),
        isNull(communityFriendship.needsOwnerApproval)
      )
    );

  // Own outgoing + own bots' outgoing. The peer displayed is the addressee.
  const outgoingRequesterIds = [userId, ...ownBotIds];
  const outgoing = await db
    .select(rowProjection)
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.addresseeId))
    .leftJoin(communityUserProfile, eq(communityUserProfile.userId, user.id))
    .where(
      and(
        inArray(communityFriendship.requesterId, outgoingRequesterIds),
        eq(communityFriendship.status, "pending")
      )
    );

  // Only incoming + outgoing render on the pending page. Owner-gated J1 rows
  // (a stranger→owner's-bot request) are actioned in the DM approval card, not
  // here, so they aren't queried. A bot-outgoing row gated on its own owner is
  // already covered by `outgoing` (requesterId ∈ owner's bots), where it stays
  // legible. Dedup by id in case a row satisfies both queries.
  const seen = new Set<string>();
  const merged: Array<
    (typeof incoming)[number] & { kind: "incoming" | "outgoing" }
  > = [];
  for (const r of incoming) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push({ ...r, kind: "incoming" });
  }
  for (const r of outgoing) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push({ ...r, kind: "outgoing" });
  }
  return merged;
}

// ─── Owner decision (approve / deny) ─────────────────────────────────────────

export type OwnerDecisionResult =
  | { ok: false; reason: "forbidden" | "already_resolved" }
  | { ok: true; friendship: FriendshipRow; broadcasts: FriendshipBroadcast[] };

/**
 * The bot owner approves or denies a gated friendship row via a DM card.
 * One function, all four cases (deny + three approve sub-cases). See
 * plans/agent-friendship-approval-gate.md §ownerDecideOnRow.
 *
 * Auth: `actorId` must equal the row's current `needsOwnerApproval` (else
 * forbidden). Compare-and-set on `status='pending' AND needsOwnerApproval=?`
 * so a decision racing a concurrent supersede finds zero rows → already_resolved.
 */
export async function ownerDecideOnRow(
  db: Database,
  data: { friendshipId: string; actorId: string; decision: "approve" | "deny" }
): Promise<OwnerDecisionResult> {
  const row = await getFriendship(db, data.friendshipId);
  if (!row) return { ok: false, reason: "already_resolved" };
  // Auth precedes CAS — a prior gating owner (gate already walked) gets 403.
  if (row.needsOwnerApproval !== data.actorId) return { ok: false, reason: "forbidden" };

  const flags = await loadBotFlags(db, [row.requesterId, row.addresseeId]);
  const requesterIsBot = !!flags.get(row.requesterId)?.isBot;
  const addresseeIsBot = !!flags.get(row.addresseeId)?.isBot;
  const addresseeOwner = flags.get(row.addresseeId)?.ownerUserId ?? null;

  if (data.decision === "deny") {
    const updated = await casTransition(db, data.friendshipId, data.actorId, {
      status: "denied",
      resolvedAt: nowIso(),
      needsOwnerApproval: null,
    });
    if (!updated) return { ok: false, reason: "already_resolved" };
    // Silent deny — only the deciding owner's card updates; no requester push.
    return { ok: true, friendship: updated, broadcasts: await buildCardUpdateBroadcasts(db, updated) };
  }

  // approve
  if (requesterIsBot && addresseeIsBot) {
    // J3 — two-hop.
    if (row.requesterId && flags.get(row.requesterId)?.ownerUserId === data.actorId) {
      // First hop: walk the gate to the addressee bot's owner + write a fresh
      // card in that owner's DM with their bot.
      const updated = await casTransition(db, data.friendshipId, data.actorId, {
        needsOwnerApproval: addresseeOwner,
      });
      if (!updated) return { ok: false, reason: "already_resolved" };
      const broadcasts: FriendshipBroadcast[] = [];
      if (addresseeOwner) {
        const dm = await createOrGetDM(db, { userId1: row.addresseeId, userId2: addresseeOwner });
        const profiles = await loadProfiles(db, [row.addresseeId, row.requesterId, addresseeOwner]);
        const botP = profiles.get(row.addresseeId);
        const otherP = profiles.get(row.requesterId);
        const content = cardContent(otherP?.name ?? "Someone", botP?.name ?? "your bot");
        const msg = await createMessage(db, {
          authorId: row.addresseeId,
          dmConversationId: dm.id,
          content,
          friendshipId: updated.id,
        });
        const approval = projectApproval(updated, addresseeOwner, [row.addresseeId, addresseeOwner], profiles);
        if (approval) {
          broadcasts.push({
            userId: addresseeOwner,
            event: {
              type: WS_EVENTS.DM_NEW_MESSAGE,
              dmConversationId: dm.id,
              message: {
                id: msg.id,
                authorId: row.addresseeId,
                authorName: botP?.name ?? "",
                content: msg.content,
                createdAt: msg.createdAt,
                approval,
              },
            },
          });
        }
      }
      // Rehydrate the first-hop card as "waiting on <target owner>".
      broadcasts.push(...(await buildCardUpdateBroadcasts(db, updated)));
      return { ok: true, friendship: updated, broadcasts };
    }
    // Second hop (actor is the addressee bot's owner): accept, no FRIEND_ACCEPT.
    const updated = await casTransition(db, data.friendshipId, data.actorId, {
      status: "accepted",
      resolvedAt: nowIso(),
      needsOwnerApproval: null,
    });
    if (!updated) return { ok: false, reason: "already_resolved" };
    return { ok: true, friendship: updated, broadcasts: await buildCardUpdateBroadcasts(db, updated) };
  }

  if (requesterIsBot && !addresseeIsBot) {
    // J2 — unlock outbound intent; row stays pending, human addressee accepts next.
    const updated = await casTransition(db, data.friendshipId, data.actorId, {
      needsOwnerApproval: null,
    });
    if (!updated) return { ok: false, reason: "already_resolved" };
    const broadcasts: FriendshipBroadcast[] = [
      {
        userId: row.addresseeId,
        event: {
          type: WS_EVENTS.FRIEND_REQUEST,
          friendship: {
            id: updated.id,
            requesterId: updated.requesterId,
            addresseeId: updated.addresseeId,
            status: "pending",
            createdAt: updated.createdAt,
          },
        },
      },
      ...(await buildCardUpdateBroadcasts(db, updated)),
    ];
    return { ok: true, friendship: updated, broadcasts };
  }

  // J1 — requester is human, addressee is bot: accept outright.
  const updated = await casTransition(db, data.friendshipId, data.actorId, {
    status: "accepted",
    resolvedAt: nowIso(),
    needsOwnerApproval: null,
  });
  if (!updated) return { ok: false, reason: "already_resolved" };
  const broadcasts: FriendshipBroadcast[] = [
    {
      userId: updated.requesterId,
      event: { type: WS_EVENTS.FRIEND_ACCEPT, friendshipId: updated.id },
    },
    ...(await buildCardUpdateBroadcasts(db, updated)),
  ];
  return { ok: true, friendship: updated, broadcasts };
}

/**
 * Compare-and-set update gated on `id=? AND status='pending' AND
 * needsOwnerApproval=actorId`. Returns the updated row or null (race lost).
 */
async function casTransition(
  db: Database,
  friendshipId: string,
  actorId: string,
  set: Partial<{
    status: string;
    resolvedAt: string;
    needsOwnerApproval: string | null;
  }>
): Promise<FriendshipRow | null> {
  const rows = await db
    .update(communityFriendship)
    .set({ ...set, updatedAt: nowIso() })
    .where(
      and(
        eq(communityFriendship.id, friendshipId),
        eq(communityFriendship.status, "pending"),
        eq(communityFriendship.needsOwnerApproval, actorId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

// ─── Supersede ───────────────────────────────────────────────────────────────

/**
 * Direction-agnostic, atomic supersede of any active pending row between two
 * users. Returns the superseded rows + the DM_MESSAGE_UPDATED fanout for every
 * card referencing them (rehydrate as "Replaced"). No-op on non-pending rows.
 */
export async function supersedePendingBetween(
  db: Database,
  data: { userA: string; userB: string }
): Promise<{ superseded: FriendshipRow[]; broadcasts: FriendshipBroadcast[] }> {
  const rows = await db
    .update(communityFriendship)
    .set({ status: "superseded", resolvedAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        eq(communityFriendship.status, "pending"),
        or(
          and(
            eq(communityFriendship.requesterId, data.userA),
            eq(communityFriendship.addresseeId, data.userB),
          ),
          and(
            eq(communityFriendship.requesterId, data.userB),
            eq(communityFriendship.addresseeId, data.userA),
          ),
        ),
      ),
    )
    .returning();
  const broadcasts: FriendshipBroadcast[] = [];
  for (const r of rows) {
    broadcasts.push(...(await buildCardUpdateBroadcasts(db, r)));
  }
  return { superseded: rows, broadcasts };
}

/**
 * Requester withdraws a still-pending request: mark the row 'cancelled' (a
 * terminal state, distinct from 'superseded') instead of hard-deleting it, and
 * return the DM_MESSAGE_UPDATED fanout for every card referencing it so a
 * gating owner's Approve/Deny card rehydrates to a non-actionable "cancelled"
 * chip without a refetch. No-op (row: null, broadcasts: []) on a non-pending or
 * missing row.
 */
export async function cancelPendingRequest(
  db: Database,
  friendshipId: string
): Promise<{ row: FriendshipRow | null; broadcasts: FriendshipBroadcast[] }> {
  const rows = await db
    .update(communityFriendship)
    .set({ status: "cancelled", resolvedAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        eq(communityFriendship.id, friendshipId),
        eq(communityFriendship.status, "pending"),
      ),
    )
    .returning();
  const row = rows[0] ?? null;
  if (!row) return { row: null, broadcasts: [] };
  return { row, broadcasts: await buildCardUpdateBroadcasts(db, row) };
}

// ─── Sibling-bot auto-friendship ─────────────────────────────────────────────

export type EnsureSiblingResult =
  | { blocked: true }
  | { blocked: false; friendshipId: string; wasCreated: boolean };

/**
 * Direction-agnostic, idempotent accepted-friendship between two sibling bots
 * (same owner). See plans/agent-friendship-approval-gate.md §ensureSiblingBotFriendship.
 *
 * Precondition (programmer-error guard, throws): both users are bots sharing an
 * owner. Then: SELECT any existing row; blocked → sentinel; accepted → return
 * its id; none → INSERT accepted (ON CONFLICT DO NOTHING against
 * uq_friendship_active) then SELECT the survivor. Siblings never have pending
 * rows, so there is no pending branch.
 *
 * Do NOT route this through a pending→accepted promotion path — for siblings
 * that would mask the "never pending" invariant.
 */
export async function ensureSiblingBotFriendship(
  db: Database,
  data: { botA: string; botB: string }
): Promise<EnsureSiblingResult> {
  const flags = await loadBotFlags(db, [data.botA, data.botB]);
  const a = flags.get(data.botA);
  const b = flags.get(data.botB);
  if (
    !a?.isBot ||
    !b?.isBot ||
    !a.ownerUserId ||
    a.ownerUserId !== b.ownerUserId
  ) {
    throw new Error("ensureSiblingBotFriendship: parties must be sibling bots");
  }

  const existing = await findActive(db, data.botA, data.botB);
  if (existing) {
    if (isBlockedStatus(existing.status)) return { blocked: true };
    // accepted (pending is impossible for siblings)
    return { blocked: false, friendshipId: existing.id, wasCreated: false };
  }

  const newId = newFriendshipId();
  const inserted = await db
    .insert(communityFriendship)
    .values({
      id: newId,
      requesterId: data.botA,
      addresseeId: data.botB,
      status: "accepted",
      needsOwnerApproval: null,
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    return { blocked: false, friendshipId: inserted[0].id, wasCreated: true };
  }
  // Lost the race to a concurrent racer — re-SELECT the survivor.
  const survivor = await findActive(db, data.botA, data.botB);
  if (survivor && isBlockedStatus(survivor.status)) return { blocked: true };
  if (survivor) return { blocked: false, friendshipId: survivor.id, wasCreated: false };
  // Extremely unlikely — the conflicting row was terminal-ized between INSERT
  // and SELECT. Retry the insert once.
  const retry = await db
    .insert(communityFriendship)
    .values({
      id: newFriendshipId(),
      requesterId: data.botA,
      addresseeId: data.botB,
      status: "accepted",
      needsOwnerApproval: null,
      resolvedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .onConflictDoNothing()
    .returning();
  if (retry[0]) return { blocked: false, friendshipId: retry[0].id, wasCreated: true };
  const s2 = await findActive(db, data.botA, data.botB);
  if (s2 && isBlockedStatus(s2.status)) return { blocked: true };
  return { blocked: false, friendshipId: s2?.id ?? newId, wasCreated: false };
}

// ─── DM approval-card hydration ──────────────────────────────────────────────

/**
 * Given DM message ids and the viewer, return the per-message `approval`
 * projection for any message stamped with a `friendshipId`. Messages without a
 * back-ref (or whose friendship was hard-deleted → FK null) are omitted.
 */
export async function hydrateApprovalsForDmMessages(
  db: Database,
  dmMessageIds: string[],
  viewerUserId: string
): Promise<Map<string, FriendApprovalPayload>> {
  const out = new Map<string, FriendApprovalPayload>();
  if (dmMessageIds.length === 0) return out;

  const rows = await db
    .select({
      messageId: communityMessage.id,
      dmConversationId: communityMessage.dmConversationId,
      friendshipId: communityMessage.friendshipId,
      user1Id: communityDmConversation.user1Id,
      user2Id: communityDmConversation.user2Id,
      fId: communityFriendship.id,
      requesterId: communityFriendship.requesterId,
      addresseeId: communityFriendship.addresseeId,
      status: communityFriendship.status,
      needsOwnerApproval: communityFriendship.needsOwnerApproval,
    })
    .from(communityMessage)
    .innerJoin(
      communityFriendship,
      eq(communityFriendship.id, communityMessage.friendshipId)
    )
    .leftJoin(
      communityDmConversation,
      eq(communityDmConversation.id, communityMessage.dmConversationId)
    )
    .where(inArray(communityMessage.id, dmMessageIds));

  const profileIds = rows.flatMap((r) => [
    r.requesterId,
    r.addresseeId,
    r.user1Id,
    r.user2Id,
    r.needsOwnerApproval,
  ]).filter((id): id is string => !!id);
  const profiles = await loadProfiles(db, profileIds);

  for (const r of rows) {
    const peerIds = [r.user1Id, r.user2Id].filter((id): id is string => !!id);
    const approval = projectApproval(
      {
        id: r.fId,
        requesterId: r.requesterId,
        addresseeId: r.addresseeId,
        status: r.status,
        needsOwnerApproval: r.needsOwnerApproval,
      },
      viewerUserId,
      peerIds,
      profiles
    );
    if (approval) out.set(r.messageId, approval);
  }
  return out;
}
