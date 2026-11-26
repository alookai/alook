import { createElement, memo, type ReactNode } from "react"
import { RUNNING_PRESETS } from "@alook/shared"
import { DndProvider } from "react-dnd"
import { HTML5Backend } from "react-dnd-html5-backend"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { serverDirectoryFixture, serverRailResponseFixture } from "@/test/community-resource-fixtures"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { ingestServerDetail, ingestServers } from "@/lib/community-db/sync"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { profileSchema } from "@/lib/community-db/schema"
import { communityKeys } from "@/lib/query-keys"
import { useUiHandlers } from "@/stores/community"
import { useServers } from "@/hooks/community/use-servers"
import { useFolders } from "@/hooks/community/use-folders"
import { normalizeCommunityHref, resolveCommunityCheckpointPlan } from "@/lib/community/community-route"
import { initialUserBarExtensionState } from "./user-bar-extension-state"
import { tid } from "@/lib/community/testids"
import { CommunityRouteContext } from "./community-route-context"
import { ShellFrame } from "./shell-frame"
import { ShellFrameView } from "./shell-frame-view"
import { ServerRail } from "./server-rail"

const counters = vi.hoisted(() => ({
  runningOwnedBotsCalls: 0,
  serverRailProjectionCalls: 0,
  serverRailRenders: 0,
  userBarRenders: 0,
  railDndBindingMounts: 0,
  pathname: "/c/channels/s1/c1",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => counters.pathname,
  useSelectedLayoutSegments: () => counters.pathname.split("/").slice(3),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))

vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => "desktop",
  useIsMobile: () => false,
}))

vi.mock("./use-hydrated-client", () => ({
  useHydratedClient: () => true,
}))

vi.mock("@/hooks/community/use-native-system-notifications", () => ({
  useNativeSystemNotifications: () => vi.fn(),
  useNativeSystemNotificationConversationDismissal: () => undefined,
}))

vi.mock("@/hooks/community/use-native-mobile-back", () => ({
  useNativeMobileBack: () => undefined,
}))

vi.mock("@/lib/community/navigation-metadata", () => ({
  prepareNavigationMetadata: vi.fn(async () => undefined),
}))

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}))

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => createElement("div", { "data-slot": "resizable-panel-group" }, children),
  ResizablePanel: ({ children, id }: { children?: ReactNode; id?: string }) => createElement("div", { "data-slot": "resizable-panel", "data-testid": String(id ?? "") }, children),
  ResizableHandle: () => createElement("div", { "data-slot": "resizable-handle" }),
}))

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return {
    ...actual,
    apiFetch: vi.fn(async () => ({})),
  }
})

vi.mock("@/hooks/community/use-running-owned-bots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/community/use-running-owned-bots")>()
  return {
    ...actual,
    useRunningOwnedBots: () => {
      counters.runningOwnedBotsCalls += 1
      return actual.useRunningOwnedBots()
    },
  }
})

vi.mock("@/lib/community-db/projections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/community-db/projections")>()
  return {
    ...actual,
    useServerRailProjection: () => {
      counters.serverRailProjectionCalls += 1
      return actual.useServerRailProjection()
    },
  }
})

vi.mock("./use-server-rail-dnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-server-rail-dnd")>()
  const OriginalBinding = actual.RailDndBinding
  return {
    ...actual,
    RailDndBinding: (props: Parameters<typeof OriginalBinding>[0]) => {
      counters.railDndBindingMounts += 1
      return createElement(OriginalBinding, props)
    },
  }
})

vi.mock("./server-rail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-rail")>()
  const Original = actual.ServerRail
  const Tracked = memo(function TrackedServerRail(props: Parameters<typeof Original>[0]) {
    counters.serverRailRenders += 1
    return createElement(Original, props)
  })
  return { ...actual, ServerRail: Tracked }
})

vi.mock("./user-bar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./user-bar")>()
  const Original = actual.UserBar
  const Tracked = memo(function TrackedUserBar(props: Parameters<typeof Original>[0]) {
    counters.userBarRenders += 1
    return createElement(Original, props)
  })
  return { ...actual, UserBar: Tracked }
})

const VIEWER_USER = {
  id: "viewer",
  email: "viewer@example.com",
  name: "Viewer",
  discriminator: "0001",
  avatar: "V",
  avatarVersion: 1,
}

beforeEach(() => {
  counters.runningOwnedBotsCalls = 0
  counters.serverRailProjectionCalls = 0
  counters.serverRailRenders = 0
  counters.userBarRenders = 0
  counters.railDndBindingMounts = 0
  localStorage.clear()
  if (typeof globalThis.IntersectionObserver !== "function") {
    class NoopIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
      root = null
      rootMargin = ""
      thresholds = []
    }
    Object.defineProperty(globalThis, "IntersectionObserver", {
      writable: true,
      configurable: true,
      value: NoopIntersectionObserver,
    })
  }
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("min-width: 640px"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ShellFrame subscription isolation and rail/profile efficiency", () => {
  it("isolates closed Inbox and Profile from unrelated websocket events without re-rendering shell, rail, sidebar, or UserBar", async () => {
    const { client, registry, runtime } = await createCommunityQueryOwner("viewer")
    ingestServers(
      registry,
      serverRailResponseFixture({
        servers: [{ id: "s1", name: "Alpha", initial: "A", active: false, unread: false, mentions: 0, ownerId: "viewer" }],
      }, "viewer"),
    )
    ingestServerDetail(
      registry,
      serverDirectoryFixture({
        id: "s1",
        name: "Alpha",
        categories: [{ id: "cat1", name: "General", channels: [{ id: "c1", name: "general", active: false, unread: false }] }],
      }),
    )

    let sidebarRenderCount = 0
    const UiHandlersChild = memo(function UiHandlersChild() {
      const handlers = useUiHandlers()
      return <div data-testid="ui-handlers-child">{typeof handlers.openProfile === "function" ? "ready" : "none"}</div>
    })

    const view = render(
      <CommunityTestProvider client={client} registry={registry}>
        <CurrentUserProvider initialUser={VIEWER_USER}>
          <DndProvider backend={HTML5Backend}>
            <ShellFrame
              view="server"
              activeServerId="s1"
              frameHref="/c/channels/s1/c1"
              sidebar={() => {
                sidebarRenderCount += 1
                return <div data-testid="channel-sidebar-slot">sidebar</div>
              }}
              extraDialogs={<UiHandlersChild />}
            >
              <div>main</div>
            </ShellFrame>
          </DndProvider>
        </CurrentUserProvider>
      </CommunityTestProvider>,
    )

    await waitFor(() => expect(view.getByTestId("ui-handlers-child")).toHaveTextContent("ready"))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })

    const baselineSidebar = sidebarRenderCount
    const baselineRail = counters.serverRailRenders
    const baselineUserBar = counters.userBarRenders
    const handlersBefore = runtime.ui.get().uiHandlers

    await act(async () => {
      runtime.ws.actions.markSeenMessage("unrelated-msg-1")
    })
    const handlersAfterSeen = runtime.ui.get().uiHandlers

    await act(async () => {
      runtime.ws.actions.setPresence("unrelated-user-999", "online")
      await Promise.resolve()
    })
    const handlersAfterPresence = runtime.ui.get().uiHandlers

    expect(sidebarRenderCount - baselineSidebar).toBe(0)
    expect(counters.serverRailRenders - baselineRail).toBe(0)
    expect(counters.userBarRenders - baselineUserBar).toBe(0)
    expect(handlersAfterSeen).toBe(handlersBefore)
    expect(handlersAfterPresence).toBe(handlersBefore)

    view.unmount()
  })

  it("deduplicates running owned bots subscription when opening self ProfileCard", async () => {
    const { client, registry } = await createCommunityQueryOwner("viewer", {
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    })
    const botId = "bot-1"
    await writeCommunityCollectionRows(
      registry,
      "profiles",
      [
        profileSchema.parse({ id: "viewer", name: "Viewer", discriminator: "0001", avatar: "V", avatarVersion: 1 }),
        profileSchema.parse({
          id: botId,
          name: "BotOne",
          discriminator: "0002",
          avatar: "B",
          avatarVersion: 1,
          statusEmoji: RUNNING_PRESETS[0].emoji,
          statusText: RUNNING_PRESETS[0].text,
        }),
      ],
      (row) => row.id,
    )
    client.setQueryData(communityKeys.bots(), {
      bots: [{ id: botId, name: "BotOne", discriminator: "0002", avatar: "B", isActive: true, runtime: "codex" }],
    })

    const frame = normalizeCommunityHref("/c/channels/s1/c1")
    const checkpoint = resolveCommunityCheckpointPlan({
      committedFrame: { ...frame, revision: 1 },
      targetHref: "/c/channels/s1/c1",
      pending: false,
      targetReady: true,
    })

    counters.runningOwnedBotsCalls = 0
    const profileView = render(
      <CommunityTestProvider client={client} registry={registry} retainOwner>
        <CurrentUserProvider initialUser={VIEWER_USER}>
          <CommunityRouteContext
            value={{
              breakpoint: "desktop",
              frame: { ...frame, revision: 1 },
              navigation: {
                publishedHref: "/c/channels/s1/c1",
                navigationPending: false,
                pendingHref: null,
                entryIntent: null,
                push: vi.fn(),
                replace: vi.fn(),
                prefetch: vi.fn(),
                resolveAndPush: vi.fn(),
                cancelPendingNavigation: vi.fn(),
                captureIntent: () => () => true,
              } as unknown as NonNullable<Parameters<typeof CommunityRouteContext>[0]["value"]>["navigation"],
              openInbox: vi.fn(),
              notificationConsumer: { current: null },
              ownerDeleteRouteScope: undefined,
            }}
          >
            <DndProvider backend={HTML5Backend}>
              <ShellFrameView
                mobileMotionRef={{ current: null }}
                breakpoint="desktop"
                checkpoint={checkpoint}
                routeCommitted
                sidebar={() => null}
                rail={{
                  railProps: {
                    servers: [],
                    folders: [],
                    topOrder: [],
                    serverHrefs: {},
                    homeHref: "/c/me",
                    view: "server",
                    activeId: "s1",
                    onHome: vi.fn(),
                    onSelectServer: vi.fn(),
                    onCreateServer: vi.fn(),
                    onOpenJoin: vi.fn(),
                  },
                } as unknown as Parameters<typeof ShellFrameView>[0]["rail"]}
                profile={{
                  currentUser: VIEWER_USER,
                  profile: {
                    data: { userId: "viewer", name: "Viewer", discriminator: "0001", avatar: "V" },
                    x: 100,
                    y: 100,
                  },
                  closeProfile: vi.fn(),
                  profileMessage: vi.fn(),
                  updateOwnStatus: vi.fn(),
                  openOwnerProfile: vi.fn(),
                  openBotAudit: vi.fn(),
                  openUserSettings: vi.fn(),
                  openProfile: vi.fn(),
                  previewImage: vi.fn(),
                  previewAttachment: vi.fn(),
                  lightbox: null,
                  attachmentPreview: null,
                  userSettingsOpen: false,
                  closeUserSettings: vi.fn(),
                  closeLightbox: vi.fn(),
                  closeAttachmentPreview: vi.fn(),
                } as unknown as Parameters<typeof ShellFrameView>[0]["profile"]}
                inbox={{
                  hasUnread: false,
                  unreadCount: 0,
                  unreadCountPartial: false,
                  popoverProps: {
                    unreads: [],
                    unreadDms: [],
                    mentions: [],
                    todos: [],
                    marked: [],
                    friendRequests: [],
                    loading: false,
                    hasProjectedUnreads: false,
                    hasProjectedMentions: false,
                  },
                } as unknown as Parameters<typeof ShellFrameView>[0]["inbox"]}
                inboxOpening={false}
                userBarExtension={{ ...initialUserBarExtensionState, active: "profile" }}
                daemonUpdate={{
                  update: null,
                  eligibleMachines: [],
                  collapse: vi.fn(),
                  open: vi.fn(),
                  request: vi.fn(),
                } as unknown as Parameters<typeof ShellFrameView>[0]["daemonUpdate"]}
                onUserBarInboxOpenChange={vi.fn()}
                onUserBarOpenProfile={vi.fn()}
                onUserBarOpenUpdate={vi.fn()}
                dismissUserBarExtension={vi.fn()}
              >
                <div>main</div>
              </ShellFrameView>
            </DndProvider>
          </CommunityRouteContext>
        </CurrentUserProvider>
      </CommunityTestProvider>,
    )

    await waitFor(() => expect(counters.runningOwnedBotsCalls).toBe(1))
    profileView.unmount()
  })

  it("keeps collapsed ServerRail folder children mounted without DnD bindings or folder end-drop targets and avoids duplicating rail projection in useFolders", async () => {
    const { client, registry } = await createCommunityQueryOwner("viewer")
    const serverFixtures = Array.from({ length: 60 }, (_, i) => ({
      id: `s-${i}`,
      name: `Srv ${i}`,
      initial: "S",
      active: false,
      unread: false,
      mentions: 0,
      ownerId: "viewer",
    }))
    ingestServers(registry, serverRailResponseFixture({ servers: serverFixtures }, "viewer"))

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(CommunityTestProvider, { client, registry, retainOwner: true }, children)

    counters.serverRailProjectionCalls = 0
    let railHookRenders = 0
    const railHooksView = renderHook(() => {
      railHookRenders += 1
      return {
        servers: useServers(),
        folders: useFolders(),
      }
    }, { wrapper })
    await waitFor(() => expect(railHooksView.result.current.servers.servers).toHaveLength(60))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(counters.serverRailProjectionCalls).toBe(railHookRenders)
    railHooksView.unmount()

    const folders = Array.from({ length: 10 }, (_, f) => ({
      id: `folder-${f}`,
      name: `Folder ${f}`,
      servers: Array.from({ length: 5 }, (_, k) => {
        const idx = f * 5 + k
        return { id: `s-${idx}`, name: `Srv ${idx}`, initial: "S", icon: null }
      }),
    }))
    const topOrder = [
      ...folders.map((f) => ({ kind: "folder" as const, id: f.id })),
      ...Array.from({ length: 10 }, (_, k) => ({ kind: "server" as const, id: `s-${50 + k}` })),
    ]
    counters.railDndBindingMounts = 0
    const railView = render(
      createElement(
        CommunityTestProvider,
        { client, registry, retainOwner: true },
        createElement(
          DndProvider,
          { backend: HTML5Backend },
          createElement(ServerRail, {
            servers: serverFixtures,
            folders,
            topOrder,
            serverHrefs: {},
            homeHref: "/c/me",
            view: "server",
            activeId: "s-50",
            onHome: vi.fn(),
            onSelectServer: vi.fn(),
            onCreateServer: vi.fn(),
            onOpenJoin: vi.fn(),
          } as unknown as Parameters<typeof ServerRail>[0]),
        ),
      ),
    )
    // Collapsed folder children remain mounted (preserving DOM identity/transitions),
    // while DnD bindings only mount for the 10 folders + 10 top-level servers (20 total, not 70)
    // and collapsed folders mount 0 RailEndDropTarget nodes.
    const collapsedChildServerLink = railView.getByTestId(tid.serverIcon("s-0"))
    expect(collapsedChildServerLink).toBeInTheDocument()
    expect(railView.queryByTestId(tid.serverRailFolderEnd("folder-0"))).toBeNull()
    expect(counters.railDndBindingMounts).toBe(20)

    fireEvent.click(railView.getByRole("button", { name: "Folder 0" }))
    expect(railView.getByTestId(tid.serverIcon("s-0"))).toBe(collapsedChildServerLink)
    expect(railView.getByTestId(tid.serverRailFolderEnd("folder-0"))).toBeInTheDocument()
    expect(counters.railDndBindingMounts).toBeGreaterThanOrEqual(25)
    railView.unmount()
  })
})
