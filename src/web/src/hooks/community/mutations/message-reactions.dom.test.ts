import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useCanonicalMessagesById } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { getMessageOverlay } from "@/stores/community/message-stream"
import { useAddReactionApi, useToggleReactionApi } from "./message-reactions"
import type { Msg } from "@/lib/community/models/message"

const api = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => api(...args) }))
let client: QueryClient, registry: CommunityDbRegistry
beforeEach(async () => {
  api.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  registry = createCommunityDbRegistry(client, "u_me")
  await registry.preload()
})
afterEach(async () => {
  await act(async () => {
    registry.runtime.lifecycle.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(500)
    vi.useRealTimers()
    await client.cancelQueries(); await registry.cleanup(); client.clear()
  })
})
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children)) }
const args = { serverId: "s1", channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" }
const mine = [{ emoji: "👍", count: 1, me: true, userIds: ["u_me"] }]
function seed(reactions: Msg["reactions"] = [], channelId = "ch_1", id = "m_1") {
  publishCommunityMessages(client, { channelId, messages: [{ id, seq: 1, type: "chat", content: "hello", reactions }], proof: { token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
}
function rows(id = "m_1") { return registry.collections.messages.get(id)?.reactions }
function mounted() { return renderHook(() => ({ add: useAddReactionApi(), toggle: useToggleReactionApi(), messages: useCanonicalMessagesById() }), { wrapper: Owner }) }
async function advance(ms = 300) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe("native reaction intents — original debounce and rollback guarantees", () => {
  it("keeps the add-only action stable across renders with a stable query client", () => {
    const rendered = mounted(), first = rendered.result.current.add
    rendered.rerender()
    expect(rendered.result.current.add).toBe(first)
  })
  it("treats add on me=true as a strict fact, mutation, and network no-op", async () => {
    seed(mine)
    const rendered = mounted(), before = registry.collections.messages.get("m_1")
    vi.useFakeTimers()
    act(() => rendered.result.current.add(args))
    expect(registry.collections.messages.get("m_1")).toBe(before)
    expect(client.getMutationCache().findAll({ status: "pending" })).toHaveLength(0)
    await advance(500)
    expect(api).not.toHaveBeenCalled()
  })
  it("does not rewrite facts or postpone the first PUT when add is repeated", async () => {
    seed(); api.mockResolvedValue(undefined)
    const rendered = mounted()
    vi.useFakeTimers()
    act(() => rendered.result.current.add(args))
    await advance(150)
    const first = client.getMutationCache().findAll({ status: "pending" })[0]
    expect(first).toBeDefined()
    const before = registry.collections.messages.get("m_1")
    act(() => rendered.result.current.add(args))
    expect(client.getMutationCache().findAll({ status: "pending" })).toEqual([first])
    expect(registry.collections.messages.get("m_1")).toBe(before)
    await advance(150)
    expect(api).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledWith(expect.stringContaining("/api/community/messages/m_1/reactions/"), expect.objectContaining({ method: "PUT", signal: expect.anything(), assertActive: expect.any(Function) }))
  })
  it("coalesces chip remove followed by picker add to the original state and zero requests", async () => {
    seed(mine)
    const rendered = mounted()
    vi.useFakeTimers()
    act(() => { rendered.result.current.toggle(args); rendered.result.current.add(args) })
    await advance(500)
    expect(rows()).toEqual(mine)
    expect(api).not.toHaveBeenCalled()
    expect(client.getMutationCache().findAll({ status: "pending" })).toHaveLength(0)
  })
  it("drives additional consumers through canonical optimistic add and rollback", async () => {
    seed()
    const first = mounted(), second = mounted(), onError = vi.fn()
    api.mockRejectedValueOnce(new Error("boom")); vi.useFakeTimers()
    act(() => first.result.current.add({ ...args, onError }))
    await advance(0)
    expect(first.result.current.messages?.get("m_1")?.reactions).toEqual(mine)
    expect(second.result.current.messages?.get("m_1")?.reactions).toEqual(mine)
    await advance()
    expect(rows()).toEqual([])
    expect(second.result.current.messages?.get("m_1")?.reactions).toEqual([])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }))
  })
  it("optimistically patches and rolls back a thread opener shared by the single-message consumer", async () => {
    seed([{ emoji: "👍", count: 1, me: false, userIds: ["other"] }])
    client.setQueryData(communityKeys.message("m_1"), "m_1")
    const rendered = mounted()
    api.mockRejectedValueOnce(new Error("boom")); vi.useFakeTimers()
    act(() => rendered.result.current.toggle(args))
    await advance(0)
    expect(rows()).toEqual([{ emoji: "👍", count: 2, me: true, userIds: ["other", "u_me"] }])
    await advance()
    expect(rows()).toEqual([{ emoji: "👍", count: 1, me: false, userIds: ["other"] }])
    expect(client.getQueryData(communityKeys.message("m_1"))).toBe("m_1")
  })
  it.each(["channel", "dm"] as const)("updates and rolls back a fallback-only %s row without creating a second row", async (kind) => {
    const id = kind === "dm" ? "dm_1" : "ch_1"
    seed(mine, id)
    const scope = kind === "dm" ? { kind, id } : { kind, id, serverId: "s1" }
    registry.runtime.messageStream.actions.dispatch(scope, { type: "wsMessage", message: { id: "m_1", seq: 1, type: "chat", content: "hello", reactions: mine } })
    const key = kind === "dm" ? communityKeys.dmMessages(id) : communityKeys.channelMessages(id)
    const base = { pages: [{ ids: [], hasMore: false }], pageParams: [null] }
    client.setQueryData(key, base)
    const rendered = mounted()
    api.mockRejectedValueOnce(new Error("boom")); vi.useFakeTimers()
    act(() => rendered.result.current.toggle({ ...args, channelId: kind === "channel" ? id : undefined, dmId: kind === "dm" ? id : undefined }))
    await advance(0)
    expect(getMessageOverlay(client, scope).liveById.get("m_1")?.reactions).toEqual([])
    await advance()
    expect(api).toHaveBeenCalledWith(expect.stringContaining("/api/community/messages/m_1/reactions/"), expect.objectContaining({ method: "DELETE" }))
    expect(getMessageOverlay(client, scope).liveById.size).toBe(1)
    expect(getMessageOverlay(client, scope).liveById.get("m_1")?.reactions).toEqual(mine)
    expect(client.getQueryData(key)).toEqual(base)
    expect(registry.collections.messages.size).toBe(1)
  })
  it("does not invent a DM fallback when the message exists in neither base nor overlay", async () => {
    const rendered = mounted()
    api.mockRejectedValueOnce(new Error("boom")); vi.useFakeTimers()
    act(() => rendered.result.current.toggle({ ...args, channelId: undefined, dmId: "dm_1", messageId: "missing" }))
    await advance(500)
    expect(getMessageOverlay(client, { kind: "dm", id: "dm_1" }).liveById.size).toBe(0)
    expect(registry.collections.messages.size).toBe(0)
  })
  it.each([3, 5])("%s rapid alternating clicks settle to exactly one API call at the end of the window", async (clicks) => {
    seed(); api.mockResolvedValue(undefined)
    const rendered = mounted()
    vi.useFakeTimers()
    act(() => { for (let index = 0; index < clicks; index++) rendered.result.current.toggle(args) })
    await advance(299)
    expect(api).not.toHaveBeenCalled()
    await advance(1)
    expect(api).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "PUT" }))
    expect(rows()).toEqual(mine)
  })
  it("flip-back (net-zero) cancels the intent — zero API calls fire", async () => {
    seed(); api.mockResolvedValue(undefined)
    const rendered = mounted()
    vi.useFakeTimers()
    act(() => { rendered.result.current.toggle(args); rendered.result.current.toggle(args) })
    await advance(500)
    expect(api).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })
  it("retiring the original account before the delay ends cancels the pending API call", async () => {
    seed(); api.mockResolvedValue(undefined)
    const rendered = mounted()
    vi.useFakeTimers()
    act(() => rendered.result.current.toggle(args))
    await advance(100)
    act(() => registry.runtime.lifecycle.setState((state) => ({ ...state, active: false, generation: state.generation + 1 })))
    await advance(400)
    expect(api).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
    expect(client.getMutationCache().findAll({ status: "pending" })).toHaveLength(0)
  })
  it.each(["success", "failure"] as const)("preserves a newer WS reaction on original command %s", async (outcome) => {
    seed()
    let resolve!: () => void, reject!: (error: Error) => void
    api.mockReturnValueOnce(new Promise<void>((done, fail) => { resolve = done; reject = fail }))
    const rendered = mounted()
    vi.useFakeTimers()
    act(() => rendered.result.current.toggle(args))
    await advance()
    expect(api).toHaveBeenCalledOnce()
    act(() => projectCommunityWsEventToDb(client, { type: "community:reaction.add", messageId: "m_1", channelId: "ch_1", emoji: "👍", userId: "other" }))
    await act(async () => { if (outcome === "success") resolve(); else reject(new Error("boom")); await vi.advanceTimersByTimeAsync(0) })
    expect(rows()).toEqual(outcome === "success" ? [{ emoji: "👍", count: 2, me: true, userIds: ["other", "u_me"] }] : [{ emoji: "👍", count: 1, me: false, userIds: ["other"] }])
  })
})
