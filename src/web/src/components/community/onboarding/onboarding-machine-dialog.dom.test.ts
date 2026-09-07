import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  refetch: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => ({ machines: [], isSuccess: true, refetch: mocks.refetch }),
}))
vi.mock("@/components/community/machines/pair-machine-sheet", () => ({
  buildPairCommand: (tokenId: string) => `pair ${tokenId}`,
  PairMachineSteps: vi.fn(() => null),
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: React.PropsWithChildren) => React.createElement("dialog", {}, children),
  DialogContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("section", props, children),
  DialogDescription: ({ children }: React.PropsWithChildren) => React.createElement("p", {}, children),
  DialogFooter: ({ children }: React.PropsWithChildren) => React.createElement("footer", {}, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement("header", {}, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement("h2", {}, children),
}))

import { OnboardingMachineDialog } from "./onboarding-machine-dialog"
import { PairMachineSteps } from "@/components/community/machines/pair-machine-sheet"

const mockedSteps = vi.mocked(PairMachineSteps)

describe("OnboardingMachineDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it("coalesces overlapping command generation attempts", async () => {
    let resolvePair!: (value: { tokenId: string; expiresAt: string }) => void
    mocks.apiFetch.mockReturnValue(new Promise((resolve) => {
      resolvePair = resolve
    }))

    render(React.createElement(OnboardingMachineDialog, {
      open: true,
      harness: "codex",
      harnessLabel: "Codex",
      onConnected: vi.fn(),
    }))

    act(() => mockedSteps.mock.calls.at(-1)![0].onRetry())
    expect(mocks.apiFetch).toHaveBeenCalledOnce()

    await act(async () => {
      resolvePair({ tokenId: "token-1", expiresAt: "soon" })
      await Promise.resolve()
    })
    expect(mockedSteps.mock.calls.at(-1)![0].command).toBe("pair token-1")
  })

  it("renders an offline preview command without minting a real pairing token", () => {
    render(React.createElement(OnboardingMachineDialog, {
      open: true,
      harness: "codex",
      harnessLabel: "Codex",
      onConnected: vi.fn(),
      previewCommand: "pair preview-token",
    }))

    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(mockedSteps.mock.calls.at(-1)![0]).toMatchObject({
      command: "pair preview-token",
      generating: false,
      connectedHostname: null,
    })
  })
})
