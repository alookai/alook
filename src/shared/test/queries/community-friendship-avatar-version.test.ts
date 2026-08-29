import { beforeEach, describe, expect, it, vi } from "vitest"

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

import * as friendship from "../../src/db/queries/community/friendship"

function fakeDb(selectRows: unknown[][], updateRows: unknown[][] = []) {
  let selectIndex = 0
  let updateIndex = 0
  const db: any = {
    select: vi.fn(() => {
      const chain: any = {}
      chain.from = vi.fn(() => chain)
      chain.innerJoin = vi.fn(() => chain)
      chain.where = vi.fn(() => Promise.resolve(selectRows[selectIndex++] ?? []))
      chain.limit = vi.fn(() => Promise.resolve(selectRows[selectIndex++] ?? []))
      return chain
    }),
    update: vi.fn(() => {
      const chain: any = {}
      chain.set = vi.fn(() => chain)
      chain.where = vi.fn(() => chain)
      chain.returning = vi.fn(() => Promise.resolve(updateRows[updateIndex++] ?? []))
      return chain
    }),
    insert: vi.fn(() => {
      const chain: any = {}
      chain.values = vi.fn(() => chain)
      chain.returning = vi.fn(() => Promise.resolve([]))
      return chain
    }),
    batch: vi.fn(),
  }
  return db
}

beforeEach(() => {
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

describe("friend approval MESSAGE_CREATE identity", () => {
  it("includes the gating bot avatar version on a newly created approval card", async () => {
    const inserted = {
      id: "friendship1",
      requesterId: "human1",
      addresseeId: "bot1",
      status: "pending",
      needsOwnerApproval: "owner1",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      resolvedAt: null,
    }
    const db = fakeDb([
      [],
      [
        { id: "human1", isBot: false, ownerUserId: null, name: "Human" },
        { id: "bot1", isBot: true, ownerUserId: "owner1", name: "Bot" },
      ],
      [
        { id: "human1", name: "Human", discriminator: "0001", image: null, avatarVersion: 0, isBot: false, ownerUserId: null },
        { id: "bot1", name: "Bot", discriminator: "0002", image: "/bot", avatarVersion: 7, isBot: true, ownerUserId: "owner1" },
        { id: "owner1", name: "Owner", discriminator: "0003", image: null, avatarVersion: 0, isBot: false, ownerUserId: null },
      ],
    ])
    db.batch.mockResolvedValue([[], [inserted]])

    const result = await friendship.sendRequest(db, {
      requesterId: "human1",
      addresseeId: "bot1",
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
    const row = {
      id: "friendship2",
      requesterId: "bot1",
      addresseeId: "bot2",
      status: "pending",
      needsOwnerApproval: "owner1",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      resolvedAt: null,
    }
    const updated = { ...row, needsOwnerApproval: "owner2" }
    const db = fakeDb([
      [row],
      [
        { id: "bot1", isBot: true, ownerUserId: "owner1", name: "Bot One" },
        { id: "bot2", isBot: true, ownerUserId: "owner2", name: "Bot Two" },
      ],
      [
        { id: "bot1", name: "Bot One", discriminator: "0001", image: "/bot1", avatarVersion: 4, isBot: true, ownerUserId: "owner1" },
        { id: "bot2", name: "Bot Two", discriminator: "0002", image: "/bot2", avatarVersion: 9, isBot: true, ownerUserId: "owner2" },
        { id: "owner2", name: "Owner Two", discriminator: "0003", image: null, avatarVersion: 0, isBot: false, ownerUserId: null },
      ],
    ], [[updated]])

    const result = await friendship.ownerDecideOnRow(db, {
      friendshipId: "friendship2",
      actorId: "owner1",
      decision: "approve",
    })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error("expected owner decision to succeed")
    expect(result.broadcasts[0]?.event).toMatchObject({
      type: "community:message.create",
      message: {
        authorId: "bot2",
        authorAvatarVersion: 9,
      },
    })
  })
})
