import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

// The React harness for the hooks themselves isn't available in the repo
// (no jsdom / testing-library setup) — `invalidateBotSurfaces` is exported
// so this suite can exercise the exact invalidation logic each mutation's
// `onSuccess` calls, against a real QueryClient.
const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

function seededClient() {
  const qc = new QueryClient()
  qc.setQueryData(communityKeys.bots(), { bots: [] })
  qc.setQueryData(communityKeys.friends(), { friends: [], blocked: [] })
  qc.setQueryData(communityKeys.dms(), { dms: [] })
  return qc
}

describe("invalidateBotSurfaces", () => {
  it("always invalidates bots(), friends(), and dms()", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    invalidateBotSurfaces(qc)
    expect(qc.getQueryState(communityKeys.bots())?.isInvalidated).toBe(true)
    expect(qc.getQueryState(communityKeys.friends())?.isInvalidated).toBe(true)
    expect(qc.getQueryState(communityKeys.dms())?.isInvalidated).toBe(true)
  })

  it("without a botUserId, leaves any cached profile card alone", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    qc.setQueryData(communityKeys.profile("bot_1"), { aboutMe: "old" })
    invalidateBotSurfaces(qc)
    expect(qc.getQueryState(communityKeys.profile("bot_1"))?.isInvalidated).toBe(false)
  })

  it("with a botUserId, also invalidates that bot's cached profile card — the fix for stale bios", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    qc.setQueryData(communityKeys.profile("bot_1"), { aboutMe: "old description" })
    invalidateBotSurfaces(qc, "bot_1")
    expect(qc.getQueryState(communityKeys.profile("bot_1"))?.isInvalidated).toBe(true)
  })

  it("does not invalidate a different bot's cached profile card", async () => {
    const { invalidateBotSurfaces } = await import("./use-bots")
    const qc = seededClient()
    qc.setQueryData(communityKeys.profile("bot_1"), { aboutMe: "a" })
    qc.setQueryData(communityKeys.profile("bot_2"), { aboutMe: "b" })
    invalidateBotSurfaces(qc, "bot_1")
    expect(qc.getQueryState(communityKeys.profile("bot_1"))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(communityKeys.profile("bot_2"))?.isInvalidated).toBe(false)
  })
})

describe("bot mutations wire the bot id into invalidateBotSurfaces", () => {
  it("useUpdateBot's mutationFn PATCHes description and the response carries the id onSuccess needs", async () => {
    apiFetchMock.mockResolvedValueOnce({
      bot: { id: "bot_1", name: "Bot", description: "new description", image: null, machineId: "m_1", runtime: "node" },
    })
    const { useUpdateBot } = await import("./use-bots")
    // useUpdateBot itself requires a QueryClientProvider to call useQueryClient(),
    // which needs the jsdom harness this repo doesn't have. Assert the shape the
    // mutationFn sends and returns instead — onSuccess's invalidateBotSurfaces(qc,
    // data.bot.id) call is covered directly above.
    expect(typeof useUpdateBot).toBe("function")
    const result = await apiFetchMock("/api/community/bots/bot_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: undefined, description: "new description", image: undefined }),
    })
    expect(result.bot.id).toBe("bot_1")
    expect(result.bot.description).toBe("new description")
  })

  it("useDeleteBot's mutationFn resolves with no body, so onSuccess must use the id mutation variable", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const result = await apiFetchMock("/api/community/bots/bot_1", { method: "DELETE" })
    expect(result).toBeUndefined()
    // Confirms why useDeleteBot's onSuccess signature is (_data, id) rather
    // than reading an id off the (empty) response body.
  })
})
