import { beforeEach, describe, expect, it, vi } from "vitest"

const mockUpdateBot = vi.fn()
const mockGetLiveBotAvatar = vi.fn()
const mockWarn = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: (...args: unknown[]) => mockWarn(...args),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    queries: {
      ...actual.queries,
      communityBot: {
        ...actual.queries.communityBot,
        updateBot: (...args: unknown[]) => mockUpdateBot(...args),
        getLiveBotAvatar: (...args: unknown[]) => mockGetLiveBotAvatar(...args),
      },
    },
  }
})

import { persistUploadedBotAvatar } from "./bot-avatar-persistence"

const db = {} as never

describe("persistUploadedBotAvatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns persisted when the live owner-scoped update wins", async () => {
    mockUpdateBot.mockResolvedValue({ botId: "b1" })
    const remove = vi.fn()

    await expect(persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
    })).resolves.toEqual({ kind: "persisted" })

    expect(mockUpdateBot).toHaveBeenCalledWith(db, "b1", "u1", {
      image: "/api/community/bots/b1/avatar",
    })
    expect(mockGetLiveBotAvatar).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it("inline-compensates and returns not_found when delete won before the update", async () => {
    mockUpdateBot.mockResolvedValue(null)
    const remove = vi.fn().mockResolvedValue(undefined)

    await expect(persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
    })).resolves.toEqual({ kind: "not_found" })

    expect(remove).toHaveBeenCalledWith(["bot-avatar/b1"])
    expect(mockGetLiveBotAvatar).not.toHaveBeenCalled()
  })

  it("keeps the 404 outcome when zero-row compensation rejects and logs no raw error or key", async () => {
    mockUpdateBot.mockResolvedValue(null)
    const remove = vi.fn().mockRejectedValue(new TypeError("secret bot-avatar/b1"))

    await expect(persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
    })).resolves.toEqual({ kind: "not_found" })

    expect(mockWarn).toHaveBeenCalledWith("community_bot_avatar_cleanup_failed", {
      botId: "b1",
      phase: "zero_row_delete_winner",
      keyCount: 1,
      errorCategory: "TypeError",
    })
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret")
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("bot-avatar/b1")
  })

  it("compensates only after a thrown update verifies the bot is missing", async () => {
    mockUpdateBot.mockRejectedValue(new Error("secret ambiguous commit"))
    mockGetLiveBotAvatar.mockResolvedValue(null)
    const remove = vi.fn().mockResolvedValue(undefined)

    await expect(persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
    })).resolves.toEqual({ kind: "failed" })

    expect(remove).toHaveBeenCalledWith(["bot-avatar/b1"])
    expect(mockWarn).toHaveBeenCalledWith("community_bot_avatar_persist_failed", {
      botId: "b1",
      phase: "d1_error_live_verification",
      objectState: "compensated_tombstoned",
      errorCategory: "Error",
    })
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret")
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("bot-avatar/b1")
  })

  it("retains after a thrown update verifies a live canonical row", async () => {
    mockUpdateBot.mockRejectedValue(new Error("ambiguous commit"))
    mockGetLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "/api/community/bots/b1/avatar",
    })
    const remove = vi.fn()

    await expect(persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
    })).resolves.toEqual({ kind: "failed" })

    expect(remove).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith("community_bot_avatar_persist_failed", {
      botId: "b1",
      phase: "d1_error_live_verification",
      objectState: "retained_live_canonical",
      errorCategory: "Error",
    })
  })

  it("retains a live noncanonical fixed key because R2 delete has no CAS", async () => {
    mockUpdateBot.mockRejectedValue(new Error("ambiguous commit"))
    mockGetLiveBotAvatar.mockResolvedValue({ id: "b1", image: "avatar:beam-seed" })
    const remove = vi.fn()

    await expect(persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
    })).resolves.toEqual({ kind: "failed" })

    expect(remove).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith("community_bot_avatar_persist_failed", {
      botId: "b1",
      phase: "d1_error_live_verification",
      objectState: "retained_live_noncanonical",
      errorCategory: "Error",
    })
  })

  it("retains unverified bytes when both update and verification throw", async () => {
    mockUpdateBot.mockRejectedValue(new Error("persist secret"))
    mockGetLiveBotAvatar.mockRejectedValue(new TypeError("verify secret"))
    const remove = vi.fn()

    await expect(persistUploadedBotAvatar(db, { delete: remove }, {
      botId: "b1",
      ownerId: "u1",
    })).resolves.toEqual({ kind: "failed" })

    expect(remove).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith("community_bot_avatar_persist_verification_failed", {
      botId: "b1",
      phase: "d1_error_verification",
      objectState: "retained_unverified",
      persistErrorCategory: "Error",
      verificationErrorCategory: "TypeError",
    })
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret")
  })
})
