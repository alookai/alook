import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import {
  communityChannel,
  communityChannelMember,
  communityFriendship,
  communityMessage,
} from "../../src/db/community-schema"
import { user } from "../../src/db/schema"
import {
  acceptRequest,
  getFriendship,
  hydrateApprovalsForDmMessages,
  listActionableIncomingRequests,
  listAgentFriends,
  listBlocked,
  listPending,
  removeFriend,
  sendRequest,
  supersedePendingBetween,
} from "../../src/db/queries/community/friendship"
import { createMigratedDb } from "../helpers/migrated-db"

describe("listActionableIncomingRequests", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        discriminator TEXT NOT NULL DEFAULT '',
        image TEXT,
        avatarVersion INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE community_friendship (
        id TEXT PRIMARY KEY,
        requester_id TEXT NOT NULL,
        addressee_id TEXT NOT NULL,
        status TEXT NOT NULL,
        needs_owner_approval TEXT,
        blocker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
    `)
    sqlite.prepare("INSERT INTO user (id, name, image, avatarVersion) VALUES (?, ?, ?, ?)")
      .run("viewer", "Viewer", null, 0)
    for (const [id, name, version] of [
      ["newer", "Newer", 2],
      ["tie-z", "Tie Z", 3],
      ["tie-a", "Tie A", 4],
      ["outgoing", "Outgoing", 5],
      ["gated", "Gated", 6],
      ["terminal", "Terminal", 7],
    ] as const) {
      sqlite.prepare("INSERT INTO user (id, name, image, avatarVersion) VALUES (?, ?, ?, ?)")
        .run(id, name, null, version)
    }
    const insert = sqlite.prepare(`
      INSERT INTO community_friendship
        (id, requester_id, addressee_id, status, needs_owner_approval, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run("fr_newer", "newer", "viewer", "pending", null, "2026-09-12T02:00:00Z", "2026-09-12T02:00:00Z")
    insert.run("fr_z", "tie-z", "viewer", "pending", null, "2026-09-12T01:00:00Z", "2026-09-12T01:00:00Z")
    insert.run("fr_a", "tie-a", "viewer", "pending", null, "2026-09-12T01:00:00Z", "2026-09-12T01:00:00Z")
    insert.run("fr_out", "viewer", "outgoing", "pending", null, "2026-09-12T03:00:00Z", "2026-09-12T03:00:00Z")
    insert.run("fr_gated", "gated", "viewer", "pending", "viewer", "2026-09-12T03:00:00Z", "2026-09-12T03:00:00Z")
    for (const status of ["accepted", "denied", "cancelled", "superseded", "blocked"]) {
      insert.run(`fr_${status}`, "terminal", "viewer", status, null, "2026-09-12T04:00:00Z", "2026-09-12T04:00:00Z")
    }
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("returns only ungated incoming pending rows in deterministic newest-first order", async () => {
    await expect(listActionableIncomingRequests(db, "viewer")).resolves.toEqual([
      {
        id: "fr_newer",
        userId: "newer",
        name: "Newer",
        discriminator: "",
        image: null,
        avatarVersion: 2,
        createdAt: "2026-09-12T02:00:00Z",
      },
      {
        id: "fr_z",
        userId: "tie-z",
        name: "Tie Z",
        discriminator: "",
        image: null,
        avatarVersion: 3,
        createdAt: "2026-09-12T01:00:00Z",
      },
      {
        id: "fr_a",
        userId: "tie-a",
        name: "Tie A",
        discriminator: "",
        image: null,
        avatarVersion: 4,
        createdAt: "2026-09-12T01:00:00Z",
      },
    ])
  })
})

it("lists scoped pending, blocked, and agent relationships on the migrated schema", async () => {
  const { db, sqlite } = createMigratedDb()
  try {
    const humans = [
      "viewer", "other-owner", "incoming", "direct-target", "owned-target",
      "peer-a", "peer-b", "blocked-a", "blocked-b", "blocked-viewer",
    ]
    await db.insert(user).values([
      ...humans.map(id => ({ id, name: id, email: id + "@example.test" })),
      { id: "owned-bot", name: "Owned bot", email: "owned-bot@example.test", isBot: true, ownerUserId: "viewer" },
      { id: "gated-bot", name: "Gated bot", email: "gated-bot@example.test", isBot: true, ownerUserId: "other-owner" },
    ]).run()
    await db.insert(communityFriendship).values([
      { id: "request-incoming", requesterId: "incoming", addresseeId: "viewer", status: "pending" },
      { id: "request-direct", requesterId: "viewer", addresseeId: "direct-target", status: "pending" },
      { id: "request-gated", requesterId: "gated-bot", addresseeId: "viewer", status: "pending", needsOwnerApproval: "other-owner" },
      { id: "request-owned-bot", requesterId: "owned-bot", addresseeId: "owned-target", status: "pending", needsOwnerApproval: "viewer" },
      { id: "request-gated-incoming", requesterId: "incoming", addresseeId: "owned-bot", status: "pending", needsOwnerApproval: "viewer" },
      { id: "friend-a", requesterId: "owned-bot", addresseeId: "peer-a", status: "accepted" },
      { id: "friend-b", requesterId: "peer-b", addresseeId: "owned-bot", status: "accepted" },
      { id: "block-a", requesterId: "viewer", addresseeId: "blocked-a", status: "blocked", blockerId: "viewer" },
      { id: "block-b", requesterId: "blocked-b", addresseeId: "viewer", status: "blocked", blockerId: "viewer" },
      { id: "other-block", requesterId: "blocked-viewer", addresseeId: "viewer", status: "blocked", blockerId: "blocked-viewer" },
    ]).run()

    await expect(listBlocked(db, "viewer")).resolves.toMatchObject([
      { id: "block-a", blockedUserId: "blocked-a" },
      { id: "block-b", blockedUserId: "blocked-b" },
    ])

    const pending = await listPending(db, "viewer")
    expect(pending.toSorted((a, b) => a.id.localeCompare(b.id))).toMatchObject([
      { id: "request-direct", userId: "direct-target", kind: "outgoing" },
      { id: "request-incoming", userId: "incoming", kind: "incoming" },
      { id: "request-owned-bot", userId: "owned-target", kind: "outgoing", needsOwnerApproval: "viewer" },
    ])

    await expect(listAgentFriends(db, "owned-bot")).resolves.toMatchObject({
      accepted: [
        { friendshipId: "friend-a", peerUserId: "peer-a" },
        { friendshipId: "friend-b", peerUserId: "peer-b" },
      ],
      pendingOutgoing: [{ friendshipId: "request-owned-bot", peerUserId: "owned-target" }],
      pendingIncoming: [],
    })
  } finally {
    sqlite.close()
  }
})

it("accepts and replaces pending relationships without modifying other pairs", async () => {
  const { db, sqlite } = createMigratedDb()
  try {
    await db.insert(user).values(["alpha", "beta", "gamma", "delta", "intruder"].map(id => ({
      id, name: id, email: id + "@example.test",
    }))).run()
    await db.insert(communityFriendship).values([
      { id: "crossover", requesterId: "alpha", addresseeId: "beta", status: "pending" },
      { id: "explicit", requesterId: "gamma", addresseeId: "delta", status: "pending" },
      { id: "replace", requesterId: "delta", addresseeId: "alpha", status: "pending" },
      { id: "unrelated", requesterId: "gamma", addresseeId: "alpha", status: "pending" },
    ]).run()

    await expect(sendRequest(db, { requesterId: "beta", addresseeId: "alpha" })).resolves.toMatchObject({
      kind: "auto_accepted",
      friendship: { id: "crossover", status: "accepted" },
    })

    await expect(acceptRequest(db, { friendshipId: "explicit", actorId: "intruder" })).resolves.toEqual({
      ok: false, reason: "gated",
    })
    await expect(getFriendship(db, "explicit")).resolves.toMatchObject({ status: "pending" })
    await expect(acceptRequest(db, { friendshipId: "explicit", actorId: "delta" })).resolves.toMatchObject({
      ok: true, friendship: { id: "explicit", status: "accepted" },
    })

    await expect(supersedePendingBetween(db, { userA: "alpha", userB: "delta" })).resolves.toMatchObject({
      superseded: [{ id: "replace", status: "superseded" }],
    })
    await expect(getFriendship(db, "replace")).resolves.toMatchObject({ status: "superseded" })
    await expect(getFriendship(db, "unrelated")).resolves.toMatchObject({ status: "pending" })

    await expect(removeFriend(db, "crossover")).resolves.toMatchObject({ id: "crossover", status: "accepted" })
    await expect(getFriendship(db, "crossover")).resolves.toBeNull()
    await expect(getFriendship(db, "explicit")).resolves.toMatchObject({ status: "accepted" })
  } finally {
    sqlite.close()
  }
})

it("hydrates the referenced approval card with the authorized DM peers", async () => {
  const { db, sqlite } = createMigratedDb()
  try {
    await db.insert(user).values([
      { id: "owner", name: "Owner", email: "owner@example.test" },
      { id: "bot", name: "Bot", email: "bot@example.test", isBot: true, ownerUserId: "owner", avatarVersion: 7 },
      { id: "peer", name: "Peer", email: "peer@example.test" },
      { id: "a-notify", name: "Notify", email: "notify@example.test" },
    ]).run()
    await db.insert(communityFriendship).values({
      id: "pending-approval", requesterId: "peer", addresseeId: "bot", status: "pending", needsOwnerApproval: "owner",
    }).run()
    await db.insert(communityChannel).values({ id: "approval-dm", type: "dm" }).run()
    await db.insert(communityChannelMember).values([
      { channelId: "approval-dm", userId: "a-notify", relation: "notify" },
      { channelId: "approval-dm", userId: "owner", relation: "access" },
      { channelId: "approval-dm", userId: "bot", relation: "access" },
    ]).run()
    await db.insert(communityMessage).values([
      { id: "approval-card", channelId: "approval-dm", authorId: "bot", seq: 1, friendshipId: "pending-approval" },
      { id: "plain-message", channelId: "approval-dm", authorId: "owner", seq: 2 },
    ]).run()

    const cards = await hydrateApprovalsForDmMessages(db, ["approval-card", "plain-message", "missing"], "owner")
    expect([...cards.keys()]).toEqual(["approval-card"])
    expect(cards.get("approval-card")).toMatchObject({
      friendshipId: "pending-approval",
      status: "pending",
      waitingOn: "you",
      botProfile: { id: "bot", avatarVersion: 7 },
      otherProfile: { id: "peer" },
    })
  } finally {
    sqlite.close()
  }
})
