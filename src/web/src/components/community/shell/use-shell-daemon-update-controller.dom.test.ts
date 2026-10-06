import { createElement, useReducer } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render as rtlRender } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import type { MachineSummary } from "@/hooks/community/use-machines"
import {
  daemonUpdateCollapseStorageKey,
  useShellDaemonUpdateController,
} from "./use-shell-daemon-update-controller"
import {
  initialUserBarExtensionState,
  userBarExtensionReducer,
  type UserBarExtensionState,
} from "./user-bar-extension-state"

const mocks = vi.hoisted(() => ({
  machines: {
    machines: [] as MachineSummary[],
    isSuccess: true,
  },
  warn: vi.fn(),
}))

vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => mocks.machines,
}))
vi.mock("@/lib/logger", () => ({
  log: { warn: mocks.warn },
}))

const latestVersion = "0.1.35"

function machine(
  id: string,
  daemonVersion = "0.1.34",
): MachineSummary {
  return {
    id,
    hostname: `${id}.local`,
    displayName: id,
    platform: "darwin",
    arch: "arm64",
    osRelease: "26.0",
    daemonVersion,
    lastSeenAt: null,
    status: "online",
    availableRuntimes: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
const render: typeof rtlRender = (node, options) => rtlRender(node, { ...options, wrapper: ({ children }) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "user-1", retainOwner: true }, children) })

type Controller = ReturnType<typeof useShellDaemonUpdateController>
type Snapshot = { state: UserBarExtensionState; controller: Controller }

function Capture({
  initialState,
  version,
  requestUpdate,
  onResult,
}: {
  initialState: UserBarExtensionState
  version?: string
  requestUpdate?: (machineId: string) => Promise<unknown>
  onResult: (snapshot: Snapshot) => void
}) {
  const [state, dispatch] = useReducer(userBarExtensionReducer, initialState)
  const controller = useShellDaemonUpdateController({
    userId: "user-1",
    extensionState: state,
    dispatch,
    latestDaemonVersion: version,
    requestUpdate,
  })
  onResult({ state, controller })
  return null
}

async function renderController({
  initialState = initialUserBarExtensionState,
  version = latestVersion,
  requestUpdate = vi.fn(async () => {}),
}: {
  initialState?: UserBarExtensionState
  version?: string
  requestUpdate?: (machineId: string) => Promise<unknown>
} = {}) {
  let current!: Snapshot
  let renderer!: ReturnType<typeof rtlRender>
  const element = () => createElement(Capture, {
    initialState,
    version,
    requestUpdate,
    onResult: (snapshot) => { current = snapshot },
  })
  await act(async () => {
    renderer = render(element())
  })
  return {
    get current() { return current },
    rerender: async (nextVersion?: string) => {
      if (nextVersion !== undefined) version = nextVersion
      await act(async () => renderer.rerender(element()))
    },
    unmount: () => renderer.unmount(),
  }
}

function activeUpdate(values: Partial<NonNullable<UserBarExtensionState["update"]>> = {}): UserBarExtensionState {
  return {
    active: "update",
    update: {
      phase: "expanded",
      targetMachineIds: ["machine-1"],
      acceptedMachineIds: [],
      failedMachineIds: [],
      pendingMachineIds: [],
      ...values,
    },
  }
}

describe("useShellDaemonUpdateController", () => {
  beforeEach(async () => {
    owner = await createCommunityQueryOwner("user-1")
    window.localStorage.clear()
    mocks.warn.mockReset()
    mocks.machines = { machines: [], isSuccess: true }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    window.localStorage.clear()
  })

  it("uses the configured production dependencies when optional overrides are omitted", async () => {
    vi.stubEnv("NEXT_PUBLIC_LATEST_DAEMON_VERSION", latestVersion)
    mocks.machines = { machines: [machine("machine-1")], isSuccess: true }
    let current!: Snapshot
    let renderer!: ReturnType<typeof rtlRender>

    await act(async () => {
      renderer = render(createElement(Capture, {
        initialState: initialUserBarExtensionState,
        onResult: (snapshot) => { current = snapshot },
      }))
    })

    expect(current.state).toMatchObject({
      active: "update",
      update: { phase: "expanded", targetMachineIds: ["machine-1"] },
    })
    renderer.unmount()
  })

  it("restores, opens, collapses, and clears the version-scoped preference from live Machines", async () => {
    const key = daemonUpdateCollapseStorageKey("user-1", latestVersion)
    window.localStorage.setItem(key, "1")
    mocks.machines = { machines: [machine("machine-1")], isSuccess: true }
    const hook = await renderController()

    expect(hook.current.state).toMatchObject({
      active: "none",
      update: { phase: "collapsedBadge", targetMachineIds: ["machine-1"] },
    })
    await act(async () => hook.current.controller.open())
    expect(hook.current.state).toMatchObject({ active: "update", update: { phase: "expanded" } })
    expect(window.localStorage.getItem(key)).toBeNull()

    await act(async () => hook.current.controller.collapse())
    expect(hook.current.state).toMatchObject({ active: "none", update: { phase: "collapsedBadge" } })
    expect(window.localStorage.getItem(key)).toBe("1")

    mocks.machines = { machines: [machine("machine-1", latestVersion)], isSuccess: true }
    await hook.rerender()
    expect(hook.current.state).toEqual(initialUserBarExtensionState)
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it("waits for a successful Machine snapshot and a valid target version", async () => {
    mocks.machines = { machines: [machine("machine-1")], isSuccess: false }
    const loading = await renderController()
    expect(loading.current.state).toEqual(initialUserBarExtensionState)
    loading.unmount()

    mocks.machines = { machines: [machine("machine-1")], isSuccess: true }
    const missing = await renderController({ version: "" })
    expect(missing.current.controller.eligibleMachines).toEqual([])
    expect(missing.current.state).toEqual(initialUserBarExtensionState)
    missing.unmount()

    const malformed = await renderController({ version: "next" })
    expect(malformed.current.state).toEqual(initialUserBarExtensionState)
  })

  it("keeps accepted requests updating and retries only failed eligible Machines", async () => {
    mocks.machines = {
      machines: [machine("machine-1"), machine("machine-2")],
      isSuccess: true,
    }
    let failSecond = true
    const requestUpdate = vi.fn(async (machineId: string) => {
      if (machineId === "machine-2" && failSecond) {
        failSecond = false
        throw new Error("offline race")
      }
    })
    const hook = await renderController({
      initialState: activeUpdate({ targetMachineIds: ["machine-1", "machine-2"] }),
      requestUpdate,
    })

    await act(async () => hook.current.controller.request())
    expect(hook.current.state.update).toMatchObject({
      phase: "retry",
      acceptedMachineIds: ["machine-1"],
      failedMachineIds: ["machine-2"],
      pendingMachineIds: [],
    })
    expect(mocks.warn).toHaveBeenCalledWith("daemon update request failed", {
      machineId: "machine-2",
    })

    await act(async () => hook.current.controller.request())
    expect(requestUpdate.mock.calls).toEqual([
      ["machine-1"],
      ["machine-2"],
      ["machine-2"],
    ])
    expect(hook.current.state.update).toMatchObject({
      phase: "updating",
      acceptedMachineIds: ["machine-1", "machine-2"],
      failedMachineIds: [],
      pendingMachineIds: [],
    })
  })

  it.each(["release", "authentication"] as const)("retires a late batch on %s replacement", async (retirement) => {
    mocks.machines = { machines: [machine("machine-1")], isSuccess: true }
    let resolve!: () => void
    const held = new Promise<void>((done) => { resolve = done })
    const hook = await renderController({ initialState: activeUpdate(), requestUpdate: () => held })
    let request!: Promise<void>
    act(() => { request = hook.current.controller.request() })
    if (retirement === "release") await hook.rerender("0.1.36")
    else act(() => owner.registry.authenticationView.setState((state) => ({ active: false, generation: state.generation + 1 })))
    await act(async () => { resolve(); await request })
    expect(hook.current.state.update?.acceptedMachineIds ?? []).toEqual([])
    if (retirement === "release") expect(hook.current.state.update?.pendingMachineIds).toEqual([])
  })

  it("retires an ineligible target from its original pending batch even if it becomes eligible again", async () => {
    mocks.machines = { machines: [machine("machine-1"), machine("machine-2")], isSuccess: true }
    let resolve!: () => void
    const held = new Promise<void>((done) => { resolve = done })
    const requestUpdate = vi.fn((_machineId: string) => held)
    const hook = await renderController({
      initialState: activeUpdate({ targetMachineIds: ["machine-1", "machine-2"] }),
      requestUpdate,
    })
    let request!: Promise<void>
    act(() => { request = hook.current.controller.request() })
    expect(hook.current.state.update?.pendingMachineIds).toEqual(["machine-1", "machine-2"])

    mocks.machines = { machines: [machine("machine-2")], isSuccess: true }
    await hook.rerender()
    expect(hook.current.state.update?.pendingMachineIds).toEqual(["machine-2"])
    mocks.machines = { machines: [machine("machine-1"), machine("machine-2")], isSuccess: true }
    await hook.rerender()
    await act(async () => { resolve(); await request })

    expect(requestUpdate.mock.calls).toEqual([["machine-1"], ["machine-2"]])
    expect(hook.current.state.update?.acceptedMachineIds).toEqual(["machine-2"])
    expect(hook.current.state.update?.failedMachineIds).toEqual([])
    expect(hook.current.state.update?.pendingMachineIds).toEqual([])
    expect(hook.current.state.update?.targetMachineIds).toEqual(["machine-1", "machine-2"])
    expect(mocks.warn).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("settles its same-account batch across unrelated community permission changes", async () => {
    mocks.machines = { machines: [machine("machine-1")], isSuccess: true }
    let resolve!: () => void
    const held = new Promise<void>((done) => { resolve = done })
    const hook = await renderController({ initialState: activeUpdate(), requestUpdate: () => held })
    let request!: Promise<void>
    act(() => { request = hook.current.controller.request() })
    act(() => owner.registry.runtime.ws.setState((state) => ({ ...state, accessEpoch: state.accessEpoch + 1 })))
    await act(async () => { resolve(); await request })
    expect(hook.current.state.update?.acceptedMachineIds).toEqual(["machine-1"])
  })

  it("does not dispatch without update state, with pending requests, or with no requestable target", async () => {
    const requestUpdate = vi.fn(async () => {})
    mocks.machines = { machines: [], isSuccess: false }
    const absent = await renderController({ requestUpdate })
    await act(async () => {
      absent.current.controller.collapse()
      absent.current.controller.open()
      await absent.current.controller.request()
    })
    expect(requestUpdate).not.toHaveBeenCalled()
    absent.unmount()

    mocks.machines = { machines: [machine("machine-1")], isSuccess: true }
    const pending = await renderController({
      initialState: activeUpdate({ pendingMachineIds: ["machine-1"] }),
      requestUpdate,
    })
    await act(async () => pending.current.controller.request())
    expect(requestUpdate).not.toHaveBeenCalled()
    pending.unmount()

    const accepted = await renderController({
      initialState: activeUpdate({ acceptedMachineIds: ["machine-1"] }),
      requestUpdate,
    })
    await act(async () => accepted.current.controller.request())
    expect(requestUpdate).not.toHaveBeenCalled()
  })

  it("keeps state transitions functional when local storage is unavailable", async () => {
    mocks.machines = { machines: [machine("machine-1")], isSuccess: true }
    vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
      throw new Error("storage disabled")
    })
    const hook = await renderController()
    expect(hook.current.state).toMatchObject({ active: "update", update: { phase: "expanded" } })

    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage disabled")
    })
    await act(async () => hook.current.controller.collapse())
    expect(hook.current.state.active).toBe("none")

    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
      throw new Error("storage disabled")
    })
    await act(async () => hook.current.controller.open())
    expect(hook.current.state.active).toBe("update")
  })
})
