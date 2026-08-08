import { QueryClient } from "@tanstack/react-query"
import type { CommunityMessageCreate } from "@alook/shared"
import { vi } from "vitest"
import type { UseUserWsOptions } from "@/lib/use-user-ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"

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
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQueryClient,
  }
})

export let capturedOnMessage: ((msg: unknown) => void) | null = null
export let capturedOnReconnect: (() => void) | null = null
export let capturedUseUserWsOptions: UseUserWsOptions | undefined
let stableSend: ReturnType<typeof vi.fn> = vi.fn()
export let useUserWsCallCount = 0
vi.mock("@/lib/use-user-ws", () => ({
  useUserWs: (onMessage: (msg: unknown) => void, options?: UseUserWsOptions) => {
    useUserWsCallCount += 1
    capturedOnMessage = onMessage
    capturedOnReconnect = options?.onReconnect ?? null
    capturedUseUserWsOptions = options
    return { send: stableSend }
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

function resetHarnessState() {
  resetHookInstance()
  pendingEffects = []
  effectCleanups = []
  capturedOnMessage = null
  capturedOnReconnect = null
  capturedUseUserWsOptions = undefined
  capturedQueryClient = new QueryClient()
  stableSend = vi.fn()
  useUserWsCallCount = 0
  markReadMutate.mockClear()
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
  useMessageStreamStore.getState().resetAll()
  const mod = await import("../use-community-ws")
  mod._resetActiveSend_forTesting()
}

export async function resetCommunityWsHarness() {
  resetHarnessState()
  await resetStore()
}

export async function cleanupCommunityWsHarness() {
  flushEffects()
  for (const cleanup of effectCleanups.splice(0).reverse()) cleanup()
  await resetStore()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  resetHarnessState()
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
      expiresAt: "2026-08-04T00:00:00.000Z",
      unread: false,
    })),
    included: { parentMessages: ids.map((id) => ({ id: `opener-${id}`, content: `title-${id}` })) },
    serverNow: "2026-08-01T00:00:00.000Z",
    serverClockOffsetMs: 0,
    threads: ids.map((id) => ({
      id,
      parentChannelId: "forum_1",
      parentMessageId: `opener-${id}`,
      title: `title-${id}`,
      activityAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-04T00:00:00.000Z",
      unread: false,
    })),
  }
}
