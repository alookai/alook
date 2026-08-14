import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@alook/shared", () => ({
  isDesktop: () => true,
  isTauri: mocks.isTauri,
  tauriInvoke: mocks.invoke,
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

vi.mock("@/lib/api/client", () => ({
  apiFetch: mocks.apiFetch,
  toastApiError: vi.fn(),
}))

vi.mock("@/lib/utils", () => ({
  isLocalMode: () => false,
  WS_DO_PORT_DEFAULT: 8788,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}))

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: React.PropsWithChildren) => React.createElement("div", {}, children),
  SheetContent: ({ children }: React.PropsWithChildren) => React.createElement("div", {}, children),
  SheetHeader: ({ children }: React.PropsWithChildren) => React.createElement("header", {}, children),
  SheetTitle: ({ children }: React.PropsWithChildren) => React.createElement("h2", {}, children),
  SheetDescription: ({ children }: React.PropsWithChildren) => React.createElement("p", {}, children),
  SheetBody: ({ children }: React.PropsWithChildren) => React.createElement("main", {}, children),
  SheetFooter: ({ children }: React.PropsWithChildren) => React.createElement("footer", {}, children),
  SheetClose: () => null,
}))

import { PairMachineSheet, PairMachineSteps } from "./pair-machine-sheet"
import { tid } from "@/lib/community/testids"

describe("PairMachineSheet desktop daemon integration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("location", { origin: "https://alook.ai" })
    mocks.isTauri.mockReturnValue(true)
    mocks.apiFetch.mockResolvedValue({ tokenId: "cmt_generated", expiresAt: "soon" })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "daemon_runtime_capability") {
        return Promise.resolve({ available: true, reason: null, nodeVersion: "v22.12.0" })
      }
      return Promise.resolve({ success: true, message: "Daemon paired and started" })
    })
  })

  it("probes and pairs once through Tauri while retaining the command fallback", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PairMachineSheet, {
        open: true,
        onOpenChange: vi.fn(),
        pendingTokenId: "cmt_desktop_token",
        setPendingTokenId: vi.fn(),
        connectedHostname: null,
      }))
    })

    const connect = renderer.root.findByProps({ "data-testid": tid.machinePairDesktopConnect })
    await act(async () => {
      await connect.props.onClick()
    })

    expect(mocks.invoke).toHaveBeenCalledWith("daemon_runtime_capability")
    expect(mocks.invoke).toHaveBeenCalledWith("daemon_pair", {
      machineKey: "cmt_desktop_token",
    })
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "daemon_pair")).toHaveLength(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith("This computer is connecting")
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairDesktopConnect }).props.disabled).toBe(true)
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairCommand }).children.join(""))
      .toContain("@alook/daemon")
  })

  it("surfaces a daemon launch error without removing command and copy fallback", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "daemon_runtime_capability") {
        return Promise.resolve({ available: true, reason: null, nodeVersion: "v22.12.0" })
      }
      return Promise.resolve({ success: false, message: "The daemon couldn't start" })
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PairMachineSheet, {
        open: true,
        onOpenChange: vi.fn(),
        pendingTokenId: "cmt_desktop_token",
        setPendingTokenId: vi.fn(),
        connectedHostname: null,
      }))
    })

    await act(async () => {
      await renderer.root.findByProps({ "data-testid": tid.machinePairDesktopConnect }).props.onClick()
    })

    expect(mocks.toastError).toHaveBeenCalledWith("The daemon couldn't start")
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairRuntimeHint }).children.join(""))
      .toContain("terminal command remains available")
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairCopy })).toBeTruthy()
  })

  it("keeps the command fallback and explains an unavailable Desktop runtime", async () => {
    mocks.invoke.mockResolvedValue({
      available: false,
      reason: "Node.js v20.8.0 is too old. Install Node.js 20.9 or newer.",
      nodeVersion: "v20.8.0",
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PairMachineSheet, {
        open: true,
        onOpenChange: vi.fn(),
        pendingTokenId: "cmt_desktop_token",
        setPendingTokenId: vi.fn(),
        connectedHostname: null,
      }))
    })

    expect(renderer.root.findAllByProps({ "data-testid": tid.machinePairDesktopConnect })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairRuntimeHint }).children.join(""))
      .toContain("20.9 or newer")
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairCommand })).toBeTruthy()
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairCopy })).toBeTruthy()
  })

  it("never invokes native commands in a normal browser", async () => {
    mocks.isTauri.mockReturnValue(false)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PairMachineSheet, {
        open: true,
        onOpenChange: vi.fn(),
        pendingTokenId: "cmt_browser_token",
        setPendingTokenId: vi.fn(),
        connectedHostname: null,
      }))
    })

    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairCommand })).toBeTruthy()
    expect(renderer.root.findByProps({ "data-testid": tid.machinePairCopy })).toBeTruthy()
    expect(renderer.root.findAllByProps({ "data-testid": tid.machinePairDesktopConnect })).toHaveLength(0)
  })

  it("keeps the command copy surface in the reusable browser steps", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(PairMachineSteps, {
        command: "npx @alook/daemon daemon start",
        generating: false,
        onCopy: vi.fn(),
        connectedHostname: null,
      }))
    })

    expect(renderer.root.findByProps({ "data-testid": tid.machinePairCommand }).children.join(""))
      .toContain("@alook/daemon")
    expect(renderer.root.findAllByProps({ "data-testid": tid.machinePairDesktopConnect })).toHaveLength(0)
  })
})
