import { createElement, useState, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import {
  isPublishedNonStructuralCommit,
  normalizeCommunityHref,
  resolveCommunityCheckpointPlan,
  type CommunityCommittedFrame,
} from "@/lib/community/community-route"
import { ShellFrameView } from "./shell-frame-view"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import { CommunityRouteContext } from "./community-route-context"
import ServerLayout from "@/app/c/channels/layout"

const mocks = vi.hoisted(() => ({
  pathname: "/c/channels/s1/a",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSelectedLayoutSegments: () => mocks.pathname.split("/").slice(3),
  useSearchParams: () => new URLSearchParams(mocks.search),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, prefetch: vi.fn() }),
}))
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}))
vi.mock("@/components/ui/resizable", () => {
  const Panel = ({ children }: { children: ReactNode }) => createElement("div", null, children)
  return { ResizablePanelGroup: Panel, ResizablePanel: Panel, ResizableHandle: () => null }
})
vi.mock("./use-hydrated-client", () => ({ useHydratedClient: () => true }))
vi.mock("@/hooks/community/use-running-owned-bots", () => ({
  useRunningOwnedBots: () => ({ runningBots: [] }),
}))
vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({ AlookLoading: () => null }))
vi.mock("./server-sidebar-slot", () => ({ ServerSidebarSlot: () => null }))
vi.mock("./server-rail", () => ({
  ServerRail: ({ onHome }: { onHome: () => void }) => createElement("button", {
    onClick: onHome,
  }, "New destination"),
}))
vi.mock("./user-bar", () => ({
  UserBar: ({ onInboxOpenChange, inboxOpen }: {
    onInboxOpenChange: (open: boolean) => void
    inboxOpen: boolean
  }) => createElement("button", {
    onClick: () => onInboxOpenChange(!inboxOpen),
    "aria-expanded": inboxOpen,
  }, "Inbox"),
}))
vi.mock("./community-inbox-popover", () => ({ InboxPopover: () => null }))
vi.mock("./shell-frame-overlays", () => ({ ShellFrameOverlays: () => null }))
vi.mock("./community-pending-frame", () => ({
  CommunityPendingFrame: () => createElement("div", { role: "status" },
    createElement("span", null, "Target skeleton"),
    createElement("span", null, "Blank area"),
    createElement("input", { "aria-label": "Draft input" }),
  ),
}))
vi.mock("@/components/community/channels/channel-sidebar", () => ({ ChannelSidebarSkeleton: () => null }))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebar: () => null,
  DmSidebarSkeleton: () => null,
}))
vi.mock("@/contexts/community/current-user", () => ({ useCurrentUser: () => ({ id: "viewer" }) }))
vi.mock("@/components/community/channels/channel-route", () => ({
  ChannelRoute: ({ channelId, targetHref, routeCommitted }: {
    channelId: string
    targetHref: string
    routeCommitted: boolean
  }) => routeCommitted ? createElement("span", null, "Committed content")
    : createElement("div", { role: "status", "data-channel-id": channelId, "data-target-href": targetHref },
      createElement("span", null, "Target skeleton"),
      createElement("span", null, "Blank area"),
      createElement("input", { "aria-label": "Draft input" }),
    ),
}))

type Navigation = ReturnType<typeof useCommunityNavigationController>
const target = "/c/channels/s1/b"
const nextTarget = "/c/channels/s1/c"

function frame(href: string, revision: number): CommunityCommittedFrame {
  return { ...normalizeCommunityHref(href), revision }
}

function publishHref(href: string) {
  const url = new URL(href, "https://alook.test")
  mocks.pathname = url.pathname
  mocks.search = url.search
}

function renderShell(breakpoint: "mobile" | "desktop" = "mobile", queryClient = new QueryClient()) {
  let navigation!: Navigation
  let committedFrame = frame(mocks.pathname, 0)
  function Capture() {
    const [inboxOpen, setInboxOpen] = useState(false)
    navigation = useCommunityNavigationController(committedFrame)
    const checkpoint = resolveCommunityCheckpointPlan({
      committedFrame,
      targetHref: navigation.pendingHref ?? (normalizeCommunityHref(navigation.publishedHref).leafKey !== committedFrame.leafKey
        ? navigation.entryIntent?.href ?? navigation.publishedHref : navigation.publishedHref),
      pending: navigation.navigationPending,
      targetReady: false,
    })
    const props = {
      breakpoint,
      inboxOpening: false,
      checkpoint,
      routeCommitted: isPublishedNonStructuralCommit(committedFrame, navigation.publishedHref, navigation.pendingHref ?? navigation.publishedHref),
      sidebar: () => createElement("span", null, "Sidebar"),
      rail: { railProps: { onHome: () => navigation.push(nextTarget) } } as never,
      profile: { currentUser: { id: "viewer", name: "Viewer", avatar: "V" } } as never,
      inbox: { popoverProps: {}, hasUnread: false } as never,
      userBarExtension: { active: inboxOpen ? "inbox" : "none" } as never,
      daemonUpdate: { eligibleMachines: [] } as never,
      onUserBarInboxOpenChange: setInboxOpen,
      onUserBarOpenProfile: vi.fn(),
      onUserBarOpenUpdate: vi.fn(),
      dismissUserBarExtension: vi.fn(),
    }
    return createElement(CommunityRouteContext, { value: {
      breakpoint: props.breakpoint,
      frame: committedFrame, navigation, ownerDeleteRouteScope: undefined,
    } }, createElement(ShellFrameView, props,
      committedFrame.scope.kind === "server"
        ? createElement(ServerLayout, null, createElement("span", null, "Committed content"))
        : createElement("span", null, "Committed content"),
    ))
  }
  const renderer = render(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
  return {
    queryClient,
    get navigation() { return navigation },
    commit(href: string, revision: number, publish = true) {
      if (publish) publishHref(href)
      committedFrame = frame(normalizeCommunityHref(href).pathname, revision)
      renderer.rerender(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
    },
    publish(href: string) {
      publishHref(href)
      renderer.rerender(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
    },
    unmount: renderer.unmount,
  }
}

async function beginInboxNavigation(shell: ReturnType<typeof renderShell>) {
  await act(async () => shell.navigation.pushImmediate(target))
}

function expectPendingTarget(shell: ReturnType<typeof renderShell>) {
  expect(shell.navigation.pendingHref).toBe(target)
  expect(shell.navigation.navigationPending).toBe(true)
  expect(screen.getByRole("status").textContent).toContain("Target skeleton")
  expect(screen.getByRole("status")).toHaveAttribute("data-channel-id", "b")
  expect(screen.getByRole("status")).toHaveAttribute("data-target-href", target)
  expect(screen.queryByText("Committed content")).toBeNull()
}

beforeEach(() => {
  mocks.pathname = "/c/channels/s1/a"
  mocks.search = ""
  mocks.push.mockReset()
  mocks.replace.mockReset()
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})

describe("Shell input and explicit navigation ownership", () => {
  it.each(["Target skeleton", "Blank area", "Draft input"])(
    "keeps the target checkpoint after clicking %s",
    async (label) => {
      const shell = renderShell()
      await beginInboxNavigation(shell)
      fireEvent.click(label === "Draft input" ? screen.getByLabelText(label) : screen.getByText(label))
      expectPendingTarget(shell)
      expect(mocks.push).toHaveBeenCalledTimes(1)
    },
  )

  it.each(["Enter", " ", "ArrowDown"])("keeps pending target while typing %s", async (key) => {
    const shell = renderShell()
    await beginInboxNavigation(shell)
    fireEvent.keyDown(screen.getByLabelText("Draft input"), { key })
    expectPendingTarget(shell)
  })

  it("keeps pending target while opening and closing Inbox", async () => {
    const shell = renderShell("desktop")
    await beginInboxNavigation(shell)
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
    expect(screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-expanded")).toBe("true")
    expectPendingTarget(shell)
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
    expect(screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-expanded")).toBe("false")
    expectPendingTarget(shell)
  })

  it("supersedes a previous target at a real new navigation entry", async () => {
    const shell = renderShell("desktop")
    await beginInboxNavigation(shell)
    fireEvent.click(screen.getByRole("button", { name: "New destination" }))
    expect(shell.navigation.pendingHref).toBe(nextTarget)
    expect(mocks.push.mock.calls.map(([href]) => href)).toEqual([target, nextTarget])
  })

  it("supersedes a delayed resolver through the explicit child navigation", async () => {
    const shell = renderShell("desktop")
    let resolve!: (href: string) => void
    const delayed = new Promise<string>((done) => { resolve = done })
    let result!: Promise<boolean>
    act(() => { result = shell.navigation.resolveAndPush(() => delayed) })
    fireEvent.click(screen.getByRole("button", { name: "New destination" }))
    await act(async () => {
      resolve(target)
      await expect(result).resolves.toBe(false)
    })
    expect(shell.navigation.pendingHref).toBe(nextTarget)
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(nextTarget)
  })

  it("retires a captured UI intent on any newer intent and does not revive it at the same URL", () => {
    const shell = renderShell("desktop")
    const current = shell.navigation.captureIntent()
    expect(current()).toBe(true)
    act(() => shell.navigation.push(nextTarget))
    expect(current()).toBe(false)
    shell.commit(nextTarget, 1)
    shell.commit("/c/channels/s1/a", 2)
    expect(current()).toBe(false)
    const returned = shell.navigation.captureIntent()
    expect(returned()).toBe(true)
    shell.commit("/c/me/friends", 3)
    expect(returned()).toBe(false)
  })

  it("does not clear a newer pending checkpoint when an older resolver rejects", async () => {
    const shell = renderShell("desktop")
    let reject!: (error: Error) => void
    const delayed = new Promise<string>((_, fail) => { reject = fail })
    let result!: Promise<boolean>
    act(() => { result = shell.navigation.resolveAndPush(() => delayed) })
    fireEvent.click(screen.getByRole("button", { name: "New destination" }))
    await act(async () => {
      reject(new Error("old resolver failed"))
      await expect(result).rejects.toThrow("old resolver failed")
    })
    expect(shell.navigation.pendingHref).toBe(nextTarget)
    expect(shell.navigation.navigationPending).toBe(true)
  })

  it("settles an exact frame without an extra click", async () => {
    const shell = renderShell()
    await beginInboxNavigation(shell)
    shell.commit(target, 1)
    expect(shell.navigation.pendingHref).toBeNull()
    expect(shell.navigation.navigationPending).toBe(false)
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByText("Committed content")).toBeTruthy()
  })

  it("still clears pending target on popstate", async () => {
    const shell = renderShell()
    await beginInboxNavigation(shell)
    act(() => window.dispatchEvent(new Event("popstate")))
    expect(shell.navigation.pendingHref).toBeNull()
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  describe("current pending-commit qualification", () => {
    it.each(["friends", "bots", "machines"])("keeps the latest %s query selected when an older response publishes its shared pathname", module => {
      const shell = renderShell("desktop")
      const previous = `/c/me/${module}?target=old`
      const target = `/c/me/${module}?target=new`
      act(() => shell.navigation.push(previous))
      act(() => shell.navigation.replace(target))
      shell.commit(previous, 1)
      expect(shell.navigation.pendingHref).toBe(target)
      expect(shell.navigation.navigationPending).toBe(true)
      shell.publish(target)
      expect(shell.navigation.pendingHref).toBeNull()
      expect(shell.navigation.navigationPending).toBe(false)
    })

    it.each(["frame-first", "publication-first"])("retains the structural target with a complete query URL, %s", (order) => {
      const shell = renderShell("desktop")
      const href = "/c/channels/s1?from=inbox"
      act(() => shell.navigation.push(href))
      const current = shell.navigation.captureIntent({ pendingCommitHref: href })
      expect(current()).toBe(true)
      if (order === "frame-first") shell.commit(href, 1, false)
      else shell.publish(href)
      expect(current()).toBe(true)
      shell.commit(href, 1)
      expect(shell.navigation.pendingHref).toBeNull()
      expect(shell.navigation.publishedHref).toBe(href)
      expect(current()).toBe(true)
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith(href)
    })

    it("qualifies a query-only commit without inventing a frame revision", () => {
      const shell = renderShell("desktop")
      const href = "/c/channels/s1/a?msg=m1"
      act(() => shell.navigation.push(href))
      const current = shell.navigation.captureIntent({ pendingCommitHref: href })
      shell.publish(href)
      expect(shell.navigation.pendingHref).toBeNull()
      expect(current()).toBe(true)
      act(() => shell.navigation.push("/c/channels/s1/a?msg=m2"))
      shell.publish("/c/channels/s1/a?msg=m2")
      expect(current()).toBe(false)
      shell.publish(href)
      expect(current()).toBe(false)
    })

    it.each(["push", "pushImmediate", "replace", "resolver", "cancel", "Back"])(
      "retires on %s and rejects the old same URL", async (entry) => {
        const shell = renderShell("desktop")
        act(() => shell.navigation.push(target))
        const current = shell.navigation.captureIntent({ pendingCommitHref: target })
        await act(async () => {
          if (entry === "push") shell.navigation.push(nextTarget)
          if (entry === "pushImmediate") shell.navigation.pushImmediate(nextTarget)
          if (entry === "replace") shell.navigation.replace(nextTarget)
          if (entry === "resolver") await shell.navigation.resolveAndPush(async () => nextTarget)
          if (entry === "cancel") shell.navigation.cancelPendingNavigation()
          if (entry === "Back") window.dispatchEvent(new Event("popstate"))
        })
        expect(current()).toBe(false)
        shell.commit(nextTarget, 1)
        act(() => shell.navigation.push(target))
        shell.commit(target, 2)
        expect(current()).toBe(false)
      },
    )

    it("retires on an unrelated frame, same-URL no-op and unmount", () => {
      const shell = renderShell("desktop")
      act(() => shell.navigation.push(target))
      const unrelated = shell.navigation.captureIntent({ pendingCommitHref: target })
      shell.commit(nextTarget, 1)
      expect(unrelated()).toBe(false)
      act(() => shell.navigation.push(target))
      const settled = shell.navigation.captureIntent({ pendingCommitHref: target })
      shell.commit(target, 2)
      expect(settled()).toBe(true)
      act(() => shell.navigation.push(target))
      expect(settled()).toBe(false)
      const unmounted = shell.navigation.captureIntent({ pendingCommitHref: target })
      shell.unmount()
      expect(unmounted()).toBe(false)
    })
  })

  describe("optional exact next-commit qualification", () => {
    it("retains only its own exact commit while default capture still retires", () => {
      const shell = renderShell("desktop")
      const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
      expect(ownCommit()).toBe(false)
      act(() => shell.navigation.push(target))
      const ordinary = shell.navigation.captureIntent()
      expect(ownCommit()).toBe(true)
      expect(ordinary()).toBe(true)
      shell.publish(target)
      expect(shell.navigation.navigationPending).toBe(true)
      shell.commit(target, 1)
      expect(shell.navigation.navigationPending).toBe(false)
      expect(ordinary()).toBe(false)
      expect(ownCommit()).toBe(true)
      shell.commit(target, 1)
      expect(ownCommit()).toBe(true)
      shell.commit(nextTarget, 2)
      shell.commit(target, 3)
      expect(ownCommit()).toBe(false)
    })

    it("preserves own frame settlement until its separately published URL arrives", () => {
      const shell = renderShell("desktop")
      const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
      act(() => shell.navigation.push(target))
      shell.commit(target, 1, false)
      expect(shell.navigation.navigationPending).toBe(true)
      expect(shell.navigation.publishedHref).not.toBe(target)
      expect(ownCommit()).toBe(true)
      shell.publish(target)
      expect(ownCommit()).toBe(true)
    })

    it.each(["push", "pushImmediate", "replace", "resolver", "cancel", "Back"])(
      "retires at a competing %s entry and rejects a later identical destination", async (entry) => {
        const shell = renderShell("desktop")
        const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
        act(() => shell.navigation.push(target))
        await act(async () => {
          if (entry === "push") shell.navigation.push(nextTarget)
          if (entry === "pushImmediate") shell.navigation.pushImmediate(nextTarget)
          if (entry === "replace") shell.navigation.replace(nextTarget)
          if (entry === "resolver") await shell.navigation.resolveAndPush(async () => nextTarget)
          if (entry === "cancel") shell.navigation.cancelPendingNavigation()
          if (entry === "Back") window.dispatchEvent(new Event("popstate"))
        })
        expect(ownCommit()).toBe(false)
        shell.commit(nextTarget, 1)
        act(() => shell.navigation.push(target))
        shell.commit(target, 2)
        expect(ownCommit()).toBe(false)
      },
    )

    it("rejects an intervening unrelated frame even if the pending target later commits", () => {
      const shell = renderShell("desktop")
      const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
      act(() => shell.navigation.push(target))
      shell.commit(nextTarget, 1)
      expect(ownCommit()).toBe(false)
      shell.commit(target, 2)
      expect(shell.navigation.navigationPending).toBe(false)
      expect(ownCommit()).toBe(false)
    })

    it.each(["push", "pushImmediate", "replace"] as const)(
      "discards a synchronous %s failure before any later same-URL commit", (entry) => {
        const shell = renderShell("desktop")
        const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
        mocks[entry === "replace" ? "replace" : "push"].mockImplementationOnce(() => { throw new Error("router failed") })
        act(() => { expect(() => shell.navigation[entry](target)).toThrow("router failed") })
        expect(shell.navigation.navigationPending).toBe(false)
        expect(shell.navigation.pendingHref).toBeNull()
        expect(ownCommit()).toBe(false)
        act(() => shell.navigation.push(target))
        shell.commit(target, 1)
        expect(ownCommit()).toBe(false)
      },
    )

    it("does not clear a newer pending intent when an older router call throws", () => {
      const shell = renderShell("desktop")
      const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
      mocks.push.mockImplementationOnce(() => {
        shell.navigation.push(nextTarget)
        throw new Error("old push failed")
      })
      act(() => { expect(() => shell.navigation.push(target)).toThrow("old push failed") })
      expect(shell.navigation.pendingHref).toBe(nextTarget)
      expect(shell.navigation.navigationPending).toBe(true)
      expect(ownCommit()).toBe(false)
    })

    it("retires a settled qualification on a same-URL no-op without changing default capture", () => {
      const shell = renderShell("desktop")
      const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
      act(() => shell.navigation.push(target))
      shell.commit(target, 1)
      const ordinary = shell.navigation.captureIntent()
      act(() => shell.navigation.push(target))
      expect(ownCommit()).toBe(false)
      expect(ordinary()).toBe(true)
    })

    it("retires on unmount", () => {
      const shell = renderShell("desktop")
      const ownCommit = shell.navigation.captureIntent({ nextCommitHref: target })
      act(() => shell.navigation.push(target))
      shell.unmount()
      expect(ownCommit()).toBe(false)
    })
  })

})
