import { createElement, type ReactNode } from "react"
import { renderToReadableStream, renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Database } from "@alook/shared"
import { conversationEntryFixture, dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { useCanonicalCommunityProfile, useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useDmMessages, useMessages } from "@/hooks/community/use-messages"

const documentTarget = vi.hoisted(() => ({ dm: false, author: false }))

vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "viewer" } }, isPending: false, error: null }), currentSessionViewer: () => "viewer" }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/channels/s1/c1", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/use-community-ws", () => ({ useCommunityWs: vi.fn() }))
vi.mock("@/hooks/community/use-notification-settings", () => ({ useNotificationSettings: vi.fn() }))
vi.mock("@/hooks/community/use-account-attention", () => ({ useAccountAttention: vi.fn() }))
vi.mock("@/components/perf/perf-trace-bootstrap", () => ({ PerfTraceBootstrap: () => null }))
vi.mock("@/components/community/onboarding/community-onboarding-form", () => ({ CommunityOnboardingForm: () => null }))
vi.mock("@/components/community/shell/community-ws-reconnect-overlay", () => ({ CommunityWsReconnectBoundary: ({ children }: { children: ReactNode }) => children }))
vi.mock("@/components/community/shell/owner-server-delete-route-guard", () => ({ OwnerServerDeleteRouteGuard: () => null }))
vi.mock("@/lib/community/message-door", () => ({ resolveMessageTarget: async () => ({ ok: true, value: { access: { channel: { serverId: documentTarget.dm ? null : "s1" } } } }) }))
vi.mock("@/lib/community/conversation-entry.server", () => ({ readCommunityConversationEntry: async () => {
  const entry = documentTarget.dm ? dmConversationEntryFixture() : conversationEntryFixture()
  if (documentTarget.author) entry.messages = entry.messages.map(message => ({ ...message, authorName: "Peer", authorAvatar: "P", authorAvatarVersion: 5 }))
  return { ok: true, entry }
} }))

import { readCommunityDocumentSeed } from "@/lib/community/document-seed.server"
import { CommunityShell } from "./community-shell"
import { MessageList } from "@/components/community/messages/message-list"

describe("document HTML through the actual account and profile boundaries", () => {
  it.each([
    { kind: "channel", qualified: true }, { kind: "dm", qualified: true },
    { kind: "channel", qualified: false }, { kind: "dm", qualified: false },
  ])("streams $kind rows from an initially pending document seed with qualification=$qualified", async ({ kind, qualified }) => {
    documentTarget.dm = kind === "dm"
    documentTarget.author = true
    const profile = { id: "viewer", name: "Viewer", discriminator: "0042", avatar: "/avatar", avatarVersion: 8, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: "" }
    const seed = await readCommunityDocumentSeed({} as Database, "viewer", documentTarget.dm ? "/c/me/c1" : "/c/channels/s1/c1", profile)
    let release!: (value: typeof seed) => void
    const pending = new Promise<typeof seed>(resolve => { release = resolve })
    let didRender!: () => void
    const rendered = new Promise<void>(resolve => { didRender = resolve })
    let registry: CommunityDbRegistry | null = null
    function Conversation() {
      registry = useOptionalCommunityDbRegistry()
      didRender()
      const channelFeed = useMessages(documentTarget.dm ? null : "c1", { serverId: "s1", viewerUserId: "viewer" })
      const dmFeed = useDmMessages(documentTarget.dm ? "c1" : null, { viewerUserId: "viewer" })
      const feed = documentTarget.dm ? dmFeed : channelFeed
      const author = useCanonicalCommunityProfile("peer")
      return createElement("section", null, createElement("span", { "data-testid": "canonical-peer" }, author?.name ?? "missing"), createElement(MessageList, { channel: "Channel", messages: feed.messages, loading: feed.isLoading, initialScrollReady: feed.initialPositionKnown, observation: feed.observation, onOpenThread: () => {}, viewerUserId: "viewer" }))
    }
    try {
      const streaming = renderToReadableStream(createElement(CommunityShell, { currentUser: { ...profile, email: "viewer@example.test" }, initialSeed: pending }, createElement(Conversation)))
      await rendered
      expect(registry).not.toBeNull()
      release(qualified ? seed : { ...seed, viewerId: "other" })
      const html = await new Response(await streaming).text()
      if (qualified) {
        expect(html).toContain('data-testid="community-message-m1"')
        expect(html).toContain("Body")
        expect(html).toContain("Peer")
      } else {
        expect(html).not.toContain('data-testid="community-message-m1"')
        expect(html).not.toContain("Body")
        expect(html).not.toContain("Peer")
      }
      expect(html).not.toContain("Deleted user")
      expect((registry! as CommunityDbRegistry).restoration.get().captured).toBe(false)
      expect((registry! as CommunityDbRegistry).queryClient.getQueryCache().getAll().every(query => query.state.fetchStatus === "idle")).toBe(true)
    } finally {
      release(seed)
      if (registry) { await (registry as CommunityDbRegistry).cleanup(); (registry as CommunityDbRegistry).queryClient.clear() }
      documentTarget.dm = false
      documentTarget.author = false
    }
  })

  it.each(["channel", "dm"])("emits actual %s message rows through the real message list before mount effects", async (kind) => {
    documentTarget.dm = kind === "dm"
    const profile = { id: "viewer", name: "Viewer", discriminator: "0042", avatar: "/avatar", avatarVersion: 8, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: "" }
    const seed = await readCommunityDocumentSeed({} as Database, "viewer", documentTarget.dm ? "/c/me/c1" : "/c/channels/s1/c1", profile)
    let registry: CommunityDbRegistry | null = null
    function Conversation() {
      registry = useOptionalCommunityDbRegistry()
      const channelFeed = useMessages(documentTarget.dm ? null : "c1", { serverId: "s1", viewerUserId: "viewer" })
      const dmFeed = useDmMessages(documentTarget.dm ? "c1" : null, { viewerUserId: "viewer" })
      const feed = documentTarget.dm ? dmFeed : channelFeed
      return createElement(MessageList, { channel: "Channel", messages: feed.messages, loading: feed.isLoading, initialScrollReady: feed.initialPositionKnown, observation: feed.observation, onOpenThread: () => {}, viewerUserId: "viewer" })
    }
    try {
      const html = renderToString(createElement(CommunityShell, { currentUser: { ...profile, email: "viewer@example.test" }, initialSeed: seed }, createElement(Conversation)))
      expect(html).toContain('data-testid="community-message-m1"')
      expect(html).toContain("Body")
      expect(html).not.toMatch(/data-message-list-content[^>]*aria-hidden="true"/)
      expect(html).toMatch(/transform:translate3d\(0, [1-9]\d*(?:\.\d+)?px, 0\)/)
      expect(html).toContain('data-read-position-ready="false"')
    } finally {
      if (registry) { await (registry as CommunityDbRegistry).cleanup(); (registry as CommunityDbRegistry).queryClient.clear() }
      documentTarget.dm = false
    }
  })

  it("renders the real current-user and message hooks before any restore or mount effect", async () => {
    const profile = { id: "viewer", name: "Canonical viewer", discriminator: "0042", avatar: "/avatar", avatarVersion: 8, aboutMe: "About", bannerColor: null, statusEmoji: null, statusText: "" }
    const seed = await readCommunityDocumentSeed({} as Database, "viewer", "/c/channels/s1/c1", profile)
    let registry: CommunityDbRegistry | null = null
    function Probe() {
      registry = useOptionalCommunityDbRegistry()
      const user = useCurrentUser()
      const feed = useMessages("c1", { serverId: "s1", viewerUserId: "viewer" })
      return createElement("main", null, `${user.name}:${feed.isLoading ? "pending" : feed.messages.map(message => message.content).join("|")}`)
    }
    try {
      const html = renderToString(createElement(CommunityShell, { currentUser: { ...profile, email: "viewer@example.test" }, initialSeed: seed }, createElement(Probe)))
      expect(html).toContain("<main>Canonical viewer:Body</main>")
      expect(html).not.toContain("community-session-pending")
      expect(registry).not.toBeNull()
      expect((registry! as CommunityDbRegistry).restoration.get().captured).toBe(false)
      expect((registry! as CommunityDbRegistry).queryClient.getQueryCache().getAll().every(query => query.state.fetchStatus === "idle")).toBe(true)
    } finally {
      if (registry) {
        await (registry as CommunityDbRegistry).cleanup()
        ;(registry as CommunityDbRegistry).queryClient.clear()
      }
    }
  })
})
