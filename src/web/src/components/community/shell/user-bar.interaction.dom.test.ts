import { createElement, startTransition, StrictMode, Suspense, useLayoutEffect, useRef, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { UserBar, UserBarSkeleton } from "./user-bar"
import { UserBarExtensionDrawer } from "./user-bar-extension-drawer"
import { tid } from "@/lib/community/testids"
import type { UserBarExtensionKind } from "./user-bar-extension-state"
import { requestNativeBack } from "@/components/ui/native-back-layer"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))

vi.mock("../avatar", () => ({
  Avatar: () => createElement("span", { "data-testid": "user-avatar" }),
}))

function renderBar() {
  const order: string[] = []
  const onInboxOpenChange = vi.fn(() => order.push("close"))
  const onOpenProfile = vi.fn(() => order.push("profile"))
  const onEditProfile = vi.fn(() => order.push("settings"))
  render(createElement(UserBar, {
    breakpoint: "mobile",
    user: { id: "u1", name: "User", avatar: "U" },
    onOpenProfile,
    onEditProfile,
    inbox: createElement("span", null, "Inbox content"),
    hasUnread: false,
    inboxOpen: true,
    onInboxOpenChange,
  }))
  return { order, onInboxOpenChange, onOpenProfile, onEditProfile }
}

describe("UserBar native mobile spacing", () => {
  it.each([
    { name: "native iPhone", native: true, ua: "iPhone", breakpoint: "mobile", compact: true },
    { name: "native Android", native: true, ua: "Android", breakpoint: "mobile", compact: true },
    { name: "mobile browser", native: false, ua: "iPhone", breakpoint: "mobile", compact: false },
    { name: "narrow desktop Tauri", native: true, ua: "Macintosh", breakpoint: "mobile", compact: false },
    { name: "wide native iPhone", native: true, ua: "iPhone", breakpoint: "desktop", compact: true },
  ] as const)("keeps live/loading padding aligned on $name", ({ native, ua, breakpoint, compact }) => {
    const bridge = Object.getOwnPropertyDescriptor(window, "__TAURI__")
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua)
    if (native) Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
    else Reflect.deleteProperty(window, "__TAURI__")
    try {
      const view = render(createElement("div", null,
        createElement(UserBar, { breakpoint, user: { id: "u1", name: "User", avatar: "U" }, hasUnread: false }),
        createElement(UserBarSkeleton),
      ))
      for (const id of [tid.userBar, tid.initialUserBarPending]) {
        expect(view.getByTestId(id).style.paddingBottom).toBe(compact ? "0.25rem" : "")
      }
    } finally {
      userAgent.mockRestore()
      if (bridge) Object.defineProperty(window, "__TAURI__", bridge)
      else Reflect.deleteProperty(window, "__TAURI__")
    }
  })
})

describe("UserBar Inbox switching", () => {
  it("dismisses the real mobile extension once through native Back", async () => {
    const dismissed = vi.fn()
    function Harness() {
      const [active, setActive] = useState<UserBarExtensionKind>("inbox")
      const inbox = createElement("button", null, "Inbox item")
      return createElement(UserBar, {
        breakpoint: "mobile", user: { id: "u1", name: "User", avatar: "U" },
        hasUnread: false, inboxOpen: active === "inbox",
        extension: { active, inbox, profile: null, update: null, updateBadgePhase: null, eligibleMachines: [],
          onOpenUpdate: vi.fn(), onRequestUpdate: vi.fn(), onDismiss: () => { dismissed(); setActive("none") },
        },
      })
    }
    render(createElement(Harness))
    act(() => { expect(requestNativeBack(document)).toBe("requested") })
    expect(dismissed).toHaveBeenCalledOnce()
  })

  it("keeps committed mobile extension switching outside render-phase updates", async () => {
    const errors = vi.spyOn(console, "error")
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    function Harness() {
      const [active, setActive] = useState<UserBarExtensionKind>("none")
      const inbox = createElement("button", null, "Inbox item")
      return createElement(UserBar, {
        breakpoint: "mobile",
        user: { id: "u1", name: "User", avatar: "U" },
        inbox,
        hasUnread: false,
        inboxOpen: active === "inbox",
        onInboxOpenChange: (open) => setActive(open ? "inbox" : "none"),
        onOpenProfile: () => setActive(active === "profile" ? "none" : "profile"),
        extension: {
          active,
          inbox,
          profile: createElement("button", null, "Edit status"),
          update: null,
          updateBadgePhase: null,
          eligibleMachines: [],
          onOpenUpdate: vi.fn(),
          onRequestUpdate: vi.fn(),
          onDismiss: () => setActive("none"),
        },
      })
    }
    try {
      const user = setupUser()
      render(createElement(StrictMode, null, createElement(Harness)))
      const trigger = screen.getByTestId(tid.inboxTrigger)
      await user.click(trigger)
      expect(trigger).toHaveAttribute("aria-expanded", "true")
      expect(screen.getByRole("dialog", { name: "Inbox" })).toBeVisible()
      const dialog = screen.getByRole("dialog", { name: "Inbox" })
      await waitFor(() => expect(dialog).toHaveFocus())
      const panelFocusCalls = focus.mock.calls.filter((_, index) => focus.mock.contexts[index] === dialog)
      expect(panelFocusCalls.length).toBeGreaterThan(0)
      for (const args of panelFocusCalls) expect(args).toEqual([{ preventScroll: true }])
      await user.click(screen.getByRole("button", { name: "User", exact: true }))
      const profileDialog = screen.getByRole("dialog", { name: "Your profile" })
      expect(profileDialog).toBeVisible()
      expect(profileDialog).toBe(dialog)
      await waitFor(() => expect(profileDialog).toHaveFocus())
      expect(screen.queryByRole("dialog", { name: "Inbox" })).not.toBeInTheDocument()
      await user.click(trigger)
      const reopenedInbox = screen.getByRole("dialog", { name: "Inbox" })
      expect(reopenedInbox).toBeVisible()
      expect(reopenedInbox).toBe(dialog)
      await waitFor(() => expect(reopenedInbox).toHaveFocus())
      const allPanelFocusCalls = focus.mock.calls.filter((_, index) => focus.mock.contexts[index] === dialog)
      expect(allPanelFocusCalls.length).toBeGreaterThanOrEqual(3)
      for (const args of allPanelFocusCalls) expect(args).toEqual([{ preventScroll: true }])
      await user.click(trigger)
      expect(trigger).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByRole("dialog", { name: "Inbox" })).not.toBeInTheDocument()
      expect(errors.mock.calls.filter((args) => args.some((arg) => (
        typeof arg === "string" && /Cannot update a component|while rendering a different component/.test(arg)
      )))).toEqual([])
    } finally {
      focus.mockRestore()
      errors.mockRestore()
    }
  })

  it("keeps only committed content when a suspended extension render is abandoned", async () => {
    const pending = new Promise<void>(() => {})
    const renders = vi.fn()
    const commits = vi.fn()
    function Content({ label, interactive }: { label: string; interactive?: boolean }) {
      const ref = useRef<HTMLButtonElement>(null)
      useLayoutEffect(() => {
        commits(label, interactive, ref.current?.disabled, ref.current?.closest(".community-user-bar-drawer")?.hasAttribute("inert"))
      }, [label, interactive])
      renders(label, interactive)
      if (label === "Uncommitted") throw pending
      return createElement("button", { ref, disabled: !interactive }, label)
    }
    function Harness() {
      const [label, setLabel] = useState<string | null>("First content")
      return createElement("div", null,
        createElement("button", { onClick: () => setLabel("Committed") }, "Use latest content"),
        createElement("button", {
          onClick: () => startTransition(() => setLabel("Uncommitted")),
        }, "Start pending content"),
        createElement("button", { onClick: () => setLabel(null) }, "Close drawer"),
        createElement(Suspense, { fallback: createElement("span", null, "Pending") },
          createElement(UserBarExtensionDrawer, { onDismiss: () => setLabel(null) },
            label === null ? null : createElement(Content, { label }),
          ),
        ),
      )
    }
    const renderer = render(createElement(StrictMode, null, createElement(Harness)))
    expect(renderer.getByRole("button", { name: "First content" })).toBeEnabled()
    await act(async () => renderer.getByRole("button", { name: "Use latest content" }).click())
    expect(renderer.getByRole("button", { name: "Committed" })).toBeEnabled()
    expect(renderer.queryByRole("button", { name: "First content" })).not.toBeInTheDocument()
    await act(async () => renderer.getByRole("button", { name: "Start pending content" }).click())
    expect(renders).toHaveBeenCalledWith("Uncommitted", true)
    expect(renderer.getByRole("button", { name: "Committed" })).toBeVisible()
    expect(renderer.queryByText("Pending")).not.toBeInTheDocument()
    renders.mockClear()
    await act(async () => renderer.getByRole("button", { name: "Close drawer" }).click())
    expect(renders).toHaveBeenCalledWith("Committed", false)
    expect(renders).not.toHaveBeenCalledWith("Uncommitted", false)
    expect(commits).toHaveBeenCalledWith("Committed", false, true, true)
    expect(commits.mock.calls.some(([label]) => label === "Uncommitted")).toBe(false)
    expect(renderer.queryByText("Pending")).not.toBeInTheDocument()
    expect(renderer.queryByRole("button", { name: "Committed" })).not.toBeInTheDocument()
  })

  it.each(["mobile", "desktop"] as const)("cancels the pending %s opening on the second actual trigger click", async (breakpoint) => {
    const changes = vi.fn()
    function Harness() {
      const [opening, setOpening] = useState(false)
      return createElement(UserBar, {
        breakpoint,
        user: { id: "u1", name: "User", avatar: "U" },
        inbox: createElement("span", null, "Inbox content"),
        hasUnread: false,
        inboxOpen: false,
        inboxOpening: opening,
        onInboxOpenChange: (open) => { changes(open); setOpening(open) },
      })
    }
    const user = setupUser()
    render(createElement(Harness))
    const trigger = screen.getByTestId(tid.inboxTrigger)
    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-busy", "true")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.click(trigger)
    expect(trigger).not.toHaveAttribute("aria-busy")
    expect(changes.mock.calls).toEqual([[true], [false]])
    expect(screen.queryByRole("dialog", { name: "Inbox" })).not.toBeInTheDocument()
  })

  it.each(["mobile", "desktop"] as const)("renders the real %s extension through its intended motion surface", (breakpoint) => {
    const inbox = createElement("button", null, "Inbox item")
    const renderer = render(createElement(UserBar, {
      breakpoint,
      user: { id: "u1", name: "User", avatar: "U" },
      inbox,
      hasUnread: false,
      inboxOpen: true,
      extension: {
        active: "inbox",
        inbox,
        profile: null,
        update: null,
        updateBadgePhase: null,
        eligibleMachines: [],
        onOpenUpdate: vi.fn(),
        onRequestUpdate: vi.fn(),
        onDismiss: vi.fn(),
      },
    }))
    const dialog = renderer.getByRole("dialog", { name: "Inbox" })
    expect(renderer.getAllByRole("button", { name: "Inbox item" })).toHaveLength(1)
    if (breakpoint === "mobile") {
      expect(dialog.closest(".community-user-bar-drawer")).not.toBeNull()
      expect(dialog.closest(`[data-testid="${tid.userBar}"]`)).not.toBeNull()
      expect(dialog.className).not.toContain("fade-in")
    } else {
      expect(dialog.closest(".community-user-bar-drawer")).toBeNull()
      expect(dialog.closest(`[data-testid="${tid.userBar}"]`)).toBeNull()
      expect(dialog.closest('[data-slot="popover-content"]')).not.toBeNull()
      expect(dialog).toHaveAttribute("data-presentation", "popup")
      expect(renderer.getByTestId(tid.userBar).querySelector('[data-slot="community-user-bar-base"]')).toHaveClass("rounded-xl")
      expect(dialog.className).toContain("fade-in")
    }
  })

  it.each([false, true])("switches desktop pop-ups and restores focus with hidden name=%s", async (hideName) => {
    function Harness() {
      const [active, setActive] = useState<UserBarExtensionKind>("none")
      const inbox = createElement("button", null, "Inbox item")
      return createElement("div", null,
        createElement("button", null, "Outside"),
        createElement(UserBar, {
          breakpoint: "desktop",
          user: { id: "u1", name: "User", avatar: "U" },
          inbox,
          hasUnread: false,
          inboxOpen: active === "inbox",
          onInboxOpenChange: (open) => setActive(open ? "inbox" : "none"),
          onOpenProfile: () => setActive(active === "profile" ? "none" : "profile"),
          extension: {
            active,
            inbox,
            profile: createElement("button", null, "Edit status"),
            update: null,
            updateBadgePhase: null,
            eligibleMachines: [],
            onOpenUpdate: vi.fn(),
            onRequestUpdate: vi.fn(),
            onDismiss: () => setActive("none"),
          },
        }),
      )
    }
    const user = setupUser()
    render(createElement(Harness))
    const trigger = screen.getByTestId(tid.inboxTrigger)
    await user.click(trigger)
    expect(screen.getByRole("dialog", { name: "Inbox" })).toHaveFocus()
    await user.click(screen.getByRole("button", { name: "User", exact: true }))
    expect(screen.queryByRole("dialog", { name: "Inbox" })).not.toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Your profile" })).toHaveFocus()
    const nameTrigger = screen.getByRole("button", { name: "User", exact: true })
    if (hideName) nameTrigger.style.display = "none"
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const expectedFocus = hideName ? screen.getByRole("button", { name: "Open profile", exact: true }) : nameTrigger
    await vi.waitFor(() => expect(expectedFocus).toHaveFocus())
    await user.click(trigger)
    await user.click(screen.getByRole("button", { name: "Outside" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await user.click(trigger)
    await user.click(trigger)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it.each(["avatar", "name"])("closes before the %s profile action exactly once", async (kind) => {
    const user = setupUser()
    const { order, onInboxOpenChange, onOpenProfile } = renderBar()
    const avatarButton = screen.getByTestId("user-avatar").closest("button")
    const button = kind === "avatar"
      ? avatarButton
      : screen.getByRole("button", { name: "User" })
    expect(button).not.toBeNull()

    await user.click(button!)

    expect(order).toEqual(["close", "profile"])
    expect(onInboxOpenChange).toHaveBeenCalledOnce()
    expect(onOpenProfile).toHaveBeenCalledOnce()
  })

  it("closes before Settings exactly once", async () => {
    const user = setupUser()
    const { order, onInboxOpenChange, onEditProfile } = renderBar()

    await user.click(screen.getByTestId(tid.userSettingsOpen))

    expect(order).toEqual(["close", "settings"])
    expect(onInboxOpenChange).toHaveBeenCalledOnce()
    expect(onEditProfile).toHaveBeenCalledOnce()
  })
})
