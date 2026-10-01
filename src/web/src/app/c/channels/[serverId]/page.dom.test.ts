import { createElement, useLayoutEffect, useRef } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ingestServerDetail, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { useServer } from "@/hooks/community/use-servers"
import { useBreakpoint } from "@/hooks/use-mobile"
import { clearLastChannel, setLastChannel } from "@/lib/community/last-channel"
import { useCommunityWsStore } from "@/stores/community/ws"
import { ChannelSidebarScope } from "@/components/community/channels/channel-sidebar-tree-owner"
import { tid } from "@/lib/community/testids"
import ServerDefaultPage from "./page"

const mocks = vi.hoisted(() => ({
  actual: false,
  breakpoint: { current: "mobile" as "mobile" | "desktop" | "unknown" },
  lastChannel: { current: null as string | null },
  replace: vi.fn(),
  search: { current: "" },
  server: { current: null as null | {
    categories: Array<{ channels: Array<{ id: string }> }>
  } },
}))

vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({
  AlookLoading: () => null,
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "server_1" }),
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search.current),
}))
vi.mock("@/hooks/community/use-servers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/community/use-servers")>()
  return { ...actual, useServer: (...args: Parameters<typeof actual.useServer>) => mocks.actual
    ? actual.useServer(...args) : { server: mocks.server.current } }
})
vi.mock("@/hooks/use-mobile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-mobile")>()
  return { ...actual, useBreakpoint: () => mocks.actual ? actual.useBreakpoint() : mocks.breakpoint.current }
})
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return { ...actual, apiFetch: () => new Promise(() => {}) }
})
vi.mock("@/lib/community/last-channel", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/last-channel")>(
    "@/lib/community/last-channel",
  )
  return {
    ...actual,
    getLastChannel: (serverId: string) => mocks.actual ? actual.getLastChannel(serverId) : mocks.lastChannel.current,
  }
})

beforeEach(() => {
  mocks.actual = false
  mocks.breakpoint.current = "mobile"
  mocks.lastChannel.current = null
  mocks.replace.mockClear()
  mocks.search.current = ""
  mocks.server.current = {
    categories: [{ channels: [{ id: "channel_1" }, { id: "channel_2" }] }],
  }
})

describe("actual mounted landing projection and breakpoint", () => {
  it.each(["text", "forum", "thread", "remembered", "cleared", "cold", "invalid-account"] as const)(
    "uses the current target structure in the first desktop commit: %s",
    async (scenario) => {
      mocks.actual = true
      clearLastChannel("server_1")
      const viewerId = scenario === "invalid-account" ? "new-viewer" : "landing-viewer"
      useCommunityWsStore.getState().activateProfileAccount(viewerId)
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const registry = createCommunityDbRegistry(client, viewerId)
      const { cleanup: disposeRegistry } = registry
      await registry.preload()
      const unregister = registerCommunityDbRegistry(registry)
      const known = scenario !== "cold" && scenario !== "invalid-account"
      const firstType = scenario === "forum" || scenario === "thread" ? "forum" : "text"
      if (known) ingestServerDetail(registry, { id: "server_1", name: "Server", discriminator: "0001",
        description: "", icon: null, ownerId: viewerId, categories: [{ id: "category", name: "Category", channels: [
          { id: "channel_1", name: "First", type: firstType, active: false, unread: false },
          { id: "channel_2", name: "Second", type: "forum", active: false, unread: false },
        ] }] })
      if (scenario === "thread") {
        projectCommunityWsEventToDb(client, { type: "community:channel.child_create", parentChannelId: "channel_1", parentMessageId: "opener",
          channel: { id: "remembered-thread", name: "Thread", type: "thread", createdAt: "2026-01-01T00:00:00.000Z" } })
        setLastChannel("server_1", "remembered-thread")
      }
      if (scenario === "remembered" || scenario === "cleared" || scenario === "invalid-account") setLastChannel("server_1", "channel_2")
      if (scenario === "cleared") clearLastChannel("server_1")
      let mobile = true
      const listeners = new Set<() => void>()
      vi.stubGlobal("matchMedia", () => ({ get matches() { return mobile },
        addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      }))
      const commits: Array<{ breakpoint: string; subtype: string | null; neutral: boolean }> = []
      function Capture() {
        const breakpoint = useBreakpoint()
        const { server } = useServer("server_1")
        const ref = useRef<HTMLDivElement>(null)
        useLayoutEffect(() => { commits.push({ breakpoint,
          subtype: ref.current?.querySelector("[data-community-conversation-subtype]")?.getAttribute("data-community-conversation-subtype") ?? null,
          neutral: !!ref.current?.querySelector("[data-community-unresolved-main]"),
        }) })
        return createElement("div", { ref }, createElement(ChannelSidebarScope, { categories: server?.categories ?? null,
          scopeKey: "server:server_1", targetServerId: "server_1", serverId: "server_1", serverName: "Server",
          activeChannel: "channel_1", setActiveChannel: vi.fn(), isAdmin: false, currentUserId: viewerId }),
        createElement(ServerDefaultPage))
      }
      const rendered = render(createElement(QueryClientProvider, { client },
        createElement(CommunityDbProvider, { registry }, createElement(Capture))))
      try {
        await waitFor(() => expect(commits.at(-1)?.breakpoint).toBe("mobile"))
        if (known) await waitFor(() => expect(rendered.container.querySelector(`[data-testid="${tid.channelRow("channel_1")}"]`)).toBeInTheDocument())
        const row = rendered.container.querySelector(`[data-testid="${tid.channelRow("channel_1")}"]`)
        const scroll = rendered.container.querySelector(`[data-testid="${tid.channelSidebarScroll}"]`)
        act(() => { mobile = false; for (const listener of listeners) listener() })
        const first = commits.find((commit) => commit.breakpoint === "desktop")
        expect(first).toBeDefined()
        if (known) {
          expect(first?.neutral).toBe(false)
          expect(first?.subtype).toBe(scenario === "thread" ? "thread" : scenario === "remembered" ? "forum" : firstType)
          expect(rendered.container.querySelector(`[data-testid="${tid.channelRow("channel_1")}"]`)).toBe(row)
          expect(rendered.container.querySelector(`[data-testid="${tid.channelSidebarScroll}"]`)).toBe(scroll)
          expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(`/c/channels/server_1/${scenario === "thread" ? "remembered-thread" : scenario === "remembered" ? "channel_2" : "channel_1"}`)
        } else {
          expect(first?.neutral).toBe(true)
          expect(first?.subtype).toBeNull()
          expect(mocks.replace).not.toHaveBeenCalled()
        }
      } finally {
        act(() => rendered.unmount())
        unregister()
        await disposeRegistry()
        await client.cancelQueries()
        client.clear()
        clearLastChannel("server_1")
        vi.unstubAllGlobals()
        mocks.actual = false
      }
    },
  )
})

describe("ServerDefaultPage checkpoint route contract", () => {
  it.each(["mobile", "unknown"] as const)("keeps the %s server root on the list route without rendering detail", async (breakpoint) => {
    mocks.breakpoint.current = breakpoint
    const rendered = render(createElement(ServerDefaultPage))

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(rendered.container).toBeEmptyDOMElement()
  })

  it("keeps cold or incomplete detail on the root, then redirects only when canonical detail is known", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.server.current = null
    const rendered = render(createElement(ServerDefaultPage))

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(screen.getByRole("main", { name: "Loading server" })).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("main", { name: "Loading server" }))
      .not.toHaveAttribute("data-community-mobile-transition")
    expect(rendered.container.querySelectorAll("header, button, form, textarea")).toHaveLength(0)

    mocks.server.current = { categories: [{ channels: [{ id: "channel_ready" }] }] }
    rendered.rerender(createElement(ServerDefaultPage))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/channels/server_1/channel_ready")
    expect(screen.getByRole("main", { name: "Loading server" })).toBeInTheDocument()
  })

  it("replaces the desktop server root with the remembered channel and preserves search", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.lastChannel.current = "channel_2"
    mocks.search.current = "settings=1"
    render(createElement(ServerDefaultPage))

    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_2?settings=1",
    )
    expect(screen.getByRole("main", { name: "Loading server" })).toBeInTheDocument()
  })

  it("does not enqueue the same landing redirect again while restored detail reconciles", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.lastChannel.current = "channel_2"
    const rendered = render(createElement(ServerDefaultPage))

    mocks.server.current = {
      categories: [{ channels: [{ id: "channel_1" }, { id: "channel_2" }] }],
    }
    rendered.rerender(createElement(ServerDefaultPage))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      "/c/channels/server_1/channel_2",
    )

    mocks.lastChannel.current = null
    mocks.server.current = { categories: [{ channels: [{ id: "channel_3" }] }] }
    rendered.rerender(createElement(ServerDefaultPage))
    expect(mocks.replace).toHaveBeenNthCalledWith(
      2,
      "/c/channels/server_1/channel_3",
    )
  })

  it("falls back to the first top-level channel on desktop", async () => {
    mocks.breakpoint.current = "desktop"

    render(createElement(ServerDefaultPage))

    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1",
    )
  })

  it("keeps an empty desktop server on its root with an empty state", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.server.current = { categories: [{ channels: [] }] }
    const rendered = render(createElement(ServerDefaultPage))

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(rendered.container.querySelector("[aria-label='Loading server']")).not.toBeInTheDocument()
    expect(screen.getByText("No channels yet")).toBeInTheDocument()
    expect(screen.getByText("Create a channel from the sidebar to get started.")).toBeInTheDocument()
  })
})
