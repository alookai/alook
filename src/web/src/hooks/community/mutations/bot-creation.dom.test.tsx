import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { botCreationFixture } from "@/test/bot-creation-fixtures"
import { ingestMessages, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { messageProfileIds } from "@/lib/community/models/message"
import { useBotCreationDecision } from "./bot-creation"

const api = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args) }))
beforeEach(() => api.mockReset())
async function owner() {
  const state = await createCommunityQueryOwner()
  ingestMessages(state.registry, "dm-1", [{ id: "message-1", type: "chat", seq: 1, content: "", botCreation: botCreationFixture() }])
  state.client.setQueryData(communityKeys.bots(), { bots: [] })
  state.client.setQueryData(communityKeys.machines(), { machines: [] })
  function Wrapper({ children }: PropsWithChildren) { return createElement(CommunityTestProvider, { ...state, retainOwner: true }, children) }
  const view = renderHook(useBotCreationDecision, { wrapper: Wrapper })
  return { ...state, view }
}
const input = { requestId: "request-1", messageId: "message-1", decision: "approve" as const }
function approved() {
  const request = botCreationFixture({ status: "approved", resolvedAt: "2026-10-22T09:01:00Z" })
  request.bots[0]!.createdBot = { id: "created-1", name: "Researcher", discriminator: "0042", image: null, avatarVersion: 0 }
  return request
}

describe("bot creation owner decision", () => {
  it("does not overwrite a renamed bot when an old approved card is loaded", async () => {
    const state = await owner()
    writeCommunityProfilePatches([{ id: "created-1", identityAbout: { name: "Renamed Bot", discriminator: "0042" }, avatar: { avatar: "new-avatar", avatarVersion: 2 } }], state.registry, { command: true })
    ingestMessages(state.registry, "dm-1", [{ id: "historical-card", type: "chat", seq: 2, botCreation: approved() }])
    expect(state.registry.collections.profiles.get("created-1")).toMatchObject({ name: "Renamed Bot", avatar: "new-avatar", avatarVersion: 2 })
    api.mockResolvedValueOnce({ botCreation: approved() })
    await act(async () => { await state.view.result.current.mutateAsync(input) })
    expect(state.registry.collections.profiles.get("created-1")).toMatchObject({ name: "Renamed Bot", avatar: "new-avatar", avatarVersion: 2 })
  })

  it.each(["approve", "decline"] as const)("sends %s and publishes the authoritative card", async (decision) => {
    const state = await owner()
    const request = decision === "approve" ? approved() : botCreationFixture({ status: "declined" })
    api.mockResolvedValue({ botCreation: request })
    await act(async () => { await state.view.result.current.mutateAsync({ ...input, decision }) })
    expect(api).toHaveBeenCalledWith("/api/community/bots/creation-requests/request-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ decision }), signal: expect.any(AbortSignal) }))
    expect(state.registry.collections.messages.get("message-1")?.botCreation).toEqual(request)
    if (decision === "approve") {
      expect(state.registry.collections.profiles.has("created-1")).toBe(false)
      expect(state.client.getQueryState(communityKeys.bots())?.isInvalidated).toBe(true)
      expect(state.client.getQueryState(communityKeys.machines())?.isInvalidated).toBe(false)
      expect(messageProfileIds(state.registry.collections.messages.get("message-1")!)).toContain("created-1")
    }
  })

  it("keeps a quota failure pending and rejects a mismatched response", async () => {
    const state = await owner()
    api.mockRejectedValueOnce(new Error("Not enough bot slots"))
    await act(async () => { await expect(state.view.result.current.mutateAsync(input)).rejects.toThrow("Not enough bot slots") })
    expect(state.registry.collections.messages.get("message-1")?.botCreation?.status).toBe("pending")
    api.mockResolvedValueOnce({ botCreation: { ...approved(), requestId: "another-request" } })
    await act(async () => { await expect(state.view.result.current.mutateAsync(input)).rejects.toThrow("request changed") })
    expect(state.registry.collections.messages.get("message-1")?.botCreation?.status).toBe("pending")
  })

  it("preserves a newer WS resolution and a late snapshot cannot revert it", async () => {
    const state = await owner()
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    let pending!: Promise<unknown>
    act(() => { pending = state.view.result.current.mutateAsync(input) })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    const terminal = approved()
    act(() => projectCommunityWsEventToDb(state.client, { type: "community:message.updated", channelId: "dm-1", messageId: "message-1", botCreation: terminal }))
    await act(async () => { resolve({ botCreation: botCreationFixture({ status: "declined" }) }); await pending })
    expect(state.registry.collections.messages.get("message-1")?.botCreation).toEqual(terminal)
  })

  it.each(["success", "failure"] as const)("withholds retired-owner %s and callbacks", async (outcome) => {
    const state = await owner(), success = vi.fn(), failure = vi.fn()
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    api.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    let pending!: Promise<unknown>
    act(() => { pending = state.view.result.current.mutateAsync(input, { onSuccess: success, onError: failure }).catch((error: unknown) => error) })
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    state.runtime.ws.actions.activateProfileAccount("other"); state.runtime.ws.actions.activateProfileAccount("viewer")
    await act(async () => { if (outcome === "success") resolve({ botCreation: approved() }); else reject(new Error("old failure")); expect(await pending).toMatchObject({ name: "AbortError" }) })
    expect(success).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled()
    expect(state.registry.collections.messages.get("message-1")?.botCreation?.status).toBe("pending")
    expect(state.registry.collections.profiles.has("created-1")).toBe(false)
  })
})
