import {
  buildCommunityNotificationCopy,
  isDesktop,
  tauriInvoke,
  type CommunityMessageCreate,
  type CommunityWsEvent,
} from "@alook/shared"
import type { QueryClient } from "@tanstack/react-query"
import { fetchChannelMetadata, type ChannelMetadata } from "@/hooks/community/channel-metadata"
import { communityKeys } from "@/lib/query-keys"
import type { StructuralSnapshotV1 } from "./structural-snapshot"
import {
  parseDesktopSystemNotificationActivation,
  type DesktopSystemNotificationActivation,
  type DesktopSystemNotificationTarget,
} from "./system-notification-route"

type CommunityUnreadBump = Extract<CommunityWsEvent, { type: "community:unread.bump" }>

export type DesktopSystemNotificationCandidate = {
  viewerUserId: string
  title: string
  body: string
  target: DesktopSystemNotificationTarget
}

type DesktopSystemNotificationConversation = {
  conversationKind: "channel" | "thread"
  serverName?: string | null
  channelName?: string | null
  parentChannelName?: string | null
}

function snapshotConversation(
  create: CommunityMessageCreate,
  viewerUserId: string,
  snapshot: StructuralSnapshotV1 | null,
): DesktopSystemNotificationConversation | null {
  if (!create.serverId) return null
  const server = snapshot?.accountId === viewerUserId
    ? snapshot.servers.find((entry) => entry.id === create.serverId)
    : undefined
  const child = server?.childRouteHints.find((entry) => entry.id === create.channelId)
  const channel = server?.channels.find((entry) => entry.id === create.channelId)
  const parent = child
    ? server?.channels.find((entry) => entry.id === child.parentChannelId)
    : undefined
  return {
    conversationKind: child ? "thread" : "channel",
    serverName: server?.name,
    channelName: child?.name ?? channel?.name,
    parentChannelName: parent?.name,
  }
}

export function buildDesktopSystemNotificationCandidate(
  create: CommunityMessageCreate,
  bump: CommunityUnreadBump,
  viewerUserId: string | null,
  snapshot: StructuralSnapshotV1 | null = null,
  resolvedConversation: DesktopSystemNotificationConversation | null = null,
): DesktopSystemNotificationCandidate | null {
  if (!viewerUserId || bump.userId !== viewerUserId) return null
  if (create.channelId !== bump.channelId || create.serverId !== bump.serverId) return null
  if (create.message.authorId === viewerUserId) return null

  const target: DesktopSystemNotificationTarget = create.serverId
    ? {
      kind: "server",
      serverId: create.serverId,
      channelId: create.channelId,
      messageId: create.message.id,
      seq: create.message.seq,
    }
    : {
      kind: "dm",
      channelId: create.channelId,
      messageId: create.message.id,
      seq: create.message.seq,
    }
  const conversation = resolvedConversation ?? snapshotConversation(create, viewerUserId, snapshot)
  const copy = buildCommunityNotificationCopy({
    conversationKind: create.serverId ? conversation?.conversationKind ?? "channel" : "dm",
    authorName: create.message.authorName,
    content: create.message.content,
    attachmentContentTypes: create.message.attachments?.map((attachment) => attachment.contentType) ?? [],
    serverName: conversation?.serverName,
    channelName: conversation?.channelName,
    parentChannelName: conversation?.parentChannelName,
  })

  return {
    viewerUserId,
    ...copy,
    target,
  }
}

export async function resolveDesktopSystemNotificationCandidate(
  create: CommunityMessageCreate,
  bump: CommunityUnreadBump,
  viewerUserId: string | null,
  queryClient: QueryClient,
  snapshot: StructuralSnapshotV1 | null = null,
): Promise<DesktopSystemNotificationCandidate | null> {
  const fallback = buildDesktopSystemNotificationCandidate(create, bump, viewerUserId, snapshot)
  if (!fallback || !viewerUserId || !create.serverId) return fallback

  const cached = snapshotConversation(create, viewerUserId, snapshot)
  if (
    cached?.channelName
    && (cached.conversationKind !== "thread" || cached.parentChannelName)
  ) return fallback

  try {
    const channel = await queryClient.fetchQuery({
      queryKey: communityKeys.channelMeta(create.serverId, create.channelId),
      queryFn: () => fetchChannelMetadata(create.serverId!, create.channelId),
      staleTime: Infinity,
    }) as ChannelMetadata
    const parent = channel.parentChannelId
      ? await queryClient.fetchQuery({
        queryKey: communityKeys.channelMeta(create.serverId, channel.parentChannelId),
        queryFn: () => fetchChannelMetadata(create.serverId!, channel.parentChannelId!),
        staleTime: Infinity,
      }) as ChannelMetadata
      : null

    return buildDesktopSystemNotificationCandidate(create, bump, viewerUserId, snapshot, {
      conversationKind: channel.parentChannelId ? "thread" : "channel",
      serverName: cached?.serverName,
      channelName: channel.name,
      parentChannelName: parent?.name,
    })
  } catch {
    return fallback
  }
}

export async function showDesktopSystemNotification(
  candidate: DesktopSystemNotificationCandidate,
): Promise<void> {
  if (!isDesktop()) return
  await tauriInvoke("desktop_system_notification_show", { candidate })
}

type TauriChannel = { onmessage: (value: unknown) => void }
type TauriWindow = Window & {
  __TAURI__?: { core?: { Channel?: new () => TauriChannel } }
}

export async function listenDesktopSystemNotificationActivations(
  ready: () => void,
): Promise<() => void> {
  const Channel = (window as TauriWindow).__TAURI__?.core?.Channel
  if (!Channel) throw new Error("native_bridge_unavailable")
  const channel = new Channel()
  channel.onmessage = ready
  const registrationId = await tauriInvoke<number>("desktop_system_notification_listen", { channel })
  return () => {
    void tauriInvoke("desktop_system_notification_unlisten", { registrationId }).catch(() => undefined)
  }
}

export async function takeDesktopSystemNotificationActivation(): Promise<DesktopSystemNotificationActivation | null> {
  const value = await tauriInvoke<unknown>("desktop_system_notification_take_activation")
  return parseDesktopSystemNotificationActivation(value)
}
