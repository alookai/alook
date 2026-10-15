import { createElement, type ReactNode } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Database } from "@alook/shared"
import { conversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useMessages } from "@/hooks/community/use-messages"

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
vi.mock("@/lib/community/message-door", () => ({ resolveMessageTarget: async () => ({ ok: true, value: { access: { channel: { serverId: "s1" } } } }) }))
vi.mock("@/lib/community/conversation-entry.server", () => ({ readCommunityConversationEntry: async () => ({ ok: true, entry: conversationEntryFixture() }) }))

import { readCommunityDocumentSeed } from "@/lib/community/document-seed.server"
import { CommunityShell } from "./community-shell"

describe("document HTML through the actual account and profile boundaries", () => {
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
