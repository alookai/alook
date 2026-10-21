import React, { type PropsWithChildren } from "react"
import type { Editor } from "@tiptap/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { serializeComposerDocument } from "../messages/composer-ordered-list"
import type { ComposerHandle, ComposerProps } from "../messages/composer-types"
import { DmView } from "./dm-view"

const mocks = vi.hoisted(() => ({
  editor: null as Editor | null,
  metadata: {
    canRead: true, status: "readable", data: undefined as { type: "dm" } | undefined,
    canonical: { id: "dm_1", serverId: null, type: "dm", pending: true, resourceComplete: false },
  },
  profiles: new Map([["peer", { id: "peer", name: "Peer", discriminator: "0042" }]]),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "mobile" }))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "u_me", name: "Me", avatar: "M" }) }))
vi.mock("@/hooks/community/use-dms", () => ({ useDms: () => ({ dms: [{ id: "dm_1", userId: "peer", name: "Peer", avatar: "P" }], isLoading: false, isFetching: false }) }))
vi.mock("@/hooks/community/use-friends", () => ({ useFriends: () => ({ friends: [], blocked: [] }) }))
vi.mock("@/hooks/community/use-messages", () => ({ useDmMessages: () => ({ messages: [{ id: "target", authorId: "peer", authorName: "Peer", type: "chat", content: "reply target" }], isLoading: false, isPending: false, isError: false, latestSeq: 1 }) }))
vi.mock("@/hooks/community/use-channel-metadata", () => ({ useChannelMetadata: () => mocks.metadata }))
vi.mock("@/hooks/community/use-dm-watermark", () => ({ useDmWatermark: vi.fn() }))
vi.mock("@/hooks/community/use-channel-ref-directory", () => ({ useChannelRefDirectory: () => ({ directory: [], isResolved: true }) }))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({ useNativeSystemNotificationConversationDismissal: vi.fn() }))
vi.mock("./use-dm-seq-context", () => ({ useDmSeqContext: vi.fn() }))
vi.mock("@/lib/community/last-community-route", () => ({ commitCommunityChannelRoute: vi.fn() }))
vi.mock("@/hooks/community/use-notification-settings", () => ({ useNotificationSettings: () => ({ channel: {} }) }))
vi.mock("@/hooks/community/use-community-ws", () => ({ communityWsSubscribe: vi.fn(), communityWsUnsubscribe: vi.fn(), communityWsSendTyping: vi.fn(), communityWsEndTyping: vi.fn() }))
vi.mock("@/lib/community-onboarding", () => ({ readCommunityOnboardingState: () => null, advanceCommunityOnboarding: vi.fn() }))
vi.mock("@/hooks/community/mutations", async importOriginal => ({ ...await importOriginal<typeof import("@/hooks/community/mutations")>(), useAddReactionApi: () => vi.fn(), useToggleReactionApi: () => vi.fn(), useToggleMark: () => vi.fn(), useSetChannelNotif: () => ({ mutate: vi.fn() }) }))
vi.mock("@/lib/community-db/projections", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/community-db/projections")>(), useCanonicalProfilesByUserId: () => mocks.profiles }))
vi.mock("./dm-header", () => ({ DmHeader: () => null }))
vi.mock("@/components/community/avatar", () => ({ Avatar: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/messages/conversation-footer-shell", () => ({ ConversationFooterSlotProvider: ({ children }: PropsWithChildren) => children, ConversationFooterShell: ({ children }: PropsWithChildren) => children }))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: ({ onReply }: { onReply?: (id: string) => void }) => React.createElement("button", { onClick: () => onReply?.("target") }, "Reply") }))
vi.mock("@/components/community/messages/composer", async () => {
  const { EditorContent } = await import("@tiptap/react")
  const { useComposerController } = await import("../messages/use-composer-controller")
  return {
    ComposerSkeleton: () => null,
    Composer: React.forwardRef<ComposerHandle, ComposerProps>(function RealEditor(props, ref) {
      const view = useComposerController(props, ref)
      mocks.editor = view.editor
      return React.createElement(React.Fragment, null,
        React.createElement(EditorContent, { editor: view.editor }),
        view.replyingTo ? React.createElement("button", { onClick: props.onCancelReply }, "Cancel reply") : null)
    }),
  }
})

beforeEach(() => {
  localStorage.clear()
  mocks.editor = null
  mocks.metadata.canRead = true
  mocks.metadata.data = undefined
  mocks.metadata.canonical.pending = true
  mocks.metadata.canonical.resourceComplete = false
  const rect = new DOMRect(10, 20, 1, 18)
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect })
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [rect] })
})
afterEach(() => {
  delete (Range.prototype as Partial<Range>).getBoundingClientRect
  delete (Range.prototype as Partial<Range>).getClientRects
})

async function renderDm() {
  const owner = await createCommunityQueryOwner("u_me")
  const wrapper = ({ children }: PropsWithChildren) => React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "u_me", retainOwner: true }, children)
  return render(React.createElement(DmView, { dmId: "dm_1" }), { wrapper })
}

describe("DM reply during partial metadata projection", () => {
  it.each(["", "before @Peer#0042 after"])("preserves the exact manual document %j before full metadata arrives", async draft => {
    const rendered = await renderDm()
    await waitFor(() => expect(mocks.editor).not.toBeNull())
    const editor = mocks.editor!
    await act(async () => { editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", ...(draft ? { content: [{ type: "text", text: draft }] } : {}) }] }) })
    const before = editor.getJSON()
    await act(async () => screen.getByRole("button", { name: "Reply", exact: true }).click())
    expect(screen.getByRole("button", { name: "Cancel reply", exact: true })).toBeInTheDocument()
    expect(editor.getJSON()).toEqual(before)
    expect(serializeComposerDocument(editor)).toBe(draft)
    expect(editor.view.dom.querySelectorAll('[data-type="mention"]')).toHaveLength(0)
    mocks.metadata.data = { type: "dm" }
    mocks.metadata.canonical.pending = false
    mocks.metadata.canonical.resourceComplete = true
    await act(async () => { rendered.rerender(React.createElement(DmView, { dmId: "dm_1" })) })
    expect(editor.getJSON()).toEqual(before)
    await act(async () => screen.getByRole("button", { name: "Cancel reply", exact: true }).click())
    expect(editor.getJSON()).toEqual(before)
    rendered.unmount()
  })

  it("keeps the composer unavailable without a read grant", async () => {
    mocks.metadata.canRead = false
    const rendered = await renderDm()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(mocks.editor).toBeNull()
    rendered.unmount()
  })
})
