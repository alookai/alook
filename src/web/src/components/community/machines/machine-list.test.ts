import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  fetchLatestDaemonVersion: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

vi.mock("@/lib/api/client", () => ({
  apiFetch: mocks.apiFetch,
  getErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}))

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("dialog", props, children),
  AlertDialogContent: ({ children }: React.PropsWithChildren) =>
    React.createElement("section", {}, children),
  AlertDialogHeader: ({ children }: React.PropsWithChildren) =>
    React.createElement("header", {}, children),
  AlertDialogTitle: ({ children }: React.PropsWithChildren) =>
    React.createElement("h2", {}, children),
  AlertDialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement("p", {}, children),
  AlertDialogFooter: ({ children }: React.PropsWithChildren) =>
    React.createElement("footer", {}, children),
  AlertDialogAction: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", { ...props, "data-kind": "confirm" }, children),
  AlertDialogCancel: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", { ...props, "data-kind": "cancel" }, children),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}))

vi.mock("@/components/ui/button", () => ({ Button: () => null }))
vi.mock("@/components/ui/card", () => ({ Card: () => null }))
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }))
vi.mock("@/components/avatar", () => ({ GeneratedAvatar: () => null }))
vi.mock("./machine-card", () => ({ MachineCard: () => null }))
vi.mock("./pair-machine-sheet", () => ({ PairMachineSheet: () => null }))
vi.mock("@/components/community/onboarding-tiles/connect-tile", () => ({ ConnectTile: () => null }))
vi.mock("@/hooks/community/use-machines", () => ({ useMachines: () => ({ machines: [], isLoading: false }) }))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: [] }) }))
vi.mock("@/stores/community", () => ({
  usePendingMachineTokenId: () => null,
  useCommunityStore: { getState: () => ({ setPendingMachineTokenId: vi.fn() }) },
}))
vi.mock("@/lib/community-onboarding", () => ({
  advanceCommunityOnboarding: vi.fn(),
  readCommunityOnboardingState: vi.fn(() => null),
  startCommunityOnboarding: vi.fn(),
  updateCommunityOnboardingResources: vi.fn(),
  useCommunityOnboarding: () => "done",
}))
vi.mock("@/lib/api/config", () => ({
  fetchLatestDaemonVersion: mocks.fetchLatestDaemonVersion,
}))
vi.mock("@/lib/utils", () => ({ getAppMode: () => "production" }))

import type { CommunityMachineSummary } from "@alook/shared"
import {
  canUpdateMachine,
  MachineList,
  MachineUpdateDialog,
  requestMachineUpdate,
} from "./machine-list"

function machine(overrides: Partial<CommunityMachineSummary> = {}): CommunityMachineSummary {
  return {
    id: "machine-1",
    hostname: "Studio Mac",
    status: "online",
    daemonVersion: "0.1.7",
    availableRuntimes: [],
    ...overrides,
  } as CommunityMachineSummary
}

describe("machine daemon update UI", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    mocks.fetchLatestDaemonVersion.mockReset()
    mocks.fetchLatestDaemonVersion.mockResolvedValue({
      version: "0.1.8",
      package: "@alook/daemon",
    })
  })

  it("loads Community update eligibility from the daemon package endpoint", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(MachineList))
    })

    expect(mocks.fetchLatestDaemonVersion).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })

  it("allows every remote controller mode and hides Update only in dev", () => {
    for (const mode of ["production", "app", "desktop", "mobile"] as const) {
      expect(canUpdateMachine(machine(), "0.1.8", mode)).toBe(true)
    }
    expect(canUpdateMachine(machine(), "0.1.8", "dev")).toBe(false)
  })

  it("requires an online, outdated, supported daemon with a valid latest version", () => {
    expect(canUpdateMachine(machine({ status: "offline" }), "0.1.8", "production")).toBe(false)
    expect(canUpdateMachine(machine({ daemonVersion: "0.1.8" }), "0.1.8", "production")).toBe(false)
    expect(canUpdateMachine(machine({ daemonVersion: "0.1.6" }), "0.1.8", "production")).toBe(false)
    expect(canUpdateMachine(machine({ daemonVersion: "invalid" }), "0.1.8", "production")).toBe(false)
    expect(canUpdateMachine(machine(), "invalid", "production")).toBe(false)
  })

  it("cancels without dispatch and confirms exactly once", async () => {
    const onOpenChange = vi.fn()
    mocks.apiFetch.mockResolvedValue({ dispatched: true })
    const onConfirm = vi.fn((target: CommunityMachineSummary) =>
      requestMachineUpdate(target.id),
    )
    const target = machine()
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MachineUpdateDialog, {
          machine: target,
          onOpenChange,
          onConfirm,
        }),
      )
    })

    const cancel = renderer.root.findByProps({ "data-kind": "cancel" })
    const confirm = renderer.root.findByProps({ "data-kind": "confirm" })
    act(() => cancel.props.onClick())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(mocks.apiFetch).not.toHaveBeenCalled()

    await act(async () => {
      await confirm.props.onClick()
    })
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith(target)
    expect(mocks.apiFetch).toHaveBeenCalledOnce()
  })

  it("reports successful dispatch as requested, not completed", async () => {
    mocks.apiFetch.mockResolvedValue({ dispatched: true })

    await expect(requestMachineUpdate("machine-1")).resolves.toBe(true)

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/community/machines/machine-1/update",
      { method: "POST" },
    )
    expect(mocks.toastSuccess).toHaveBeenCalledOnce()
    const successMessage = String(mocks.toastSuccess.mock.calls[0]?.[0]).toLowerCase()
    expect(successMessage).not.toContain("completed")
    expect(successMessage).not.toContain("completion")
  })

  it("preserves the API error message", async () => {
    mocks.apiFetch.mockRejectedValue(new Error("Machine is offline"))

    await expect(requestMachineUpdate("machine-1")).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith("Machine is offline")
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
