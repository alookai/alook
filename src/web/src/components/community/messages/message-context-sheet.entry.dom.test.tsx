import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { messageReadPageFixture, messageResourceFixture } from "@/test/community-resource-fixtures"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages, retireCommunityChannelReading } from "@/lib/community-db/sync"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { ApiError } from "@/lib/errors"
import { COMMUNITY_CONVERSATION_ANCHOR_MISSING } from "@alook/shared"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => load(...args), toastApiError: vi.fn() }))
vi.mock("@/components/community/shell/community-sheet", () => ({ CommunitySheet: ({ children, title }: { children: React.ReactNode; title: React.ReactNode }) => <aside role="dialog">{title}{children}</aside> }))
vi.mock("./message-row", () => ({ MessageRow: ({ m, onJumpToId }: { m: { id: string; content?: string; replyTo?: { id: string } }; onJumpToId?: (id: string) => void }) => <article data-message-id={m.id}>{m.content}{m.replyTo && <button onClick={() => onJumpToId?.(m.replyTo!.id)}>Show original</button>}</article> }))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: () => null }))
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => <span>Loading context</span> }))
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }))
vi.mock("@/hooks/community/mutations", () => ({
  usePinMessage: () => ({ mutate: vi.fn() }), useUnpinMessage: () => ({ mutate: vi.fn() }), useCreateThread: () => ({ mutateAsync: vi.fn() }),
  useToggleMark: () => vi.fn(), useToggleReactionApi: () => vi.fn(), useAddReactionApi: () => vi.fn(),
}))
vi.mock("@/stores/community", async original => ({ ...await original<typeof import("@/stores/community")>(), useUiHandlers: () => ({}) }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "viewer" }) }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useParams: () => ({}) }))

import { MessageContextSheet } from "./message-context-sheet"

let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
beforeEach(async () => { owner = await createCommunityQueryOwner(); load.mockReset() })

const message = (id: string) => messageResourceFixture({ id, channelId: "c1", authorId: "peer", content: `Body ${id}` })
function sheet(targetMessageId: string, open = true) {
  return <MessageContextSheet open={open} onOpenChange={vi.fn()} channelId="c1" serverId="s1" channelLabel="Current channel" targetSeq={null} targetMessageId={targetMessageId} />
}
function mount(id: string) {
  return render(sheet(id), { wrapper: ({ children }) => <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>{children}</CommunityTestProvider> })
}
function held() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(done => { resolve = done })
  return { promise, resolve }
}

describe("native context Query ownership", () => {
  it("shows a qualified canonical target while fetching its separate window by ID", async () => {
    const entry = await seedConversationEntry(owner.client, conversationEntryFixture())
    const target = message("older")
    await publishCommunityMessages(owner.client, { channelId: "c1", messages: [target], profiles: conversationEntryFixture().profiles, proof: { token: captureCommunityLiveSnapshotToken(owner.client, "c1") } })
    const window = owner.client.getQueryData(entry.resource.windowKey)
    const pointer = owner.registry.collections.readStates.get("c1")
    const pending = held()
    load.mockImplementation(() => pending.promise)
    const view = mount("older")
    await waitFor(() => expect(view.getByText("Body older")).toBeInTheDocument())
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(view.getByText("Current channel")).toBeInTheDocument()
    expect(view.getByText("#1")).toBeInTheDocument()
    expect(load.mock.calls[0][0]).toBe("/api/community/channels/c1/messages?anchor=older&limit=11")
    await act(async () => { pending.resolve(messageReadPageFixture({ messages: [target, message("neighbor")] })); await pending.promise })
    await waitFor(() => expect(view.getByText("Body neighbor")).toBeInTheDocument())
    expect(owner.client.getQueryData(entry.resource.windowKey)).toBe(window)
    expect(owner.registry.collections.readStates.get("c1")).toBe(pointer)
  })

  it("cancels A/B and close races even when the transport delivers after abort", async () => {
    const a = held(), b = held(), c = held()
    load.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise).mockImplementationOnce(() => c.promise)
    const view = mount("a")
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    const aSignal = load.mock.calls[0][1].signal as AbortSignal
    view.rerender(sheet("b"))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(aSignal.aborted).toBe(true)
    await act(async () => { a.resolve(messageReadPageFixture({ messages: [message("a")] })); b.resolve(messageReadPageFixture({ messages: [message("b")] })); await Promise.all([a.promise, b.promise]) })
    await waitFor(() => expect(view.getByText("Body b")).toBeInTheDocument())
    expect(owner.registry.collections.messages.has("a")).toBe(false)
    view.rerender(sheet("c"))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3))
    const cSignal = load.mock.calls[2][1].signal as AbortSignal
    view.rerender(sheet("c", false))
    expect(cSignal.aborted).toBe(true)
    await act(async () => { c.resolve(messageReadPageFixture({ messages: [message("c")] })); await c.promise })
    expect(view.queryByRole("dialog")).toBeNull()
    expect(owner.registry.collections.messages.has("c")).toBe(false)
  })

  it("withholds a cached ID from another channel while the scoped lookup is pending", async () => {
    await seedConversationEntry(owner.client, conversationEntryFixture())
    await publishCommunityMessages(owner.client, { channelId: "other", messages: [{ ...message("foreign"), channelId: "other", content: "Foreign private body" }], profiles: conversationEntryFixture().profiles, proof: { token: captureCommunityLiveSnapshotToken(owner.client) } })
    const pending = held()
    load.mockImplementation(() => pending.promise)
    const view = mount("foreign")
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(view.queryByText("Foreign private body")).toBeNull()
    await act(async () => { pending.resolve(Promise.reject(new ApiError("anchor missing", 404, [COMMUNITY_CONVERSATION_ANCHOR_MISSING]))); await pending.promise.catch(() => undefined) })
    await waitFor(() => expect(view.getByText(/may have been deleted/)).toBeInTheDocument())
    expect(view.queryByText("Foreign private body")).toBeNull()
  })

  it("keeps replies inside the context window local without a second fetch", async () => {
    const target = message("target")
    const reply = { ...message("reply"), seq: 2, replyToId: target.id, replyTo: { id: target.id, authorId: target.authorId, authorName: "Peer" } }
    load.mockResolvedValueOnce(messageReadPageFixture({ messages: [target, reply] }))
    const view = mount("reply")
    await waitFor(() => expect(view.getByText("Body reply")).toBeInTheDocument())
    await act(async () => { view.getByRole("button", { name: "Show original" }).click() })
    await waitFor(() => expect(view.container.querySelector('[data-anchor-row="1"]')).toHaveTextContent("Body target"))
    expect(load).toHaveBeenCalledOnce()
  })

  it.each(["account", "access"] as const)("rejects late publication after %s retirement", async kind => {
    const pending = held()
    load.mockImplementation(() => pending.promise)
    const view = mount("late")
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => {
      if (kind === "account") retireCommunityAccount(owner.registry)
      else retireCommunityChannelReading(owner.registry, "c1", { reason: "read-denied", serverId: "s1" })
    })
    await act(async () => { pending.resolve(messageReadPageFixture({ messages: [message("late")] })); await pending.promise })
    expect(owner.registry.collections.messages.has("late")).toBe(false)
    expect(view.queryByText("Body late")).toBeNull()
    if (kind === "access") expect(view.getByRole("alert")).toHaveTextContent("You can no longer read")
  })

  it("distinguishes uncached loading, confirmed absence and retryable failure", async () => {
    const pending = held()
    load.mockImplementationOnce(() => pending.promise)
    const view = mount("missing")
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(view.queryByText(/may have been deleted/)).toBeNull()
    await act(async () => { pending.resolve(Promise.reject(new ApiError("anchor missing", 404, [COMMUNITY_CONVERSATION_ANCHOR_MISSING]))); await pending.promise.catch(() => undefined) })
    await waitFor(() => expect(view.getByText(/may have been deleted/)).toBeInTheDocument())
    load.mockRejectedValueOnce(new ApiError("offline", 0))
    view.rerender(sheet("retry"))
    await waitFor(() => expect(view.getByRole("button", { name: "Retry" })).toBeInTheDocument())
    load.mockResolvedValueOnce(messageReadPageFixture({ messages: [message("retry")] }))
    await act(async () => { view.getByRole("button", { name: "Retry" }).click() })
    await waitFor(() => expect(view.getByText("Body retry")).toBeInTheDocument())
  })
})
