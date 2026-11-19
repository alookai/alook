import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createOrGetDM: vi.fn(),
  createMessage: vi.fn(),
  listMessagesReferencingFriendship: vi.fn(),
}))

vi.mock("../../src/db/queries/community/dm", () => ({
  createOrGetDM: (...args: unknown[]) => mocks.createOrGetDM(...args),
}))

vi.mock("../../src/db/queries/community/message", () => ({
  createMessage: (...args: unknown[]) => mocks.createMessage(...args),
  listMessagesReferencingFriendship: (...args: unknown[]) =>
    mocks.listMessagesReferencingFriendship(...args),
}))

import { communityFriendship } from "../../src/db/community-schema"
import { user } from "../../src/db/schema"
import * as friendship from "../../src/db/queries/community/friendship"
import { createMigratedDb } from "../helpers/migrated-db"

let fixture: ReturnType<typeof createMigratedDb>

beforeEach(() => {
  fixture = createMigratedDb()
  vi.clearAllMocks()
  mocks.createOrGetDM.mockResolvedValue({ id: "dm1" })
  mocks.createMessage.mockResolvedValue({
    id: "message1",
    seq: 1,
    content: "approval",
    createdAt: "2026-08-29T00:00:00.000Z",
  })
  mocks.listMessagesReferencingFriendship.mockResolvedValue([])
})

afterEach(() => fixture.sqlite.close())

describe("friend approval MESSAGE_CREATE identity", () => {
  it("includes the gating bot avatar version on a newly created approval card", async () => {
    const { db } = fixture
    await db.insert(user).values([
      { id: "human1", email: "human1@example.test", name: "Human", discriminator: "0001" },
      { id: "owner1", email: "owner1@example.test", name: "Owner", discriminator: "0003" },
      { id: "bot1", email: "bot1@example.test", name: "Bot", discriminator: "0002", image: "/bot", avatarVersion: 7, isBot: true, ownerUserId: "owner1" },
    ]).run()

    const result = await friendship.sendRequest(db, {
      requesterId: "human1",
      addresseeId: "bot1",
    })

    await expect(friendship.getFriendship(db, result.friendship.id)).resolves.toMatchObject({
      requesterId: "human1",
      addresseeId: "bot1",
      status: "pending",
      needsOwnerApproval: "owner1",
    })
    expect(result.broadcasts[0]?.event).toMatchObject({
      type: "community:message.create",
      message: {
        authorId: "bot1",
        authorAvatarVersion: 7,
      },
    })
  })

  it("includes the second bot avatar version when a two-hop gate advances", async () => {
    const { db } = fixture
    await db.insert(user).values([
      { id: "owner1", email: "owner1@example.test", name: "Owner One", discriminator: "0004" },
      { id: "owner2", email: "owner2@example.test", name: "Owner Two", discriminator: "0003" },
      { id: "bot1", email: "bot1@example.test", name: "Bot One", discriminator: "0001", image: "/bot1", avatarVersion: 4, isBot: true, ownerUserId: "owner1" },
      { id: "bot2", email: "bot2@example.test", name: "Bot Two", discriminator: "0002", image: "/bot2", avatarVersion: 9, isBot: true, ownerUserId: "owner2" },
    ]).run()
    await db.insert(communityFriendship).values({
      id: "friendship2",
      requesterId: "bot1",
      addresseeId: "bot2",
      status: "pending",
      needsOwnerApproval: "owner1",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    }).run()

    const result = await friendship.ownerDecideOnRow(db, {
      friendshipId: "friendship2",
      actorId: "owner1",
      decision: "approve",
    })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error("expected owner decision to succeed")
    await expect(friendship.getFriendship(db, "friendship2")).resolves.toMatchObject({
      status: "pending",
      needsOwnerApproval: "owner2",
    })
    expect(result.broadcasts[0]?.event).toMatchObject({
      type: "community:message.create",
      message: {
        authorId: "bot2",
        authorAvatarVersion: 9,
      },
    })
  })
})
