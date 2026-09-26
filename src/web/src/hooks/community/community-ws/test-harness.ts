import { QueryClient } from "@tanstack/react-query"
import type { CommunityMessageCreate } from "@alook/shared"
import { vi } from "vitest"
import type { UseUserWsOptions, UserWsConnectionPhase } from "@/lib/use-user-ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import {
  captureCommunityLiveSnapshotToken,
  ingestServerDetail,
  ingestServers,
  publishCommunityChannelMetadata,
  publishCommunityForumSidebar,
} from "@/lib/community-db/sync"
import { getForumSidebarBase } from "@/hooks/community/use-forum-sidebar-threads"

const communityApiFetch = vi.hoisted(() => vi.fn(async (...args: unknown[]) => {
  const url = args[0]
  if (url === "/api/community/users/me/read-state") {
    return { revision: 0, readStates: [] }
  }
  throw new Error(`unexpected API fetch: ${url}`)
}))

export function getCommunityApiFetchMock() {
  return communityApiFetch
}

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client")
  return { ...actual, apiFetch: (...args: unknown[]) => communityApiFetch(...args) }
})

type ShimCallback = (...args: unknown[]) => unknown

let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let callbackMemo: Map<string, { fn: ShimCallback; deps: unknown[] }> = new Map()
let callbackCounter = 0
let pendingEffects: Array<() => void | (() => void)> = []
let effectCleanups: Array<() => void> = []

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useState: (initial: unknown) => [initial, () => { }],
  useCallback: (fn: ShimCallback, deps: unknown[]) => {
    const id = `cb-${callbackCounter++}`
    const existing = callbackMemo.get(id)
    if (existing && JSON.stringify(existing.deps) === JSON.stringify(deps)) {
      return existing.fn
    }
    callbackMemo.set(id, { fn, deps })
    return fn
  },
  useEffect: (fn: () => void | (() => void), _deps: unknown[]) => {
    pendingEffects.push(fn)
  },
}))

export function flushEffects() {
  const effects = pendingEffects
  pendingEffects = []
  for (const fn of effects) {
    const cleanup = fn()
    if (typeof cleanup === "function") effectCleanups.push(cleanup)
  }
}

export let capturedQueryClient: QueryClient
let canonicalRegistry: CommunityDbRegistry | null = null
let unregisterCanonicalRegistry: (() => void) | null = null
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQueryClient,
  }
})

export let capturedOnMessage: ((msg: unknown) => void) | null = null
export let capturedOnReconnect: ((info: { reconnectDurationMs: number }) => void | Promise<void>) | null = null
export let capturedConnectionStateChange: ((phase: UserWsConnectionPhase) => void | Promise<void>) | null = null
export let capturedUseUserWsOptions: UseUserWsOptions | undefined
let stableSend: ReturnType<typeof vi.fn> = vi.fn()
let stableReconnectNow: ReturnType<typeof vi.fn> = vi.fn()
export let useUserWsCallCount = 0
vi.mock("@/lib/use-user-ws", () => ({
  useUserWs: (onMessage: (msg: unknown) => void, options?: UseUserWsOptions) => {
    useUserWsCallCount += 1
    capturedOnMessage = onMessage
    capturedOnReconnect = options?.onReconnect ?? null
    capturedConnectionStateChange = options?.onConnectionStateChange ?? null
    capturedUseUserWsOptions = options
    return { send: stableSend, reconnectNow: stableReconnectNow }
  },
}))

export const markReadMutate = vi.fn()
vi.mock("@/hooks/community/mutations/messages", () => ({
  useMarkChannelRead: () => ({ mutate: markReadMutate }),
  flushPendingReads: () => { },
}))

export function resetHookMemoization() {
  refCounter = 0
  callbackCounter = 0
}

export function resetHookInstance() {
  refs = new Map()
  callbackMemo = new Map()
  resetHookMemoization()
}

export function setStableSend(send: ReturnType<typeof vi.fn>) {
  stableSend = send
}

export function getStableSend() {
  return stableSend
}

export function getStableReconnectNow() {
  return stableReconnectNow
}

function resetHarnessState() {
  resetHookInstance()
  pendingEffects = []
  effectCleanups = []
  capturedOnMessage = null
  capturedOnReconnect = null
  capturedConnectionStateChange = null
  capturedUseUserWsOptions = undefined
  capturedQueryClient = new QueryClient()
  stableSend = vi.fn()
  stableReconnectNow = vi.fn()
  useUserWsCallCount = 0
  markReadMutate.mockClear()
  communityApiFetch.mockReset()
  communityApiFetch.mockImplementation(async (...args: unknown[]) => {
    const url = args[0]
    if (url === "/api/community/users/me/read-state") {
      return { revision: 0, readStates: [] }
    }
    throw new Error(`unexpected API fetch: ${url}`)
  })
}

export async function mountHook(options?: { viewerUserId?: string | null } & Record<string, unknown>) {
  const mod = await import("../use-community-ws")
  return mod.useCommunityWs(options)
}

async function resetStore() {
  const { useCommunityStore } = await import("@/stores/community")
  useCommunityStore.getState().reset()
  useCommunityStore.getState().setCurrentServerId("s1")
  const { useCommunityWsStore } = await import("@/stores/community/ws")
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
  useCommunityWsStore.getState().markAccessConnected()
  useMessageStreamStore.getState().resetAll()
  const mod = await import("../use-community-ws")
  mod._resetActiveSend_forTesting()
}

export async function resetCommunityWsHarness() {
  resetHarnessState()
  canonicalRegistry = createCommunityDbRegistry(capturedQueryClient, "u_me")
  await canonicalRegistry.preload()
  unregisterCanonicalRegistry = registerCommunityDbRegistry(canonicalRegistry)
  await resetStore()
}

export async function cleanupCommunityWsHarness() {
  unmountHook()
  await resetStore()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  unregisterCanonicalRegistry?.()
  unregisterCanonicalRegistry = null
  await canonicalRegistry?.cleanup()
  canonicalRegistry = null
  resetHarnessState()
}

export function unmountHook() {
  flushEffects()
  for (const cleanup of effectCleanups.splice(0).reverse()) cleanup()
}

export function messageCreate(channelId: string, msgId = "m_1"): CommunityMessageCreate {
  return {
    type: "community:message.create",
    channelId,
    message: {
      id: msgId,
      type: "chat",
      authorId: "u_author",
      authorName: "author",
      authorAvatarVersion: 0,
      content: "hi",
      seq: 1,
      createdAt: "2026-07-03T00:00:00.000Z",
    },
  }
}

export function unreadBump(
  channelId: string,
  userId: string,
  extra?: { serverId?: string; railChannelId?: string; isMention?: boolean },
) {
  return { type: "community:unread.bump" as const, userId, channelId, ...extra }
}

export function forumSidebarFixture(ids = ["post_1"]) {
  return {
    channels: ids.map((id) => ({
      id,
      name: `fallback-${id}`,
      parentChannelId: "forum_1",
      parentMessageId: `opener-${id}`,
      activityAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2099-08-04T00:00:00.000Z",
      unread: false,
    })),
    included: { parentMessages: ids.map((id) => ({ id: `opener-${id}`, content: `title-${id}` })) },
    serverNow: "2026-08-01T00:00:00.000Z",
    serverClockOffsetMs: 0,
    verifiedEpoch: 0,
    threads: ids.map((id) => ({
      id,
      parentChannelId: "forum_1",
      parentMessageId: `opener-${id}`,
      title: `title-${id}`,
      activityAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2099-08-04T00:00:00.000Z",
      unread: false,
    })),
  }
}

export function seedCanonicalForumSidebar(serverId: string, ids = ["post_1"]) {
  if (!canonicalRegistry) throw new Error("canonical test registry is not active")
  ingestServers(canonicalRegistry, { servers: [{
    id: serverId,
    name: "Server",
    initial: "S",
    active: false,
    unread: false,
    mentions: 0,
    ownerId: "viewer",
  }] })
  ingestServerDetail(canonicalRegistry, {
    id: serverId,
    name: "Server",
    discriminator: "0001",
    description: "",
    icon: null,
    ownerId: "viewer",
    categories: [{
      id: `${serverId}-forums`,
      name: "Forums",
      channels: [{
        id: "forum_1",
        name: "Forum",
        active: false,
        unread: false,
        type: "forum",
      }],
    }],
  })
  publishCommunityForumSidebar(capturedQueryClient, {
    serverId,
    channels: forumSidebarFixture(ids).channels.map((channel) => ({
      ...channel,
      serverId,
      type: "thread",
      creatorId: "viewer",
      archived: false,
      lastMessageAt: channel.activityAt,
    })),
    openers: forumSidebarFixture(ids).included.parentMessages.map((message) => ({
      ...message,
      channelId: "forum_1",
      type: "chat" as const,
    })),
    proof: {
      token: captureCommunityLiveSnapshotToken(capturedQueryClient),
      signal: undefined,
    },
  })
}

export function canonicalForumSidebar(serverId: string) {
  return getForumSidebarBase(capturedQueryClient, serverId)
}

export function seedCanonicalThread(
  serverId: string,
  parentId: string,
  parentType: "text" | "forum",
  childId: string,
) {
  if (!canonicalRegistry) throw new Error("canonical test registry is not active")
  ingestServers(canonicalRegistry, { servers: [{
    id: serverId, name: "Server", initial: "S", active: false, unread: false,
    mentions: 0, ownerId: "u_me",
  }] })
  ingestServerDetail(canonicalRegistry, {
    id: serverId, name: "Server", discriminator: "0001", description: "",
    icon: null, ownerId: "u_me", categories: [{
      id: `${serverId}-category`, name: "Category", channels: [{
        id: parentId, name: "Parent", active: false, unread: false, type: parentType,
      }],
    }],
  })
  publishCommunityChannelMetadata(capturedQueryClient, {
    metadata: {
      id: childId,
      serverId,
      name: "Child",
      type: "thread",
      parentChannelId: parentId,
      parentMessageId: `${childId}-opener`,
      creatorId: "u_me",
      archived: false,
      lastMessageAt: "2026-08-01T00:00:00.000Z",
    },
    proof: {
      token: captureCommunityLiveSnapshotToken(capturedQueryClient),
      signal: undefined,
    },
  })
}

export function hasCanonicalChannel(channelId: string) {
  return canonicalRegistry?.collections.channels.has(channelId) ?? false
}

export function hasCanonicalChannelAccess(channelId: string, userId: string) {
  return canonicalRegistry?.collections.channelMemberships.has(`${channelId}:${userId}:access`)
    ?? false
}

export function hasCanonicalChannelNotify(channelId: string, userId: string) {
  return canonicalRegistry?.collections.channelMemberships.has(`${channelId}:${userId}:notify`)
    ?? false
}
