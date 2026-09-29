import { QueryClient } from "@tanstack/react-query"
import {
  DbClient,
  BTreeIndex,
  collectionOptions,
  createLiveQueryCollection,
  eq,
} from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apiFetch } from "@/lib/api/client"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import {
  createMessageCollectionDescriptor,
  readMessageWindowPublication,
} from "./message-resource"
import {
  messagePagesQueryKey,
  messageRowsQueryKey,
} from "./message-pagination"
import { messageSchema } from "./schema"

vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn() }))

const apiFetchMock = vi.mocked(apiFetch)

const message = (seq: number): Msg => ({
  id: `m${seq}`,
  type: "chat",
  seq,
  createdAt: new Date(seq * 1000).toISOString(),
  content: `message ${seq}`,
})

function setup(base: "tail" | { anchor: string } = "tail") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const dbClient = new DbClient({ queryClient })
  const descriptor = createMessageCollectionDescriptor(queryClient, "viewer")
  const options = queryCollectionOptions({
    id: "message-resource-test",
    queryClient,
    queryKey: descriptor.queryKey,
    queryFn: descriptor.queryFn,
    schema: messageSchema,
    getKey: (row) => row.id,
    syncMode: "on-demand",
    staleTime: Infinity,
  })
  const messages = dbClient.collection(collectionOptions(
    "message-resource-test",
    () => options,
  ))
  descriptor.bindRows(() => messages.values())
  messages.createIndex((row) => row.seq!, { indexType: BTreeIndex })
  const demand = {
    scope: {
      accountId: "viewer",
      kind: "server-channel",
      serverId: "server",
      channelId: "channel",
    },
    tag: null,
    sequence: {
      base: base === "tail"
        ? { mode: "tail" }
        : { mode: "anchor", anchor: base.anchor },
      direction: "older",
      order: ["seq", "asc", "id", "asc"],
    },
  } as const
  descriptor.setDemand(demand)
  const views: Array<ReturnType<typeof createLiveQueryCollection>> = []
  const view = (direction: "older" | "newer", limit: number) => {
    const created = createLiveQueryCollection({
      query: (q) => q.from({ message: messages })
        .where(({ message: row }) => eq(row.channelId, "channel"))
        .orderBy(({ message: row }) => row.seq, direction === "older" ? "desc" : "asc")
        .orderBy(({ message: row }) => row.id, direction === "older" ? "desc" : "asc")
        .limit(limit),
    })
    views.push(created)
    return created
  }
  return {
    descriptor,
    demand,
    messages,
    queryClient,
    view,
    cleanup: async () => {
      await Promise.all(views.map((created) => created.cleanup()))
      await dbClient.cleanup()
      queryClient.clear()
    },
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  apiFetchMock.mockReset()
})

describe("message QueryCollection resource", () => {
  it("rejects a demand owned by a different account", () => {
    const descriptor = createMessageCollectionDescriptor(new QueryClient(), "viewer")

    expect(() => descriptor.setDemand({
      scope: {
        accountId: "other",
        kind: "server-channel",
        serverId: "server",
        channelId: "channel",
      },
      tag: null,
      sequence: {
        base: { mode: "tail" },
        direction: "older",
        order: ["seq", "asc", "id", "asc"],
      },
    })).toThrow("message demand account mismatch")
  })

  it.each(["channel", "thread", "forum", "dm"] as const)(
    "publishes a validated %s surface receipt",
    async (surfaceKind) => {
      apiFetchMock.mockResolvedValue({
        messages: [message(1)],
        hasMore: false,
        latestSeq: 1,
        surfaceReceipt: { channelId: "channel", surfaceKind },
      })
      const runtime = setup()
      cleanups.push(runtime.cleanup)
      const leaf = runtime.view("older", 25)

      await leaf.preload()

      expect(readMessageWindowPublication(runtime.queryClient, runtime.demand))
        .toMatchObject({
          hasMore: false,
          rows: [expect.objectContaining({ id: "m1" })],
          surfaceReceipt: { channelId: "channel", surfaceKind },
        })
    },
  )

  it("reports no publication before a cursor sequence owns pages", () => {
    const runtime = setup()
    cleanups.push(runtime.cleanup)

    expect(readMessageWindowPublication(runtime.queryClient, runtime.demand)).toBeUndefined()
  })

  it("fences a row query whose configured scope changes after key derivation", async () => {
    apiFetchMock.mockResolvedValue({ messages: [message(1)], hasMore: false, latestSeq: 1 })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const descriptor = createMessageCollectionDescriptor(queryClient, "viewer")
    const demand = {
      scope: {
        accountId: "viewer",
        kind: "server-channel" as const,
        serverId: "server",
        channelId: "channel",
      },
      tag: null,
      sequence: {
        base: { mode: "tail" as const },
        direction: "older" as const,
        order: ["seq", "asc", "id", "asc"] as const,
      },
    }
    descriptor.setDemand(demand)
    const options = {
      where: {
        type: "func",
        name: "eq",
        args: [
          { type: "ref", path: ["channelId"] },
          { type: "val", value: "channel" },
        ],
      },
    }
    const queryKey = descriptor.queryKey(options as never)
    demand.scope.channelId = "changed"

    await expect(descriptor.queryFn({
      queryKey,
      signal: new AbortController().signal,
    } as never)).rejects.toThrow("message row query resource mismatch")
    queryClient.clear()
  })

  it.each([
    [0, []],
    [1, ["m1"]],
  ] as const)("activates a direct leaf with %i rows and no other consumer", async (count, ids) => {
    apiFetchMock.mockResolvedValue({
      messages: count === 0 ? [] : [message(1)],
      hasMore: false,
      latestSeq: count,
    })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const leaf = runtime.view("older", 25)

    await leaf.preload()

    expect([...leaf.values()].map((row) => row.id)).toEqual(ids)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/channel/messages",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("grows a >25 tail from the shared page prefix without refetching page one", async () => {
    apiFetchMock.mockImplementation(async (url): Promise<MessagesPage> => {
      const href = String(url)
      return href.includes("cursor=older-25")
        ? { messages: Array.from({ length: 25 }, (_, index) => message(index + 1)), hasMore: false }
        : {
            messages: Array.from({ length: 25 }, (_, index) => message(index + 26)),
            hasMore: true,
            cursor: "older-25",
            latestSeq: 50,
          }
    })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const firstWindow = runtime.view("older", 25)
    await firstWindow.preload()
    expect([...firstWindow.values()].map((row) => row.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `m${50 - index}`),
    )

    const expandedWindow = runtime.view("older", 50)
    await expandedWindow.preload()

    expect([...expandedWindow.values()].map((row) => row.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `m${50 - index}`),
    )
    expect(apiFetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/community/channels/channel/messages",
      "/api/community/channels/channel/messages?cursor=older-25",
    ])
  })

  it("keeps the expanded window when the prior live-query owner unloads", async () => {
    apiFetchMock.mockImplementation(async (url): Promise<MessagesPage> => {
      const href = String(url)
      return href.includes("cursor=older-50")
        ? {
            messages: Array.from({ length: 25 }, (_, index) => message(index + 1)),
            hasMore: false,
          }
        : {
            messages: Array.from({ length: 50 }, (_, index) => message(index + 26)),
            hasMore: true,
            cursor: "older-50",
            latestSeq: 75,
          }
    })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const firstLease = runtime.descriptor.acquireWindow(runtime.demand, 50)
    const firstWindow = runtime.view("older", 50)
    await firstWindow.preload()

    const expandedLease = runtime.descriptor.acquireWindow(runtime.demand, 100)
    const expandedWindow = runtime.view("older", 100)
    await expandedLease.update(100)
    await expandedWindow.preload()
    await firstWindow.cleanup()
    await firstLease.release()

    await vi.waitFor(() => expect(runtime.messages.size).toBe(75))
    expect([...expandedWindow.values()]).toHaveLength(75)
  })

  it("reapplies a larger window after the prior live-query owner has unloaded", async () => {
    apiFetchMock.mockImplementation(async (url): Promise<MessagesPage> => {
      const href = String(url)
      return href.includes("cursor=older-50")
        ? {
            messages: Array.from({ length: 25 }, (_, index) => message(index + 1)),
            hasMore: false,
          }
        : {
            messages: Array.from({ length: 50 }, (_, index) => message(index + 26)),
            hasMore: true,
            cursor: "older-50",
            latestSeq: 75,
          }
    })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const firstLease = runtime.descriptor.acquireWindow(runtime.demand, 50)
    const firstWindow = runtime.view("older", 50)
    await firstWindow.preload()
    const expandedLease = runtime.descriptor.acquireWindow(runtime.demand, 100)
    await firstWindow.cleanup()
    await firstLease.release()

    const expandedWindow = runtime.view("older", 100)
    await expandedLease.update(100)
    await expandedWindow.preload()

    await vi.waitFor(() => expect(runtime.messages.size).toBe(75))
    expect([...expandedWindow.values()]).toHaveLength(75)
  })

  it.each(["smaller-first", "larger-first"] as const)(
    "retains one stable owner until concurrent 50/100 leases release %s",
    async (releaseOrder) => {
      apiFetchMock.mockImplementation(async (url): Promise<MessagesPage> => {
        const href = String(url)
        return href.includes("cursor=older-50")
          ? {
              messages: Array.from({ length: 25 }, (_, index) => message(index + 1)),
              hasMore: false,
            }
          : {
              messages: Array.from({ length: 50 }, (_, index) => message(index + 26)),
              hasMore: true,
              cursor: "older-50",
              latestSeq: 75,
            }
      })
      const runtime = setup()
      cleanups.push(runtime.cleanup)
      const smallerLease = runtime.descriptor.acquireWindow(runtime.demand, 50)
      const smaller = runtime.view("older", 50)
      await smaller.preload()
      const largerLease = runtime.descriptor.acquireWindow(runtime.demand, 100)
      const larger = runtime.view("older", 100)
      await largerLease.update(100)
      await larger.preload()
      await vi.waitFor(() => expect(runtime.messages.size).toBe(75))

      const first = releaseOrder === "smaller-first"
        ? { lease: smallerLease, view: smaller }
        : { lease: largerLease, view: larger }
      const last = releaseOrder === "smaller-first"
        ? { lease: largerLease, view: larger }
        : { lease: smallerLease, view: smaller }
      await first.view.cleanup()
      await first.lease.release()
      expect(runtime.messages.size).toBe(75)

      await last.view.cleanup()
      await last.lease.release()
      await vi.waitFor(() => expect(runtime.messages.size).toBe(0))
      expect(runtime.queryClient.getQueryData(messageRowsQueryKey(
        runtime.demand.scope,
        runtime.demand.tag,
        runtime.demand.sequence,
      ))).toBeUndefined()
      expect(runtime.queryClient.getQueryData(messagePagesQueryKey(
        runtime.demand.scope,
        runtime.demand.tag,
        runtime.demand.sequence,
      ))).toBeUndefined()
      expect(apiFetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it("keeps anchor older/newer acquisitions independent and follows empty nonterminal pages", async () => {
    apiFetchMock.mockImplementation(async (url): Promise<MessagesPage> => {
      const href = String(url)
      if (href.includes("since=newer-empty")) {
        return { messages: [], hasMoreNewer: true, newerCursor: "newer-last" }
      }
      if (href.includes("since=newer-last")) {
        return { messages: [message(5)], hasMoreNewer: false }
      }
      if (href.includes("cursor=older-last")) {
        return { messages: [message(1)], hasMoreOlder: false }
      }
      return {
        messages: [message(2), message(3), message(4)],
        hasMoreOlder: true,
        olderCursor: "older-last",
        hasMoreNewer: true,
        newerCursor: "newer-empty",
      }
    })
    const runtime = setup({ anchor: "m3" })
    cleanups.push(runtime.cleanup)
    const olderLease = runtime.descriptor.acquireWindow(runtime.demand, 3)
    const newerDemand = {
      ...runtime.demand,
      sequence: { ...runtime.demand.sequence, direction: "newer" as const },
    }
    const newerLease = runtime.descriptor.acquireWindow(newerDemand, 3)
    const older = runtime.view("older", 3)
    const newer = runtime.view("newer", 3)

    await Promise.all([older.preload(), newer.preload()])

    expect([...runtime.messages.values()].map((row) => row.id).sort()).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ])
    expect(apiFetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      "/api/community/channels/channel/messages?anchor=m3",
      "/api/community/channels/channel/messages?cursor=older-last",
      "/api/community/channels/channel/messages?since=newer-empty",
      "/api/community/channels/channel/messages?since=newer-last",
    ]))
    expect(apiFetchMock).toHaveBeenCalledTimes(5)
    await Promise.all([olderLease.release(), newerLease.release()])
  })

  it("reconciles every active sequence through its stable canonical owner", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ messages: [message(1)], hasMore: false, latestSeq: 1 })
      .mockResolvedValueOnce({
        messages: [{ ...message(1), content: "edited" }, message(2)],
        hasMore: false,
        latestSeq: 2,
      })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquireWindow(runtime.demand, 50)
    const leaf = runtime.view("older", 50)
    await leaf.preload()
    runtime.descriptor.markChanged("stale-direct-change", "channel", true)

    await runtime.descriptor.reconcileScope("server-channel", "channel")

    await vi.waitFor(() => expect(runtime.messages.get("m2")?.content).toBe("message 2"))
    expect(runtime.messages.get("m1")?.content).toBe("edited")
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    await lease.release()
  })

  it("resets both sides of an anchored demand through their active owners", async () => {
    apiFetchMock.mockResolvedValue({
      messages: [message(1)],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    })
    const runtime = setup({ anchor: "m1" })
    cleanups.push(runtime.cleanup)
    const newerDemand = {
      ...runtime.demand,
      sequence: { ...runtime.demand.sequence, direction: "newer" as const },
    }
    const olderLease = runtime.descriptor.acquireWindow(runtime.demand, 26)
    const newerLease = runtime.descriptor.acquireWindow(newerDemand, 26)
    const older = runtime.view("older", 26)
    const newer = runtime.view("newer", 26)
    await Promise.all([older.preload(), newer.preload()])
    const cancel = vi.spyOn(runtime.queryClient, "cancelQueries")

    await runtime.descriptor.resetDemand(runtime.demand)

    expect(cancel.mock.calls).toHaveLength(4)
    await Promise.all([olderLease.release(), newerLease.release()])
  })

  it("keeps an exact write that lands while a stale reconcile is in flight", async () => {
    let resolveReconcile!: (page: MessagesPage) => void
    const reconcilePage = new Promise<MessagesPage>((resolve) => {
      resolveReconcile = resolve
    })
    apiFetchMock
      .mockResolvedValueOnce({ messages: [message(1)], hasMore: false, latestSeq: 1 })
      .mockReturnValueOnce(reconcilePage)
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquireWindow(runtime.demand, 50)
    const leaf = runtime.view("older", 50)
    await leaf.preload()

    const reconcile = runtime.descriptor.reconcileScope("server-channel", "channel")
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    runtime.descriptor.markChanged("m1", "channel")
    runtime.messages.utils.writeUpsert({
      ...message(1),
      channelId: "channel",
      content: "exact WS value",
    })
    await vi.waitFor(() => {
      expect(runtime.messages.get("m1")?.content).toBe("exact WS value")
    })
    resolveReconcile({
      messages: [{ ...message(1), content: "stale HTTP value" }],
      hasMore: false,
      latestSeq: 1,
    })
    await reconcile

    expect(runtime.messages.get("m1")?.content).toBe("exact WS value")
    await lease.release()
  })

  it("applies an absent-row exact patch when an older reconcile later supplies the row", async () => {
    let resolveReconcile!: (page: MessagesPage) => void
    const reconcilePage = new Promise<MessagesPage>((resolve) => {
      resolveReconcile = resolve
    })
    apiFetchMock
      .mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
      .mockReturnValueOnce(reconcilePage)
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquireWindow(runtime.demand, 50)
    const leaf = runtime.view("older", 50)
    await leaf.preload()

    const reconcile = runtime.descriptor.reconcileScope("server-channel", "channel")
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    runtime.descriptor.markChanged(
      "m1",
      "channel",
      false,
      (row) => ({ ...row, content: "exact WS value" }),
    )
    resolveReconcile({
      messages: [{ ...message(1), content: "stale HTTP value" }],
      hasMore: false,
      latestSeq: 1,
    })
    await reconcile

    expect(runtime.messages.get("m1")?.content).toBe("exact WS value")
    await lease.release()
  })

  it("keeps manual canonical upserts out of the cursor-page namespace", async () => {
    apiFetchMock.mockResolvedValue({ messages: [message(1)], hasMore: false, latestSeq: 1 })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    const lease = runtime.descriptor.acquireWindow(runtime.demand, 50)
    const leaf = runtime.view("older", 50)
    await leaf.preload()
    const pageKey = messagePagesQueryKey(
      runtime.demand.scope,
      runtime.demand.tag,
      runtime.demand.sequence,
    )
    const before = runtime.queryClient.getQueryData(pageKey)

    runtime.messages.utils.writeUpsert({
      ...message(99),
      channelId: "channel",
    })

    expect(runtime.queryClient.getQueryData(pageKey)).toEqual(before)
    expect(runtime.messages.get("m99")).toBeDefined()
    await lease.release()
  })

  it("purges every row/page resource owner for a revoked message scope", async () => {
    apiFetchMock.mockResolvedValue({ messages: [message(1)], hasMore: false, latestSeq: 1 })
    const runtime = setup()
    cleanups.push(runtime.cleanup)
    runtime.descriptor.acquireWindow(runtime.demand, 50)
    const leaf = runtime.view("older", 50)
    await leaf.preload()

    await runtime.descriptor.purgeScope("channel")

    expect(runtime.queryClient.getQueryData(messageRowsQueryKey(
      runtime.demand.scope,
      runtime.demand.tag,
      runtime.demand.sequence,
    ))).toBeUndefined()
    expect(runtime.queryClient.getQueryData(messagePagesQueryKey(
      runtime.demand.scope,
      runtime.demand.tag,
      runtime.demand.sequence,
    ))).toBeUndefined()
    // Entity deletion belongs to the atomic access-purge transaction; the
    // descriptor owns and removes only its row/page acquisition namespaces.
    expect(runtime.messages.get("m1")).toBeDefined()
  })
})
