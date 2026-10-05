import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { clearLastChannel, setLastChannel } from "@/lib/community/last-channel"
import { setLastMeLocation } from "@/lib/community/last-me-location"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityRailHrefs } from "./use-community-rail-hrefs"

const owner = vi.hoisted(() => ({ registry: null as CommunityDbRegistry | null }))
vi.mock("@/lib/community-db/projections", () => ({ useOptionalCommunityDbRegistry: () => owner.registry }))

function collection<T>(initial: readonly [string, T][]) {
  const rows = new Map(initial)
  const listeners = new Set<() => void>()
  return {
    get: (id: string) => rows.get(id), values: () => rows.values(),
    subscribeChanges: (notify: () => void) => {
      listeners.add(notify)
      return { unsubscribe: () => listeners.delete(notify) }
    },
    put: (id: string, row: T) => { rows.set(id, row); listeners.forEach((notify) => notify()) },
    listenerCount: () => listeners.size,
  }
}

beforeEach(() => { localStorage.clear(); owner.registry = null })

describe("rail hrefs derived from canonical rows and existing navigation memory", () => {
  it("updates remembered Home leaves after commit for each non-DM page", () => {
    const view = renderHook(() => useCommunityRailHrefs([], "desktop"))
    expect(view.result.current.homeHref).toBe("/c/me/friends")
    for (const leaf of ["bots", "machines", "friends"]) {
      act(() => setLastMeLocation(`/c/me/${leaf}`))
      expect(view.result.current.homeHref).toBe(`/c/me/${leaf}`)
    }
  })

  it("subscribes to complete canonical channels, filters placeholders/threads, and follows the latest memory", () => {
    const servers = collection<{ detailComplete: boolean }>([["s", { detailComplete: false }]])
    const channels = collection<{ id: string; serverId: string; type: string; pending?: boolean }>([
      ["pending", { id: "pending", serverId: "s", type: "text", pending: true }],
      ["thread", { id: "thread", serverId: "s", type: "thread" }],
      ["first", { id: "first", serverId: "s", type: "text" }],
      ["foreign", { id: "foreign", serverId: "other", type: "text" }],
    ])
    owner.registry = { collections: { servers, channels } } as unknown as CommunityDbRegistry
    const rows = [{ id: "s" }]
    const view = renderHook(({ breakpoint }: { breakpoint: "desktop" | "mobile" }) =>
      useCommunityRailHrefs(rows, breakpoint), { initialProps: { breakpoint: "desktop" } })
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s")
    act(() => servers.put("s", { detailComplete: true }))
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s/first")
    act(() => setLastChannel("s", "latest"))
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s/latest")
    act(() => clearLastChannel("s"))
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s/first")
    view.rerender({ breakpoint: "mobile" })
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s")
    expect(view.result.current.homeHref).toBe("/c/me")
    view.unmount()
    expect(servers.listenerCount()).toBe(0)
    expect(channels.listenerCount()).toBe(0)
  })

  it("refreshes cross-tab memory from native storage events without writing during render", () => {
    const view = renderHook(() => useCommunityRailHrefs([{ id: "s" }], "desktop"))
    act(() => {
      localStorage.setItem("community:lastChannel:s", "new")
      window.dispatchEvent(new StorageEvent("storage", { key: "community:lastChannel:s" }))
    })
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s/new")
    act(() => {
      localStorage.setItem("community:lastChannel:s", "invalid/path")
      window.dispatchEvent(new StorageEvent("storage", { key: "community:lastChannel:s" }))
    })
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s")
    expect(localStorage.getItem("community:lastChannel:s")).toBe("invalid/path")
  })
})
