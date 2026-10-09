import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import type { CommunityMachineSummary } from "@alook/shared"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  refetch: vi.fn(),
  machines: [] as Pick<CommunityMachineSummary, "id" | "hostname" | "status" | "availableRuntimes">[],
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.apiFetch }))
vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => ({ machines: mocks.machines, isSuccess: true, refetch: mocks.refetch }),
}))
vi.mock("@/components/community/machines/pair-machine-sheet", () => ({
  buildPairCommand: (tokenId: string) => `pair ${tokenId}`,
  PairMachineSteps: vi.fn(() => null),
}))
vi.mock("@/components/ui/button", () => ({
  buttonVariants: () => "",
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: React.PropsWithChildren) => React.createElement("dialog", {}, children),
  DialogContent: ({ children, className }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("section", { className }, children),
  DialogDescription: ({ children }: React.PropsWithChildren) => React.createElement("p", {}, children),
  DialogFooter: ({ children }: React.PropsWithChildren) => React.createElement("footer", {}, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement("header", {}, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement("h2", {}, children),
}))

import { OnboardingMachineDialog } from "./onboarding-machine-dialog"
import { tid } from "@/lib/community/testids"
import { PairMachineSteps } from "@/components/community/machines/pair-machine-sheet"

const mockedSteps = vi.mocked(PairMachineSteps)

describe("OnboardingMachineDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.apiFetch.mockReset()
    mocks.machines = []
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  const props = () => ({
    open: true,
    harness: "codex",
    harnessLabel: "Codex",
    onConnected: vi.fn(),
    onChooseAnotherHarness: vi.fn(),
    onManageMachines: vi.fn(),
  })

  it("advances an already online matching machine once without pairing or clicking Continue", () => {
    mocks.machines = [{ id: "machine-1", hostname: "host", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] }]
    const input = props()
    const view = render(React.createElement(OnboardingMachineDialog, input))
    expect(input.onConnected).toHaveBeenCalledExactlyOnceWith("machine-1")
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    view.rerender(React.createElement(OnboardingMachineDialog, { ...input, onConnected: (id) => input.onConnected(id) }))
    expect(input.onConnected).toHaveBeenCalledOnce()
  })

  it("advances when an offline machine becomes online with the selected harness", () => {
    mocks.machines = [{ id: "machine-1", hostname: "host", status: "offline", availableRuntimes: [{ id: "codex", status: "healthy" }] }]
    mocks.apiFetch.mockReturnValue(new Promise(() => undefined))
    const input = props()
    const view = render(React.createElement(OnboardingMachineDialog, input))
    expect(input.onConnected).not.toHaveBeenCalled()
    mocks.machines = [{ ...mocks.machines[0], status: "online" }]
    view.rerender(React.createElement(OnboardingMachineDialog, input))
    expect(input.onConnected).toHaveBeenCalledExactlyOnceWith("machine-1")
  })

  it.each([
    { label: "wrong harness", availableRuntimes: [{ id: "claude-code", status: "healthy" as const }] },
    { label: "unhealthy harness", availableRuntimes: [{ id: "codex", status: "unhealthy" as const, lastError: "ENOENT" }] },
    { label: "missing harness", availableRuntimes: [] },
  ])("waits when the online machine has a $label", ({ availableRuntimes }) => {
    mocks.machines = [{ id: "machine-1", hostname: "host", status: "online", availableRuntimes }]
    mocks.apiFetch.mockReturnValue(new Promise(() => undefined))
    const input = props()
    const view = render(React.createElement(OnboardingMachineDialog, input))
    expect(input.onConnected).not.toHaveBeenCalled()
    expect(view.getByTestId(tid.onboardingRuntimeUnavailable)).toHaveTextContent("Computer is connected")
    expect(view.getByTestId(tid.onboardingRuntimeUnavailable)).toHaveTextContent("Codex isn’t ready")
    expect(view.getByTestId(tid.onboardingRuntimeUnavailable)).toHaveTextContent("restart the Alook daemon")
    const support = view.getByTestId(tid.onboardingJoinSupport)
    expect(support).toHaveAccessibleName("Need Help")
    expect(view.getByTestId(tid.onboardingRuntimeUnavailable)).toHaveTextContent(
      availableRuntimes.find((runtime) => runtime.id === "codex")?.lastError || "The selected agent wasn’t detected as available.",
    )
    expect(mockedSteps).not.toHaveBeenCalled()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(view.getByRole("button", { name: "Continue", hidden: true })).toBeDisabled()
    fireEvent.click(view.getByTestId(tid.onboardingChooseHarness))
    expect(input.onChooseAnotherHarness).toHaveBeenCalledOnce()
  })

  it("advances once when an unavailable runtime becomes healthy", () => {
    mocks.machines = [{ id: "machine-1", hostname: "host", status: "online", availableRuntimes: [{ id: "codex", status: "unhealthy" }] }]
    const input = props()
    const view = render(React.createElement(OnboardingMachineDialog, input))
    expect(view.getByTestId(tid.onboardingRuntimeUnavailable)).toBeInTheDocument()
    mocks.machines = [{ ...mocks.machines[0], availableRuntimes: [{ id: "codex", status: "healthy" }] }]
    view.rerender(React.createElement(OnboardingMachineDialog, input))
    expect(view.queryByTestId(tid.onboardingRuntimeUnavailable)).not.toBeInTheDocument()
    expect(input.onConnected).toHaveBeenCalledExactlyOnceWith("machine-1")
    view.rerender(React.createElement(OnboardingMachineDialog, input))
    expect(input.onConnected).toHaveBeenCalledOnce()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it("uses a matching machine even if the first online machine has no usable runtime", () => {
    mocks.machines = [
      { id: "other", hostname: "other", status: "online", availableRuntimes: [] },
      { id: "matching", hostname: "ready", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] },
    ]
    const input = props()
    const view = render(React.createElement(OnboardingMachineDialog, input))
    expect(input.onConnected).toHaveBeenCalledExactlyOnceWith("matching")
    expect(view.queryByTestId(tid.onboardingRuntimeUnavailable)).not.toBeInTheDocument()
    expect(mockedSteps.mock.calls.at(-1)![0].connectedHostname).toBe("ready")
  })

  it("joins Support directly and opens the joined server without leaving setup", async () => {
    mocks.machines = [{ id: "machine-1", hostname: "host", status: "online", availableRuntimes: [] }]
    let resolveJoin!: (value: { serverId: string }) => void
    mocks.apiFetch.mockReturnValue(new Promise((resolve) => { resolveJoin = resolve }))
    const input = props()
    const view = render(React.createElement(OnboardingMachineDialog, input))
    fireEvent.click(view.getByTestId(tid.onboardingJoinSupport))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(mocks.apiFetch).toHaveBeenCalledOnce()
    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/community/invites/nC7ax53lwm/join", expect.objectContaining({ method: "POST" }))
    expect(view.getByTestId(tid.onboardingJoinSupport)).toBeDisabled()
    await act(async () => { resolveJoin({ serverId: "support" }); await vi.advanceTimersByTimeAsync(0) })
    expect(view.getByTestId(tid.onboardingOpenSupport)).toHaveAttribute("href", "/c/channels/support")
    expect(view.getByTestId(tid.onboardingOpenSupport)).toHaveAttribute("target", "_blank")
    expect(view.getByTestId(tid.onboardingRuntimeUnavailable)).toBeInTheDocument()
    expect(input.onConnected).not.toHaveBeenCalled()
    expect(input.onManageMachines).not.toHaveBeenCalled()
  })

  it("shows a failed Support join and lets the user retry", async () => {
    mocks.machines = [{ id: "machine-1", hostname: "host", status: "online", availableRuntimes: [] }]
    mocks.apiFetch.mockRejectedValueOnce(new Error("INVITE_EXPIRED")).mockResolvedValueOnce({ serverId: "support" })
    const view = render(React.createElement(OnboardingMachineDialog, props()))
    fireEvent.click(view.getByTestId(tid.onboardingJoinSupport))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(view.getByRole("alert", { hidden: true })).toHaveTextContent("Couldn’t join Alook Support")
    expect(view.getByTestId(tid.onboardingJoinSupport)).toBeEnabled()
    fireEvent.click(view.getByTestId(tid.onboardingJoinSupport))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(view.getByTestId(tid.onboardingOpenSupport)).toBeInTheDocument()
    expect(view.queryByRole("alert", { hidden: true })).not.toBeInTheDocument()
  })

  it("does not advance a closed dialog but advances when opened", () => {
    mocks.machines = [{ id: "machine-1", hostname: "host", status: "online", availableRuntimes: [{ id: "codex", status: "healthy" }] }]
    const input = props()
    const view = render(React.createElement(OnboardingMachineDialog, { ...input, open: false }))
    expect(input.onConnected).not.toHaveBeenCalled()
    view.rerender(React.createElement(OnboardingMachineDialog, input))
    expect(input.onConnected).toHaveBeenCalledExactlyOnceWith("machine-1")
  })

  it("automatically advances online preview without creating a pairing token", () => {
    const input = props()
    render(React.createElement(OnboardingMachineDialog, { ...input, previewConnectedMachine: { id: "preview-machine", hostname: "Preview" } }))
    expect(input.onConnected).toHaveBeenCalledExactlyOnceWith("preview-machine")
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

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
      onChooseAnotherHarness: vi.fn(),
      onManageMachines: vi.fn(),
    }))

    act(() => mockedSteps.mock.calls.at(-1)![0].onRetry())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(mocks.apiFetch).toHaveBeenCalledOnce()

    await act(async () => {
      resolvePair({ tokenId: "token-1", expiresAt: "soon" })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockedSteps.mock.calls.at(-1)![0].command).toBe("pair token-1")
  })

  it("renders an offline preview command without minting a real pairing token", () => {
    render(React.createElement(OnboardingMachineDialog, {
      open: true,
      harness: "codex",
      harnessLabel: "Codex",
      onConnected: vi.fn(),
      onChooseAnotherHarness: vi.fn(),
      onManageMachines: vi.fn(),
      previewCommand: "pair preview-token",
    }))

    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(mockedSteps.mock.calls.at(-1)![0]).toMatchObject({
      command: "pair preview-token",
      generating: false,
      connectedHostname: null,
    })
  })

  it("turns a machine limit rejection into explicit recovery actions", async () => {
    const onChooseAnotherHarness = vi.fn()
    const onManageMachines = vi.fn()
    mocks.apiFetch.mockRejectedValue(new Error("MACHINE_LIMIT_REACHED"))

    const view = render(React.createElement(OnboardingMachineDialog, {
      open: true,
      harness: "codex",
      harnessLabel: "Codex",
      onConnected: vi.fn(),
      onChooseAnotherHarness,
      onManageMachines,
    }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(view.getByRole("alert", { hidden: true })).toHaveTextContent("Machine limit reached")
    expect(view.getByRole("alert", { hidden: true })).not.toHaveTextContent("Couldn’t prepare the command")
    expect(mocks.refetch).toHaveBeenCalledOnce()

    fireEvent.click(view.getByRole("button", { name: "Choose another harness", hidden: true }))
    fireEvent.click(view.getByRole("button", { name: "Manage machines", hidden: true }))
    expect(onChooseAnotherHarness).toHaveBeenCalledOnce()
    expect(onManageMachines).toHaveBeenCalledOnce()
  })
})
