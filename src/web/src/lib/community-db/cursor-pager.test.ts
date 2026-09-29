import { QueryClient } from "@tanstack/query-core"
import { describe, expect, it, vi } from "vitest"
import { createCursorPager, type CursorPage } from "./cursor-pager"

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("condition was not reached")
}

describe("vendored createCursorPager on Query Core 5.103.2", () => {
  it("reuses a fresh prefix and fetches only the missing suffix", async () => {
    const queryClient = client()
    const calls: Array<string | undefined> = []
    const fetchPage = vi.fn(async (cursor: string | undefined): Promise<CursorPage<number>> => {
      calls.push(cursor)
      return cursor === undefined
        ? { rows: [1, 2], nextCursor: "two" }
        : { rows: [3, 4], nextCursor: null }
    })
    const pager = createCursorPager({
      queryClient,
      queryKey: ["pager", "fresh"],
      staleTime: Infinity,
      fetchPage,
    })

    await expect(pager.read({ limit: 2 })).resolves.toEqual([1, 2])
    await expect(pager.read({ limit: 4 })).resolves.toEqual([1, 2, 3, 4])
    await expect(pager.read({ offset: 1, limit: 2 })).resolves.toEqual([2, 3])
    expect(calls).toEqual([undefined, "two"])
  })

  it("refreshes the complete loaded prefix when stale", async () => {
    const queryClient = client()
    let version = 0
    const calls: Array<string | undefined> = []
    const pager = createCursorPager({
      queryClient,
      queryKey: ["pager", "stale"],
      staleTime: 0,
      fetchPage: async (cursor) => {
        calls.push(cursor)
        if (cursor === undefined) {
          version += 1
          return { rows: [version * 10 + 1], nextCursor: "tail" }
        }
        return { rows: [version * 10 + 2], nextCursor: null }
      },
    })

    await expect(pager.read({ limit: 2 })).resolves.toEqual([11, 12])
    await expect(pager.read({ limit: 2 })).resolves.toEqual([21, 22])
    expect(calls).toEqual([undefined, "tail", undefined, "tail"])
  })

  it("honors zero and omitted limits and continues through short empty pages", async () => {
    const queryClient = client()
    const calls: Array<string | undefined> = []
    const pager = createCursorPager({
      queryClient,
      queryKey: ["pager", "empty"],
      staleTime: Infinity,
      fetchPage: async (cursor) => {
        calls.push(cursor)
        if (cursor === undefined) return { rows: [], nextCursor: "empty" }
        if (cursor === "empty") return { rows: [1], nextCursor: "short" }
        return { rows: [2, 3], nextCursor: null }
      },
    })

    await expect(pager.read({ limit: 0 })).resolves.toEqual([])
    expect(calls).toEqual([])
    await expect(pager.read({})).resolves.toEqual([1, 2, 3])
    expect(calls).toEqual([undefined, "empty", "short"])
  })

  it("rejects repeated and malformed continuation cursors before success", async () => {
    const repeated = createCursorPager({
      queryClient: client(),
      queryKey: ["pager", "repeated"],
      staleTime: Infinity,
      fetchPage: async (cursor) => cursor === undefined
        ? { rows: [1], nextCursor: "same" }
        : { rows: [2], nextCursor: "same" },
    })
    await expect(repeated.read({ limit: 2 })).rejects.toThrow("repeated")

    const malformed = createCursorPager({
      queryClient: client(),
      queryKey: ["pager", "malformed"],
      staleTime: Infinity,
      fetchPage: async () => ({ rows: [], nextCursor: 42 }) as unknown as CursorPage<number>,
    })
    await expect(malformed.read({ limit: 1 })).rejects.toThrow("Invalid cursor page")
  })

  it("aborting one reader does not cancel the shared transport", async () => {
    const queryClient = client()
    let resolvePage!: (page: CursorPage<number>) => void
    let transportAborted = false
    let calls = 0
    const pager = createCursorPager({
      queryClient,
      queryKey: ["pager", "reader-abort"],
      staleTime: Infinity,
      fetchPage: async (_cursor, signal) => {
        calls += 1
        signal.addEventListener("abort", () => { transportAborted = true }, { once: true })
        return new Promise((resolve) => { resolvePage = resolve })
      },
    })
    const reader = new AbortController()
    const abandoned = pager.read({ limit: 1 }, reader.signal)
    await waitFor(() => calls === 1)
    reader.abort()
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" })
    expect(transportAborted).toBe(false)
    resolvePage({ rows: [1], nextCursor: null })
    await expect(pager.read({ limit: 1 })).resolves.toEqual([1])
    expect(calls).toBe(1)
  })

  it("Query cancellation cancels transport and rejects acquisition as AbortError", async () => {
    const queryClient = client()
    const queryKey = ["pager", "transport-abort"] as const
    let transportAborted = false
    let calls = 0
    const pager = createCursorPager({
      queryClient,
      queryKey,
      staleTime: Infinity,
      fetchPage: async (_cursor, signal) => {
        calls += 1
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            transportAborted = true
            reject(signal.reason)
          }, { once: true })
        })
      },
    })
    const acquisition = pager.read({ limit: 1 })
    await waitFor(() => calls === 1)
    await queryClient.cancelQueries({ queryKey, exact: true })

    await expect(acquisition).rejects.toMatchObject({ name: "AbortError" })
    expect(transportAborted).toBe(true)
  })

  it("reset removes cached pages and invalidates queued reads", async () => {
    const queryClient = client()
    const queryKey = ["pager", "reset"] as const
    let calls = 0
    const pager = createCursorPager({
      queryClient,
      queryKey,
      staleTime: Infinity,
      fetchPage: async () => ({ rows: [++calls], nextCursor: null }),
    })
    await expect(pager.read({ limit: 1 })).resolves.toEqual([1])
    pager.reset()
    expect(queryClient.getQueryData(queryKey)).toBeUndefined()
    await expect(pager.read({ limit: 1 })).resolves.toEqual([2])
  })

  it("reset rejects an acquisition that was already queued", async () => {
    const queryClient = client()
    const queryKey = ["pager", "queued-reset"] as const
    let resolvePage!: (page: CursorPage<number>) => void
    const pager = createCursorPager({
      queryClient,
      queryKey,
      staleTime: Infinity,
      fetchPage: async () => new Promise((resolve) => { resolvePage = resolve }),
    })
    const first = pager.read({ limit: 1 })
    const queued = pager.read({ limit: 1 })
    await waitFor(() => typeof resolvePage === "function")

    pager.reset()
    resolvePage({ rows: [1], nextCursor: null })

    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(queued).rejects.toMatchObject({ name: "AbortError" })
  })

  it.each([
    { offset: -1, limit: 1 },
    { offset: 0.5, limit: 1 },
    { offset: Number.MAX_SAFE_INTEGER, limit: 1 },
  ])("rejects the invalid window %o", async (window) => {
    const pager = createCursorPager({
      queryClient: client(),
      queryKey: ["pager", "invalid-window", JSON.stringify(window)],
      staleTime: Infinity,
      fetchPage: async () => ({ rows: [1], nextCursor: null }),
    })

    await expect(pager.read(window)).rejects.toThrow(
      "Expected a nonnegative finite integer window",
    )
  })

  it("rejects an empty cached cursor sequence", async () => {
    const queryClient = client()
    const queryKey = ["pager", "empty-cached-sequence"] as const
    queryClient.setQueryData(queryKey, { pages: [], pageParams: [] })
    const pager = createCursorPager({
      queryClient,
      queryKey,
      staleTime: Infinity,
      fetchPage: async () => ({ rows: [1], nextCursor: null }),
    })

    await expect(pager.read({ limit: 1 })).rejects.toThrow(
      "Invalid cursor page: empty cached sequence",
    )
  })

  it("follows the replacement transport after a silent cancelling refetch", async () => {
    const queryClient = client()
    const queryKey = ["pager", "replacement"] as const
    queryClient.setQueryData(queryKey, {
      pages: [{ rows: [0], nextCursor: null }],
      pageParams: [undefined],
    })
    const resolvers: Array<(page: CursorPage<number>) => void> = []
    let calls = 0
    const pager = createCursorPager({
      queryClient,
      queryKey,
      staleTime: 0,
      fetchPage: async (_cursor, signal) => {
        calls += 1
        return new Promise((resolve, reject) => {
          resolvers.push(resolve)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    })
    const acquisition = pager.read({ limit: 1 })
    await waitFor(() => calls === 1)

    const replacement = queryClient.refetchQueries(
      { queryKey, exact: true },
      { cancelRefetch: true },
    )
    await waitFor(() => calls === 2)
    resolvers[1]!({ rows: [2], nextCursor: null })

    await expect(acquisition).resolves.toEqual([2])
    await expect(replacement).resolves.toBeUndefined()
  })

  it("shares one Query acquisition across pager instances", async () => {
    const queryClient = client()
    const queryKey = ["pager", "shared"] as const
    let resolvePage!: (page: CursorPage<number>) => void
    let calls = 0
    const fetchPage = async () => {
      calls += 1
      return new Promise<CursorPage<number>>((resolve) => { resolvePage = resolve })
    }
    const first = createCursorPager({ queryClient, queryKey, staleTime: Infinity, fetchPage })
    const second = createCursorPager({ queryClient, queryKey, staleTime: Infinity, fetchPage })
    const reads = [first.read({ limit: 1 }), second.read({ limit: 1 })]
    await waitFor(() => calls === 1)
    resolvePage({ rows: [7], nextCursor: null })

    await expect(Promise.all(reads)).resolves.toEqual([[7], [7]])
    expect(calls).toBe(1)
  })

  it("returns the exact ordered slice without leaking prefix or suffix rows", async () => {
    const pager = createCursorPager({
      queryClient: client(),
      queryKey: ["pager", "slice"],
      staleTime: Infinity,
      fetchPage: async (cursor) => cursor === undefined
        ? { rows: [1, 2, 3], nextCursor: "next" }
        : { rows: [4, 5, 6], nextCursor: null },
    })
    await expect(pager.read({ offset: 2, limit: 3 })).resolves.toEqual([3, 4, 5])
  })
})
