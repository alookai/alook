import { createElement, useState, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import {
  normalizeCommunityHref,
  resolveCommunityCheckpointPlan,
  type CommunityCommittedFrame,
} from "@/lib/community/community-route"
import {
  beginConversationNavigationProof,
  getConversationNavigationProof,
} from "@/lib/community/conversation-navigation-proof"
import { ShellFrameView } from "./shell-frame-view"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import { CommunityRouteContext } from "./community-route-context"
import ServerLayout from "@/app/c/channels/layout"

const mocks = vi.hoisted(() => ({
  pathname: "/c/channels/s1/a",
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSelectedLayoutSegments: () => mocks.pathname.split("/").slice(3),
  useSearchParams: () => new URLSearchParams(),
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
vi.mock("@/components/community/channels/dm-sidebar", () => ({ DmSidebarSkeleton: () => null }))
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

function renderShell(breakpoint: "mobile" | "desktop" = "mobile", queryClient = new QueryClient()) {
  let navigation!: Navigation
  let committedFrame = frame(mocks.pathname, 0)
  function Capture() {
    const [inboxOpen, setInboxOpen] = useState(false)
    navigation = useCommunityNavigationController(committedFrame)
    const checkpoint = resolveCommunityCheckpointPlan({
      committedFrame,
      targetHref: navigation.pendingHref,
      pending: navigation.navigationPending,
      targetReady: false,
    })
    const props = {
      breakpoint,
      checkpoint,
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
      if (publish) mocks.pathname = href
      committedFrame = frame(href, revision)
      renderer.rerender(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
    },
    publish(href: string) {
      mocks.pathname = href
      renderer.rerender(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
    },
    unmount: renderer.unmount,
  }
}

function beginInboxNavigation(shell: ReturnType<typeof renderShell>) {
  let proof!: ReturnType<typeof beginConversationNavigationProof>
  act(() => {
    proof = beginConversationNavigationProof(shell.queryClient, {
      href: target,
      viewerId: "viewer",
      channelId: "b",
      serverId: "s1",
      scopeKind: "channel",
    }, 0)
    shell.navigation.pushImmediate(target)
  })
  return proof
}

function expectPendingProof(shell: ReturnType<typeof renderShell>, epoch: number) {
  expect(shell.navigation.pendingHref).toBe(target)
  expect(shell.navigation.navigationPending).toBe(true)
  expect(getConversationNavigationProof(shell.queryClient)?.epoch).toBe(epoch)
  expect(screen.getByRole("status").textContent).toContain("Target skeleton")
  expect(screen.getByRole("status")).toHaveAttribute("data-channel-id", "b")
  expect(screen.getByRole("status")).toHaveAttribute("data-target-href", target)
  expect(screen.queryByText("Committed content")).toBeNull()
}

beforeEach(() => {
  mocks.pathname = "/c/channels/s1/a"
  mocks.push.mockReset()
  mocks.replace.mockReset()
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })))
})

describe("Shell input and explicit navigation ownership", () => {
  it.each(["Target skeleton", "Blank area", "Draft input"])(
    "keeps the target checkpoint and conversation proof after clicking %s",
    (label) => {
      const shell = renderShell()
      const proof = beginInboxNavigation(shell)
      fireEvent.click(label === "Draft input" ? screen.getByLabelText(label) : screen.getByText(label))
      expectPendingProof(shell, proof.epoch)
      expect(proof.signal.aborted).toBe(false)
      expect(mocks.push).toHaveBeenCalledTimes(1)
    },
  )

  it.each(["Enter", " ", "ArrowDown"])("keeps pending and proof while typing %s", (key) => {
    const shell = renderShell()
    const proof = beginInboxNavigation(shell)
    fireEvent.keyDown(screen.getByLabelText("Draft input"), { key })
    expectPendingProof(shell, proof.epoch)
    expect(proof.signal.aborted).toBe(false)
  })

  it("keeps pending and proof while opening and closing Inbox", () => {
    const shell = renderShell("desktop")
    const proof = beginInboxNavigation(shell)
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
    expect(screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-expanded")).toBe("true")
    expectPendingProof(shell, proof.epoch)
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }))
    expect(screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-expanded")).toBe("false")
    expectPendingProof(shell, proof.epoch)
  })

  it("supersedes a previous proof at a real new navigation entry", () => {
    const shell = renderShell("desktop")
    const proof = beginInboxNavigation(shell)
    fireEvent.click(screen.getByRole("button", { name: "New destination" }))
    expect(shell.navigation.pendingHref).toBe(nextTarget)
    expect(getConversationNavigationProof(shell.queryClient)).toBeNull()
    expect(proof.signal.aborted).toBe(true)
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

  it("settles an exact frame without an extra click while retaining the independent proof", () => {
    const shell = renderShell()
    const proof = beginInboxNavigation(shell)
    shell.commit(target, 1)
    expect(shell.navigation.pendingHref).toBeNull()
    expect(shell.navigation.navigationPending).toBe(false)
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByText("Committed content")).toBeTruthy()
    expect(getConversationNavigationProof(shell.queryClient)?.epoch).toBe(proof.epoch)
    expect(proof.signal.aborted).toBe(false)
  })

  it("still clears pending and proof on popstate", () => {
    const shell = renderShell()
    const proof = beginInboxNavigation(shell)
    act(() => window.dispatchEvent(new Event("popstate")))
    expect(shell.navigation.pendingHref).toBeNull()
    expect(getConversationNavigationProof(shell.queryClient)).toBeNull()
    expect(proof.signal.aborted).toBe(true)
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.replace).not.toHaveBeenCalled()
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
      expect(shell.navigation.navigationPending).toBe(false)
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
