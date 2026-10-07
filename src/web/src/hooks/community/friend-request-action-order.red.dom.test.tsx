import { useAccountAttentionProjection, reconcileAccountAttention } from "./use-account-attention"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { publishCommunityFriendships, publishAccountAttentionSnapshot, captureCommunityLiveSnapshotToken, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { useFriendshipRows } from "@/lib/community-db/projections"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { useCallback, useLayoutEffect, type RefObject } from "react"
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { apiFetch } from "@/lib/api/client"
import type { PendingRequest } from "@/lib/community/models/people"
import type { InboxFriendRequest } from "@/lib/community/models/inbox"
import { useAcceptFriendRequest } from "./mutations/friends"
import { handleFriendEvent as handleFriendEventLeaf } from "./community-ws/social-events"
import {
  runCommunityWsProjectionTransaction,
  type CommunityWsProjectionTransaction,
} from "./community-ws/projection-transaction"
import type { SocialEventContext } from "./community-ws/handler-context"
import {
  friendsQueryFn,
  type FriendsResponse,
} from "./use-friends"
import {
  useFriendRequestActionState,
  type ActionableFriendRequest,
} from "./use-friend-request-action-state"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

const pendingRows: PendingRequest[] = [
  { id: "a", userId: "ua", name: "A", avatar: "A", avatarVersion: 1, kind: "incoming" },
  { id: "b", userId: "ub", name: "B", avatar: "B", avatarVersion: 1, kind: "incoming" },
]

const inboxRows: InboxFriendRequest[] = [
  { id: "a", userId: "ua", name: "A", avatar: "A", avatarVersion: 1, createdAt: "2" },
  { id: "b", userId: "ub", name: "B", avatar: "B", avatarVersion: 1, createdAt: "1" },
]

function friendsData(ids: readonly string[]): FriendsResponse {
  return {
    friends: [],
    blocked: [],
    pending: pendingRows.filter((row) => ids.includes(row.id)),
  }
}

function attentionData(ids: readonly string[]) {
  return {
    scopes: [], limit: 100, truncated: false,
    items: inboxRows.filter((row) => ids.includes(row.id)).map((row) => ({ id: `friend_request:${row.id}`, kind: "friend_request" as const, sourceId: row.id, actorUserId: row.userId, createdAt: row.createdAt })),
    included: { servers: [], channels: [], dms: [], messages: [], profiles: inboxRows.filter((row) => ids.includes(row.id)).map((row) => ({ userId: row.userId, name: row.name, discriminator: "0001", avatar: row.avatar, avatarVersion: row.avatarVersion ?? 0 })) },
  }
}
function publishRows(client: QueryClient, ids: readonly string[], token = captureCommunityLiveSnapshotToken(client)) {
  publishCommunityFriendships(client, pendingRows.filter((row) => ids.includes(row.id)).map((row) => ({ id: row.id, userId: row.userId, kind: row.kind })), { token })
  publishAccountAttentionSnapshot(client, { snapshot: attentionData(ids), proof: { token } })
}
function handleFriendEvent(event: Parameters<typeof handleFriendEventLeaf>[0], context: SocialEventContext) {
  projectCommunityWsEventToDb(context.queryClient, event)
  handleFriendEventLeaf(event, context)
}

type Transport = {
  action: (id: string) => Promise<unknown>
  readFriends: () => Promise<readonly string[]>
  readInbox: () => Promise<readonly string[]>
}

function installTransport(transport: Transport) {
  apiFetchMock.mockImplementation(async (path: string) => {
    const action = path.match(/^\/api\/community\/friends\/([^/]+)\/(accept|reject)$/)
    if (action) return transport.action(action[1]!)
    if (path === "/api/community/friends/accepted") return { friends: [] }
    if (path === "/api/community/friends/blocked") return { blocked: [] }
    if (path === "/api/community/friends/pending") {
      const ids = await transport.readFriends()
      return { pending: pendingRows.filter((row) => ids.includes(row.id)) }
    }
    if (path === "/api/community/users/me/attention") {
      return attentionData(await transport.readInbox())
    }
    throw new Error(`unexpected API path ${path}`)
  })
}

type Surface = "inbox" | "friends"
type Paint = {
  inbox: string[]
  friends: string[]
  inboxCount: number
  friendsCount: number
  shortcutCount: number
  dot: boolean
}
type Controls = {
  act: (surface: Surface, id: string) => Promise<void>
  retry: (surface: Surface, id: string) => Promise<void>
}

function TestSurfaces({
  controlsRef,
  onPaint,
}: {
  controlsRef: RefObject<Controls | null>
  onPaint?: (paint: Paint) => void
}) {
  const friends = useQuery({
    queryKey: communityKeys.friends(),
    queryFn: friendsQueryFn,
    enabled: false,
  })
  const inbox = useAccountAttentionProjection()
  const canonicalPending = useFriendshipRows().flatMap((row) => {
    const fixture = pendingRows.find((request) => request.id === row.id)
    return fixture && (row.kind === "incoming" || row.kind === "outgoing") ? [{ ...fixture, kind: row.kind }] : []
  })
  const mutation = useAcceptFriendRequest()
  const onAccept = useCallback(
    (id: string) => mutation.mutateAsync({ friendshipId: id }),
    [mutation],
  )
  const inboxActions = useFriendRequestActionState({
    rows: inboxRows.filter((row) => inbox.items.some((item) => item.sourceId === row.id)),
    onAccept,
    surface: "inbox",
  })
  const friendsActions = useFriendRequestActionState({
    rows: canonicalPending,
    onAccept,
    surface: "friends",
  })
  const shortcutActions = useFriendRequestActionState({
    rows: canonicalPending,
    surface: "friends",
  })

  const find = <T extends { id: string }>(
    items: Array<ActionableFriendRequest<T>>,
    id: string,
  ) => {
    const item = items.find((candidate) => candidate.row.id === id)
    if (!item) throw new Error(`missing ${id}`)
    return item
  }
  useLayoutEffect(() => {
    controlsRef.current = {
      act: (surface, id) => {
        if (surface === "inbox") {
          return inboxActions.act(find(inboxActions.items, id), "accept")
        }
        return friendsActions.act(find(friendsActions.items, id), "accept")
      },
      retry: (surface, id) => {
        if (surface === "inbox") {
          return inboxActions.retry(find(inboxActions.items, id))
        }
        return friendsActions.retry(find(friendsActions.items, id))
      },
    }
  })

  const paint: Paint = {
    inbox: inboxActions.items.map((item) => `${item.row.id}:${item.status ?? "idle"}`),
    friends: friendsActions.items.map((item) => `${item.row.id}:${item.status ?? "idle"}`),
    inboxCount: inboxActions.items.length,
    friendsCount: friendsActions.items.length,
    shortcutCount: shortcutActions.items.length,
    dot: inboxActions.items.length > 0,
  }
  useLayoutEffect(() => {
    onPaint?.(paint)
  })

  const rows = (
    surface: Surface,
    items: readonly ActionableFriendRequest<{ id: string }>[],
  ) => items.map((item) => (
    <div
      key={item.row.id}
      data-testid={`${surface}-row-${item.row.id}`}
      data-status={item.status ?? "idle"}
    >
      {item.error ? <button data-testid={`${surface}-retry-${item.row.id}`}>Retry</button> : null}
    </div>
  ))

  return (
    <>
      <output
        data-testid="projection"
        data-inbox-count={paint.inboxCount}
        data-friends-count={paint.friendsCount}
        data-shortcut-count={paint.shortcutCount}
        data-dot={paint.dot ? "on" : "off"}
      />
      <section data-testid="inbox-surface">{rows("inbox", inboxActions.items)}</section>
      <section data-testid="friends-surface">{rows("friends", friendsActions.items)}</section>
    </>
  )
}

const clients = new Set<QueryClient>()
async function createClient(ids: readonly string[] = ["a", "b"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.add(client)
  const registry = createCommunityDbRegistry(client, "viewer")
  registerCommunityDbRegistry(registry)
  await registry.preload()
  publishRows(client, ids)
  client.setQueryData(communityKeys.friends(), { ids })
  client.setQueryData(communityKeys.accountAttention(), { loaded: true })
  return client
}

function mount(client: QueryClient, onPaint?: (paint: Paint) => void) {
  const registry = createCommunityDbRegistry(client, "viewer")
  registerCommunityDbRegistry(registry)
  const controls = { current: null } as RefObject<Controls | null>
  const rendered = render(
    <QueryClientProvider client={client}>
      <CommunityDbProvider registry={registry}><TestSurfaces controlsRef={controls} onPaint={onPaint} /></CommunityDbProvider>
    </QueryClientProvider>,
  )
  return { controls, rendered }
}

async function fetchFriends(client: QueryClient) {
  return client.query({
    queryKey: communityKeys.friends(),
    queryFn: friendsQueryFn,
    staleTime: 0,
  })
}

async function fetchAttention(client: QueryClient) {
  return reconcileAccountAttention(getCommunityDbRegistry(client)!)
}
afterEach(async () => {
  await act(async () => {
    for (const client of clients) { await getCommunityDbRegistry(client)?.cleanup(); client.clear() }
    clients.clear()
  })
})

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("friend-request action authority RED", () => {
  it("does not recreate A when fresh terminal absence precedes mutation rejection", async () => {
    const gate = deferred<unknown>()
    installTransport({
      action: () => gate.promise,
      readFriends: async () => [],
      readInbox: async () => [],
    })
    const client = await createClient(["a"])
    const { controls, rendered } = mount(client)
    let request!: Promise<void>
    act(() => { request = controls.current!.act("inbox", "a") })
    await act(async () => { await Promise.all([fetchFriends(client), fetchAttention(client)]) })
    await act(async () => {
      gate.reject(new Error("ambiguous failure"))
      await request
    })

    expect(rendered.queryByTestId("inbox-row-a")).toBeNull()
    expect(rendered.queryByTestId("friends-row-a")).toBeNull()
    expect(rendered.getByTestId("projection")).toHaveAttribute("data-dot", "off")
  })

  it("keeps Retry across failed refresh, then clears every projection on later fresh absence", async () => {
    let stale = true
    installTransport({
      action: async () => { throw new Error("offline") },
      readFriends: async () => {
        if (stale) throw new Error("stale friends")
        return []
      },
      readInbox: async () => {
        if (stale) throw new Error("stale inbox")
        return []
      },
    })
    const client = await createClient(["a"])
    const { controls, rendered } = mount(client)
    await act(async () => { await controls.current!.act("inbox", "a") })
    await waitFor(() => expect(rendered.getByTestId("inbox-row-a")).toHaveAttribute("data-status", "error"))

    await act(async () => {
      await Promise.allSettled([fetchFriends(client), fetchAttention(client)])
    })
    await waitFor(() => expect(rendered.getByTestId("inbox-row-a")).toHaveAttribute("data-status", "error"))

    stale = false
    await act(async () => { await fetchAttention(client) })
    expect(rendered.queryByTestId("inbox-row-a")).toBeNull()
    expect(rendered.queryByTestId("friends-row-a")).toBeNull()
    const projection = rendered.getByTestId("projection")
    expect(projection).toHaveAttribute("data-inbox-count", "0")
    expect(projection).toHaveAttribute("data-friends-count", "0")
    expect(projection).toHaveAttribute("data-shortcut-count", "0")
    expect(projection).toHaveAttribute("data-dot", "off")
  })

  it("publishes terminal absence to all three counts and the dot before the next paint", async () => {
    const inboxRead = deferred<readonly string[]>()
    installTransport({
      action: async () => { throw new Error("offline") },
      readFriends: async () => ["a"],
      readInbox: () => inboxRead.promise,
    })
    const paints: Paint[] = []
    const client = await createClient(["a"])
    const { controls, rendered } = mount(client, (paint) => paints.push(paint))
    await act(async () => { await controls.current!.act("inbox", "a") })
    const read = fetchAttention(client)
    await waitFor(() => expect(apiFetchMock.mock.calls.some(
      ([path]) => path === "/api/community/users/me/attention",
    )).toBe(true))
    paints.length = 0
    await act(async () => {
      inboxRead.resolve([])
      await read
    })

    expect(paints).not.toContainEqual(expect.objectContaining({
      inboxCount: 0,
      friendsCount: 1,
    }))
    expect(paints).not.toContainEqual(expect.objectContaining({
      inboxCount: 1,
      friendsCount: 0,
    }))
    expect(paints.length).toBeGreaterThan(0)
    expect(paints.every((paint) => (
      paint.inboxCount === 0
      && paint.friendsCount === 0
      && paint.shortcutCount === 0
      && !paint.dot
    ))).toBe(true)
    const projection = rendered.getByTestId("projection")
    expect(projection).toHaveAttribute("data-inbox-count", "0")
    expect(projection).toHaveAttribute("data-friends-count", "0")
    expect(projection).toHaveAttribute("data-shortcut-count", "0")
    expect(projection).toHaveAttribute("data-dot", "off")
  })

  it("keeps a terminal-event fence through stale sibling data and failed follow-up reads", async () => {
    installTransport({
      action: async () => { throw new Error("offline") },
      readFriends: async () => { throw new Error("friends refresh failed") },
      readInbox: async () => { throw new Error("inbox refresh failed") },
    })
    const paints: Paint[] = []
    const client = await createClient(["a"])
    const { controls, rendered } = mount(client, (paint) => paints.push(paint))
    await act(async () => { await controls.current!.act("inbox", "a") })
    paints.length = 0

    act(() => {
      runCommunityWsProjectionTransaction(client, (projection) => {
        handleFriendEvent(
          { type: "community:friend.remove", friendshipId: "a" },
          {
            deliveryMode: "single",
            queryClient: client,
            sub: {},
            viewerUserIdRef: { current: "viewer" },
            projection,
            scheduleInboxInvalidate: vi.fn(),
          } satisfies SocialEventContext,
        )
      })
    })

    expect(rendered.queryByTestId("inbox-row-a")).toBeNull()
    expect(rendered.queryByTestId("friends-row-a")).toBeNull()
    expect(paints.every((paint) => (
      paint.inboxCount === 0
      && paint.friendsCount === 0
      && paint.shortcutCount === 0
      && !paint.dot
    ))).toBe(true)

    await act(async () => {
      await Promise.allSettled([fetchFriends(client), fetchAttention(client)])
    })
    expect(rendered.queryByTestId("inbox-row-a")).toBeNull()
    expect(rendered.queryByTestId("friends-row-a")).toBeNull()
  })

  it("suppresses a late unknown request for a blocked user until both fresh surfaces prove absence", async () => {
    let mode: "failed" | "absent" = "failed"
    installTransport({
      action: async () => undefined,
      readFriends: async () => {
        if (mode === "failed") throw new Error("friends refresh failed")
        return []
      },
      readInbox: async () => {
        if (mode === "failed") throw new Error("inbox refresh failed")
        return []
      },
    })
    const paints: Paint[] = []
    const client = await createClient([])
    const { rendered } = mount(client, (paint) => paints.push(paint))
    const beforeBlock = captureCommunityLiveSnapshotToken(client)

    const projection = {
      project: <T,>(effect: () => T) => effect(),
      invalidate: vi.fn(),
      fence: vi.fn(),
    } satisfies CommunityWsProjectionTransaction
    act(() => {
      handleFriendEvent(
        { type: "community:friend.block", userId: "ua" },
        {
          deliveryMode: "single",
          queryClient: client,
          sub: {},
          viewerUserIdRef: { current: "viewer" },
          projection,
          scheduleInboxInvalidate: vi.fn(),
        } satisfies SocialEventContext,
      )
      publishRows(client, ["a"], beforeBlock)
    })

    await act(async () => {
      await Promise.allSettled([fetchFriends(client), fetchAttention(client)])
    })
    expect(rendered.queryByTestId("inbox-row-a")).toBeNull()
    expect(rendered.queryByTestId("friends-row-a")).toBeNull()
    expect(paints.every((paint) => (
      paint.inboxCount === 0
      && paint.friendsCount === 0
      && paint.shortcutCount === 0
      && !paint.dot
    ))).toBe(true)

    mode = "absent"
    await act(async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: communityKeys.friends(),
          exact: true,
          refetchType: "none",
        }),
        client.invalidateQueries({
          queryKey: communityKeys.accountAttention(),
          exact: true,
          refetchType: "none",
        }),
      ])
      await Promise.all([fetchFriends(client), fetchAttention(client)])
    })
    expect(rendered.queryByTestId("inbox-row-a")).toBeNull()
    expect(rendered.queryByTestId("friends-row-a")).toBeNull()

    await act(async () => {
      publishRows(client, ["a"])
    })
    await waitFor(() => {
      expect(rendered.getByTestId("inbox-row-a")).toBeInTheDocument()
      expect(rendered.getByTestId("friends-row-a")).toBeInTheDocument()
    })
    expect(rendered.getByTestId("projection")).toHaveAttribute("data-shortcut-count", "1")
  })

  it("keeps pre-terminal exact-key reads from committing after both post-terminal absences", async () => {
    const oldFriends = deferred<readonly string[]>()
    const oldInbox = deferred<readonly string[]>()
    let postTerminal = false
    installTransport({
      action: async () => undefined,
      readFriends: () => postTerminal ? Promise.resolve([]) : oldFriends.promise,
      readInbox: () => postTerminal ? Promise.resolve([]) : oldInbox.promise,
    })
    const client = await createClient(["a"])
    const preTerminalReads = [fetchFriends(client), fetchAttention(client)]
    await waitFor(() => expect(apiFetchMock.mock.calls.some(
      ([path]) => path === "/api/community/users/me/attention",
    )).toBe(true))
    await Promise.all([
      client.cancelQueries({ queryKey: communityKeys.friends(), exact: true }),
      client.cancelQueries({ queryKey: communityKeys.accountAttention(), exact: true }),
    ])
    postTerminal = true
    await Promise.all([fetchFriends(client), fetchAttention(client)])

    oldFriends.resolve(["a"])
    oldInbox.resolve(["a"])
    await Promise.allSettled(preTerminalReads)

    expect([...getCommunityDbRegistry(client)!.collections.friendships.values()].filter((row) => row.kind === "incoming")).toEqual([])
    expect([...getCommunityDbRegistry(client)!.collections.attentionItems.values()]).toEqual([])
  })
})

describe("friend-request shared owner RED", () => {
  it.each<Surface>(["inbox", "friends"])(
    "shows one pending A on both surfaces when the action starts from %s",
    async (origin) => {
      const gate = deferred<unknown>()
      installTransport({
        action: () => gate.promise,
        readFriends: async () => ["a", "b"],
        readInbox: async () => ["a", "b"],
      })
      const client = await createClient()
      const { controls, rendered } = mount(client)
      let request!: Promise<void>
      act(() => { request = controls.current!.act(origin, "a") })
      try {
        await waitFor(() => {
          expect(rendered.getByTestId("inbox-row-a")).toHaveAttribute("data-status", "pending")
          expect(rendered.getByTestId("friends-row-a")).toHaveAttribute("data-status", "pending")
        })
        expect(rendered.getByTestId("inbox-row-b")).toHaveAttribute("data-status", "idle")
        expect(rendered.getByTestId("friends-row-b")).toHaveAttribute("data-status", "idle")
      } finally {
        gate.resolve(undefined)
        await act(async () => { await request })
      }
    },
  )

  it("inherits both surface rows when Retry starts with both cache envelopes absent", async () => {
    const retryGate = deferred<unknown>()
    let attempts = 0
    installTransport({
      action: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("offline")
        return retryGate.promise
      },
      readFriends: async () => ["a"],
      readInbox: async () => ["a"],
    })
    const client = await createClient(["a"])
    const { controls, rendered } = mount(client)
    await act(async () => { await controls.current!.act("inbox", "a") })
    await waitFor(() => expect(rendered.getByTestId("inbox-row-a")).toHaveAttribute("data-status", "error"))
    act(() => {
      client.removeQueries({ queryKey: communityKeys.friends(), exact: true })
      client.removeQueries({ queryKey: communityKeys.accountAttention(), exact: true })
    })

    let retry!: Promise<void>
    act(() => { retry = controls.current!.retry("inbox", "a") })
    try {
      await waitFor(() => {
        expect(rendered.getByTestId("inbox-row-a")).toHaveAttribute("data-status", "pending")
        expect(rendered.getByTestId("friends-row-a")).toHaveAttribute("data-status", "pending")
      })
      expect(client.getQueryData(communityKeys.friends())).toBeUndefined()
      expect(client.getQueryData(communityKeys.accountAttention())).toBeUndefined()
    } finally {
      retryGate.resolve(undefined)
      await act(async () => { await retry })
    }
  })

  it("coalesces same-frame duplicate pending actions across both surfaces", async () => {
    const gate = deferred<unknown>()
    let calls = 0
    installTransport({
      action: () => {
        calls += 1
        return gate.promise
      },
      readFriends: async () => ["a"],
      readInbox: async () => ["a"],
    })
    const client = await createClient(["a"])
    const { controls } = mount(client)
    let inboxRequest!: Promise<void>
    let friendsRequest!: Promise<void>
    act(() => {
      inboxRequest = controls.current!.act("inbox", "a")
      friendsRequest = controls.current!.act("friends", "a")
    })
    try {
      await waitFor(() => expect(calls).toBeGreaterThan(0))
      expect(calls).toBe(1)
    } finally {
      gate.resolve(undefined)
      await act(async () => { await Promise.all([inboxRequest, friendsRequest]) })
    }
  })

  it("permits only one generation increment when Retry is invoked twice in one frame", async () => {
    const retryGate = deferred<unknown>()
    let calls = 0
    installTransport({
      action: async () => {
        calls += 1
        if (calls === 1) throw new Error("offline")
        return retryGate.promise
      },
      readFriends: async () => ["a"],
      readInbox: async () => ["a"],
    })
    const client = await createClient(["a"])
    const { controls, rendered } = mount(client)
    await act(async () => { await controls.current!.act("inbox", "a") })
    await waitFor(() => expect(rendered.getByTestId("inbox-row-a")).toHaveAttribute("data-status", "error"))
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = controls.current!.retry("inbox", "a")
      second = controls.current!.retry("inbox", "a")
    })
    try {
      await waitFor(() => expect(calls).toBeGreaterThan(1))
      expect(calls).toBe(2)
    } finally {
      retryGate.resolve(undefined)
      await act(async () => { await Promise.all([first, second]) })
    }
  })

  it.each([
    { terminalId: "a", failedId: "b", order: "terminal-first" },
    { terminalId: "a", failedId: "b", order: "failure-first" },
    { terminalId: "b", failedId: "a", order: "terminal-first" },
    { terminalId: "b", failedId: "a", order: "failure-first" },
  ] as const)(
    "suppresses $terminalId and keeps only $failedId retryable with $order completion",
    async ({ terminalId, failedId, order }) => {
      const actions = new Map([
        ["a", deferred<unknown>()],
        ["b", deferred<unknown>()],
      ])
      installTransport({
        action: (id) => actions.get(id)!.promise,
        readFriends: async () => [failedId],
        readInbox: async () => [failedId],
      })
      const client = await createClient()
      const { controls, rendered } = mount(client)
      let actionA!: Promise<void>
      let actionB!: Promise<void>
      act(() => {
        actionA = controls.current!.act("inbox", "a")
        actionB = controls.current!.act("inbox", "b")
      })

      if (order === "terminal-first") {
        await act(async () => { await Promise.all([fetchFriends(client), fetchAttention(client)]) })
        await act(async () => {
          actions.get(terminalId)!.reject(new Error(`ambiguous ${terminalId}`))
          await (terminalId === "a" ? actionA : actionB)
        })
        await act(async () => {
          actions.get(failedId)!.reject(new Error(`failed ${failedId}`))
          await (failedId === "a" ? actionA : actionB)
        })
      } else {
        await act(async () => {
          actions.get(failedId)!.reject(new Error(`failed ${failedId}`))
          await (failedId === "a" ? actionA : actionB)
        })
        await act(async () => { await Promise.all([fetchFriends(client), fetchAttention(client)]) })
        await act(async () => {
          actions.get(terminalId)!.reject(new Error(`ambiguous ${terminalId}`))
          await (terminalId === "a" ? actionA : actionB)
        })
      }

      expect(rendered.queryByTestId(`inbox-row-${terminalId}`)).toBeNull()
      expect(rendered.queryByTestId(`friends-row-${terminalId}`)).toBeNull()
      await waitFor(() => expect(rendered.getByTestId(`inbox-row-${failedId}`)).toHaveAttribute("data-status", "error"))
      await waitFor(() => expect(rendered.getByTestId(`friends-row-${failedId}`)).toHaveAttribute("data-status", "error"))
    },
  )
})
