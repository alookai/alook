import { describe, expect, it, vi } from "vitest"
import { notifyManager, QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  getCommunityWsProjectionFlushError,
  runCommunityWsProjectionTransaction,
} from "./projection-transaction"
import { invalidateInbox } from "./invalidation-projections"

describe("community WS projection transaction", () => {
  it("has no flush error metadata for primitive or null errors", () => {
    expect(getCommunityWsProjectionFlushError(null)).toBeUndefined()
    expect(getCommunityWsProjectionFlushError("project failed")).toBeUndefined()
  })

  it("executes projections synchronously inside one notification batch", () => {
    const queryClient = new QueryClient()
    const batch = vi.spyOn(notifyManager, "batch")

    try {
      runCommunityWsProjectionTransaction(queryClient, (transaction) => {
        transaction.project(() => queryClient.setQueryData(["entity"], { value: 1 }))
        expect(queryClient.getQueryData(["entity"])).toEqual({ value: 1 })
        transaction.project(() => queryClient.setQueryData<{ value: number }>(
          ["entity"],
          (current) => ({ value: (current?.value ?? 0) + 1 }),
        ))
        expect(queryClient.getQueryData(["entity"])).toEqual({ value: 2 })
      })
      expect(batch).toHaveBeenCalled()
    } finally {
      batch.mockRestore()
    }
  })

  it("deduplicates only identical owner and filter pairs in first-seen order", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const first = { queryKey: ["community", "inbox"] as const }
    const conflict = { queryKey: ["community", "inbox"] as const, exact: true }
    const second = { queryKey: ["community", "servers"] as const, exact: true }

    runCommunityWsProjectionTransaction(queryClient, (transaction) => {
      invalidateInbox(transaction)
      invalidateInbox(transaction)
      transaction.invalidate("inbox", conflict)
      transaction.invalidate("servers", second)
    })

    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      first,
      conflict,
      second,
    ])
  })

  it("upgrades a normal invalidation to one exact fence in either order", async () => {
    for (const order of ["invalidate-first", "fence-first"] as const) {
      const queryClient = new QueryClient()
      const observer = new QueryObserver(queryClient, {
        queryKey: ["community", "servers"], queryFn: async () => "current", initialData: "prior", staleTime: Infinity,
      })
      const unsubscribe = observer.subscribe(() => {})
      const cancel = vi.spyOn(queryClient, "cancelQueries").mockResolvedValue()
      const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
      const refetch = vi.spyOn(queryClient, "fetchQuery").mockResolvedValue("current")
      const filters = { queryKey: ["community", "servers"] as const, exact: true }

      runCommunityWsProjectionTransaction(queryClient, (transaction) => {
        if (order === "invalidate-first") transaction.invalidate("servers-list", filters)
        transaction.fence("servers-list", filters)
        if (order === "fence-first") transaction.invalidate("servers-list", filters)
      })
      await vi.waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))

      expect(cancel).toHaveBeenCalledTimes(1)
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ ...filters, refetchType: "none", predicate: expect.any(Function) }))
      expect(refetch).toHaveBeenCalledWith(expect.objectContaining({ queryKey: filters.queryKey, staleTime: 0 }))
      unsubscribe()
      queryClient.clear()
    }
  })

  it("starts cancellation before projection and waits for it before refetch", async () => {
    const queryClient = new QueryClient()
    const observer = new QueryObserver(queryClient, {
      queryKey: ["community", "servers"], queryFn: async () => "current", initialData: "prior", staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    let release!: () => void
    const cancellation = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    vi.spyOn(queryClient, "cancelQueries").mockImplementation(() => {
      order.push("cancel")
      return cancellation
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async () => {
      order.push("invalidate")
    })
    vi.spyOn(queryClient, "fetchQuery").mockImplementation(async () => {
      order.push("refetch")
      return "current"
    })

    runCommunityWsProjectionTransaction(queryClient, (transaction) => {
      transaction.fence("servers-list", { queryKey: ["community", "servers"], exact: true })
      transaction.project(() => order.push("project"))
    })
    expect(order).toEqual(["cancel", "project"])
    expect(invalidate).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => expect(order).toContain("refetch"))
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(order).toEqual(["cancel", "project", "invalidate", "refetch"])
    unsubscribe()
    queryClient.clear()
  })

  it("upgrades one owner/filter entry and replaces each active query exactly once", async () => {
    const queryClient = new QueryClient()
    const prefix = ["community", "channel", "forum_1", "threads"] as const
    const allQuery = vi.fn(async () => ({ page: "all" }))
    const archivedQuery = vi.fn(async () => ({ page: "archived" }))
    const allObserver = new QueryObserver(queryClient, {
      queryKey: [...prefix, "feed", null],
      queryFn: allQuery,
      initialData: { page: "all" },
      staleTime: Infinity,
    })
    const archivedObserver = new QueryObserver(queryClient, {
      queryKey: [...prefix, "feed", "archived"],
      queryFn: archivedQuery,
      initialData: { page: "archived" },
      staleTime: Infinity,
    })
    const unsubscribeAll = allObserver.subscribe(() => {})
    const unsubscribeArchived = archivedObserver.subscribe(() => {})
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    try {
      runCommunityWsProjectionTransaction(queryClient, (transaction) => {
        transaction.invalidate("threads", { queryKey: prefix })
        transaction.fence("threads", { queryKey: prefix })
      })

      await vi.waitFor(() => {
        expect(allQuery).toHaveBeenCalledTimes(1)
        expect(archivedQuery).toHaveBeenCalledTimes(1)
      })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(invalidate).toHaveBeenCalledTimes(1)
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: prefix, refetchType: "none", predicate: expect.any(Function) }))
    } finally {
      unsubscribeAll()
      unsubscribeArchived()
    }
  })

  it("absorbs a rejected active replacement while preserving its query error state", async () => {
    const queryClient = new QueryClient()
    const prefix = ["community", "channel", "forum_1", "threads"] as const
    const failure = new Error("probe-refetch-failed")
    const queryFn = vi.fn().mockRejectedValue(failure)
    const observer = new QueryObserver(queryClient, {
      queryKey: [...prefix, "feed", null],
      queryFn,
      initialData: { page: "all" },
      staleTime: Infinity,
      retry: false,
    })
    const unsubscribe = observer.subscribe(() => {})
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)

    try {
      runCommunityWsProjectionTransaction(queryClient, (transaction) => {
        transaction.fence("threads", { queryKey: prefix })
      })

      await vi.waitFor(() => {
        expect(queryFn).toHaveBeenCalledOnce()
        expect(observer.getCurrentResult()).toMatchObject({
          status: "error",
          error: failure,
        })
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(cancel).toHaveBeenCalledOnce()
      expect(invalidate).toHaveBeenCalledOnce()
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: prefix, refetchType: "none", predicate: expect.any(Function) }))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", unhandled)
      unsubscribe()
    }
  })

  it.each(["removed", "replaced", "unobserved", "retired"] as const)("does not hand a fenced read to a %s owner", async (race) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = ["original-read"]
    const read = vi.fn(async () => "fresh")
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read, initialData: "prior", staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cancel = client.cancelQueries.bind(client)
    vi.spyOn(client, "cancelQueries").mockImplementation(async (...args) => { await cancel(...args); await gate })
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const replacementRead = vi.fn(async () => "replacement-fresh")
    let unsubscribeReplacement: (() => void) | undefined
    let current = true
    try {
      runCommunityWsProjectionTransaction(client, (transaction) => {
        transaction.fence("original", { queryKey: key, exact: true }, () => current)
      })
      if (race === "unobserved") unsubscribe()
      else if (race === "retired") current = false
      else {
        client.removeQueries({ queryKey: key, exact: true })
        if (race === "replaced") {
          const replacement = new QueryObserver(client, {
            queryKey: key, queryFn: replacementRead, initialData: "replacement", staleTime: Infinity,
          })
          unsubscribeReplacement = replacement.subscribe(() => {})
        }
      }
      release()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(read).not.toHaveBeenCalled()
      expect(replacementRead).not.toHaveBeenCalled()
      if (race === "removed") expect(client.getQueryState(key)).toBeUndefined()
      if (race === "replaced") expect(client.getQueryState(key)).toMatchObject({ data: "replacement", isInvalidated: false })
      if (race === "retired") expect(invalidate).not.toHaveBeenCalled()
    } finally { unsubscribe(); unsubscribeReplacement?.(); client.clear() }
  })

  it("uses the latest eligibility when a batch fences the same original Query twice", async () => {
    const client = new QueryClient()
    const key = ["current-generation"]
    const read = vi.fn(async () => "fresh")
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read, initialData: "prior", staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    const cancel = vi.spyOn(client, "cancelQueries")
    try {
      runCommunityWsProjectionTransaction(client, (transaction) => {
        transaction.fence("current", { queryKey: key, exact: true }, () => false)
        transaction.fence("current", { queryKey: key, exact: true }, () => true)
      })
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
      expect(cancel).toHaveBeenCalledOnce()
      expect(observer.getCurrentResult().data).toBe("fresh")
    } finally { unsubscribe(); client.clear() }
  })

  it("rechecks eligibility after invalidation before starting the replacement transport", async () => {
    const client = new QueryClient()
    const key = ["retired-during-invalidation"]
    const read = vi.fn(async () => "fresh")
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read, initialData: "prior", staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => {})
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const invalidate = client.invalidateQueries.bind(client)
    const held = vi.spyOn(client, "invalidateQueries").mockImplementation(async (...args) => { await invalidate(...args); await gate })
    let current = true
    try {
      runCommunityWsProjectionTransaction(client, (transaction) => {
        transaction.fence("current", { queryKey: key, exact: true }, () => current)
      })
      await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
      current = false
      release()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(read).not.toHaveBeenCalled()
    } finally { unsubscribe(); client.clear() }
  })

  it("flushes queued invalidations when projection fails", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const projectError = new Error("project failed")

    expect(() => runCommunityWsProjectionTransaction(queryClient, (transaction) => {
      transaction.invalidate("inbox", { queryKey: ["community", "inbox"] })
      throw projectError
    })).toThrow(projectError)

    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it("preserves the projection error when the invalidation flush also throws", () => {
    const queryClient = new QueryClient()
    const projectError = new Error("project failed")
    const flushError = new Error("flush failed")
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => {
      throw flushError
    })

    expect(() => runCommunityWsProjectionTransaction(queryClient, (transaction) => {
      transaction.invalidate("inbox", { queryKey: ["community", "inbox"] })
      throw projectError
    })).toThrow(projectError)
    expect(getCommunityWsProjectionFlushError(projectError)).toBe(flushError)
  })

  it("throws a flush error when projection succeeds", () => {
    const queryClient = new QueryClient()
    const flushError = new Error("flush failed")
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => {
      throw flushError
    })

    expect(() => runCommunityWsProjectionTransaction(queryClient, (transaction) => {
      transaction.invalidate("inbox", { queryKey: ["community", "inbox"] })
    })).toThrow(flushError)
  })
})
