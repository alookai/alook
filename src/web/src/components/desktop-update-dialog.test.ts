import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  desktop: true,
  tauri: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  openUrl: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@alook/shared", () => ({
  isDesktop: () => mocks.desktop,
  isTauri: () => mocks.tauri,
  tauriInvoke: mocks.invoke,
}))

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}))

vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react")
  const element = (name: string) => ({ children, ...props }: Record<string, unknown>) =>
    createElement(name, props, children as never)
  return {
    Dialog: element("dialog-root"),
    DialogContent: element("dialog-content"),
    DialogDescription: element("dialog-description"),
    DialogFooter: element("dialog-footer"),
    DialogHeader: element("dialog-header"),
    DialogTitle: element("dialog-title"),
  }
})

vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react")
  return {
    Button: ({ children, ...props }: Record<string, unknown>) =>
      createElement("button", props, children as never),
  }
})

import {
  connectDesktopUpdateOffers,
  DESKTOP_PENDING_UPDATE_COMMAND,
  DESKTOP_UPDATE_AVAILABLE_EVENT,
  DESKTOP_UPDATE_RESPONSE_COMMAND,
  DesktopUpdateDialog,
  type DesktopUpdateOffer,
  isDesktopUpdateOffer,
  respondToDesktopUpdateOffer,
} from "./desktop-update-dialog"

const offer: DesktopUpdateOffer = {
  currentVersion: "1.2.3",
  availableVersion: "2.0.0",
  changelogUrl: "https://github.com/alookai/alook/releases/tag/v2.0.0",
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => typeof child === "string" ? child : text(child))
    .join("")
}

describe("DesktopUpdateDialog bridge", () => {
  beforeEach(() => {
    mocks.desktop = true
    mocks.tauri = true
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
    mocks.unlisten.mockReset()
    mocks.openUrl.mockReset()
    mocks.openUrl.mockResolvedValue(undefined)
    mocks.toastError.mockReset()
    mocks.listen.mockResolvedValue(mocks.unlisten)
    vi.stubGlobal("window", {
      __TAURI__: {
        event: { listen: mocks.listen },
        opener: { openUrl: mocks.openUrl },
      },
    })
  })

  it("accepts only the exact versioned GitHub changelog URL", () => {
    expect(isDesktopUpdateOffer(offer)).toBe(true)
    expect(isDesktopUpdateOffer({ ...offer, changelogUrl: "https://example.com/v2.0.0" }))
      .toBe(false)
    expect(isDesktopUpdateOffer({ ...offer, availableVersion: "" })).toBe(false)
  })

  it("subscribes before querying pending state and does not overwrite a newer event", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined
    const listen = vi.fn(async (event, handler) => {
      expect(event).toBe(DESKTOP_UPDATE_AVAILABLE_EVENT)
      listener = handler
      return mocks.unlisten
    })
    let resolvePending: ((value: DesktopUpdateOffer | null) => void) | undefined
    const invoke = vi.fn(() => new Promise<DesktopUpdateOffer | null>((resolve) => {
      resolvePending = resolve
    }))
    const received: Array<DesktopUpdateOffer | null> = []
    const connecting = connectDesktopUpdateOffers((value) => received.push(value), {
      listen,
      invoke,
    })
    await vi.waitFor(() => expect(listener).toBeTypeOf("function"))
    const newer = {
      currentVersion: "1.2.3",
      availableVersion: "2.1.0",
      changelogUrl: "https://github.com/alookai/alook/releases/tag/v2.1.0",
    }
    listener?.({ payload: newer })
    resolvePending?.(offer)

    await expect(connecting).resolves.toBe(mocks.unlisten)
    expect(invoke).toHaveBeenCalledWith(DESKTOP_PENDING_UPDATE_COMMAND)
    expect(received).toEqual([newer])
  })

  it("returns only update or later with the offered version", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    await respondToDesktopUpdateOffer(offer, "update", invoke)
    await respondToDesktopUpdateOffer(offer, "later", invoke)

    expect(invoke.mock.calls).toEqual([
      [DESKTOP_UPDATE_RESPONSE_COMMAND, { version: "2.0.0", action: "update" }],
      [DESKTOP_UPDATE_RESPONSE_COMMAND, { version: "2.0.0", action: "later" }],
    ])
  })

  it("renders current and new versions, one body link, and exactly two footer buttons", async () => {
    mocks.invoke.mockResolvedValue(offer)
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DesktopUpdateDialog))
    })

    const root = renderer!.root
    expect(root.findByProps({ "data-testid": "desktop-update-dialog" })).toBeTruthy()
    expect(root.findAllByType("dt").map(text)).toEqual(["Current version", "New version"])
    expect(root.findAllByType("dd").map(text)).toEqual(["v1.2.3", "v2.0.0"])
    const changelog = root.findByProps({ "data-testid": "desktop-update-changelog" })
    expect(changelog.props.href).toBe(offer.changelogUrl)
    expect(text(changelog)).toBe("View changelog")
    const footer = root.findByType("dialog-footer")
    expect(footer.findAllByType("button").map(text)).toEqual(["Later", "Update Alook"])
    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_PENDING_UPDATE_COMMAND)
  })

  it("opens the changelog in the system browser without answering or closing", async () => {
    mocks.invoke.mockResolvedValue(offer)
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DesktopUpdateDialog))
    })
    mocks.invoke.mockClear()

    const changelog = renderer!.root.findByType("a")
    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }
    await act(async () => {
      changelog.props.onClick(event)
    })

    expect(mocks.openUrl).toHaveBeenCalledWith(offer.changelogUrl)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(renderer!.root.findByProps({ "data-testid": "desktop-update-dialog" }))
      .toBeTruthy()
  })

  it.each([
    [false, true],
    [true, false],
  ])("does not mount the bridge when tauri=%s desktop=%s", async (tauri, desktop) => {
    mocks.tauri = tauri
    mocks.desktop = desktop
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DesktopUpdateDialog))
    })

    expect(renderer!.root.findAllByProps({ "data-testid": "desktop-update-dialog" }))
      .toHaveLength(0)
    expect(mocks.listen).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
