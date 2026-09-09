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
    expect(slot.className).toContain("rounded-t-xl")
    expect(slot.style.height).toContain("100dvh")
    expect(renderer.getByTestId("inbox-content")).toBeInTheDocument()
    expect(renderer.queryByTestId("profile-content")).not.toBeInTheDocument()
    expect(renderer.queryByTestId(tid.daemonUpdateNotice)).not.toBeInTheDocument()
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
    await act(async () => action.click())
    expect(onRequestUpdate).toHaveBeenCalledOnce()
  })

  it("dismisses on Escape and outside press but leaves User Bar switching atomic", async () => {
    const onDismiss = vi.fn()
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
      onRequestUpdate: vi.fn(),
    }))

    await act(async () => switchButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
    expect(onDismiss).not.toHaveBeenCalled()
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
    expect(onDismiss).toHaveBeenCalledOnce()
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(onDismiss).toHaveBeenCalledTimes(2)

    renderer.unmount()
    userBar.remove()
  })
})
