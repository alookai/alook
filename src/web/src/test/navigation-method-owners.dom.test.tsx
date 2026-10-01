import { createElement, useLayoutEffect, useRef } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { act, render, waitFor, mockElementGeometry } from "@/test/react-dom-harness"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestServerDetail } from "@/lib/community-db/sync"
import { CommunityDbProvider, useServerTreeProjection, useTrustedRestoredPrimary } from "@/lib/community-db/projections"
import { normalizeCommunityHref, resolveCommunityCheckpointPlan } from "@/lib/community/community-route"
import { ChannelSidebarScope } from "@/components/community/channels/channel-sidebar-tree-owner"
import { CommunityPendingFrame } from "@/components/community/shell/community-pending-frame"
import { inspectConversationReadiness } from "./conversation-readiness"
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { tid } from "@/lib/community/testids"

const detail = {
  id: "target", name: "Target", discriminator: "0001", description: "", icon: null, ownerId: "viewer",
  categories: [{ id: "category", name: "Category", channels: [{ id: "leaf", name: "leaf", type: "text" as const, active: false, unread: false }] }],
}

describe("real navigation method owners", () => {
  it("retains a complete live warm tree without a cold commit across Home remount", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(client, "viewer")
    const { cleanup: disposeRegistry } = registry
    await registry.preload()
    ingestServerDetail(registry, detail)
    const commits: Array<{ ready: boolean; trusted: boolean; mode: string; subtype: string | undefined; cold: boolean; owner: boolean }> = []
    function Owner({ show }: { show: boolean }) {
      const tree = useServerTreeProjection("target")
      const trusted = useTrustedRestoredPrimary()
      const ref = useRef<HTMLDivElement>(null)
      const subtype = tree?.categories.flatMap((category) => category.channels).find((channel) => channel.id === "leaf")?.type
      const checkpoint = resolveCommunityCheckpointPlan({
        committedFrame: { ...normalizeCommunityHref("/c/me/friends"), revision: 1 },
        targetHref: "/c/channels/target/leaf", pending: true, targetReady: tree !== undefined,
        targetConversationSubtype: subtype === "text" || subtype === "forum" ? subtype : undefined,
      })
      useLayoutEffect(() => {
        if (show) commits.push({ ready: tree !== undefined, trusted, mode: checkpoint.mode, subtype,
          cold: !!ref.current?.querySelector("[data-pending-server-id]"),
          owner: !!ref.current?.querySelector("[data-community-channel-tree-scope]") })
      })
      return createElement("div", { ref }, show && createElement(ChannelSidebarScope, {
        categories: tree?.categories ?? null, scopeKey: "server:target", targetServerId: "target", serverId: "target",
        serverName: "Target", activeChannel: "leaf", setActiveChannel: vi.fn(), isAdmin: false, currentUserId: "viewer",
      }), show && checkpoint.main.kind === "target-skeleton" && createElement(CommunityPendingFrame, {
        href: checkpoint.main.href, conversationSubtype: checkpoint.main.conversationSubtype,
      }))
    }
    const view = (show: boolean) => <QueryClientProvider client={client}>
      <CommunityDbProvider registry={registry}><Owner show={show} /></CommunityDbProvider>
    </QueryClientProvider>
    const rendered = render(view(true))
    try {
      await waitFor(() => expect(commits.some((commit) => commit.ready && commit.mode === "warm-scope" && commit.subtype === "text")).toBe(true))
      expect(rendered.container.querySelector('[data-community-conversation-subtype="text"]')).toBeInTheDocument()
      rendered.rerender(view(true))
      await waitFor(() => expect(rendered.container.querySelector(`[data-testid="${tid.channelRow("leaf")}"]`)).toBeInTheDocument())
      rendered.rerender(view(false))
      expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBeNull()
      const before = commits.length
      rendered.rerender(view(true))
      const remount = commits.slice(before)
      expect(remount.length).toBeGreaterThan(0)
      expect(remount.every((commit) => commit.ready && !commit.trusted && commit.mode === "warm-scope" && commit.subtype === "text")).toBe(true)
      expect(remount.some((commit) => commit.cold)).toBe(false)
      expect(remount.every((commit) => commit.owner)).toBe(true)
    } finally {
      act(() => rendered.unmount())
      await disposeRegistry()
      client.clear()
    }
  })
})


describe("actual installed Panel DOM", () => {
  it("qualifies mobile detail through the real primitive inner wrapper", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal("location", { pathname: "/c/channels/target/leaf" })
    const sidebarProps = { id: "sidebar", "data-mobile-hidden": "true" }
    const mainProps = { id: "main", "data-mobile-active": "true" }
    const rendered = render(createElement("div", { "data-slot": "community-shell-root" },
      createElement(ResizablePanelGroup, { id: "community-shell", orientation: "horizontal" },
        createElement(ResizablePanel, sidebarProps,
          createElement("div", { "data-slot": "community-sidebar-panel-content", hidden: true },
            createElement("div", { "data-community-channel-tree-scope": "server:target", style: { display: "contents" } },
              createElement("div", { "data-testid": tid.channelSidebarScroll })))),
        createElement(ResizablePanel, mainProps,
          createElement("div", { "data-slot": "community-main-panel-content", "data-community-mobile-surface": "detail" },
            createElement("div", { "data-slot": "community-conversation-surface", "data-channel-id": "leaf" },
              createElement("div", { "data-message-list-content": "", "data-initial-position-phase": "revealed" },
                createElement("div", { "data-testid": tid.message("expected") }, "Expected")),
              createElement("div", { "data-testid": tid.composerInput }, createElement("div", { contentEditable: true }))))))))
    const restorers = Array.from(rendered.container.querySelectorAll<HTMLElement>("*")).map((node) => mockElementGeometry(node, {
      width: node.closest("#sidebar") ? 0 : 100, height: node.closest("#sidebar") ? 0 : 40,
    }))
    try {
      const content = rendered.container.querySelector('[data-slot="community-sidebar-panel-content"]')!
      expect(content.parentElement).not.toBe(rendered.container.querySelector("#sidebar"))
      expect(content.closest('[data-slot="resizable-panel"]')).toBe(rendered.container.querySelector("#sidebar"))
      expect(inspectConversationReadiness({ pathname: "/c/channels/target/leaf", serverId: "target", channelId: "leaf", kind: "text", layout: "mobile-detail", messageTestId: tid.message("expected"),
        testIds: { channelSidebarScroll: tid.channelSidebarScroll, composerInput: tid.composerInput, forumPostList: tid.forumPostList, pendingMainPrefix: tid.pendingMain(""), messagePrefix: tid.message("") } }).blockers).toEqual([])
    } finally {
      restorers.reverse().forEach((restore) => restore())
      rendered.unmount()
      vi.unstubAllGlobals()
    }
  })
})

import type { Page } from "@playwright/test"
import { observeRenderedNavigation, renderedViolations, withOwnedCleanup } from "./e2e-ui/_fixtures/rendered-navigation"
import { ServerLandingPendingFrame } from "@/components/community/shell/server-landing-pending-frame"
import ServerRouteLoading from "@/app/c/channels/[serverId]/loading"
import { ConversationResolutionPendingFrame } from "@/components/community/channels/conversation-resolution-pending-frame"
import { DmLoadingFrame } from "@/components/community/channels/dm-loading-frame"
import { ForumView } from "@/components/community/channels/forum-view"
import { DmSidebar } from "@/components/community/channels/dm-sidebar"

async function observeOwner(content: ReturnType<typeof createElement>, options: { pathname?: string; cold?: boolean; tree?: boolean; dm?: "empty" | "rows" | "pending"; mutate?: (container: HTMLElement) => void } = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal("location", { pathname: options.pathname ?? "/c/channels/target" })
  if (options.dm) vi.stubGlobal("innerWidth", 390)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0))
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle))
  const restoreViewportGeometry = mockElementGeometry(HTMLElement.prototype, { width: 300, height: 800, offsetWidth: 300, offsetHeight: 800, clientWidth: 300, clientHeight: 800 })
  const rendered = render(createElement("div", { "data-slot": "community-shell-root" },
    createElement("div", { "data-slot": "resizable-panel-group", id: "community-shell" },
      (options.cold || options.tree) && createElement("div", { "data-slot": "resizable-panel", id: "sidebar" },
        createElement("div", { "data-slot": "community-sidebar-panel-content" }, createElement(ChannelSidebarScope, {
          categories: options.tree ? detail.categories : null, scopeKey: "server:target", targetServerId: "target", serverId: "target", serverName: "Target",
          activeChannel: "leaf", setActiveChannel: vi.fn(), isAdmin: false, currentUserId: "viewer",
        }))),
      options.dm && createElement("div", { "data-slot": "resizable-panel", id: "sidebar" },
        createElement("div", { "data-slot": "community-sidebar-panel-content", "data-community-mobile-surface": "list" },
          createElement(DmSidebar, { dms: options.dm !== "rows" ? [] : [{ id: "dm", userId: "peer", name: "Peer",
            discriminator: "0002", avatar: "P", avatarVersion: 0, status: "offline", preview: "Preview", unread: false }],
          loading: options.dm === "pending", activeDm: null, onPickDm: vi.fn(), onShowFriends: vi.fn() }))),
      createElement("div", { "data-slot": "resizable-panel", id: "main" },
        createElement("div", { "data-slot": "community-main-panel-content", hidden: !!options.dm }, content)))))
  options.mutate?.(rendered.container)
  const restores = Array.from(rendered.container.querySelectorAll<HTMLElement>("*")).map((node) => mockElementGeometry(node, { width: 100, height: 40 }))
  const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as unknown as Page
  try {
    const probe = await observeRenderedNavigation(page, null, "programmatic")
    return await probe.stop()
  } finally {
    restores.reverse().forEach((restore) => restore())
    rendered.unmount()
    restoreViewportGeometry()
    vi.unstubAllGlobals()
  }
}

describe("actual mobile DM Home list owner", () => {
  const contract = { paths: ["/c/me"], finalPath: "/c/me", scopes: [], listStates: ["dms"],
    finalListState: "dms", stationary: true, actionKind: "programmatic" as const }
  it.each(["empty", "rows"] as const)("recognizes the real %s DM sidebar with a hidden main", async (dm) => {
    const observation = await observeOwner(createElement("input", { placeholder: "Search friends" }), { pathname: "/c/me", dm })
    expect(observation.frames.at(-1)?.lists).toEqual(["dms"])
    expect(observation.frames.at(-1)?.dmLists).toEqual([{ owned: true, visible: true,
      rows: dm === "rows" ? [tid.dmRow("dm")] : [], state: dm, width: 100, height: 40 }])
    expect(renderedViolations(observation, contract)).toEqual([])
  })
  it("allows a pending transition but rejects it as the final Home list", async () => {
    const observation = await observeOwner(createElement("input", { placeholder: "Search friends" }), { pathname: "/c/me", dm: "pending" })
    expect(observation.frames.at(-1)?.lists).toEqual(["dms-pending"])
    expect(renderedViolations(observation, { ...contract, listStates: ["dms", "dms-pending"] })).toContain("missing final list surface")
  })
  it.each(["hidden", "foreign", "missing-shortcuts", "duplicate", "blank"] as const)(
    "rejects a %s DM Home witness", async (fault) => {
      const observation = await observeOwner(createElement("input", { placeholder: "Search friends" }), {
        pathname: "/c/me", dm: "empty", mutate: (container) => {
          const list = container.querySelector('[data-slot="dm-sidebar-list"]')!
          if (fault === "hidden") list.setAttribute("hidden", "")
          if (fault === "missing-shortcuts") container.querySelector('[data-slot="dm-sidebar-shortcuts"]')!.remove()
          if (fault === "blank") list.replaceChildren()
          if (fault === "duplicate") list.parentElement!.appendChild(list.cloneNode(true))
          if (fault === "foreign") {
            const panel = document.createElement("div")
            panel.dataset.slot = "resizable-panel"; panel.id = "foreign"
            container.appendChild(panel); panel.appendChild(list)
          }
        },
      })
      expect(renderedViolations(observation, contract).length).toBeGreaterThan(0)
    },
  )
})

describe("actual pending marker roles", () => {
  it.each([
    ["wrapped-server-landing", () => createElement(CommunityPendingFrame, { href: "/c/channels/target" })],
    ["direct-server-landing", () => createElement(ServerLandingPendingFrame)],
    ["segment-loading", () => createElement(ServerRouteLoading)],
    ["unknown-conversation", () => createElement(ConversationResolutionPendingFrame)],
    ["me-root", () => createElement(CommunityPendingFrame, { href: "/c/me" })],
    ["route-resolution", () => createElement(CommunityPendingFrame, { href: "/not-community" })],
  ] as const)("retains raw marker and classifies real %s branch", async (role, content) => {
    const observation = await observeOwner(content(), { cold: true })
    expect(observation.frames.at(-1)?.unresolved).toEqual([{ role, kind: role === "wrapped-server-landing" ? "server-landing" : role === "me-root" ? "me-root" : role === "route-resolution" ? "route-resolution" : null, subtype: role === "unknown-conversation" ? "unknown" : null, owned: true }])
    const violations = renderedViolations(observation, { paths: ["/c/channels/target"], finalPath: "/c/channels/target", scopes: [], actionKind: "programmatic", coldRoot: { serverId: "target", rootPath: "/c/channels/target" }, allowedColdServers: ["target"], pendingKind: role === "wrapped-server-landing" ? "server-landing" : role === "unknown-conversation" ? "server-conversation" : role === "me-root" ? "me-root" : "route-resolution" })
    expect(violations.includes("wrong neutral conversation")).toBe(!["wrapped-server-landing", "direct-server-landing", "segment-loading"].includes(role))
  })
  it.each(["text", "forum", "thread"] as const)("known %s has no raw unresolved marker", async (subtype) => {
    const observation = await observeOwner(<ConversationResolutionPendingFrame subtype={subtype} />)
    expect(observation.frames.at(-1)?.neutral).toBe(false)
    expect(observation.frames.at(-1)?.pending).toContainEqual({ kind: "server-conversation", subtype })
  })
  it("real DM skeleton has no raw unresolved marker", async () => {
    expect((await observeOwner(createElement(DmLoadingFrame))).frames.at(-1)?.neutral).toBe(false)
  })
  it.each(["foreign-panel", "duplicate", "known-leaf", "foreign-cold-shell"])("rejects %s raw marker", async (fault) => {
    const observation = await observeOwner(createElement(ServerLandingPendingFrame), { cold: true,
      pathname: fault === "known-leaf" ? "/c/channels/target/leaf" : undefined,
      mutate: (container) => {
        const marker = container.querySelector("[data-community-unresolved-main]")!
        if (fault === "foreign-cold-shell") {
          const foreignShell = document.createElement("div"); foreignShell.dataset.slot = "community-shell-root"
          const foreignGroup = document.createElement("div"); foreignGroup.dataset.slot = "resizable-panel-group"; foreignGroup.id = "community-shell"
          container.appendChild(foreignShell); foreignShell.appendChild(foreignGroup)
          foreignGroup.appendChild(container.querySelector('[data-slot="resizable-panel"][id="sidebar"]')!)
        }
        if (fault === "duplicate") marker.parentNode!.insertBefore(marker.cloneNode(true), marker.nextSibling)
        if (fault === "foreign-panel") { const panel = document.createElement("div"); panel.dataset.slot = "resizable-panel"; panel.id = "foreign"; marker.parentElement!.appendChild(panel); panel.appendChild(marker) }
      },
    })
    expect(renderedViolations(observation, { paths: ["/c/channels/target", "/c/channels/target/leaf"], finalPath: observation.frames.at(-1)!.pathname, scopes: [], actionKind: "programmatic", allowedColdServers: ["target"], coldRoot: { serverId: "target", rootPath: "/c/channels/target" } })).toContain("wrong neutral conversation")
  })
})

const post = { id: "post", name: "Post", messageCount: 1, lastMessageAt: "2026-09-01T00:00:00.000Z", parent: { authorName: "Viewer", text: "Post" }, authorId: "viewer", authorAvatar: "V", authorAvatarVersion: 0, openerMessageId: "opener", tags: [], preview: "Preview", participants: [], participantCount: 1 }
function forum() { return createElement(ForumView, { forumChannelId: "leaf", members: [], posts: [post], tag: "All", onTagChange: vi.fn(), onOpenPost: vi.fn() }) }

describe("real ForumView namespace and ownership", () => {
  it("classifies container and canonical children separately from actual card", async () => {
    const observation = await observeOwner(forum())
    const frame = observation.frames.at(-1)!
    expect(frame.forumPosts).toEqual([tid.forumThreadCard("post")])
    expect(frame.forumRoles).toContainEqual({ id: tid.forumPostList, role: "container" })
    expect(frame.forumRoles?.some((entry) => entry.role === "child")).toBe(true)
    expect(frame.forumRoles?.some((entry) => entry.role === "unclassified")).toBe(false)
  })
  it.each(["wrong", "missing", "duplicate", "foreign", "collision"])("retains %s card/prefix failure", async (fault) => {
    const observation = await observeOwner(forum(), { mutate: (container) => {
      const card = container.querySelector(`[data-testid="${tid.forumThreadCard("post")}"]`)!
      if (fault === "wrong") card.setAttribute("data-testid", tid.forumThreadCard("wrong"))
      if (fault === "missing") card.remove()
      if (fault === "duplicate") card.parentNode!.insertBefore(card.cloneNode(true), card.nextSibling)
      if (fault === "foreign") container.querySelector('[data-slot="community-main-panel-content"]')!.appendChild(card)
      if (fault === "collision") { const collision = document.createElement("div"); collision.dataset.testid = tid.forumThreadCard("unrecognized-prefix"); card.appendChild(collision) }
    } })
    expect(renderedViolations(observation, { paths: ["/c/channels/target"], finalPath: "/c/channels/target", scopes: [], forum: true, forumPostTestId: tid.forumThreadCard("post"), actionKind: "programmatic" }).length).toBeGreaterThan(0)
  })
})

describe("exact owned cleanup helper", () => {
  it("attempts every cleanup and preserves primary, cleanup and attachment errors", async () => {
    const primary = new Error("primary")
    const called: string[] = []
    const failure = await withOwnedCleanup("control", async () => { throw primary }, [
      { name: "closed-page-evaluate", run: () => { called.push("evaluate"); throw new Error("page closed") } },
      { name: "node-listener", run: () => { called.push("listener") } },
      { name: "image", run: () => { called.push("image"); throw new Error("image unavailable") } },
    ], { attach: async () => { throw new Error("attachment unavailable") } }).catch((error) => error)
    expect(called).toEqual(["evaluate", "listener", "image"])
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.cause).toBe(primary)
    expect(failure.errors.map(String)).toEqual(["Error: primary", "Error: page closed", "Error: image unavailable", "Error: attachment unavailable"])
  })
})

import { communityKeys } from "@/lib/query-keys"

it("real restored registry reveals immediately across Home remount while forum is missing", async () => {
  const sourceClient = new QueryClient()
  const sourceRegistry = createCommunityDbRegistry(sourceClient, "viewer")
  const { cleanup: disposeSourceRegistry } = sourceRegistry
  await sourceRegistry.preload()
  ingestServerDetail(sourceRegistry, detail)
  const client = new QueryClient()
  for (const [name, collection] of Object.entries(sourceRegistry.collections)) {
    client.setQueryData(communityKeys.communityDbCollection("viewer", name as Parameters<typeof communityKeys.communityDbCollection>[1]), Array.from(collection.values() as Iterable<unknown>))
  }
  await disposeSourceRegistry()
  sourceClient.clear()
  const registry = createCommunityDbRegistry(client, "viewer")
  const { cleanup: disposeRegistry } = registry
  registry.captureRestoredCollections()
  await registry.preload()
  const commits: Array<{ cold: boolean; owner: boolean; trusted: boolean }> = []
  function Restored({ show }: { show: boolean }) {
    const tree = useServerTreeProjection("target")
    const trusted = useTrustedRestoredPrimary()
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      if (show && tree) commits.push({ trusted, cold: !!ref.current?.querySelector("[data-pending-server-id]"), owner: !!ref.current?.querySelector("[data-community-channel-tree-scope]") })
    })
    return createElement("div", { ref }, show && tree && createElement(ChannelSidebarScope, {
      categories: tree.categories,
      scopeKey: "server:target", targetServerId: "target", serverId: "target", serverName: "Target", activeChannel: "leaf",
      setActiveChannel: vi.fn(), isAdmin: false, currentUserId: "viewer",
    }))
  }
  const view = (show: boolean) => <QueryClientProvider client={client}>
    <CommunityDbProvider registry={registry}><Restored show={show} /></CommunityDbProvider>
  </QueryClientProvider>
  const rendered = render(view(true))
  try {
    await waitFor(() => expect(commits.length).toBeGreaterThan(0))
    expect(commits.every((commit) => commit.trusted && !commit.cold && commit.owner)).toBe(true)
    rendered.rerender(view(false))
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBeNull()
    const before = commits.length
    rendered.rerender(view(true))
    expect(commits.length).toBeGreaterThan(before)
    expect(commits.slice(before).every((commit) => commit.trusted && !commit.cold && commit.owner)).toBe(true)
    expect(rendered.container.querySelector(`[data-testid="${tid.channelRow("leaf")}"]`)).toBeInTheDocument()
  } finally {
    rendered.unmount()
    await disposeRegistry()
    client.clear()
  }
})


it.each(["valid", "foreign-scroll-panel", "foreign-row-panel", "duplicate-scroll"])("real tree same-panel raw-root qualifier: %s", async (fault) => {
  const observation = await observeOwner(createElement(ServerLandingPendingFrame), { tree: true, mutate: (container) => {
    const owner = container.querySelector("[data-community-channel-tree-scope]")!
    const scroll = owner.querySelector(`[data-testid="${tid.channelSidebarScroll}"]`)!
    if (fault === "duplicate-scroll") scroll.parentNode!.insertBefore(scroll.cloneNode(true), scroll.nextSibling)
    if (fault === "foreign-scroll-panel" || fault === "foreign-row-panel") {
      const panel = document.createElement("div"); panel.dataset.slot = "resizable-panel"; panel.id = "foreign"
      owner.appendChild(panel); panel.appendChild(fault === "foreign-scroll-panel" ? scroll : owner.querySelector(`[data-testid="${tid.channelRow("leaf")}"]`)!)
    }
  } })
  expect(observation.frames.at(-1)?.scopes[0].owned).toBe(fault === "valid")
  const violations = renderedViolations(observation, { paths: ["/c/channels/target"], finalPath: "/c/channels/target", scopes: ["server:target"], actionKind: "programmatic", coldRoot: { serverId: "target", rootPath: "/c/channels/target" } })
  expect(violations.includes("wrong neutral conversation")).toBe(fault !== "valid")
})

import { captureReadyConversation, runRenderedNavigation } from "./e2e-ui/_fixtures/rendered-navigation"
import type { TestInfo } from "@playwright/test"

it("exact rendered helper retains primary and fails unavailable stop with a partial cache", async () => {
  const primary = new Error("action failed")
  const partial = { timeOrigin: 0, action: { kind: "programmatic", trusted: false, atEpochMs: 1 }, frames: [], animations: [], stoppedAt: null }
  let evaluation = 0
  const page = { evaluate: async () => {
    if (++evaluation === 1) return undefined
    if (evaluation === 2) return partial
    throw new Error("page closed")
  } } as unknown as Page
  const attachments: Array<{ name: string; body: unknown }> = []
  const info = { attach: async (name: string, options: { body?: string | Buffer }) => { attachments.push({ name, body: JSON.parse(String(options.body)) }) } } as TestInfo
  const failure = await runRenderedNavigation(page, info, "unavailable", null, { paths: ["/c/me/dm"], finalPath: "/c/me/dm", channelId: "dm", scopes: [], actionKind: "programmatic" }, async (probe) => {
    await probe.checkpoint()
    throw primary
  }).catch((error) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause).toBe(primary)
  expect(failure.errors.map(String)).toEqual(["Error: action failed", "Error: page closed", "Error: UNAVAILABLE: required stopped observation"])
  expect(attachments[0].body).toMatchObject({ stopped: false, availability: "partial-cached", observation: partial })
})

it("exact capture helper records unqualified brackets when screenshot fails", async () => {
  const before = { ready: true, blockers: [], pathname: "/c/me/dm", atPageMs: 1, timeOrigin: 1, scopeMode: "visible-sidebar", mobileLayoutQualified: false }
  const page = { evaluate: async () => before, viewportSize: () => ({ width: 100, height: 100 }), screenshot: async () => { throw new Error("closed screenshot") } } as unknown as Page
  const attachments: Array<unknown> = []
  const info = { attach: async (_name: string, options: { body?: string | Buffer }) => { attachments.push(JSON.parse(String(options.body))) } } as TestInfo
  await expect(captureReadyConversation(page, { pathname: "/c/me/dm", channelId: "dm", kind: "dm", messageTestId: tid.message("expected") }, info, "capture")).rejects.toThrow("closed screenshot")
  expect(attachments[0]).toMatchObject({ before, qualified: false, available: { before: true, image: false, after: false } })
})

it("known DM frame cannot borrow the first of duplicate main containers", async () => {
  const observation = await observeOwner(createElement("div", { "data-slot": "community-conversation-surface", "data-channel-id": "dm" }), {
    pathname: "/c/me/dm", mutate: (container) => {
      const main = container.querySelector('[data-slot="community-main-panel-content"]')!
      main.parentNode!.insertBefore(main.cloneNode(true), main.nextSibling)
    },
  })
  expect(observation.frames.at(-1)?.mainOwned).toBe(false)
  expect(renderedViolations(observation, { paths: ["/c/me/dm"], finalPath: "/c/me/dm", channelId: "dm", scopes: [], actionKind: "programmatic" })).toContain("missing/duplicate/foreign main owner")
})
