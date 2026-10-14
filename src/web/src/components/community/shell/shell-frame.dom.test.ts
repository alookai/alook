import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import type { QueryClient } from "@tanstack/react-query"
import { createElement, useCallback, useLayoutEffect, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render as renderDom, screen } from "@/test/react-dom-harness"
import { ShellFrame } from "./shell-frame"
import { communityKeys } from "@/lib/query-keys"
import { useInboxAutoCollapse } from "@/hooks/community/use-inbox-auto-collapse"
import { CommunityShellLayout } from "./community-shell-layout"
import { UserBarExtensionSlot } from "./user-bar-extension-slot"
import { useCommunityRouteFrame } from "./community-route-context"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { tid } from "@/lib/community/testids"
import type { ShellFrameView } from "./shell-frame-view"
import type { useShellInboxController } from "./use-shell-inbox-controller"

const mocks = vi.hoisted(() => {
  const serverCache = new Set<string>()
  const handlers = {
    previewImage: vi.fn(),
    previewAttachment: vi.fn(),
    openProfile: vi.fn(),
    navigate: vi.fn(),
    cancelPendingNavigation: vi.fn(),
  }
  return {
    nativeNotifications: vi.fn(),
    lifecycle: false,
    viewerId: "viewer",
    openChanges: vi.fn(),
    outsideAction: vi.fn(),
    currentHref: { current: "/c/channels/s1" },
    pendingHref: { current: null as string | null },
    navigationPending: { current: false },
    serverCache,
    queryClient: {
      getQueryData: (key: unknown[]) => serverCache.has(String(key.at(-1)))
        ? { id: key.at(-1) }
        : undefined,
    },
    projectedServer: { current: undefined as undefined | Record<string, unknown> },
    projectedChannel: { current: undefined as undefined | Record<string, unknown> },
    breakpoint: { current: "desktop" },
    onboardingState: { current: null as Record<string, unknown> | null },
    replace: vi.fn(),
    push: vi.fn(),
    registerUiHandlers: vi.fn(),
    observeOwnerDelete: vi.fn(),
    registerOwnerDelete: vi.fn(() => "ordinary"),
    flushOwnerDelete: vi.fn(),
    handlers,
    rail: {
      railProps: {},
      navigate: handlers.navigate,
      cancelPendingNavigation: handlers.cancelPendingNavigation,
    },
    railOptions: vi.fn(),
    inboxOptions: vi.fn(),
    profile: {
      previewImage: handlers.previewImage,
      previewAttachment: handlers.previewAttachment,
      openProfile: handlers.openProfile,
    },
    inbox: {},
    daemonUpdate: {
      update: null,
      eligibleMachines: [],
      collapse: vi.fn(),
      open: vi.fn(),
      request: vi.fn(),
    },
    viewProps: { current: {} as Record<string, unknown> },
  }
})

vi.mock("@/hooks/community/use-native-system-notifications", () => ({useNativeSystemNotifications: (...args: unknown[]) => mocks.nativeNotifications(...args)}))

vi.mock("@/hooks/community/community-ws/scope-eviction", () => ({
  flushOwnerServerDeleteRouteCommit: (...args: unknown[]) => mocks.flushOwnerDelete(...args),
}))
vi.mock("@/lib/community/eject-server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community/eject-server")>(),
  observeOwnerServerDeleteRouteCommit: (...args: unknown[]) => mocks.observeOwnerDelete(...args),
  registerOwnerServerDeleteRoute: (...args: unknown[]) => mocks.registerOwnerDelete(...args),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint.current }))
vi.mock("@/lib/community-onboarding", () => ({
  useCommunityOnboarding: () => mocks.onboardingState.current,
}))
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.currentHref.current.split("?")[0],
  useSearchParams: () => new URLSearchParams(mocks.currentHref.current.split("?")[1]),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, prefetch: vi.fn() }),
}))
vi.mock("@/lib/community/navigation-metadata", () => ({ prepareNavigationMetadata: vi.fn(async () => undefined) }))
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}))
vi.mock("@/components/ui/resizable", () => {
  const Panel = ({ children }: { children: ReactNode }) => createElement("div", null, children)
  return { ResizablePanelGroup: Panel, ResizablePanel: Panel, ResizableHandle: () => null }
})
vi.mock("./use-hydrated-client", () => ({ useHydratedClient: () => true }))
vi.mock("./use-community-navigation-controller", async (importOriginal) => {
  const { useCommunityNavigationController } = await importOriginal<typeof import("./use-community-navigation-controller")>()
  return { useCommunityNavigationController: (frame: Parameters<typeof useCommunityNavigationController>[0]) => {
    const actual = useCommunityNavigationController(frame)
    return mocks.lifecycle ? actual : {
      publishedHref: mocks.currentHref.current,
      navigationPending: mocks.navigationPending.current,
      pendingHref: mocks.pendingHref.current,
      push: mocks.push,
      replace: mocks.replace,
      prefetch: vi.fn(),
      resolveAndPush: vi.fn(),
      cancelPendingNavigation: mocks.handlers.cancelPendingNavigation,
    }
  } }
})
vi.mock("@/stores/community", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community")>(),
  useCommunityStore: Object.assign(vi.fn(), {
    getState: () => ({ registerUiHandlers: mocks.registerUiHandlers }),
  }),
}))
vi.mock("@/stores/community/ws", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community/ws")>(),
  useCommunityWsStore: (selector: (state: { accessEpoch: number }) => unknown) => selector({ accessEpoch: 0 }),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: mocks.viewerId }),
}))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useServerTreeProjection: () => mocks.projectedServer.current,
  useRouteChannelProjection: () => mocks.projectedChannel.current,
}))
vi.mock("./use-shell-rail-controller", () => ({
  useShellRailController: (options: unknown) => {
    mocks.railOptions(options)
    return mocks.rail
  },
}))
vi.mock("./use-shell-profile-controller", () => ({
  useShellProfileController: () => mocks.profile,
}))
vi.mock("./use-shell-inbox-controller", () => ({
  useShellInboxController: (options: Parameters<typeof useShellInboxController>[0]) => {
    mocks.inboxOptions(options)
    const inbox = useInboxAutoCollapse(options)
    const changeInboxOpen = inbox.onOpenChange
    const onOpenChange = useCallback((open: boolean) => {
      mocks.openChanges(open)
      changeInboxOpen(open)
    }, [changeInboxOpen])
    return mocks.lifecycle ? { ...inbox, onOpenChange } : mocks.inbox
  },
}))
vi.mock("./use-shell-daemon-update-controller", () => ({
  useShellDaemonUpdateController: () => mocks.daemonUpdate,
}))
vi.mock("./shell-frame-view", () => ({
  ShellFrameView: (props: Record<string, unknown>) => {
    mocks.viewProps.current = props
    if (!mocks.lifecycle) return createElement("div", { "data-testid": "shell-frame-view" })
    const view = props as Parameters<typeof ShellFrameView>[0]
    return createElement(CommunityShellLayout, {
      breakpoint: view.breakpoint,
      surface: view.checkpoint.surface,
      preserveHiddenMobileModules: true,
      rail: null,
      sidebar: createElement("button", { onClick: mocks.outsideAction }, "Outside action"),
      main: view.children,
      userBar: createElement("div", { "data-testid": tid.userBar },
        view.userBarExtension.active === "inbox" ? createElement(UserBarExtensionSlot, {
          active: "inbox", inbox: "Inbox contents", update: null, eligibleMachines: [],
          onDismiss: view.dismissUserBarExtension, onRequestUpdate: vi.fn(),
        }) : null,
        createElement("button", {
          "data-testid": tid.inboxTrigger,
          "aria-expanded": view.userBarExtension.active === "inbox",
          "aria-busy": view.inboxOpening || undefined,
          onClick: () => view.onUserBarInboxOpenChange(view.userBarExtension.active !== "inbox" && !view.inboxOpening),
        }, "Inbox trigger"),
      ),
    })
  },
}))

let queryClient: QueryClient
function NativeOwner({ children }: { children: React.ReactNode }) { return createElement(CommunityTestProvider, { client: queryClient }, children) }
function render(node: React.ReactNode) { return renderDom(node, { wrapper: NativeOwner }) }

const baseProps = {
  view: "server" as const,
  activeServerId: "s1",
  frameHref: "/c/channels/s1",
  sidebar: () => createElement("sidebar"),
}

function checkpoint() {
  return mocks.viewProps.current.checkpoint as Record<string, unknown>
}

function renderInboxLifecycle(href = "/c/messages/unavailable", breakpoint = "mobile") {
  mocks.lifecycle = true
  mocks.breakpoint.current = breakpoint
  mocks.currentHref.current = href
  let frameHref = normalizeCommunityHref(href).pathname
  let context!: ReturnType<typeof useCommunityRouteFrame>
  function Action() {
    const current = useCommunityRouteFrame()
    useLayoutEffect(() => { context = current }, [current])
    return createElement("button", { onClick: current.openInbox }, "Open Inbox")
  }
  const node = () => createElement(ShellFrame, {
    ...baseProps, view: "dm", activeServerId: undefined, frameHref,
  }, createElement(Action))
  const renderer = render(node())
  return {
    get context() { return context },
    update(options: { publishedHref?: string; frameHref?: string; viewerId?: string } = {}) {
      if (options.publishedHref !== undefined) mocks.currentHref.current = options.publishedHref
      if (options.frameHref !== undefined) frameHref = options.frameHref
      if (options.viewerId !== undefined) mocks.viewerId = options.viewerId
      renderer.rerender(node())
    },
    unmount: renderer.unmount,
  }
}

function expectVisibleInbox() {
  expect(screen.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "true")
  expect(screen.getAllByTestId(tid.userBarExtension)).toHaveLength(1)
  const overlay = screen.getByTestId(tid.inboxTrigger).closest("[data-slot='community-user-bar-overlay']")!
  expect(overlay).not.toHaveAttribute("inert")
  expect(overlay).not.toHaveAttribute("aria-hidden", "true")
  expect(overlay.classList.contains("hidden")).toBe(false)
  expect(screen.getByTestId(tid.userBarExtension)).toHaveTextContent("Inbox contents")
}

describe("ShellFrame orchestration", () => {
  beforeEach(async () => {
    const owner = await createCommunityQueryOwner()
    queryClient = owner.client
    const register = owner.runtime.ui.actions.registerUiHandlers
    vi.spyOn(owner.runtime.ui.actions, "registerUiHandlers").mockImplementation((handlers) => { mocks.registerUiHandlers(handlers); register(handlers) })
    mocks.lifecycle = false
    mocks.viewerId = "viewer"
    mocks.openChanges.mockReset()
    mocks.outsideAction.mockReset()
    mocks.push.mockReset()
    mocks.replace.mockReset()
    mocks.currentHref.current = "/c/channels/s1"
    mocks.pendingHref.current = null
    mocks.navigationPending.current = false
    mocks.serverCache.clear()
    mocks.projectedServer.current = undefined
    mocks.projectedChannel.current = undefined
    mocks.breakpoint.current = "desktop"
    mocks.onboardingState.current = null
    mocks.registerUiHandlers.mockClear()
    mocks.observeOwnerDelete.mockClear()
    mocks.registerOwnerDelete.mockClear()
    mocks.flushOwnerDelete.mockClear()
    mocks.replace.mockClear()
    mocks.push.mockClear()
    mocks.railOptions.mockClear()
    mocks.inboxOptions.mockClear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it("does not rewrite the committed frame from an eagerly published pathname", () => {
    const renderer = render(createElement(ShellFrame, baseProps))
    expect(checkpoint().surface).toBe("list")
    expect(checkpoint().targetHref).toBe("/c/channels/s1")

    mocks.currentHref.current = "/c/channels/s1/c1?keep=1"
    renderer.rerender(createElement(ShellFrame, baseProps, "next"))
    expect(checkpoint().surface).toBe("list")
  })

  it("advances the committed descriptor from layout-owned frameHref", () => {
    mocks.currentHref.current = "/c/channels/s1/c2"
    mocks.pendingHref.current = "/c/channels/s1/c2"
    mocks.navigationPending.current = true
    const sourceProps = { ...baseProps, frameHref: "/c/channels/s1/c1" }
    const renderer = render(createElement(ShellFrame, sourceProps))
    expect(checkpoint().mode).toBe("same-scope-leaf")

    renderer.rerender(createElement(ShellFrame, {
      ...sourceProps,
      frameHref: "/c/channels/s1/c2",
    }))
    expect(checkpoint().mode).toBe("committed")
    expect(mocks.observeOwnerDelete).toHaveBeenLastCalledWith(queryClient, "/c/channels/s1/c2")
    expect(mocks.flushOwnerDelete).toHaveBeenLastCalledWith(
      queryClient,
    )
    expect(mocks.observeOwnerDelete.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.flushOwnerDelete.mock.invocationCallOrder.at(-1) ?? 0,
    )
  })

  it("registers the route token at the same committed-frame boundary", () => {
    const token = {}
    mocks.registerOwnerDelete.mockReturnValueOnce("participant")

    render(createElement(ShellFrame, {
      ...baseProps,
      ownerDeleteRouteScope: { serverId: "s1", token },
    }))

    expect(mocks.registerOwnerDelete).toHaveBeenCalledWith(queryClient, "s1", token)
    expect(mocks.registerOwnerDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.observeOwnerDelete.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it("keeps the committed surface until exact frame evidence arrives", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s1"
    mocks.navigationPending.current = true
    const sourceProps = { ...baseProps, frameHref: "/c/channels/s1/c1" }
    const renderer = render(createElement(ShellFrame, sourceProps))
    expect(checkpoint()).toMatchObject({
      surface: "list",
      targetHref: "/c/channels/s1",
      main: { kind: "keep" },
    })
    expect(mocks.inboxOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      publishedHref: "/c/channels/s1/c1",
      navigationPending: true,
      pendingHref: "/c/channels/s1",
    }))

    mocks.pendingHref.current = "/c/me/dm_1?from=inbox"
    renderer.rerender(createElement(ShellFrame, sourceProps, "next"))
    expect(checkpoint()).toMatchObject({
      surface: "detail",
      targetHref: "/c/me/dm_1?from=inbox",
    })
  })

  it("projects one cold cross-server target into rail, middle, and right", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s2"
    mocks.navigationPending.current = true
    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))

    expect(checkpoint()).toMatchObject({
      mode: "cold-scope",
      surface: "list",
      targetHref: "/c/channels/s2",
      sidebar: { kind: "server-skeleton", serverId: "s2" },
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      activeServerId: "s1",
      projectedView: "server",
      projectedActiveServerId: "s2",
    }))
  })

  it("uses the canonical server-tree projection as a warm server target", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s2"
    mocks.navigationPending.current = true
    mocks.projectedServer.current = {
      id: "s2",
      categories: [{ channels: [{ id: "c2" }] }],
    }

    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))

    expect(checkpoint()).toMatchObject({
      mode: "warm-scope",
      main: { kind: "keep" },
    })
  })

  it("delegates a same-server canonical conversation target to its stable route host", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s1/c2"
    mocks.navigationPending.current = true
    mocks.projectedChannel.current = { id: "c2", type: "forum" }

    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))

    expect(checkpoint()).toMatchObject({
      mode: "same-scope-leaf",
      main: {
        kind: "server-route",
        href: "/c/channels/s1/c2",
      },
    })
  })

  it("lets an exact warm target skip both forced checkpoints without relabeling A", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s2"
    mocks.navigationPending.current = true
    queryClient.setQueryData(communityKeys.server("s2"), { id: "s2" })
    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))

    expect(checkpoint()).toMatchObject({
      mode: "warm-scope",
      surface: "list",
      targetHref: "/c/channels/s2",
      main: { kind: "keep" },
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      activeServerId: "s1",
      projectedView: "server",
      projectedActiveServerId: "s1",
    }))
  })

  it("replaces a mobile detail with its semantic parent", () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/channels/s1/c1"
    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))
    const handlers = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    handlers.goBackMobile()
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/channels/s1")
  })

  it("returns mobile server onboarding to the semantic list surface", () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/me/dm_1"
    mocks.onboardingState.current = { status: "active", stage: "server" }

    render(createElement(ShellFrame, {
      ...baseProps,
      view: "dm",
      activeServerId: undefined,
      frameHref: "/c/me/dm_1",
    }))

    expect(mocks.replace).toHaveBeenCalledWith("/c/me")
  })

  it.each([
    ["/c/channels/s1/thread1", { id: "thread1", serverId: "s1", parentChannelId: "parent1" }, "/c/channels/s1/parent1"],
    ["/c/channels/s1/c1", { id: "c1", serverId: "s1", parentChannelId: null }, "/c/channels/s1"],
    ["/c/channels/s1/c1", { id: "c1", serverId: "s2", parentChannelId: "wrong" }, "/c/channels/s1"],
    ["/c/channels/s1", undefined, null],
    ["/c/me/dm1", undefined, "/c/me"],
    ["/c/me", undefined, null],
  ])("returns to the structural parent from %s and stops at list roots", (href, channel, expected) => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = href
    mocks.projectedChannel.current = channel
    const renderer = render(createElement(ShellFrame, { ...baseProps, frameHref: href }))
    const event = new Event("alook:native-back", { cancelable: true })
    act(() => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    if (expected) expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(expected)
    else expect(mocks.replace).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("supersedes an in-flight navigation with the committed page before returning further", () => {
    mocks.breakpoint.current = "mobile"
    mocks.navigationPending.current = true
    mocks.pendingHref.current = "/c/channels/s1/c2"
    const renderer = render(createElement(ShellFrame, { ...baseProps, frameHref: "/c/channels/s1" }))
    act(() => { window.dispatchEvent(new Event("alook:native-back", { cancelable: true })) })
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    renderer.unmount()
  })

  it("keeps mobile server onboarding stable on an existing list surface", () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/me"
    mocks.onboardingState.current = { status: "active", stage: "server" }

    render(createElement(ShellFrame, {
      ...baseProps,
      view: "dm",
      activeServerId: undefined,
      frameHref: "/c/me",
    }))

    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("registers the shared navigation and UI handlers", () => {
    const renderer = render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))
    const first = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    expect(Object.keys(first).sort()).toEqual([
      "cancelPendingNavigation",
      "goBackMobile",
      "navigate",
      "navigatePath",
      "openProfile",
      "previewAttachment",
      "previewImage",
      "replacePath",
    ])

    mocks.currentHref.current = "/c/channels/s1/c1?msg=m1"
    renderer.rerender(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }, "message"))
    const withMessage = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    withMessage.goBackMobile()
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/channels/s1")

    renderer.rerender(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }, "rerender"))
    const second = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    expect(second.navigatePath).toBe(withMessage.navigatePath)
    expect(second.replacePath).toBe(withMessage.replacePath)
  })

  it("passes the single resolved breakpoint to the rail controller", () => {
    mocks.breakpoint.current = "unknown"
    const renderer = render(createElement(ShellFrame, baseProps))
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({ breakpoint: "unknown" }))

    mocks.breakpoint.current = "mobile"
    renderer.rerender(createElement(ShellFrame, baseProps, "mobile"))
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({ breakpoint: "mobile" }))
  })

  describe("user-bar Inbox during list navigation", () => {
    const destination = "/c/channels/s1?from=inbox"

    it.each(["frame-first", "publication-first"])("opens once after the current complete destination, %s", (order) => {
      const shell = renderInboxLifecycle("/c/channels/s1/c1")
      act(() => shell.context.navigation.push(destination))
      const trigger = screen.getByTestId(tid.inboxTrigger)
      expect(trigger.closest("[data-slot='community-user-bar-overlay']")).not.toHaveAttribute("inert")
      fireEvent.click(trigger)
      expect(trigger).toHaveAttribute("aria-busy", "true")
      expect(trigger).toHaveAttribute("aria-expanded", "false")
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith(destination)
      if (order === "frame-first") shell.update({ frameHref: "/c/channels/s1" })
      else shell.update({ publishedHref: destination })
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
      shell.update({ frameHref: "/c/channels/s1", publishedHref: destination })
      expectVisibleInbox()
      expect(trigger).not.toHaveAttribute("aria-busy")
      expect(mocks.openChanges).toHaveBeenCalledExactlyOnceWith(true)
      shell.update()
      expect(mocks.openChanges).toHaveBeenCalledTimes(1)
      fireEvent.click(trigger)
      expect(trigger).toHaveAttribute("aria-expanded", "false")
      expect(mocks.openChanges.mock.calls).toEqual([[true], [false]])
    })

    it("waits for the known full query URL, then keeps normal navigation auto-collapse", () => {
      const shell = renderInboxLifecycle("/c/channels/s1/c1")
      act(() => shell.context.navigation.push(destination))
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      shell.update({ frameHref: "/c/channels/s1", publishedHref: "/c/channels/s1" })
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
      shell.update({ publishedHref: destination })
      expectVisibleInbox()
      shell.update({ publishedHref: "/c/channels/s1?from=other" })
      expect(screen.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "false")
    })

    it("opens directly on a settled query list and defers a query-only pending commit", () => {
      const shell = renderInboxLifecycle(destination)
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      expectVisibleInbox()
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      const next = "/c/channels/s1?from=next"
      act(() => shell.context.navigation.push(next))
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      expect(screen.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-busy", "true")
      shell.update({ publishedHref: next })
      expectVisibleInbox()
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith(next)
    })

    it("waits for publication if the structural frame arrives without a local pending target", () => {
      const shell = renderInboxLifecycle("/c/channels/s1/c1")
      shell.update({ frameHref: "/c/channels/s1" })
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
      shell.update({ publishedHref: destination })
      expectVisibleInbox()
      expect(mocks.push).not.toHaveBeenCalled()
    })

    it("cancels on the second click without cancelling navigation or reviving at the same URL", () => {
      const shell = renderInboxLifecycle("/c/channels/s1/c1")
      act(() => shell.context.navigation.push(destination))
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      expect(shell.context.navigation.pendingHref).toBe(destination)
      shell.update({ frameHref: "/c/channels/s1", publishedHref: destination })
      shell.update({ frameHref: "/c/me", publishedHref: "/c/me" })
      shell.update({ frameHref: "/c/channels/s1", publishedHref: destination })
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
      expect(screen.queryByTestId(tid.userBarExtension)).toBeNull()
    })

    it.each(["push", "pushImmediate", "replace", "resolver", "cancel", "Back"])(
      "discards a user-bar request on %s before a later identical destination", async (entry) => {
        const shell = renderInboxLifecycle("/c/channels/s1/c1")
        act(() => shell.context.navigation.push(destination))
        fireEvent.click(screen.getByTestId(tid.inboxTrigger))
        await act(async () => {
          const nav = shell.context.navigation
          if (entry === "push") nav.push("/c/me")
          if (entry === "pushImmediate") nav.pushImmediate("/c/me")
          if (entry === "replace") nav.replace("/c/me")
          if (entry === "resolver") await nav.resolveAndPush(async () => "/c/me")
          if (entry === "cancel") nav.cancelPendingNavigation()
          if (entry === "Back") window.dispatchEvent(new Event("popstate"))
        })
        shell.update({ frameHref: "/c/me", publishedHref: "/c/me" })
        shell.update({ frameHref: "/c/channels/s1", publishedHref: destination })
        expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
      },
    )

    it.each(["profile", "update", "dismiss"])("cancels pending opening before the %s extension action", (action) => {
      const shell = renderInboxLifecycle("/c/channels/s1/c1")
      act(() => shell.context.navigation.push(destination))
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      act(() => {
        const view = mocks.viewProps.current as Parameters<typeof ShellFrameView>[0]
        if (action === "profile") view.onUserBarOpenProfile("Viewer")
        if (action === "update") view.onUserBarOpenUpdate()
        if (action === "dismiss") view.dismissUserBarExtension()
      })
      shell.update({ frameHref: "/c/channels/s1", publishedHref: destination })
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
    })

    it("discards a pending user-bar request on account change", () => {
      const shell = renderInboxLifecycle("/c/channels/s1/c1")
      act(() => shell.context.navigation.push(destination))
      fireEvent.click(screen.getByTestId(tid.inboxTrigger))
      shell.update({ viewerId: "other" })
      shell.update({ viewerId: "viewer" })
      shell.update({ frameHref: "/c/channels/s1", publishedHref: destination })
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
    })
  })

  describe("shared Open Inbox commit handoff", () => {
    it("opens once after exact frame, publication and auto-collapse, then keeps outside action before dismiss", () => {
      const shell = renderInboxLifecycle()
      const overlay = screen.getByTestId(tid.inboxTrigger).closest("[data-slot='community-user-bar-overlay']")!
      expect(overlay).toHaveAttribute("inert")
      expect(overlay.classList.contains("hidden")).toBe(true)
      fireEvent.click(screen.getByRole("button", { name: "Open Inbox" }))
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/me")
      expect(shell.context.navigation.navigationPending).toBe(true)
      expect(screen.queryByTestId(tid.userBarExtension)).toBeNull()
      shell.update({ publishedHref: "/c/me" })
      expect(shell.context.navigation.navigationPending).toBe(true)
      expect(mocks.openChanges).not.toHaveBeenCalled()
      shell.update({ frameHref: "/c/me" })
      expect(shell.context.navigation.navigationPending).toBe(false)
      expectVisibleInbox()
      expect(mocks.openChanges).toHaveBeenCalledExactlyOnceWith(true)
      shell.update()
      expect(mocks.openChanges).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole("button", { name: "Outside action" }))
      expect(mocks.outsideAction).toHaveBeenCalledTimes(1)
      expect(mocks.openChanges).toHaveBeenLastCalledWith(false)
      expect(mocks.outsideAction.mock.invocationCallOrder[0]).toBeLessThan(mocks.openChanges.mock.invocationCallOrder[1]!)
      expect(screen.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "false")
    })

    it("waits for publication when the exact frame settles first", () => {
      const shell = renderInboxLifecycle()
      fireEvent.click(screen.getByRole("button", { name: "Open Inbox" }))
      shell.update({ frameHref: "/c/me" })
      expect(shell.context.navigation.navigationPending).toBe(false)
      expect(mocks.openChanges).not.toHaveBeenCalled()
      shell.update({ publishedHref: "/c/me" })
      expectVisibleInbox()
      expect(mocks.openChanges).toHaveBeenCalledExactlyOnceWith(true)
    })

    it.each([["desktop", "/c/messages/unavailable"], ["mobile", "/c/me"]])(
      "keeps direct opening on %s at %s", (breakpoint, href) => {
        const shell = renderInboxLifecycle(href, breakpoint)
        act(() => shell.context.openInbox!())
        expect(mocks.push).not.toHaveBeenCalled()
        expectVisibleInbox()
        fireEvent.click(screen.getByTestId(tid.inboxTrigger))
        expect(screen.getByTestId(tid.inboxTrigger)).toHaveAttribute("aria-expanded", "false")
      },
    )

    it.each(["push", "replace", "resolver", "cancel", "Back"])(
      "discards the request on %s and does not revive on a later same URL", async (entry) => {
        const shell = renderInboxLifecycle()
        fireEvent.click(screen.getByRole("button", { name: "Open Inbox" }))
        await act(async () => {
          const nav = shell.context.navigation
          if (entry === "push") nav.push("/c/me/friends")
          if (entry === "replace") nav.replace("/c/me/friends")
          if (entry === "resolver") await nav.resolveAndPush(async () => "/c/me/friends")
          if (entry === "cancel") nav.cancelPendingNavigation()
          if (entry === "Back") window.dispatchEvent(new Event("popstate"))
        })
        shell.update({ publishedHref: "/c/me", frameHref: "/c/me" })
        shell.update({ publishedHref: "/c/me/friends", frameHref: "/c/me/friends" })
        shell.update({ publishedHref: "/c/me", frameHref: "/c/me" })
        expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
        expect(screen.queryByTestId(tid.userBarExtension)).toBeNull()
      },
    )

    it("discards on account change even if the original account returns before the destination", () => {
      const shell = renderInboxLifecycle()
      fireEvent.click(screen.getByRole("button", { name: "Open Inbox" }))
      shell.update({ viewerId: "other-viewer" })
      shell.update({ viewerId: "viewer" })
      shell.update({ publishedHref: "/c/me", frameHref: "/c/me" })
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
    })

    it("clears a synchronous push failure and cannot reopen on a later destination commit", () => {
      const shell = renderInboxLifecycle()
      mocks.push.mockImplementationOnce(() => { throw new Error("push failed") })
      act(() => { expect(() => shell.context.openInbox!()).toThrow("push failed") })
      expect(shell.context.navigation.navigationPending).toBe(false)
      expect(shell.context.navigation.pendingHref).toBeNull()
      shell.update({ publishedHref: "/c/me", frameHref: "/c/me" })
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
    })

    it("loses the request on unmount", () => {
      const shell = renderInboxLifecycle()
      fireEvent.click(screen.getByRole("button", { name: "Open Inbox" }))
      shell.unmount()
      renderInboxLifecycle("/c/me")
      expect(mocks.openChanges).not.toHaveBeenCalledWith(true)
      expect(screen.queryByTestId(tid.userBarExtension)).toBeNull()
    })

    it("keeps a repeated external request pending until its latest exact commit", () => {
      const shell = renderInboxLifecycle()
      fireEvent.click(screen.getByRole("button", { name: "Open Inbox" }))
      act(() => shell.context.openInbox!())
      expect(mocks.push).toHaveBeenCalledTimes(2)
      expect(mocks.openChanges).not.toHaveBeenCalled()
      shell.update({ publishedHref: "/c/me", frameHref: "/c/me" })
      expectVisibleInbox()
      expect(mocks.openChanges).toHaveBeenCalledExactlyOnceWith(true)
    })
  })

})
