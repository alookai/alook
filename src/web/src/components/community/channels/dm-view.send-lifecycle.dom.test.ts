import { messageProfilesFixture } from "@/test/community-resource-fixtures"
import { messageResourceFixture } from "@/test/community-resource-fixtures"
import React, { type PropsWithChildren } from "react"
import { renderToString } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { DmView } from "./dm-view"
import { dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"

const mocks = vi.hoisted(() => ({ api: vi.fn(), advance: vi.fn(), list: vi.fn(), positionEntry: null as object | null, failed: true, breakpoint: "mobile", identity: true, blocked: false, windowBlocked: false }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api, toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "u_me", name: "Me", avatar: "M" }) }))
vi.mock("@/hooks/community/use-dms", () => ({ useDms: () => ({ dms: mocks.identity ? ["dm_1", "dm_2"].map(id => ({ id, userId: "peer", name: "Peer", avatar: "P" })) : [], isLoading: false, isFetching: false }) }))
vi.mock("@/hooks/community/use-friends", () => ({ useFriends: () => ({ friends: [], blocked: mocks.blocked ? [{ id: "peer", userId: "peer" }] : [] }) }))
vi.mock("@/hooks/community/use-messages", () => ({ useDmMessages: () => ({ messages: mocks.failed ? [{ id: "failed", clientNonce: "retry_nonce", authorId: "u_me", type: "chat", content: "retry" }] : [], positionEntry: mocks.positionEntry, positionDataState: "ready", isLoading: false, isPending: false, isError: false, latestSeq: 0, navigationBlocked: mocks.windowBlocked }) }))
vi.mock("@/hooks/community/use-channel-metadata", () => ({ useChannelMetadata: () => ({ canRead: true, status: "readable" }) }))
vi.mock("@/hooks/community/use-dm-watermark", () => ({ useDmWatermark: vi.fn() }))
vi.mock("@/hooks/community/use-channel-ref-directory", () => ({ useChannelRefDirectory: () => ({ directory: [], isResolved: true }) }))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({ useNativeSystemNotificationConversationDismissal: vi.fn() }))
vi.mock("./use-dm-seq-context", () => ({ useDmSeqContext: vi.fn() }))
vi.mock("@/lib/community/last-community-route", () => ({ commitCommunityChannelRoute: vi.fn() }))
vi.mock("@/hooks/community/use-notification-settings", () => ({ useNotificationSettings: () => ({ channel: {} }) }))
vi.mock("@/hooks/community/use-community-ws", () => ({ communityWsSubscribe: vi.fn(), communityWsUnsubscribe: vi.fn(), communityWsSendTyping: vi.fn(), communityWsEndTyping: vi.fn() }))
vi.mock("@/lib/community-onboarding", () => ({ readCommunityOnboardingState: () => ({ status: "active", stage: "dm", dmId: "dm_1" }), advanceCommunityOnboarding: mocks.advance }))
vi.mock("@/hooks/community/mutations", async importOriginal => ({ ...await importOriginal<typeof import("@/hooks/community/mutations")>(), useAddReactionApi: () => vi.fn(), useToggleReactionApi: () => vi.fn(), useToggleMark: () => vi.fn(), useSetChannelNotif: () => ({ mutate: vi.fn() }) }))
vi.mock("./dm-header", () => ({ DmHeaderSkeleton: () => React.createElement("header", { "data-testid": "pending-peer" }), DmHeader: ({ onBack }: { onBack?: () => void }) => React.createElement("header", null, onBack ? React.createElement("button", { onClick: onBack, "aria-label": "Back" }) : null) }))
vi.mock("@/components/community/avatar", () => ({ Avatar: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/messages/conversation-footer-shell", () => ({ ConversationFooterSlotProvider: ({ children }: PropsWithChildren) => children, ConversationFooterShell: ({ children }: PropsWithChildren) => children }))
vi.mock("@/components/community/messages/composer", () => ({ ComposerSkeleton: () => React.createElement("div", { "data-testid": "composer-pending" }), Composer: ({ onAcceptSend }: { onAcceptSend: (text: string) => boolean }) => React.createElement("button", { onClick: () => onAcceptSend("hello") }, "Send") }))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: (props: { onRetry?: (id: string) => void }) => {
  mocks.list(props)
  return React.createElement("button", { onClick: () => props.onRetry?.("failed") }, "Retry")
} }))

beforeEach(() => { mocks.api.mockReset(); mocks.advance.mockReset(); mocks.list.mockReset(); mocks.positionEntry = null; mocks.failed = true; mocks.breakpoint = "mobile"; mocks.identity = true; mocks.blocked = false; mocks.windowBlocked = false })

function posted(body: { content: string; nonce: string }) {
  return { profiles: messageProfilesFixture([messageResourceFixture({ id: "confirmed", channelId: "dm_1", authorId: "u_me", authorName: "Me", authorAvatarVersion: 0, seq: 9, content: body.content, clientNonce: body.nonce, createdAt: "2026-10-09T00:00:00Z", embeds: [] })]), deduped: false, message: messageResourceFixture({ id: "confirmed", channelId: "dm_1", authorId: "u_me", authorName: "Me", authorAvatarVersion: 0, seq: 9, content: body.content, clientNonce: body.nonce, createdAt: "2026-10-09T00:00:00Z", embeds: [] }) }
}

async function createDmOwner() {
  const owner = await createCommunityQueryOwner("u_me")
  for (const id of ["dm_1", "dm_2"]) {
    const value = dmConversationEntryFixture()
    value.viewerId = "u_me"
    value.channelId = id
    value.channel = { ...value.channel, id }
    value.access = { ...value.access, channelId: id }
    value.readState = { ...value.readState, channelId: id }
    value.surfaceReceipt = { channelId: id, surfaceKind: "dm" }
    value.messages = []
    value.selection = { reason: "tail", anchorMessageId: null }
    value.readState = { ...value.readState, lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }
    value.page = { ...value.page, olderCursor: null, hasMoreOlder: false, latestSeq: 0 }
    await seedConversationEntry(owner.client, value)
  }
  return owner
}

describe("real DmView accepted send UI lifecycle", () => {
  it("keeps the known peer header and composer skeleton until its owned window is ready", async () => {
    const owner = await createDmOwner()
    mocks.windowBlocked = true
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    expect(view.container.querySelector("header")).not.toBeNull()
    expect(screen.getByTestId("composer-pending")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
    expect(mocks.list.mock.lastCall?.[0].onRetry).toBeUndefined()
    expect(mocks.api).not.toHaveBeenCalled()
    mocks.windowBlocked = false
    view.rerender(React.createElement(DmView, { dmId: "dm_1" }))
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    expect(screen.queryByTestId("composer-pending")).toBeNull()
    view.unmount()
  })

  it("keeps qualified messages when peer identity is absent and restricts sends until the peer relationship is known", async () => {
    const owner = await createDmOwner()
    mocks.identity = false
    await act(async () => {
      owner.registry.collections.profiles.utils.writeDelete("peer")
      owner.registry.collections.channelMemberships.utils.writeDelete("dm_1:peer:access")
    })
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    const retained = screen.getByRole("button", { name: "Retry" })
    expect(screen.getByTestId("pending-peer")).toBeInTheDocument()
    expect(mocks.list.mock.lastCall?.[0].messages).toHaveLength(1)
    expect(mocks.list.mock.lastCall?.[0].onRetry).toBeUndefined()
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
    await act(async () => owner.registry.collections.channelMemberships.utils.writeUpsert({ id: "dm_1:peer:access", channelId: "dm_1", userId: "peer", relation: "access", source: "added" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument())
    expect(mocks.list.mock.lastCall?.[0].channel).toBe("Direct message")
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retained)
    expect(mocks.api).not.toHaveBeenCalled()
    view.unmount()
  })

  it("keeps a known blocked peer hidden even when its presentation profile is missing", async () => {
    const owner = await createDmOwner()
    mocks.identity = false
    mocks.blocked = true
    await act(async () => owner.registry.collections.profiles.utils.writeDelete("peer"))
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
    expect(screen.getByText("You have blocked this user. Unblock to send messages.")).toBeInTheDocument()
    expect(mocks.api).not.toHaveBeenCalled()
    view.unmount()
  })

  it("passes a fresh same-DM position attempt and route activity to the retained message list", async () => {
    const owner = await createDmOwner()
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    mocks.positionEntry = {}
    const first = mocks.positionEntry
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    expect(mocks.list.mock.lastCall?.[0]).toMatchObject({ positionEntry: first, active: true, positioningActive: true, positionDataState: "ready" })
    view.rerender(React.createElement(DmView, { dmId: "dm_1", routeCommitted: false }))
    expect(mocks.list.mock.lastCall?.[0]).toMatchObject({ positionEntry: first, active: false, positioningActive: true })
    view.rerender(React.createElement(DmView, { dmId: "dm_1", routeCommitted: true }))
    expect(mocks.list.mock.lastCall?.[0]).toMatchObject({ active: true, positioningActive: true })
    expect(mocks.list.mock.lastCall?.[0].positionEntry).toBe(first)
    mocks.positionEntry = {}
    view.rerender(React.createElement(DmView, { dmId: "dm_1" }))
    expect(mocks.list.mock.lastCall?.[0].positionEntry).toBe(mocks.positionEntry)
    expect(mocks.list.mock.lastCall?.[0].positionEntry).not.toBe(first)
    view.unmount()
  })
  it.each(["send", "retry"] as const)("continues %s after target view retires without advancing old onboarding", async action => {
    const owner = await createDmOwner()
    owner.runtime.messageStream.actions.accept({ kind: "dm", id: "dm_1" }, { nonce: "retry_nonce", tempId: "temp_retry", message: { type: "chat", authorId: "u_me", content: "retry" }, localUploads: [] })
    owner.runtime.messageStream.actions.dispatch({ kind: "dm", id: "dm_1" }, { type: "postFail", nonce: "retry_nonce" })
    let finish!: (value: unknown) => void
    mocks.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    await act(async () => screen.getByRole("button", { name: action === "send" ? "Send" : "Retry" }).click())
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce())
    const [, options] = mocks.api.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(mocks.api.mock.calls[0][0]).toBe("/api/community/channels/dm_1/messages")
    view.rerender(React.createElement(DmView, { dmId: "dm_2" }))
    expect(options.signal.aborted).toBe(false)
    await act(async () => finish(posted(body)))
    await waitFor(() => expect(owner.registry.collections.messages.get("confirmed")?.channelId).toBe("dm_1"))
    expect(mocks.advance).not.toHaveBeenCalled()
    expect(mocks.api).toHaveBeenCalledOnce()
    view.unmount()
  })
  it.each(["send", "retry"] as const)("allows a current %s callback after real confirmation", async action => {
    const owner = await createDmOwner()
    owner.runtime.messageStream.actions.accept({ kind: "dm", id: "dm_1" }, { nonce: "retry_nonce", tempId: "temp_retry", message: { type: "chat", authorId: "u_me", content: "retry" }, localUploads: [] })
    owner.runtime.messageStream.actions.dispatch({ kind: "dm", id: "dm_1" }, { type: "postFail", nonce: "retry_nonce" })
    mocks.api.mockImplementationOnce((_path: string, options: { body: string }) => Promise.resolve(posted(JSON.parse(options.body))))
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    await act(async () => screen.getByRole("button", { name: action === "send" ? "Send" : "Retry" }).click())
    await waitFor(() => expect(mocks.advance).toHaveBeenCalledOnce())
    view.unmount()
  })
})

describe("DM initial responsive Back admission", () => {
  it("includes the mobile Back control in server markup before breakpoint effects", async () => {
    mocks.breakpoint = "unknown"
    const owner = await createDmOwner()
    const markup = renderToString(React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true },
      React.createElement(DmView, { dmId: "dm_1" })))
    expect(markup).toContain('aria-label="Back"')
  })
  it.each(["unknown", "mobile", "desktop"])("leaves Back display to its native responsive component while breakpoint is %s", async breakpoint => {
    mocks.breakpoint = breakpoint
    const owner = await createDmOwner()
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()
    view.unmount()
  })
})
