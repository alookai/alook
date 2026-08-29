import { beforeEach, describe, expect, it, vi } from "vitest"

const publishOwnedBotAvatar = vi.fn()
const getLiveBotAvatar = vi.fn()
const warn = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: (...args: unknown[]) => warn(...args),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    queries: {
      ...actual.queries,
      communityBot: {
        ...actual.queries.communityBot,
        publishOwnedBotAvatar: (...args: unknown[]) => publishOwnedBotAvatar(...args),
        getLiveBotAvatar: (...args: unknown[]) => getLiveBotAvatar(...args),
      },
    },
  }
})

import { persistUploadedBotAvatar } from "./bot-avatar-persistence"

const db = {} as never
const objectKey = "bot-avatar/b1/objects/new-object"

function persist(remove = vi.fn()) {
  return {
    remove,
    result: persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
      objectKey,
    }),
  }
}

describe("persistUploadedBotAvatar", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the atomic publication version and displaced pointer", async () => {
    publishOwnedBotAvatar.mockResolvedValue({
      previous: { avatarVersion: 4, avatarObjectKey: "bot-avatar/b1/objects/old" },
      current: { avatarVersion: 5, avatarObjectKey: objectKey },
    })
    const { result, remove } = persist()

    await expect(result).resolves.toEqual({
      kind: "persisted",
      avatarVersion: 5,
      avatarObjectKey: objectKey,
      previousObjectKey: "bot-avatar/b1/objects/old",
    })
    expect(publishOwnedBotAvatar).toHaveBeenCalledWith(db, "b1", "u1", {
      objectKey,
      stableUrl: "/api/community/bots/b1/avatar",
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it("deletes only the uploaded owned child when publication loses to delete", async () => {
    publishOwnedBotAvatar.mockResolvedValue(null)
    getLiveBotAvatar.mockResolvedValue(null)
    const remove = vi.fn().mockResolvedValue(undefined)

    await expect(persist(remove).result).resolves.toEqual({ kind: "not_found" })
    expect(remove).toHaveBeenCalledWith(objectKey)
  })

  it("retains a zero-row candidate when the authoritative reread fails", async () => {
    publishOwnedBotAvatar.mockResolvedValue(null)
    getLiveBotAvatar.mockRejectedValue(new TypeError("secret key"))
    const { result, remove } = persist()

    await expect(result).resolves.toEqual({ kind: "not_found" })
    expect(remove).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("community_bot_avatar_cleanup_unverified", {
      phase: "zero_row",
      objectState: "retained_unverified",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
  })

  it("recognizes an unknown commit when D1 now points at the uploaded child", async () => {
    publishOwnedBotAvatar.mockRejectedValue(new Error("ambiguous commit"))
    getLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "/api/community/bots/b1/avatar",
      avatarVersion: 7,
      avatarObjectKey: objectKey,
    })
    const { result, remove } = persist()

    await expect(result).resolves.toEqual({
      kind: "persisted",
      avatarVersion: 7,
      avatarObjectKey: objectKey,
      previousObjectKey: null,
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it("cleans an unknown noncurrent candidate only after a second authoritative reread", async () => {
    publishOwnedBotAvatar.mockRejectedValue(new Error("ambiguous commit"))
    getLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "/api/community/bots/b1/avatar",
      avatarVersion: 8,
      avatarObjectKey: "bot-avatar/b1/objects/newer",
    })
    const remove = vi.fn().mockResolvedValue(undefined)

    await expect(persist(remove).result).resolves.toEqual({ kind: "failed" })
    expect(getLiveBotAvatar).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledWith(objectKey)
  })

  it("never deletes unverified bytes after an unknown commit", async () => {
    publishOwnedBotAvatar.mockRejectedValue(new Error("persist secret"))
    getLiveBotAvatar.mockRejectedValue(new TypeError("verify secret"))
    const { result, remove } = persist()

    await expect(result).resolves.toEqual({ kind: "failed" })
    expect(remove).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("community_bot_avatar_persist_verification_failed", {
      phase: "unknown_commit",
      objectState: "retained_unverified",
      persistErrorCategory: "Error",
      verificationErrorCategory: "TypeError",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
  })
})
