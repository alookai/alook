import React from "react"
import { useCommunityNavigationController } from "@/components/community/shell/use-community-navigation-controller"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { renderToString } from "react-dom/server"
import { render as renderNative } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import MeMachinesPage from "@/app/c/me/machines/page"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  pathname: "/c/me/machines",
  goBackMobile: vi.fn(),
  query: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  fetchLatestDaemonVersion: vi.fn(),
  machinesLoading: { current: false },
  capacityPending: { current: false },
  machinesError: { current: false },
  retryMachines: vi.fn(),
  capacity: { current: { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 0, onlineCount: 0 } },
  machines: { current: [] as unknown[] },
  onboardingState: { current: "done" as unknown },
  guideMotion: vi.fn(),
  startOnboarding: vi.fn(),
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
  AlertDialog: ({ children }: React.PropsWithChildren) =>
    React.createElement("div", {}, children),
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
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, children),
}))
vi.mock("@/components/ui/card", () => ({ Card: () => null }))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => React.createElement("skeleton-row", props),
}))
vi.mock("@/components/avatar", () => ({ GeneratedAvatar: () => null }))
vi.mock("./guide-me-avatar-motion", () => ({
  GuideMeAvatarMotion: (props: { intro: boolean; onIntroComplete: () => void; seed: string }) => {
    mocks.guideMotion(props)
    return React.createElement("button", {
      "data-guide-avatar-motion": "true",
      "data-intro": String(props.intro),
      onClick: props.onIntroComplete,
    })
  },
}))
vi.mock("./machine-card", () => ({
  MachineCard: () => null,
  MachineCardFrame: ({ children }: React.PropsWithChildren) =>
    React.createElement("machine-card-frame", {}, children),
}))
vi.mock("./pair-machine-sheet", () => ({ PairMachineSheet: ({ open, onLimitReached }: { open: boolean; onLimitReached: () => void }) => open ? React.createElement("button", { "data-testid": "test-pair-sheet", onClick: onLimitReached }, "Simulate server limit") : null }))
vi.mock("@/components/community/onboarding-tiles/connect-tile", () => ({ ConnectTile: () => null }))
vi.mock("@/hooks/community/use-machines", async (importOriginal) => ({ ...await importOriginal<typeof import("@/hooks/community/use-machines")>(),
  machinesQueryFn: mocks.query,
  useMachines: () => ({ machines: mocks.machines.current, isLoading: mocks.machinesLoading.current, isPending: mocks.machinesLoading.current, isError: mocks.machinesError.current, isFetching: false, capacityPending: mocks.capacityPending.current, refetch: mocks.retryMachines, data: mocks.machinesError.current ? undefined : { machineCapacity: mocks.capacityPending.current ? undefined : mocks.capacity.current } }),
}))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: [] }) }))
vi.mock("@/stores/community", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community")>(),
  usePendingMachineTokenId: () => null,
  useUiHandlers: () => ({ goBackMobile: mocks.goBackMobile }),
  useCommunityStore: { getState: () => ({ setPendingMachineTokenId: vi.fn() }) },
}))
vi.mock("@/lib/community-onboarding", () => ({
  advanceCommunityOnboarding: vi.fn(),
  readCommunityOnboardingState: vi.fn(() => null),
  startCommunityOnboarding: mocks.startOnboarding,
  updateCommunityOnboardingResources: vi.fn(),
  useCommunityOnboarding: () => mocks.onboardingState.current,
}))
vi.mock("@/lib/api/config", () => ({
  fetchLatestDaemonVersion: mocks.fetchLatestDaemonVersion,
}))
vi.mock("@/lib/utils", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/utils")>(), getAppMode: () => "production" }))

import type { CommunityMachineSummary } from "@alook/shared"
import { tid } from "@/lib/community/testids"
import {
  canUpdateMachine,
  MachineList,
  MachineListSkeleton,
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

function withExactClass(container: HTMLElement, className: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("*"))
    .filter((node) => node.className === className)
}

describe("SSR mobile Back footprint", () => {
  it("keeps reconnect and URL cleanup dormant until the target is committed", () => {
    mocks.machines.current = [machine()]
    mocks.machinesLoading.current = false
    mocks.machinesError.current = false
    mocks.capacityPending.current = false
    mocks.replace.mockClear()
    const node = (routeCommitted: boolean) => React.createElement(CommunityModuleRouteContext, {value: {href: "/c/me/machines?reconnect=machine-1&keep=1", routeCommitted}}, React.createElement(MeMachinesPage))
    const view = render(node(false))
    expect(view.queryByTestId("test-pair-sheet")).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    view.rerender(node(true))
    expect(view.getByTestId("test-pair-sheet")).toBeVisible()
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me/machines?keep=1")
  })

  it.each([false, true])("keeps the existing mobile header through hydrate with loading=%s", async loading => {
    mocks.machines.current = []
    mocks.machinesLoading.current = loading
    mocks.machinesError.current = false
    mocks.capacityPending.current = false
    mocks.fetchLatestDaemonVersion.mockResolvedValue(null)
    mocks.goBackMobile.mockClear()
    const owner = await createCommunityQueryOwner()
    const node = React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, React.createElement(MeMachinesPage))
    const container = document.createElement("div")
    container.innerHTML = renderToString(node)
    document.body.appendChild(container)
    let view: ReturnType<typeof renderNative> | undefined
    try {
      const header = container.firstElementChild?.querySelector("header")
      expect(header).not.toBeNull()
      expect(header?.classList.contains("h-12")).toBe(true)
      expect(header?.classList.contains("sm:hidden")).toBe(true)
      expect(header?.querySelectorAll(loading ? '[data-slot="loading-back-placeholder"]' : '[aria-label="Back"]')).toHaveLength(1)
      view = renderNative(node, { container, hydrate: true })
      await act(async () => { await Promise.resolve() })
      expect(container.firstElementChild?.querySelector("header")).toBe(header)
      if (!loading) {
        fireEvent.click(header!.querySelector('[aria-label="Back"]')!)
        expect(mocks.goBackMobile).toHaveBeenCalledOnce()
      }
    } finally { view?.unmount(); container.remove(); owner.client.clear() }
  })
})

describe("machine daemon update UI", () => {
  beforeEach(() => {
    mocks.capacity.current = { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 0, onlineCount: 0 }
    mocks.apiFetch.mockReset()
    mocks.query.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    mocks.fetchLatestDaemonVersion.mockReset()
    mocks.startOnboarding.mockReset()
    mocks.fetchLatestDaemonVersion.mockResolvedValue({
      version: "0.1.8",
      package: "@alook/daemon",
    })
    mocks.capacityPending.current = false
    mocks.machinesLoading.current = false
    mocks.machinesError.current = false
    mocks.machines.current = []
    mocks.onboardingState.current = "done"
  })

  it("publishes a pending View plan click through the latest navigation owner", () => {
    mocks.pathname = "/c/channels/source/channel"
    mocks.machines.current = [machine({status: "offline"})]
    mocks.capacity.current = {plan: {id: "free", displayName: "Free"}, isFounder: false, limit: 1, ownedCount: 1, onlineCount: 0}
    const frame = {...normalizeCommunityHref(mocks.pathname), revision: 0}
    let navigation!: ReturnType<typeof useCommunityNavigationController>
    function Scenario() {
      const currentNavigation = useCommunityNavigationController(frame)
      React.useLayoutEffect(() => { navigation = currentNavigation }, [currentNavigation])
      return React.createElement(CommunityRouteContext, {value: {frame, navigation: currentNavigation, breakpoint: "desktop", ownerDeleteRouteScope: undefined}},
        React.createElement(CommunityModuleRouteContext, {value: {href: currentNavigation.pendingHref ?? "/c/me/machines?keep=1", routeCommitted: false}}, React.createElement(MachineList)))
    }
    const view = render(React.createElement(Scenario))
    act(() => navigation.pushImmediate("/c/me/machines?keep=1"))
    const oldIntent = navigation.captureIntent()
    fireEvent.click(view.getByRole("button", {name: "Connect a machine"}))
    fireEvent.click(view.getByRole("button", {name: "View plan"}))
    expect(navigation.pendingHref).toBe("/c/me/machines?keep=1&settings=billing")
    expect(oldIntent()).toBe(false)
  })

  it("shows Retry when the list is unknown rather than claiming no machines exist", () => {
    mocks.machinesError.current = true
    const view = render(React.createElement(MachineList))
    expect(view.container.textContent).not.toContain("No machines yet")
    fireEvent.click(view.getByRole("button", { name: "Retry" }))
    expect(mocks.retryMachines).toHaveBeenCalledOnce()
  })

  it("blocks adding at the owned cap even when every machine is offline", async () => {
    mocks.machines.current = [machine({ status: "offline" })]
    mocks.capacity.current = { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 1, onlineCount: 0 }
    const view = render(React.createElement(MachineList))
    fireEvent.click(view.getByRole("button", { name: "Connect a machine" }))
    expect(await view.findByText("Machine limit reached")).toBeInTheDocument()
    expect(view.queryByTestId("test-pair-sheet")).not.toBeInTheDocument()
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    window.history.replaceState(null, "", "/c/me/machines?keep=1")
    fireEvent.click(view.getByRole("button", { name: "View plan" }))
    expect(window.location.search).toBe("?keep=1&settings=billing")
  })

  it("waits for the initial allowance before the Connect action becomes available", () => {
    mocks.capacityPending.current = true
    const view = render(React.createElement(MachineList))
    const action = view.getByRole("button", { name: "Connect a machine" })
    expect(action).toBeDisabled()
    fireEvent.click(action)
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(view.queryByTestId("test-pair-sheet")).not.toBeInTheDocument()
    mocks.capacityPending.current = false
    view.rerender(React.createElement(MachineList))
    expect(action).toBeEnabled()
    fireEvent.click(action)
    expect(view.getByTestId("test-pair-sheet")).toBeInTheDocument()
  })

  it("opens pairing when there is room", () => {
    mocks.machines.current = []
    const view = render(React.createElement(MachineList))
    fireEvent.click(view.getByRole("button", { name: "Connect a machine" }))
    expect(view.getByTestId("test-pair-sheet")).toBeInTheDocument()
    expect(view.queryByText("Machine limit reached")).not.toBeInTheDocument()
  })

  it("refreshes the allowance before showing a server rejection", async () => {
    mocks.query.mockImplementation(async () => {
      mocks.capacity.current = { ...mocks.capacity.current, limit: 5, ownedCount: 5 }
      return { machines: mocks.machines.current, machineCapacity: mocks.capacity.current }
    })
    const view = render(React.createElement(MachineList))
    fireEvent.click(view.getByRole("button", { name: "Connect a machine" }))
    fireEvent.click(view.getByText("Simulate server limit"))
    expect(await view.findByText(/Your plan allows 5 machines/)).toBeInTheDocument()
    expect(mocks.query).toHaveBeenCalledOnce()
    expect(view.queryByTestId("test-pair-sheet")).not.toBeInTheDocument()
  })

  it("keeps a failed allowance refresh out of the limit dialog", async () => {
    mocks.query.mockRejectedValue(new Error("unavailable"))
    const view = render(React.createElement(MachineList))
    fireEvent.click(view.getByRole("button", { name: "Connect a machine" }))
    fireEvent.click(view.getByText("Simulate server limit"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Couldn’t refresh your machine allowance. Refresh and try again."))
    expect(view.queryByText("Machine limit reached")).not.toBeInTheDocument()
  })

  it("plays the guide once per empty-page mount and replays after remount", async () => {
    mocks.onboardingState.current = null

    let renderer = render(React.createElement(MachineList))

    const firstVisit = renderer.container.querySelector('[data-guide-avatar-motion="true"]')!
    expect(firstVisit).toHaveAttribute("data-intro", "true")
    expect(mocks.guideMotion.mock.calls.at(-1)?.[0].seed).toMatch(/^alook-guide-/)

    fireEvent.click(firstVisit)
    expect(renderer.container.querySelector('[data-guide-avatar-motion="true"]'))
      .toHaveAttribute("data-intro", "false")

    renderer.unmount()
    renderer = render(React.createElement(MachineList))
    expect(renderer.container.querySelector('[data-guide-avatar-motion="true"]'))
      .toHaveAttribute("data-intro", "true")
  })

  it("exposes a canonical start control for the first onboarding flow", async () => {
    const renderer = render(React.createElement(MachineList))

    expect(renderer.getByTestId(tid.onboardingStart)).toBeInTheDocument()
  })

  it("keeps the Machines Guide me action wired to manual onboarding", () => {
    const renderer = render(React.createElement(MachineList))

    fireEvent.click(renderer.getByTestId(tid.onboardingStart))

    expect(mocks.startOnboarding).toHaveBeenCalledOnce()
    expect(mocks.startOnboarding).toHaveBeenCalledWith(expect.objectContaining({ ui: expect.any(Object), lifecycle: expect.any(Object) }), { guideAvatarSeed: expect.any(String) })
  })

  it("loads Community update eligibility from the daemon package endpoint", async () => {
    render(React.createElement(MachineList))

    await waitFor(() => expect(mocks.fetchLatestDaemonVersion).toHaveBeenCalledOnce())
  })

  it("keeps the loaded page header, action, card group, and scroll owner while loading", async () => {
    mocks.machinesLoading.current = true
    const renderer = render(React.createElement(MachineList))
    await act(async () => {
      await mocks.fetchLatestDaemonVersion.mock.results[0]?.value
    })

    expect(withExactClass(renderer.container,
      "flex flex-1 flex-col gap-6 overflow-y-auto p-6 thin-scrollbar")).toHaveLength(1)
    expect(withExactClass(renderer.container,
      "flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between"))
      .toHaveLength(1)
    expect(withExactClass(renderer.container, "flex min-w-0 flex-col gap-1")).toHaveLength(1)
    expect(withExactClass(renderer.container, "w-full sm:w-fit sm:shrink-0")).toHaveLength(1)
    expect(withExactClass(renderer.container, "flex flex-col gap-3")).toHaveLength(1)
    expect(withExactClass(renderer.container,
      "h-11 w-full rounded-md sm:h-9 sm:w-36")).toHaveLength(1)
  })

  it("uses the same responsive header footprint after Machines load", async () => {
    mocks.machines.current = [machine()]
    const renderer = render(React.createElement(MachineList))

    const heading = renderer.container.querySelector('[data-slot="community-machines-heading"]')!
    expect(heading.className).toBe(
      "flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between",
    )
    expect(renderer.container.querySelector('[data-slot="community-machines-heading-copy"]')?.className)
      .toBe("flex min-w-0 flex-col gap-1")
    expect(renderer.container.querySelector('[data-slot="community-machines-heading-action"]')?.className)
      .toBe("w-full sm:w-fit sm:shrink-0")
    expect(renderer.getByTestId(tid.machinePairOpen).className)
      .toBe("min-h-11 w-full sm:min-h-9 sm:w-auto")
  })

  it("turns a loading Back request into an inert skeleton slot", () => {
    const renderer = render(React.createElement(MachineListSkeleton, { onBack: vi.fn() }))

    expect(renderer.container.querySelectorAll('[data-slot="loading-back-placeholder"]'))
      .toHaveLength(1)
    expect(renderer.queryAllByRole("button", { name: "Back" })).toHaveLength(0)
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
    const renderer = render(React.createElement(MachineUpdateDialog, {
      machine: target,
      onOpenChange,
      onConfirm,
    }))

    const cancel = renderer.container.querySelector('[data-kind="cancel"]')!
    const confirm = renderer.container.querySelector('[data-kind="confirm"]')!
    fireEvent.click(cancel)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(mocks.apiFetch).not.toHaveBeenCalled()

    fireEvent.click(confirm)
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
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
