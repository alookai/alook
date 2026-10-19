import "fake-indexeddb/auto"
import { createElement, useReducer } from "react"
import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query"
import { it, expect, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { communityKeys } from "@/lib/query-keys"
import { createIdbPersister, PERSIST_BUSTER } from "@/lib/query-persister"
import type { MachinesResponse, MachineSummary } from "@/hooks/community/use-machines"
import { initialUserBarExtensionState, userBarExtensionReducer, type UserBarExtensionState } from "@/components/community/shell/user-bar-extension-state"
import { daemonUpdateCollapseStorageKey, useShellDaemonUpdateController } from "./use-shell-daemon-update-controller"
const transport = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => transport.load(...args) }))
const machine: MachineSummary = { id: "machine-1", hostname: "fixture", displayName: "Fixture", platform: "darwin", arch: "arm64", osRelease: "26.0", daemonVersion: "0.1.34", status: "online", lastSeenAt: null, availableRuntimes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
it.each([false, true])("preserves collapsed preference through native restored list; empty=%s", async empty => {
  const owner = await createCommunityQueryOwner("user-1")
  const disk = createIdbPersister("user-1")
  const seed = new QueryClient()
  seed.setQueryData(communityKeys.machines(), { machines: empty ? [] : [machine] })
  await disk.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(seed) })
  const restored = await disk.restoreClient()
  expect(restored).toBeDefined()
  hydrate(owner.client, restored!.clientState)
  expect(owner.client.getQueryData<MachinesResponse>(communityKeys.machines())?.observed).toBe(false)
  let release!: (value: MachinesResponse) => void
  const live = new Promise<MachinesResponse>(resolve => { release = resolve })
  transport.load.mockReset()
  transport.load.mockImplementation((url: string) => url.includes("view=observations") ? Promise.resolve({ quotas: [] }) : live)
  const key = daemonUpdateCollapseStorageKey("user-1", "0.1.35")
  window.localStorage.setItem(key, "1")
  let state!: UserBarExtensionState
  function Probe() {
    const [current, dispatch] = useReducer(userBarExtensionReducer, initialUserBarExtensionState)
    useShellDaemonUpdateController({ userId: "user-1", extensionState: current, dispatch, latestDaemonVersion: "0.1.35" })
    state = current
    return null
  }
  const view = render(createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "user-1", retainOwner: true }, createElement(Probe)))
  try {
    await waitFor(() => expect(transport.load).toHaveBeenCalledWith("/api/community/machines?view=list", expect.anything()))
    expect(window.localStorage.getItem(key)).toBe("1")
    await act(async () => { release({ machines: [machine] }) })
    await waitFor(() => expect(state.update?.phase).toBe("collapsedBadge"))
    expect(state.active).toBe("none")
    expect(window.localStorage.getItem(key)).toBe("1")
  } finally {
    await act(async () => { release({ machines: [machine] }) })
    view.unmount();seed.clear();owner.client.clear()
    window.localStorage.removeItem(key)
  }
})

it("clears a restored collapse preference after a qualified fresh empty list", async () => {
  const owner = await createCommunityQueryOwner("user-1")
  const disk = createIdbPersister("user-1")
  const seed = new QueryClient()
  seed.setQueryData(communityKeys.machines(), { machines: [machine] })
  await disk.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(seed) })
  const restored = await disk.restoreClient()
  hydrate(owner.client, restored!.clientState)
  let release!: (value: MachinesResponse) => void
  const live = new Promise<MachinesResponse>(resolve => { release = resolve })
  transport.load.mockReset()
  transport.load.mockImplementation((url: string) => url.includes("view=observations") ? Promise.resolve({ quotas: [] }) : live)
  const key = daemonUpdateCollapseStorageKey("user-1", "0.1.35")
  window.localStorage.setItem(key, "1")
  let state!: UserBarExtensionState
  function Probe() {
    const [current, dispatch] = useReducer(userBarExtensionReducer, initialUserBarExtensionState)
    useShellDaemonUpdateController({ userId: "user-1", extensionState: current, dispatch, latestDaemonVersion: "0.1.35" })
    state = current
    return null
  }
  const view = render(createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "user-1", retainOwner: true }, createElement(Probe)))
  try {
    await waitFor(() => expect(transport.load).toHaveBeenCalledWith("/api/community/machines?view=list", expect.anything()))
    expect(window.localStorage.getItem(key)).toBe("1")
    await act(async () => { release({ machines: [] }) })
    await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull())
    expect(owner.client.getQueryData<MachinesResponse>(communityKeys.machines())).toMatchObject({ machines: [], source: "network" })
    expect(state).toEqual(initialUserBarExtensionState)
  } finally {
    await act(async () => { release({ machines: [] }) })
    view.unmount(); seed.clear(); owner.client.clear()
    window.localStorage.removeItem(key)
  }
})

it("syncs the same eligible machine identity only when its partial list becomes qualified", async () => {
  const owner = await createCommunityQueryOwner("user-1")
  const rows = [machine]
  owner.client.setQueryData<MachinesResponse>(communityKeys.machines(), { machines: rows, complete: false, observed: true })
  const previousRows = owner.client.getQueryData<MachinesResponse>(communityKeys.machines())!.machines
  transport.load.mockReset()
  let release!: (value: MachinesResponse) => void
  const live = new Promise<MachinesResponse>(resolve => { release = resolve })
  transport.load.mockImplementation((url: string) => url.includes("view=observations") ? Promise.resolve({ quotas: [] }) : live)
  const key = daemonUpdateCollapseStorageKey("user-1", "0.1.35")
  window.localStorage.setItem(key, "1")
  let state!: UserBarExtensionState
  let currentRows!: MachineSummary[]
  function Probe() {
    const [current, dispatch] = useReducer(userBarExtensionReducer, initialUserBarExtensionState)
    const controller = useShellDaemonUpdateController({ userId: "user-1", extensionState: current, dispatch, latestDaemonVersion: "0.1.35" })
    state = current
    currentRows = controller.eligibleMachines
    return null
  }
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "user-1", retainOwner: true }, createElement(Probe))) })
  try {
    expect(state).toEqual(initialUserBarExtensionState)
    expect(currentRows.map(row => row.id)).toEqual([machine.id])
    const eligibleBefore = currentRows
    expect(window.localStorage.getItem(key)).toBe("1")
    await act(async () => { owner.client.setQueryData<MachinesResponse>(communityKeys.machines(), { machines: rows, complete: true, observed: true }) })
    await waitFor(() => expect(state.update?.phase).toBe("collapsedBadge"))
    expect(owner.client.getQueryData<MachinesResponse>(communityKeys.machines())!.machines).toBe(previousRows)
    expect(currentRows).toBe(eligibleBefore)
    expect(state.update?.targetMachineIds).toEqual([machine.id])
    expect(state.active).toBe("none")
    expect(window.localStorage.getItem(key)).toBe("1")
    expect(transport.load.mock.calls.filter(([url]) => String(url).includes("view=list"))).toHaveLength(1)
  } finally {
    view.unmount(); owner.client.clear()
    await act(async () => { release({ machines: rows }) })
    window.localStorage.removeItem(key)
  }
})
