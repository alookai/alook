import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, waitFor } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  isLocalServiceEnvironment: vi.fn(() => false),
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
  isLocalServiceEnvironment: mocks.isLocalServiceEnvironment,
  WS_DO_PORT_DEFAULT: 8788,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}))

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({ children, footer }: {
    children?: React.ReactNode
    footer?: React.ReactNode | ((requestClose: () => void) => React.ReactNode)
  }) => React.createElement(
    "div",
    {},
    children,
    typeof footer === "function" ? footer(vi.fn()) : footer,
  ),
}))

import { PairMachineSheet, PairMachineSteps } from "./pair-machine-sheet"
import { tid } from "@/lib/community/testids"

describe("PairMachineSheet desktop daemon integration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("location", { origin: "https://alook.ai" })
    mocks.isTauri.mockReturnValue(true)
    mocks.isLocalServiceEnvironment.mockReturnValue(false)
    mocks.apiFetch.mockResolvedValue({ tokenId: "cmt_generated", expiresAt: "soon" })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "daemon_runtime_capability") {
        return Promise.resolve({ available: true, reason: null, nodeVersion: "v22.12.0" })
      }
      return Promise.resolve({ success: true, message: "Daemon paired and started" })
    })
  })

  it("probes and pairs once through Tauri while retaining the command fallback", async () => {
    const renderer = render(React.createElement(PairMachineSheet, {
      open: true,
      onOpenChange: vi.fn(),
      pendingTokenId: "cmt_desktop_token",
      setPendingTokenId: vi.fn(),
      connectedHostname: null,
    }))

    const connect = await renderer.findByTestId(tid.machinePairDesktopConnect)
    fireEvent.click(connect)

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("daemon_pair", {
      machineKey: "cmt_desktop_token",
      machineId: null,
    }))
    expect(mocks.invoke).toHaveBeenCalledWith("daemon_runtime_capability")
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "daemon_pair")).toHaveLength(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith("This computer is connecting")
    expect(renderer.getByTestId(tid.machinePairDesktopConnect)).toBeDisabled()
    const command = (await renderer.findByTestId(tid.machinePairCommand)).textContent ?? ""
    expect(command).toContain("npx --yes @alook/daemon@latest daemon start")
    expect(command).toContain("--machine-key cmt_desktop_token")
    expect(command).not.toContain("npm exec --yes --package=@alook/daemon@latest -- alook-daemon")
    expect(command).not.toContain("--server-url")
    expect(command).not.toContain("--ws-url")
  })

  it("uses the short exact-machine reconnect command in terminal and native paths", async () => {
    const renderer = render(React.createElement(PairMachineSheet, {
      open: true,
      onOpenChange: vi.fn(),
      pendingTokenId: "cmt_reconnect_token",
      setPendingTokenId: vi.fn(),
      connectedHostname: null,
      mode: { kind: "reconnect", machineId: "cm_abcdefgh", hostname: "host" },
    }))

    const command = (await renderer.findByTestId(tid.machinePairCommand)).textContent ?? ""
    expect(command).toContain("npx --yes @alook/daemon@latest daemon reconnect")
    expect(command).toContain("--id cm_abcdefgh --machine-key cmt_reconnect_token")
    expect(command).not.toContain("--server-url")
    expect(command).not.toContain("--ws-url")

    fireEvent.click(await renderer.findByTestId(tid.machinePairDesktopConnect))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("daemon_pair", {
      machineKey: "cmt_reconnect_token",
      machineId: "cm_abcdefgh",
    }))
  })

  it("surfaces a daemon launch error without removing command and copy fallback", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "daemon_runtime_capability") {
        return Promise.resolve({ available: true, reason: null, nodeVersion: "v22.12.0" })
      }
      return Promise.resolve({ success: false, message: "The daemon couldn't start" })
    })
    const renderer = render(React.createElement(PairMachineSheet, {
      open: true,
      onOpenChange: vi.fn(),
      pendingTokenId: "cmt_desktop_token",
      setPendingTokenId: vi.fn(),
      connectedHostname: null,
    }))

    fireEvent.click(await renderer.findByTestId(tid.machinePairDesktopConnect))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("The daemon couldn't start"))
    expect(renderer.getByTestId(tid.machinePairRuntimeHint).textContent)
      .toContain("terminal command remains available")
    expect(renderer.getByTestId(tid.machinePairCopy)).toBeInTheDocument()
  })

  it("surfaces a native string rejection without removing the fallback", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "daemon_runtime_capability") {
        return Promise.resolve({ available: true, reason: null, nodeVersion: "v16.0.0" })
      }
      return Promise.reject("Node.js 20.9 or newer is required by @alook/daemon")
    })
    const renderer = render(React.createElement(PairMachineSheet, {
      open: true,
      onOpenChange: vi.fn(),
      pendingTokenId: "cmt_desktop_token",
      setPendingTokenId: vi.fn(),
      connectedHostname: null,
    }))

    fireEvent.click(await renderer.findByTestId(tid.machinePairDesktopConnect))

    await waitFor(() => expect(mocks.toastError)
      .toHaveBeenCalledWith("Node.js 20.9 or newer is required by @alook/daemon"))
    expect(renderer.getByTestId(tid.machinePairRuntimeHint).textContent)
      .toContain("Node.js 20.9 or newer is required by @alook/daemon")
    expect(renderer.getByTestId(tid.machinePairCopy)).toBeInTheDocument()
  })

  it("keeps the command fallback and explains an unavailable Desktop runtime", async () => {
    mocks.invoke.mockResolvedValue({
      available: false,
      reason: "npm was not found. Install npm with Node.js and try again.",
      nodeVersion: "v16.0.0",
    })
    const renderer = render(React.createElement(PairMachineSheet, {
      open: true,
      onOpenChange: vi.fn(),
      pendingTokenId: "cmt_desktop_token",
      setPendingTokenId: vi.fn(),
      connectedHostname: null,
    }))

    await waitFor(() => expect(renderer.queryAllByTestId(tid.machinePairDesktopConnect)).toHaveLength(0))
    expect(renderer.getByTestId(tid.machinePairRuntimeHint).textContent)
      .toContain("npm was not found")
    expect(await renderer.findByTestId(tid.machinePairCommand)).toBeInTheDocument()
    expect(renderer.getByTestId(tid.machinePairCopy)).toBeInTheDocument()
  })

  it("never invokes native commands in a normal browser", async () => {
    mocks.isTauri.mockReturnValue(false)
    const renderer = render(React.createElement(PairMachineSheet, {
      open: true,
      onOpenChange: vi.fn(),
      pendingTokenId: "cmt_browser_token",
      setPendingTokenId: vi.fn(),
      connectedHostname: null,
    }))

    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(await renderer.findByTestId(tid.machinePairCommand)).toBeInTheDocument()
    expect(renderer.getByTestId(tid.machinePairCopy)).toBeInTheDocument()
    expect(renderer.queryAllByTestId(tid.machinePairDesktopConnect)).toHaveLength(0)
  })

  it("keeps the command copy surface in the reusable browser steps", () => {
    const renderer = render(React.createElement(PairMachineSteps, {
      command: "npx --yes @alook/daemon@latest daemon start",
      generating: false,
      onCopy: vi.fn(),
      connectedHostname: null,
    }))

    expect(renderer.getByTestId(tid.machinePairCommand).textContent)
      .toContain("@alook/daemon")
    expect(renderer.queryAllByTestId(tid.machinePairDesktopConnect)).toHaveLength(0)
  })

  it("exposes a canonical retry control when command generation fails", () => {
    const renderer = render(React.createElement(PairMachineSteps, {
      command: "",
      generating: false,
      generationError: "Couldn’t prepare the command. Try again.",
      onRetry: vi.fn(),
      onCopy: vi.fn(),
      connectedHostname: null,
    }))

    expect(renderer.getByTestId(tid.machinePairRetry)).toBeInTheDocument()
  })

  it("keeps explicit endpoints only for local development", async () => {
    mocks.isLocalServiceEnvironment.mockReturnValue(true)
    vi.stubGlobal("location", { origin: "http://localhost:3000" })

    const renderer = render(React.createElement(PairMachineSheet, {
      open: true,
      onOpenChange: vi.fn(),
      pendingTokenId: "cmt_local_token",
      setPendingTokenId: vi.fn(),
      connectedHostname: null,
    }))

    const command = (await renderer.findByTestId(tid.machinePairCommand)).textContent ?? ""
    expect(command).toContain("pnpm daemon start --machine-key cmt_local_token")
    expect(command).toContain("--server-url http://localhost:3000")
    expect(command).toContain("--ws-url ws://localhost:8788/api/ws/community-daemon")
  })
})
