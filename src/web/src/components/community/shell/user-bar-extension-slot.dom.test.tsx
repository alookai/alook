import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { UserBarExtensionSlot } from "./user-bar-extension-slot"
import type { UserBarUpdateState } from "./user-bar-extension-state"

function update(
  values: Partial<UserBarUpdateState> = {},
): UserBarUpdateState {
  return {
    phase: "expanded",
    targetMachineIds: ["machine-1"],
    acceptedMachineIds: [],
    failedMachineIds: [],
    pendingMachineIds: [],
    ...values,
  }
}

const machines = [{
  id: "machine-1",
  hostname: "studio-mac",
  displayName: "Studio Mac",
  platform: "darwin",
  arch: "arm64",
  osRelease: "26.0",
  daemonVersion: "0.1.34",
  lastSeenAt: null,
  status: "online" as const,
  availableRuntimes: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}]

describe("UserBarExtensionSlot", () => {
  it("disables dismissal and focus while retained for the closing animation", async () => {
    const onDismiss = vi.fn()
    const onInitialFocus = vi.fn()
    const props = {
      active: "profile" as const,
      profile: createElement("div", null, "Profile"),
      update: null,
      eligibleMachines: [],
      onDismiss,
      onRequestUpdate: vi.fn(),
      onInitialFocus,
    }
    const renderer = render(createElement(UserBarExtensionSlot, props))
    renderer.rerender(createElement(UserBarExtensionSlot, {
      ...props, interactive: false, focusOnOpen: true,
    }))
    await act(async () => {
      document.body.click()
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(onDismiss).not.toHaveBeenCalled()
    expect(onInitialFocus).not.toHaveBeenCalled()
    expect(renderer.getByText("Profile")).toBeInTheDocument()
  })

  it("renders only the active Inbox occupant in the bounded joined surface", () => {
    const renderer = render(createElement(UserBarExtensionSlot, {
      active: "inbox",
      inbox: createElement("div", { "data-testid": "inbox-content" }, "Inbox content"),
      profile: createElement("div", { "data-testid": "profile-content" }),
      update: update(),
      eligibleMachines: machines,
      onDismiss: vi.fn(),
      onRequestUpdate: vi.fn(),
    }))

    const slot = renderer.getByTestId(tid.userBarExtension)
    expect(slot).toHaveAttribute("role", "dialog")
    expect(slot).toHaveAttribute("aria-modal", "false")
    expect(slot).toHaveAttribute("data-extension", "inbox")
    const classes = slot.className.split(" ")
    expect(classes).toEqual(expect.arrayContaining([
      "rounded-t-xl",
      "border-x",
      "border-t",
      "border-border/40",
      "shadow-(--e2)",
      "[clip-path:inset(-2rem_-2rem_0)]",
    ]))
    expect(classes).not.toContain("border-b")
    expect(classes).not.toContain("border-b-0")
    expect(classes).not.toContain("shadow-none")
    expect(slot.style.height).toContain("100dvh")
    expect(renderer.getByTestId("inbox-content")).toBeInTheDocument()
    expect(renderer.queryByTestId("profile-content")).not.toBeInTheDocument()
    expect(renderer.queryByTestId(tid.daemonUpdateNotice)).not.toBeInTheDocument()
    expect(renderer.queryByRole("button", { name: "Dismiss Inbox" })).not.toBeInTheDocument()
  })

  it.each([
    [["machine-1"], "You can update your machine to get more features."],
    [["machine-1", "machine-2"], "You can update your machines to get more features."],
  ])("restores the exact initial Update copy for %d eligible Machines", (targetMachineIds, description) => {
    const renderer = render(createElement(UserBarExtensionSlot, {
      active: "update",
      update: update({ targetMachineIds }),
      eligibleMachines: machines,
      onDismiss: vi.fn(),
      onRequestUpdate: vi.fn(),
    }))

    expect(renderer.getByText("Machine update available")).toBeInTheDocument()
    expect(renderer.getByText(description)).toBeInTheDocument()
    const action = renderer.getByTestId(tid.daemonUpdateAction)
    expect(action.className).toContain("h-11")
    expect(action.className).toContain("px-3")
    expect(action.className).toContain("sm:h-9")
    expect(action.className).toContain("sm:px-2")
    expect(action.className).not.toContain("min-h-")
    expect(renderer.queryByRole("button", { name: "Dismiss Machine update" })).not.toBeInTheDocument()
  })

  it("keeps accepted machines in Updating until live eligibility clears", () => {
    const renderer = render(createElement(UserBarExtensionSlot, {
      active: "update",
      update: update({ phase: "updating", acceptedMachineIds: ["machine-1"] }),
      eligibleMachines: machines,
      onDismiss: vi.fn(),
      onRequestUpdate: vi.fn(),
    }))

    expect(renderer.getByText("Updating machines")).toBeInTheDocument()
    expect(renderer.getByText(/disappear when they report the new version/)).toBeInTheDocument()
    expect(renderer.queryByTestId(tid.daemonUpdateAction)).not.toBeInTheDocument()
  })

  it("shows Updating and a failure-only Retry together after a partial dispatch", async () => {
    const onRequestUpdate = vi.fn()
    const renderer = render(createElement(UserBarExtensionSlot, {
      active: "update",
      update: update({
        phase: "retry",
        targetMachineIds: ["machine-1", "machine-2"],
        acceptedMachineIds: ["machine-1"],
        failedMachineIds: ["machine-2"],
      }),
      eligibleMachines: machines,
      onDismiss: vi.fn(),
      onRequestUpdate,
    }))

    expect(renderer.getByText("1 machine is updating. 1 update request failed.")).toBeInTheDocument()
    const action = renderer.getByTestId(tid.daemonUpdateAction)
    expect(action).toHaveTextContent("Retry")
    expect(action.className).toContain("h-11")
    expect(action.className).toContain("px-3")
    expect(action.className).toContain("sm:h-9")
    expect(action.className).toContain("sm:px-2")
    await act(async () => action.click())
    expect(onRequestUpdate).toHaveBeenCalledOnce()
  })

  it("dismisses on Escape and a blank outside click but leaves User Bar switching atomic", async () => {
    const onDismiss = vi.fn()
    const onDismissOutside = vi.fn()
    const userBar = document.createElement("div")
    userBar.dataset.testid = tid.userBar
    const switchButton = document.createElement("button")
    userBar.appendChild(switchButton)
    document.body.appendChild(userBar)
    const renderer = render(createElement(UserBarExtensionSlot, {
      active: "profile",
      profile: createElement("div", null, "Profile"),
      update: update(),
      eligibleMachines: machines,
      onDismiss,
      onDismissOutside,
      onRequestUpdate: vi.fn(),
    }))

    await act(async () => switchButton.click())
    expect(onDismiss).not.toHaveBeenCalled()
    expect(onDismissOutside).not.toHaveBeenCalled()
    await act(async () => document.body.click())
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onDismissOutside).not.toHaveBeenCalled()
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(onDismiss).toHaveBeenCalledTimes(2)

    renderer.unmount()
    userBar.remove()
  })

  it("lets an outside control complete its click before dismissing", async () => {
    const order: string[] = []
    const outsideButton = document.createElement("button")
    outsideButton.addEventListener("click", () => order.push("outside action"))
    document.body.appendChild(outsideButton)
    const renderer = render(createElement(UserBarExtensionSlot, {
      active: "update",
      update: update(),
      eligibleMachines: machines,
      onDismiss: () => order.push("focus-return dismiss"),
      onDismissOutside: () => order.push("outside dismiss"),
      onRequestUpdate: vi.fn(),
    }))

    await act(async () => outsideButton.click())
    expect(order).toEqual(["outside action", "outside dismiss"])

    renderer.unmount()
    outsideButton.remove()
  })

  it("moves focus into the dialog only for an explicit open request", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const onInitialFocus = vi.fn()
    const renderer = render(createElement(UserBarExtensionSlot, {
      active: "inbox",
      inbox: createElement("button", null, "Inbox action"),
      update: update(),
      eligibleMachines: machines,
      onDismiss: vi.fn(),
      onRequestUpdate: vi.fn(),
      focusOnOpen: true,
      onInitialFocus,
    }))

    const slot = renderer.getByTestId(tid.userBarExtension)
    expect(slot).toHaveAttribute("tabindex", "-1")
    expect(slot).toHaveFocus()
    expect(onInitialFocus).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    focus.mockRestore()
  })
})
