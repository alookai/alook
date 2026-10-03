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

const mocks = vi.hoisted(() => ({
  pathname: "/c/channels/s1/a",
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
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
    return createElement(ShellFrameView, props, createElement("span", null, "Committed content"))
  }
  const renderer = render(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
  return {
    queryClient,
    get navigation() { return navigation },
    commit(href: string, revision: number) {
      mocks.pathname = href
      committedFrame = frame(href, revision)
      renderer.rerender(createElement(QueryClientProvider, { client: queryClient }, createElement(Capture)))
    },
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
})
