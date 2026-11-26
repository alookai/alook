import { canonicalChannelRow } from "@/lib/community-db/schema"
import { createStore } from "@tanstack/store"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { serverResourceFixture, channelResourceFixture, serverRailResponseFixture } from "@/test/community-resource-fixtures"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { ingestServers } from "@/lib/community-db/sync"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { clearLastChannel, setLastChannel } from "@/lib/community/last-channel"
import { setLastMeLocation } from "@/lib/community/last-me-location"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityRailHrefs } from "./use-community-rail-hrefs"

const canonicalChannelFixture = (fields: Parameters<typeof channelResourceFixture>[0]) => canonicalChannelRow(channelResourceFixture(fields))

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
afterEach(() => { vi.restoreAllMocks() })

describe("rail hrefs derived from canonical rows and existing navigation memory", () => {
  it.each(["desktop", "mobile", "unknown"] as const)("server-renders deterministic %s links without reading client memory or subscribing", (breakpoint) => {
    const servers = collection([["s", serverResourceFixture({ id: "s" })], ["other", serverResourceFixture({ id: "other" })]])
    const channels = collection([
      ["first", canonicalChannelFixture({ id: "first", serverId: "s" })],
      ["second", canonicalChannelFixture({ id: "second", serverId: "other" })],
    ])
    owner.registry = { queryClient: new QueryClient(), accountId: "viewer", scopeId: "viewer", runtime: { lifecycle: createStore({ active: true, generation: 0 }) }, collections: { servers, categories: collection([]), channels } } as unknown as CommunityDbRegistry
    setLastMeLocation("/c/me/machines")
    setLastChannel("s", "remembered")
    setLastChannel("other", "other-remembered")
    const getItem = vi.spyOn(Storage.prototype, "getItem")
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    const removeItem = vi.spyOn(Storage.prototype, "removeItem")
    const getServer = vi.spyOn(servers, "get")
    const channelValues = vi.spyOn(channels, "values")

    function Rail() {
      const { homeHref, serverHrefs } = useCommunityRailHrefs([{ id: "s" }, { id: "other" }], breakpoint)
      return createElement("nav", null,
        Object.entries({ home: homeHref, ...serverHrefs }).map(([id, href]) => createElement("a", { key: id, href }, id)))
    }
    const markup = document.createElement("div")
    markup.innerHTML = renderToString(createElement(Rail))
    expect(Object.fromEntries(Array.from(markup.querySelectorAll("a"), (link) => [link.textContent, link.getAttribute("href")]))).toEqual({
      home: breakpoint === "desktop" ? "/c/me/friends" : "/c/me",
      s: "/c/channels/s",
      other: "/c/channels/other",
    })
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(getServer).not.toHaveBeenCalled()
    expect(channelValues).not.toHaveBeenCalled()
    expect(servers.listenerCount()).toBe(0)
    expect(channels.listenerCount()).toBe(0)
    expect(localStorage.getItem("community:lastChannel:me")).toBe("machines")
    expect(localStorage.getItem("community:lastChannel:s")).toBe("remembered")
    expect(localStorage.getItem("community:lastChannel:other")).toBe("other-remembered")
  })

  it("updates remembered Home leaves after commit for each non-DM page", () => {
    const view = renderHook(() => useCommunityRailHrefs([], "desktop"))
    expect(view.result.current.homeHref).toBe("/c/me/friends")
    for (const leaf of ["bots", "machines", "friends"]) {
      act(() => setLastMeLocation(`/c/me/${leaf}`))
      expect(view.result.current.homeHref).toBe(`/c/me/${leaf}`)
    }
  })

  it("subscribes to complete canonical channels, filters placeholders/threads, and follows the latest memory", () => {
    const servers = collection([["s", serverResourceFixture({ id: "s" })]])
    const channels = collection<ReturnType<typeof channelResourceFixture> & { pending?: boolean }>([
      ["pending", { ...canonicalChannelFixture({ id: "pending", serverId: "s" }), pending: true }],
      ["thread", canonicalChannelFixture({ id: "thread", serverId: "s", type: "thread", parentChannelId: "first", parentMessageId: "opener" })],
      ["first", canonicalChannelFixture({ id: "first", serverId: "s" })],
      ["foreign", canonicalChannelFixture({ id: "foreign", serverId: "other" })],
    ])
    owner.registry = { queryClient: new QueryClient(), accountId: "viewer", scopeId: "viewer", runtime: { lifecycle: createStore({ active: true, generation: 0 }) }, collections: { servers, categories: collection([]), channels } } as unknown as CommunityDbRegistry
    const rows = [{ id: "s" }]
    const view = renderHook(({ breakpoint }: { breakpoint: "desktop" | "mobile" }) =>
      useCommunityRailHrefs(rows, breakpoint), { initialProps: { breakpoint: "desktop" } })
    expect(view.result.current.serverHrefs.s).toBe("/c/channels/s")
    act(() => {
      owner.registry!.queryClient.setQueryData(communityKeys.server("s"), { schemaVersion: BUSINESS_SCHEMA_VERSION, accountId: "viewer", serverId: "s", categoryIds: [], channelIds: ["first"] })
      servers.put("s", serverResourceFixture({ id: "s" }))
    })
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

  it("ignores non-structural channel lastMessageAt updates without localStorage reads or JSON serialization", async () => {
    const { registry } = await createCommunityQueryOwner("viewer")
    const serverCount = 150
    const channelCount = 500
    const servers = Array.from({ length: serverCount }, (_, i) => ({
      id: `srv-${i}`,
      name: `Server ${i}`,
      initial: "S",
      active: false,
      unread: false,
      mentions: 0,
      ownerId: "viewer",
    }))
    ingestServers(registry, serverRailResponseFixture({ servers }, "viewer"))
    const channels = Array.from({ length: channelCount }, (_, i) =>
      canonicalChannelFixture({ id: `ch-${i}`, serverId: `srv-${i % serverCount}`, type: "text", position: i }),
    )
    await writeCommunityCollectionRows(registry, "channels", channels, (r) => r.id)
    owner.registry = registry

    let renders = 0
    const view = renderHook(() => {
      renders += 1
      return useCommunityRailHrefs(servers, "desktop")
    })
    expect(Object.keys(view.result.current.serverHrefs)).toHaveLength(serverCount)

    const rendersBeforePatch = renders
    const snapshotBeforePatch = view.result.current
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem")
    const stringifySpy = vi.spyOn(JSON, "stringify")

    await act(async () => {
      const nextChannels = [
        canonicalChannelFixture({
          id: "ch-0",
          serverId: "srv-0",
          type: "text",
          position: 0,
          lastMessageAt: "2026-11-26T12:00:00.000Z",
        }),
        ...channels.slice(1),
      ]
      await writeCommunityCollectionRows(registry, "channels", nextChannels, (r) => r.id)
    })

    const railHrefsStringifyCalls = stringifySpy.mock.calls.filter(
      ([arg]) => typeof arg === "object" && arg !== null && "serverHrefs" in arg,
    ).length

    expect(getItemSpy).not.toHaveBeenCalled()
    expect(railHrefsStringifyCalls).toBe(0)
    expect(renders - rendersBeforePatch).toBe(0)
    expect(view.result.current).toBe(snapshotBeforePatch)

    view.unmount()
    await registry.cleanup()
  })
})
