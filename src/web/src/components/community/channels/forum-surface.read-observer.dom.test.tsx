import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { forumConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { profileResourceFixture } from "@/test/community-resource-fixtures"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize } from "@/test/message-scroll-fixture"
import { communityKeys } from "@/lib/query-keys"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { READ_COORDINATOR_DEBOUNCE_MS } from "@/hooks/community/read-coordinator"
import { ForumSurface } from "./forum-surface"

const apiFetchMock = vi.hoisted(() => vi.fn())
const currentUser = vi.hoisted(() => ({ id: "viewer", name: "Viewer", avatar: "V" }))

vi.mock("@/lib/api/client", async (original) => ({
  ...(await original<typeof import("@/lib/api/client")>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => currentUser,
}))
vi.mock("@/hooks/community/use-channel-panels", () => ({
  useForumTags: () => ({ data: { tags: [] }, isSuccess: true }),
}))
vi.mock("@/hooks/community/community-ws/read-state-reconciliation", () => ({
  reconcileAccountReadState: vi.fn(() => Promise.resolve()),
}))
vi.mock("@/hooks/community/use-account-attention", () => ({
  reconcileAccountAttention: vi.fn(() => Promise.resolve()),
}))

type TrackedIntersectionObserver = {
  callback: IntersectionObserverCallback
  observed: Set<Element>
  disconnected: boolean
}

let intersectionObservers: TrackedIntersectionObserver[] = []

class TrackingIntersectionObserver {
  private readonly record: TrackedIntersectionObserver

  constructor(callback: IntersectionObserverCallback) {
    this.record = {
      callback,
      observed: new Set(),
      disconnected: false,
    }
    intersectionObservers.push(this.record)
  }

  observe(element: Element) {
    this.record.observed.add(element)
  }

  unobserve(element: Element) {
    this.record.observed.delete(element)
  }

  takeRecords() {
    return []
  }

  disconnect() {
    this.record.disconnected = true
    this.record.observed.clear()
  }
}

function activeObserversFor(element: Element) {
  return intersectionObservers.filter((observer) => !observer.disconnected && observer.observed.has(element))
}

function intersect(element: Element, ratio = 1) {
  const active = activeObserversFor(element)
  expect(active.length).toBeGreaterThan(0)
  for (const observer of active) {
    observer.callback(
      [{ target: element, isIntersecting: true, intersectionRatio: ratio, time: performance.now() } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
  }
}

function makeForumEntryWithPosts(posts: Array<{ threadId: string; openerId: string; seq: number; authorId: string; title: string }>, lastReadSeq: number, lastReadMessageId: string | null) {
  const base = forumConversationEntryFixture("forum-1", "s1", false)
  const templateThread = base.forumFeed!.threads[0]!
  const templateOpener = base.forumFeed!.included.messages[0]!
  base.readState = {
    channelId: "forum-1",
    lastReadMessageId,
    lastReadAt: lastReadMessageId ? "2026-10-01T00:00:01.000Z" : null,
    lastReadSeq,
  }
  base.readStateRevision = 10
  base.page = { ...base.page, latestSeq: Math.max(0, ...posts.map((post) => post.seq)) }
  base.forumFeed = {
    ...base.forumFeed!,
    threads: posts.map((post) => ({
      ...templateThread,
      id: post.threadId,
      parentMessageId: post.openerId,
      name: post.title,
      creatorId: post.authorId,
      createdAt: `2026-10-01T00:00:0${post.seq}.000Z`,
      lastMessageAt: `2026-10-01T00:00:0${post.seq}.000Z`,
    })),
    included: {
      ...base.forumFeed!.included,
      messages: posts.map((post) => ({
        ...templateOpener,
        id: post.openerId,
        channelId: "forum-1",
        seq: post.seq,
        authorId: post.authorId,
        content: post.title,
        createdAt: `2026-10-01T00:00:0${post.seq}.000Z`,
      })),
      profiles: [
        profileResourceFixture({ id: "peer", name: "Peer" }),
        profileResourceFixture({ id: "viewer", name: "Viewer" }),
      ],
    },
  }
  return base
}

async function seedForumAttention(
  owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>,
  openerId: string,
  seq: number,
  threadId: string,
) {
  await writeCommunityCollectionRows(owner.registry, "attentionScopes", [{
    scopeId: "forum-1",
    channelId: "forum-1",
    serverId: "s1",
    parentChannelId: null,
    ordinaryUnread: true,
    lastUnreadSeq: seq,
    lastAttentionSeq: seq,
    attentionCount: 1,
  }], (row) => row.scopeId)
  await writeCommunityCollectionRows(owner.registry, "attentionItems", [{
    id: `forum_post:${threadId}`,
    kind: "forum_post",
    sourceId: threadId,
    scopeId: "forum-1",
    messageId: openerId,
    actorUserId: null,
    createdAt: `2026-10-01T00:00:0${seq}.000Z`,
    childChannelId: threadId,
    openerSeq: seq,
    readTarget: { channelId: "forum-1", seq },
  }], (row) => row.id)
}

beforeEach(() => {
  installMessageScrollFixture()
  intersectionObservers = []
  vi.stubGlobal("IntersectionObserver", TrackingIntersectionObserver)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  apiFetchMock.mockReset()
  localStorage.clear()
})

afterEach(() => {
  restoreMessageScrollFixture()
})

describe("ForumSurface real read observer and Inbox sync", () => {
  it("observes posts after transitioning from loading state, sends PUT /read, and clears Inbox forum_post", async () => {
    const owner = await createCommunityQueryOwner("viewer")
    await seedForumAttention(owner, "opener-2", 2, "thread-2")
    const packet = makeForumEntryWithPosts(
      [
        { threadId: "thread-2", openerId: "opener-2", seq: 2, authorId: "peer", title: "Unread foreign post" },
        { threadId: "thread-1", openerId: "opener-1", seq: 1, authorId: "peer", title: "Older read post" },
      ],
      1,
      "opener-1",
    )
    let resolveEntry!: (value: typeof packet) => void
    const readCalls: Array<{ url: string; body: unknown }> = []
    apiFetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/messages?entry=1")) {
        return new Promise((resolve) => { resolveEntry = resolve })
      }
      if (url === "/api/community/channels/forum-1/read" && init?.method === "PUT") {
        readCalls.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
        return Promise.resolve({ changed: true, revision: 11, targetSeq: 2 })
      }
      return Promise.resolve(packet.forumFeed)
    })

    const view = render(
      <CommunityTestProvider {...owner}>
        <ForumSurface serverId="s1" forumChannelId="forum-1" routeTag="" members={[]} onOpenPost={() => {}} />
      </CommunityTestProvider>,
    )
    try {
      const root = view.getByTestId("community-forum-post-list")
      expect(root.firstElementChild).toHaveAttribute("data-message-list-content")
      expect(root.firstElementChild).toHaveAttribute("data-read-position-ready", "false")

      await act(async () => {
        resolveEntry(packet)
        await vi.advanceTimersByTimeAsync(0)
      })
      resize()
      await act(async () => { await Promise.resolve() })

      expect(root.firstElementChild).toHaveAttribute("data-read-position-ready", "true")
      expect(root.querySelector("[data-message-rows]")).not.toBeNull()
      const card = root.querySelector<HTMLElement>('[data-msg-id="opener-2"]')
      expect(card).not.toBeNull()
      expect(activeObserversFor(card!).length).toBeGreaterThan(0)

      await act(async () => {
        intersect(card!)
        await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS + 50)
      })

      expect(readCalls).toEqual([
        { url: "/api/community/channels/forum-1/read", body: { lastReadMessageId: "opener-2" } },
      ])
      expect(owner.registry.collections.attentionItems.get("forum_post:thread-2")).toBeUndefined()
      expect(owner.registry.collections.attentionScopes.get("forum-1")).toBeUndefined()
    } finally {
      view.unmount()
      owner.client.clear()
    }
  })

  it("refreshes a stale cached forumFeed on manual entry, observes the new post, and clears Inbox", async () => {
    const owner = await createCommunityQueryOwner("viewer")
    const stalePacket = makeForumEntryWithPosts(
      [{ threadId: "thread-1", openerId: "opener-1", seq: 1, authorId: "peer", title: "Already read post" }],
      1,
      "opener-1",
    )
    await seedConversationEntry(owner.client, stalePacket, { channelId: "forum-1", serverId: "s1", tag: null })
    await seedForumAttention(owner, "opener-2", 2, "thread-2")

    const freshPacket = makeForumEntryWithPosts(
      [
        { threadId: "thread-2", openerId: "opener-2", seq: 2, authorId: "peer", title: "Fresh unread post" },
        { threadId: "thread-1", openerId: "opener-1", seq: 1, authorId: "peer", title: "Already read post" },
      ],
      1,
      "opener-1",
    )
    let resolveFresh!: (value: typeof freshPacket) => void
    const readCalls: Array<{ url: string; body: unknown }> = []
    apiFetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/messages?entry=1")) {
        return new Promise((resolve) => { resolveFresh = resolve })
      }
      if (url === "/api/community/channels/forum-1/read" && init?.method === "PUT") {
        readCalls.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
        return Promise.resolve({ changed: true, revision: 12, targetSeq: 2 })
      }
      return Promise.resolve(freshPacket.forumFeed)
    })

    const view = render(
      <CommunityTestProvider {...owner}>
        <ForumSurface serverId="s1" forumChannelId="forum-1" routeTag="" members={[]} onOpenPost={() => {}} />
      </CommunityTestProvider>,
    )
    try {
      resize()
      const root = view.getByTestId("community-forum-post-list")
      expect(root.querySelector('[data-msg-id="opener-1"]')).not.toBeNull()
      expect(root.querySelector('[data-msg-id="opener-2"]')).toBeNull()

      await act(async () => {
        resolveFresh(freshPacket)
        await vi.advanceTimersByTimeAsync(0)
      })
      resize()
      await act(async () => { await Promise.resolve() })

      const freshCard = root.querySelector<HTMLElement>('[data-msg-id="opener-2"]')
      expect(freshCard).not.toBeNull()
      expect(activeObserversFor(freshCard!).length).toBeGreaterThan(0)

      await act(async () => {
        intersect(freshCard!)
        await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS + 50)
      })

      expect(readCalls).toEqual([
        { url: "/api/community/channels/forum-1/read", body: { lastReadMessageId: "opener-2" } },
      ])
      expect(owner.registry.collections.attentionItems.get("forum_post:thread-2")).toBeUndefined()
      expect(owner.client.getQueryData<{ pages: Array<{ threads: Array<{ openerMessageId: string | null }> }> }>(communityKeys.forumFeed("forum-1", null))?.pages[0]?.threads.map((t) => t.openerMessageId)).toEqual(["opener-2", "opener-1"])
    } finally {
      view.unmount()
      owner.client.clear()
    }
  })

  it("does not emit PUT /read for own-authored posts or while presentation is not ready", async () => {
    const owner = await createCommunityQueryOwner("viewer")
    const packet = makeForumEntryWithPosts(
      [
        { threadId: "thread-own", openerId: "opener-own", seq: 2, authorId: "viewer", title: "Own post" },
        { threadId: "thread-foreign", openerId: "opener-foreign", seq: 3, authorId: "peer", title: "Foreign post" },
      ],
      1,
      "opener-1",
    )
    const readCalls: Array<{ url: string; body: unknown }> = []
    apiFetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/messages?entry=1")) return Promise.resolve(packet)
      if (url === "/api/community/channels/forum-1/read" && init?.method === "PUT") {
        readCalls.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
        return Promise.resolve({ changed: true, revision: 13, targetSeq: 3 })
      }
      return Promise.resolve(packet.forumFeed)
    })

    // Wrap in a paused parent layer (same real attribute used when a thread overlays the forum).
    const view = render(
      <CommunityTestProvider {...owner}>
        <section data-thread-parent="" data-read-observation-paused="">
          <ForumSurface serverId="s1" forumChannelId="forum-1" routeTag="" members={[]} onOpenPost={() => {}} />
        </section>
      </CommunityTestProvider>,
    )
    try {
      await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve()
        await vi.advanceTimersByTimeAsync(0)
      })
      resize()
      const root = view.getByTestId("community-forum-post-list")
      const parentLayer = view.container.querySelector<HTMLElement>("[data-thread-parent]")!
      const foreignCard = root.querySelector<HTMLElement>('[data-msg-id="opener-foreign"]')
      const ownCard = root.querySelector<HTMLElement>('[data-msg-id="opener-own"]')
      expect(foreignCard).not.toBeNull()
      expect(ownCard).not.toBeNull()

      // While parent presentation is paused, no active observer binds rows and any stale callback emits no PUT /read.
      expect(activeObserversFor(foreignCard!)).toHaveLength(0)
      await act(async () => {
        for (const observer of intersectionObservers) {
          observer.callback(
            [{ target: foreignCard!, isIntersecting: true, intersectionRatio: 1, time: performance.now() } as unknown as IntersectionObserverEntry],
            {} as IntersectionObserver,
          )
        }
        await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS + 50)
      })
      expect(readCalls).toEqual([])

      // Resume parent presentation -> real MutationObserver resamples active rows.
      await act(async () => {
        parentLayer.removeAttribute("data-read-observation-paused")
        await Promise.resolve()
      })
      expect(root.firstElementChild).toHaveAttribute("data-read-position-ready", "true")

      // Intersecting own-authored post must NOT send PUT /read.
      await act(async () => {
        intersect(ownCard!)
        await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS + 50)
      })
      expect(readCalls).toEqual([])

      // Intersecting the foreign post after reveal sends PUT /read.
      await act(async () => {
        intersect(foreignCard!)
        await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS + 50)
      })
      expect(readCalls).toEqual([
        { url: "/api/community/channels/forum-1/read", body: { lastReadMessageId: "opener-foreign" } },
      ])
    } finally {
      view.unmount()
      owner.client.clear()
    }
  })
})
