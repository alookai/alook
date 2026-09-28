import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  clearAgent: vi.fn(),
  clearCommunity: vi.fn(),
}))

vi.mock("@/lib/agent-chat-persistence", () => ({
  clearAgentChatPersistenceForAccount: mocks.clearAgent,
}))
vi.mock("@/lib/community-db/collections", () => ({
  clearCommunityPersistenceForAccount: mocks.clearCommunity,
}))

import { clearBrowserPersistenceForAccount } from "./account-persistence"

beforeEach(() => {
  mocks.clearAgent.mockReset().mockResolvedValue(undefined)
  mocks.clearCommunity.mockReset().mockResolvedValue(undefined)
})

describe("account persistence cleanup", () => {
  it("clears Agent and Community scopes for the same account", async () => {
    await clearBrowserPersistenceForAccount("account-a")

    expect(mocks.clearAgent).toHaveBeenCalledWith("account-a")
    expect(mocks.clearCommunity).toHaveBeenCalledWith("account-a")
  })

  it("still clears Community when Agent cleanup fails", async () => {
    mocks.clearAgent.mockRejectedValueOnce(new Error("agent cleanup failed"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await clearBrowserPersistenceForAccount("account-a")

    expect(mocks.clearCommunity).toHaveBeenCalledWith("account-a")
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
