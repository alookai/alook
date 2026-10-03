import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import { act, renderHook, type RenderHookResult } from "@/test/react-dom-harness"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import type { CommunityMessageCreate } from "@alook/shared"
import { vi } from "vitest"
import type { UseUserWsOptions, UserWsConnectionPhase } from "@/lib/use-user-ws"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import {
  captureCommunityLiveSnapshotToken,
  ingestServerDetail,
  ingestServers,
  ingestMessages,
  publishCommunityChannelMetadata,
  publishCommunityForumSidebar,
} from "@/lib/community-db/sync"
import { getForumSidebarBase } from "@/hooks/community/use-forum-sidebar-threads"
import { useAccountAttention } from "@/hooks/community/use-account-attention"
import { useCanonicalMessagesById } from "@/lib/community-db/projections"
import type { Msg } from "@/lib/community/models/message"
import type { MessageScope, MessageOverlayEvent } from "@/lib/community/message-stream"

const communityApiFetch = vi.hoisted(() => vi.fn(async (...args: unknown[]) => {
  const url = args[0]
  if (url === "/api/community/users/me/read-state") {
    return { revision: 0, readStates: [] }
  }
  if (url === "/api/community/users/me/attention") return { scopes: [], items: [], limit: 50, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } }
  throw new Error(`unexpected API fetch: ${url}`)
}))

export function getCommunityApiFetchMock() {
  return communityApiFetch
}

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client")
  return { ...actual, apiFetch: (...args: unknown[]) => communityApiFetch(...args) }
})

export function flushEffects() {
  act(() => {})
}

export let capturedQueryClient: QueryClient
export let canonicalRegistry: CommunityDbRegistry | null = null
let unregisterCanonicalRegistry: (() => void) | null = null
let renderedHook: RenderHookResult<void, Parameters<typeof mountHook>[0]> | null = null
let attentionHook: RenderHookResult<ReturnType<typeof useAccountAttention>, unknown> | null = null
const additionalHooks: Array<RenderHookResult<void, Parameters<typeof mountHook>[0]>> = []
let messageProjectionHook: RenderHookResult<ReturnType<typeof useCanonicalMessagesById>, unknown> | null = null
const projectionHooks: Array<{ unmount: () => void }> = []

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
    capturedOnMessage = (message) => act(() => onMessage(message))
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
}

export function resetHookInstance() {
  unmountHook()
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
  capturedOnMessage = null
  capturedOnReconnect = null
  capturedConnectionStateChange = null
  capturedUseUserWsOptions = undefined
  capturedQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
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
    if (url === "/api/community/users/me/attention") return { scopes: [], items: [], limit: 50, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } }
    throw new Error(`unexpected API fetch: ${url}`)
  })
}

function ownerWrapper({ children }: { children: ReactNode }) {
  if (!canonicalRegistry) throw new Error("Community test owner missing")
  return createElement(QueryClientProvider, { client: capturedQueryClient },
    createElement(CommunityDbProvider, { registry: canonicalRegistry }, children))
}

export async function mountHook(options?: { viewerUserId?: string | null } & Record<string, unknown>) {
  const mod = await import("../use-community-ws")
  await act(async () => {
    if (renderedHook) renderedHook.rerender(options)
    else {
      renderedHook = renderHook((props) => mod.useCommunityWs(props), {
        initialProps: options,
        wrapper: ownerWrapper,
      })
    }
  })
  if (!renderedHook) throw new Error("Community WS test hook missing")
  return renderedHook.result.current
}

export async function mountAdditionalHook(options?: Parameters<typeof mountHook>[0]) {
  const mod = await import("../use-community-ws")
  const hook = renderHook((props) => mod.useCommunityWs(props), { initialProps: options, wrapper: ownerWrapper })
  additionalHooks.push(hook)
  return hook.result.current
}

export async function mountCanonicalHook<Result>(hook: () => Result) {
  let rendered!: ReturnType<typeof renderHook<Result, unknown>>
  await act(async () => { rendered = renderHook(hook, { wrapper: ownerWrapper }) })
  projectionHooks.push(rendered)
  return rendered
}

export function getCapturedRuntime() {
  if (!canonicalRegistry) throw new Error("Community test owner missing")
  return canonicalRegistry.runtime
}
async function resetStore() {
  const runtime = getCapturedRuntime()
  runtime.ui.actions.reset()
  runtime.ui.actions.setCurrentServerId("s1")
  runtime.ws.actions.reset()
  runtime.ws.actions.activateProfileAccount("u_me")
  runtime.ws.actions.markAccessConnected()
  runtime.messageStream.actions.resetAll()
  runtime.transport.send = null
}

export async function resetCommunityWsHarness() {
  resetHarnessState()
  canonicalRegistry = createCommunityDbRegistry(capturedQueryClient, "u_me")
  await canonicalRegistry.preload()
  unregisterCanonicalRegistry = registerCommunityDbRegistry(canonicalRegistry)
  await resetStore()
  attentionHook = renderHook(() => useAccountAttention(), { wrapper: ownerWrapper })
  messageProjectionHook = renderHook(() => useCanonicalMessagesById(), { wrapper: ownerWrapper })
  await act(async () => { await capturedQueryClient.getQueryCache().find({ queryKey: ["community", "attention"], exact: true })?.promise })
  communityApiFetch.mockClear()
}

export async function cleanupCommunityWsHarness() {
  await act(async () => {
  unmountHook()
  for (const hook of projectionHooks.splice(0)) hook.unmount()
  for (const hook of additionalHooks.splice(0)) hook.unmount()
  attentionHook?.unmount()
  attentionHook = null
  messageProjectionHook?.unmount()
  messageProjectionHook = null
  await resetStore()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  unregisterCanonicalRegistry?.()
  unregisterCanonicalRegistry = null
  await capturedQueryClient.cancelQueries()
  await canonicalRegistry?.cleanup()
  capturedQueryClient.clear()
  canonicalRegistry = null
  resetHarnessState()
  })
}

export function unmountHook() {
  renderedHook?.unmount()
  renderedHook = null
}

export function seedCanonicalMessages(channelId: string, messages: Array<Partial<Msg> & Pick<Msg, "id">>) {
  if (!canonicalRegistry) throw new Error("Community test owner missing")
  act(() => ingestMessages(canonicalRegistry!, channelId, messages.map((message) => ({ type: "chat", content: "", seq: 1, ...message }))))
}

export function seedCanonicalStream(scope: MessageScope, event: MessageOverlayEvent) {
  if (event.type === "wsMessage") seedCanonicalMessages(scope.id, [event.message])
  act(() => getCapturedRuntime().messageStream.actions.dispatch(scope, event))
}

export function canonicalMessage(id: string) {
  return messageProjectionHook?.result.current?.get(id)
}

export function seedCanonicalServer(server: Partial<Parameters<typeof ingestServerDetail>[1]> & { id: string }) {
  if (!canonicalRegistry) throw new Error("Community test owner missing")
  const detail = { name: "Server", discriminator: "0001", description: "", icon: null, ownerId: "u_me", categories: [], ...server }
  act(() => {
    ingestServers(canonicalRegistry!, { servers: [{ id: detail.id, name: detail.name, initial: detail.name[0]!, active: false, unread: false, mentions: 0, ownerId: detail.ownerId }] })
    ingestServerDetail(canonicalRegistry!, detail)
  })
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
  act(() => {
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
  act(() => {
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

export function seedCanonicalFocusedChannel(metadata: { name: string; parentChannelId?: string | null; parentMessageId?: string | null }) {
  act(() => {
    if (!canonicalRegistry) throw new Error("Community test owner missing")
    const state = canonicalRegistry.runtime.ui.get()
    const channelId = state.currentChannelId ?? state.subscription.channelId
    if (!channelId) throw new Error("Focused test channel missing")
    publishCommunityChannelMetadata(capturedQueryClient, {
      metadata: { creatorId: null, archived: false, lastMessageAt: null, parentMessageId: null, parentChannelId: null, ...canonicalRegistry.collections.channels.get(channelId), id: channelId, serverId: state.currentServerId ?? "s1", type: metadata.parentChannelId ? "thread" : "text", ...metadata },
      proof: { token: captureCommunityLiveSnapshotToken(capturedQueryClient), signal: undefined },
    })
  })
}
