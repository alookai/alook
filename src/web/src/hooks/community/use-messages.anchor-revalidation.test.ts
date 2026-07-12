import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useMessages } from "./use-messages"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

function Capture({ onRender, channelId, lastReadMessageId }: {
  onRender: (messageIds: string[]) => void
  channelId: string | null
  lastReadMessageId?: string | null
}) {
  const result = useMessages(channelId, { lastReadMessageId })
  onRender(result.messages.map((m) => m.id))
  return null
}

async function flush(ms = 50) {
  // Let queued microtasks (the mocked fetch's resolved promise, TanStack's
  // internal state updates, the `.then()` in Fix 3's out-of-band merge)
  // settle between renders.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

// Poll until `predicate` holds (or we give up), advancing timers each round.
// The out-of-band merge chain (mocked fetch `setTimeout(20)` → `.then()` →
// `setQueryData` → re-render) can take longer than a single fixed `flush(50)`
// on a slow/coarse-timer CI runner (this test was Windows-flaky under a bare
// `flush()`); polling makes the wait environment-independent instead of
// betting on a fixed sleep.
async function waitForSettled(predicate: () => boolean, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await flush(10)
  }
}

describe("useMessages — Fix 3 anchor re-validation", () => {
  it("fresh cache with a drifted anchor: merges the new anchor page into the already-loaded history instead of discarding it", async () => {
    // `staleTime: Infinity` — without this, mounting a new observer over
    // already-cached data triggers TanStack's own implicit refetch-on-mount
    // (default staleTime is 0), which would race with and consume the
    // mocked fetch response meant for Fix 3's own decision path. That
    // implicit refetch is real production behavior but orthogonal to what
    // this test isolates: Fix 3's stale-vs-fresh branch choice.
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const key = communityKeys.channelMessages("ch_1")

    // Pre-seed the cache as if the channel had already loaded a window not
    // containing "m_new_anchor" — and mark it as freshly fetched (`dataUpdatedAt`
    // well within STALE_HYDRATED_CACHE_MS), simulating "returned from a
    // Thread after the watermark advanced" rather than a stale IDB hydration.
    // Explicit timestamps OLDER than the new anchor page's — these rows must
    // survive the merge and sort BEFORE the new page's rows.
    queryClient.setQueryData(key, {
      pages: [{
        messages: [
          { id: "m_old_1", createdAt: "2026-06-30T23:59:58.000Z" },
          { id: "m_old_2", createdAt: "2026-06-30T23:59:59.000Z" },
        ],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ mode: "anchor", anchor: "m_old_anchor" }],
    })

    // `mergeMessagesPages` sorts by (createdAt, id) — stamp explicit
    // timestamps so the resulting order isn't an accident of id string
    // comparison. Resolves on a real delay (not immediately) so React
    // commits the pre-fetch render as its own frame — a synchronously
    // resolving mock lets React batch the "cleared to empty" and "refetch
    // landed" updates into a single commit, hiding the very regression
    // this test exists to catch (see the intermediate-blank-frame
    // assertion below).
    apiFetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        messages: [
          { id: "m_new_1", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_new_anchor", createdAt: "2026-07-01T00:00:02.000Z" },
          { id: "m_new_2", createdAt: "2026-07-01T00:00:03.000Z" },
        ],
        hasMoreOlder: true,
        hasMoreNewer: true,
      }), 20)),
    )

    const renderedMessageIds: string[][] = []
    act(() => {
      TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            onRender: (ids) => { renderedMessageIds.push(ids) },
            channelId: "ch_1",
            lastReadMessageId: "m_new_anchor",
          }),
        ),
      )
    })

    // Wait until the out-of-band merge has landed (5 rows) rather than a fixed
    // sleep — see `waitForSettled`.
    await waitForSettled(() => (renderedMessageIds.at(-1)?.length ?? 0) === 5)

    // The old (valid) window must never be cleared to empty at any point in
    // between — every render either shows the old window or the merged one,
    // never a 0-length list. `resetQueries` would fail this: it clears
    // `pages` to `undefined` synchronously (one render with 0 messages)
    // before the refetch resolves.
    for (const ids of renderedMessageIds) {
      expect(ids.length).toBeGreaterThan(0)
    }
    // The final, settled render shows the OLD history merged with the NEW
    // anchor window — proving the previously-loaded pages survive the
    // re-anchor instead of being discarded wholesale.
    expect(renderedMessageIds.at(-1)).toEqual([
      "m_old_1", "m_old_2", "m_new_1", "m_new_anchor", "m_new_2",
    ])
    // Exactly one out-of-band fetch — no `resetQueries`-triggered refetch
    // through the normal queryFn path.
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/ch_1/messages?anchor=m_new_anchor",
    )
  })

  it("fresh cache with THREE pages (anchor + two fetchOlder pages): merge keeps every page's messages, not just the newest fetch", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const key = communityKeys.channelMessages("ch_multi")

    // Simulate a user who scrolled up and loaded two older pages via
    // `fetchOlder`, in addition to the original anchor-window page. Pages
    // are stored oldest-last per this hook's `getNextPageParam` convention
    // (`pages[0]` = anchor/newest, later pages = progressively older).
    queryClient.setQueryData(key, {
      pages: [
        { messages: [{ id: "m_anchor_old", createdAt: "2026-07-01T00:00:05.000Z" }], hasMoreOlder: true, hasMoreNewer: false },
        { messages: [{ id: "m_older_1", createdAt: "2026-07-01T00:00:03.000Z" }], hasMoreOlder: true, hasMoreNewer: false },
        { messages: [{ id: "m_older_2", createdAt: "2026-07-01T00:00:01.000Z" }], hasMoreOlder: false, hasMoreNewer: false },
      ],
      pageParams: [
        { mode: "anchor", anchor: "m_anchor_old" },
        { mode: "older", cursor: "x" },
        { mode: "older", cursor: "y" },
      ],
    })

    apiFetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        messages: [{ id: "m_new_anchor", createdAt: "2026-07-01T00:00:10.000Z" }],
        hasMoreOlder: true,
        hasMoreNewer: true,
      }), 20)),
    )

    const renderedMessageIds: string[][] = []
    act(() => {
      TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            onRender: (ids) => { renderedMessageIds.push(ids) },
            channelId: "ch_multi",
            lastReadMessageId: "m_new_anchor",
          }),
        ),
      )
    })

    // Wait until the merge has folded in the new anchor (4 rows total).
    await waitForSettled(() => (renderedMessageIds.at(-1)?.length ?? 0) === 4)

    // All three pre-existing pages' messages must survive the merge — this
    // is the exact regression the user hit: scrolling up loads history via
    // `fetchOlder`, then a later Fix 3 re-anchor must not silently drop it.
    const finalIds = renderedMessageIds.at(-1)
    expect(finalIds).toContain("m_older_1")
    expect(finalIds).toContain("m_older_2")
    expect(finalIds).toContain("m_anchor_old")
    expect(finalIds).toContain("m_new_anchor")
    expect(finalIds).toEqual([
      "m_older_2", "m_older_1", "m_anchor_old", "m_new_anchor",
    ])
    // Merge collapses to a single page.
    const cache = queryClient.getQueryData(key) as { pages: unknown[] } | undefined
    expect(cache?.pages.length).toBe(1)
  })

  it("stale cache with a drifted anchor: swaps in the fresh anchor window WITHOUT ever clearing to an empty list", async () => {
    // `staleTime: Infinity` — without this, mounting a new observer over
    // already-cached data triggers TanStack's own implicit refetch-on-mount
    // (default staleTime is 0), which would race with and consume the
    // mocked fetch response meant for Fix 3's own decision path. That
    // implicit refetch is real production behavior but orthogonal to what
    // this test isolates: Fix 3's stale-vs-fresh branch choice.
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const key = communityKeys.channelMessages("ch_2")

    queryClient.setQueryData(key, {
      pages: [{ messages: [{ id: "m_old_1", createdAt: "2026-06-30T00:00:00.000Z" }], hasMoreOlder: false, hasMoreNewer: false }],
      pageParams: [{ mode: "anchor", anchor: "m_old_anchor" }],
    })
    // Force `dataUpdatedAt` far in the past — well beyond STALE_HYDRATED_CACHE_MS
    // (30s) — simulating a cross-session IDB-hydrated cache.
    const state = queryClient.getQueryState(key)
    if (state) state.dataUpdatedAt = Date.now() - 60_000

    // Resolve on a real delay (not synchronously) so React commits the
    // pre-swap render as its own frame — otherwise React batches the "old
    // window" and "fresh window" updates into one commit and hides the very
    // empty-frame regression this test guards against. See the fresh-cache
    // test above for the same rationale.
    apiFetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        messages: [{ id: "m_fresh_anchor", createdAt: "2026-07-01T00:00:00.000Z" }],
        hasMoreOlder: true,
        hasMoreNewer: false,
      }), 20)),
    )

    const renderedMessageIds: string[][] = []
    act(() => {
      TestRenderer.create(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Capture, {
            onRender: (ids) => { renderedMessageIds.push(ids) },
            channelId: "ch_2",
            lastReadMessageId: "m_fresh_anchor",
          }),
        ),
      )
    })

    // Wait until the fresh anchor window has replaced the stale one.
    await waitForSettled(() => renderedMessageIds.at(-1)?.[0] === "m_fresh_anchor")

    // The stale window must never clear to empty mid-mount — that empty
    // frame is what surfaced as the "second skeleton flash then jump to the
    // top hero" bug. `resetQueries` (the old behavior) clears `pages` to
    // `undefined` synchronously (one 0-length render) before the refetch
    // lands; this assertion fails under that path.
    for (const ids of renderedMessageIds) {
      expect(ids.length).toBeGreaterThan(0)
    }
    // The stale cross-session window is untrustworthy, so the fresh anchor
    // page REPLACES it (unlike the fresh-drift case, which merges) — the
    // final render shows only the refetched window.
    expect(renderedMessageIds.at(-1)).toEqual(["m_fresh_anchor"])
    // Fix 3 fetched the fresh anchor window out of band via the queryFn.
    // (A second `?anchor=m_old_anchor` fetch may also fire — that's Fix 4's
    // independent mount-time `invalidateQueries` re-running the persisted
    // stale pageParam. Both keep the previous data on screen during the
    // refetch; neither is a `resetQueries` empty-clear, which is what this
    // test's per-render `length > 0` assertion above guards against.)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/ch_2/messages?anchor=m_fresh_anchor",
    )
  })
})
