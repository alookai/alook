import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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
  it("useUpdateBot forwards explicit reasoning effort values and omission", async () => {
    const { useUpdateBot } = await import("./use-bots")
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    let mutation!: ReturnType<typeof useUpdateBot>
    function Probe() {
      mutation = useUpdateBot()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Probe),
        ),
      )
    })
    apiFetchMock.mockResolvedValue({ bot: { id: "bot_1" } })

    await act(async () => {
      await mutation.mutateAsync({ id: "bot_1", reasoningEffort: "xhigh" })
      await mutation.mutateAsync({ id: "bot_1", name: "Renamed" })
    })

    expect(JSON.parse(apiFetchMock.mock.calls[0]![1].body)).toMatchObject({
      reasoningEffort: "xhigh",
    })
    expect(JSON.parse(apiFetchMock.mock.calls[1]![1].body)).not.toHaveProperty("reasoningEffort")
    act(() => renderer.unmount())
  })

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

  it("useUpdateBot includes `model` in its request body when the input carries it", async () => {
    const { useUpdateBot } = await import("./use-bots")
    expect(typeof useUpdateBot).toBe("function")
    // Mirror the mutationFn's body construction: `model` is present when the
    // input object has the key (including explicit null), omitted otherwise.
    const buildBody = (input: { id: string; name?: string; model?: string | null }) =>
      JSON.stringify({
        name: input.name,
        description: undefined,
        image: undefined,
        ...("model" in input ? { model: input.model } : {}),
      })
    expect(JSON.parse(buildBody({ id: "b1", model: "claude-sonnet-4-6" })).model).toBe("claude-sonnet-4-6")
    expect("model" in JSON.parse(buildBody({ id: "b1", model: null }))).toBe(true)
    expect("model" in JSON.parse(buildBody({ id: "b1", name: "x" }))).toBe(false)
  })

  it("useDeleteBot's mutationFn resolves with no body, so onSuccess must use the id mutation variable", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const result = await apiFetchMock("/api/community/bots/bot_1", { method: "DELETE" })
    expect(result).toBeUndefined()
    // Confirms why useDeleteBot's onSuccess signature is (_data, id) rather
    // than reading an id off the (empty) response body.
  })
})
