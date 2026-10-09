import React, { type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { DmView } from "./dm-view"

const mocks = vi.hoisted(() => ({ api: vi.fn(), advance: vi.fn(), failed: true }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api, toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "mobile" }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "u_me", name: "Me", avatar: "M" }) }))
vi.mock("@/hooks/community/use-dms", () => ({ useDms: () => ({ dms: ["dm_1", "dm_2"].map(id => ({ id, userId: "peer", name: "Peer", avatar: "P" })), isLoading: false, isFetching: false }) }))
vi.mock("@/hooks/community/use-friends", () => ({ useFriends: () => ({ friends: [], blocked: [] }) }))
vi.mock("@/hooks/community/use-messages", () => ({ useDmMessages: () => ({ messages: mocks.failed ? [{ id: "failed", clientNonce: "retry_nonce", authorId: "u_me", type: "chat", content: "retry" }] : [], isLoading: false, isPending: false, isError: false, latestSeq: 0 }) }))
vi.mock("@/hooks/community/use-channel-metadata", () => ({ useChannelMetadata: () => ({ canRead: true, status: "readable" }) }))
vi.mock("@/hooks/community/use-dm-read-state", () => ({ useDmReadStateSnapshot: () => ({ snapshot: { lastReadMessageId: null, lastReadSeq: 0 }, isFetching: false }) }))
vi.mock("@/hooks/community/use-dm-watermark", () => ({ useDmWatermark: vi.fn() }))
vi.mock("@/hooks/community/use-channel-ref-directory", () => ({ useChannelRefDirectory: () => ({ directory: [], isResolved: true }) }))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({ useNativeSystemNotificationConversationDismissal: vi.fn() }))
vi.mock("./use-dm-seq-context", () => ({ useDmSeqContext: vi.fn() }))
vi.mock("@/lib/community/conversation-navigation-proof", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/community/conversation-navigation-proof")>(), useConversationNavigationGate: () => ({ allowed: true, failed: false }) }))
vi.mock("@/lib/community/last-community-route", () => ({ commitCommunityChannelRoute: vi.fn() }))
vi.mock("@/hooks/community/use-notification-settings", () => ({ useNotificationSettings: () => ({ channel: {} }) }))
vi.mock("@/hooks/community/use-community-ws", () => ({ communityWsSubscribe: vi.fn(), communityWsUnsubscribe: vi.fn(), communityWsSendTyping: vi.fn(), communityWsEndTyping: vi.fn() }))
vi.mock("@/lib/community-onboarding", () => ({ readCommunityOnboardingState: () => ({ status: "active", stage: "dm", dmId: "dm_1" }), advanceCommunityOnboarding: mocks.advance }))
vi.mock("@/hooks/community/mutations", async importOriginal => ({ ...await importOriginal<typeof import("@/hooks/community/mutations")>(), useAddReactionApi: () => vi.fn(), useToggleReactionApi: () => vi.fn(), useToggleMark: () => vi.fn(), useSetChannelNotif: () => ({ mutate: vi.fn() }) }))
vi.mock("./dm-header", () => ({ DmHeader: () => null }))
vi.mock("@/components/community/avatar", () => ({ Avatar: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/messages/conversation-footer-shell", () => ({ ConversationFooterSlotProvider: ({ children }: PropsWithChildren) => children, ConversationFooterShell: ({ children }: PropsWithChildren) => children }))
vi.mock("@/components/community/messages/composer", () => ({ ComposerSkeleton: () => null, Composer: ({ onAcceptSend }: { onAcceptSend: (text: string) => boolean }) => React.createElement("button", { onClick: () => onAcceptSend("hello") }, "Send") }))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: ({ onRetry }: { onRetry: (id: string) => void }) => React.createElement("button", { onClick: () => onRetry("failed") }, "Retry") }))

beforeEach(() => { mocks.api.mockReset(); mocks.advance.mockReset(); mocks.failed = true })

describe("real DmView accepted send UI lifecycle", () => {
  it.each(["send", "retry"] as const)("continues %s after target view retires without advancing old onboarding", async action => {
    const owner = await createCommunityQueryOwner("u_me")
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
    await act(async () => finish({ message: { id: "confirmed", seq: 9, type: "chat", content: body.content, authorId: "u_me", authorName: "Me", createdAt: "2026-10-09T00:00:00Z", embeds: [] } }))
    await waitFor(() => expect(owner.registry.collections.messages.get("confirmed")?.channelId).toBe("dm_1"))
    expect(mocks.advance).not.toHaveBeenCalled()
    expect(mocks.api).toHaveBeenCalledOnce()
    view.unmount()
  })
  it.each(["send", "retry"] as const)("allows a current %s callback after real confirmation", async action => {
    const owner = await createCommunityQueryOwner("u_me")
    owner.runtime.messageStream.actions.accept({ kind: "dm", id: "dm_1" }, { nonce: "retry_nonce", tempId: "temp_retry", message: { type: "chat", authorId: "u_me", content: "retry" }, localUploads: [] })
    owner.runtime.messageStream.actions.dispatch({ kind: "dm", id: "dm_1" }, { type: "postFail", nonce: "retry_nonce" })
    mocks.api.mockResolvedValueOnce({ message: { id: "confirmed", seq: 9, type: "chat", content: "hello", authorId: "u_me", authorName: "Me", createdAt: "2026-10-09T00:00:00Z", embeds: [] } })
    const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
    const view = render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
    await act(async () => screen.getByRole("button", { name: action === "send" ? "Send" : "Retry" }).click())
    await waitFor(() => expect(mocks.advance).toHaveBeenCalledOnce())
    view.unmount()
  })
})
