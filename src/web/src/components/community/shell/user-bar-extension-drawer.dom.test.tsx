import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@/test/react-dom-harness"
import { UserBarExtensionDrawer } from "./user-bar-extension-drawer"

function DrawerPanel({ label }: {
  label: string
  active?: "inbox" | "profile" | "update"
  interactive?: boolean
  animate?: boolean
  focusOnOpen?: boolean
  onInitialFocus?: () => void
}) {
  return createElement("div", null, label)
}

function installNativeKeyboard(packet: unknown) {
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: {
      messageHandlers: {
        alookKeyboard: {
          postMessage: vi.fn(async () => packet),
        },
      },
    },
  })
}

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI__")
  Reflect.deleteProperty(window, "webkit")
  document.documentElement.style.removeProperty("--alook-keyboard-progress")
  document.documentElement.style.removeProperty("--alook-keyboard-bottom")
  document.documentElement.style.removeProperty("--alook-kb-layout-progress")
  document.documentElement.style.removeProperty("--alook-kb-visual-progress")
  document.documentElement.style.removeProperty("--alook-kb-translate-y")
  document.documentElement.style.removeProperty("--alook-kb-transition")
  document.documentElement.removeAttribute("data-alook-kb-animating")
})

describe("UserBarExtensionDrawer keyboard GPU layer", () => {
  it("omits the GPU layer when closed and applies net user-bar displacement only when open or retained", async () => {
    installNativeKeyboard({
      mode: "overlay-gpu",
      targetInset: 0,
      viewportWidth: 400,
      durationMs: 0,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      phase: "settled",
      sequence: 0,
    })

    const view = render(
      <UserBarExtensionDrawer onDismiss={vi.fn()} userBarHeightCss="60px">
        {null}
      </UserBarExtensionDrawer>,
    )

    const viewport = view.container.querySelector<HTMLElement>(".community-user-bar-drawer-viewport")
    expect(viewport).not.toBeNull()
    expect(viewport?.hasAttribute("data-alook-kb-gpu-layer")).toBe(false)
    expect(viewport?.className).not.toContain("alook-kb-gpu-layer")
    expect(viewport?.style.getPropertyValue("--alook-kb-layer-translate-y")).toBe("")

    view.rerender(
      <UserBarExtensionDrawer onDismiss={vi.fn()} userBarHeightCss="60px">
        <DrawerPanel active="inbox" label="Inbox" />
      </UserBarExtensionDrawer>,
    )

    await waitFor(() => {
      expect(viewport?.getAttribute("data-alook-kb-gpu-layer")).toBe("true")
    })
    expect(viewport?.getAttribute("data-alook-kb-gpu-offset")).toBe("user-bar")
    expect(viewport?.className).toContain("alook-kb-gpu-layer")
    expect(viewport?.style.getPropertyValue("--alook-kb-layer-translate-y")).toBe(
      "calc(max(0px, calc(var(--alook-kb-layout-progress, 0px) - 60px)) - max(0px, calc(var(--alook-kb-visual-progress, 0px) - 60px)))",
    )

    view.unmount()
  })

  it("does not attach the GPU layer in legacy keyboard mode", async () => {
    installNativeKeyboard({ bottomInset: 280, viewportWidth: 400 })

    const view = render(
      <UserBarExtensionDrawer onDismiss={vi.fn()} userBarHeightCss="60px">
        <DrawerPanel active="profile" label="Profile" />
      </UserBarExtensionDrawer>,
    )

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).not.toBe("")
    })
    const viewport = view.container.querySelector<HTMLElement>(".community-user-bar-drawer-viewport")
    expect(viewport?.hasAttribute("data-alook-kb-gpu-layer")).toBe(false)
    expect(viewport?.className).not.toContain("alook-kb-gpu-layer")

    view.unmount()
  })
})
