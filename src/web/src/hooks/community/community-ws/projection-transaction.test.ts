import { describe, expect, it, vi } from "vitest"
import { notifyManager, QueryClient } from "@tanstack/react-query"
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
