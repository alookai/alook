import {
  buildCommunityNotificationCopy,
  isDesktop,
  tauriInvoke,
  type CommunityMessageCreate,
  type CommunityWsEvent,
} from "@alook/shared"
import type { QueryClient } from "@tanstack/react-query"
import { channelMetadataOptions } from "@/hooks/community/channel-metadata"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import type { ChannelRow } from "@/lib/community-db/schema"
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

function collectionConversation(
  create: CommunityMessageCreate,
  viewerUserId: string,
  queryClient: QueryClient,
): DesktopSystemNotificationConversation | null {
  if (!create.serverId) return null
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry || registry.accountId !== viewerUserId) return null
  const server = registry.collections.servers.get(create.serverId)
  const channel = registry.collections.channels.get(create.channelId)
  const parent = channel?.parentChannelId
    ? registry.collections.channels.get(channel.parentChannelId)
    : undefined
  return {
    conversationKind: channel?.type === "thread" ? "thread" : "channel",
    serverName: server?.name,
    channelName: channel?.name,
    parentChannelName: parent?.name,
  }
}

export function buildDesktopSystemNotificationCandidate(
  create: CommunityMessageCreate,
  bump: CommunityUnreadBump,
  viewerUserId: string | null,
  conversation: DesktopSystemNotificationConversation | null = null,
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
): Promise<DesktopSystemNotificationCandidate | null> {
  const cached = viewerUserId
    ? collectionConversation(create, viewerUserId, queryClient)
    : null
  const fallback = buildDesktopSystemNotificationCandidate(create, bump, viewerUserId, cached)
  if (!fallback || !viewerUserId || !create.serverId) return fallback

  if (
    cached?.channelName
    && (cached.conversationKind !== "thread" || cached.parentChannelName)
  ) return fallback

  const token = captureCommunityLiveSnapshotToken(queryClient)
  try {
    await queryClient.query({ ...channelMetadataOptions(queryClient, create.serverId, create.channelId), select: undefined })
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    const channel = getCommunityDbRegistry(queryClient)?.collections.channels.get(create.channelId)
    if (!channel) return fallback
    let parent: ChannelRow | undefined
    if (channel.parentChannelId) {
      await queryClient.query({ ...channelMetadataOptions(queryClient, create.serverId, channel.parentChannelId), select: undefined })
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
      parent = getCommunityDbRegistry(queryClient)?.collections.channels.get(channel.parentChannelId)
    }

    return buildDesktopSystemNotificationCandidate(create, bump, viewerUserId, {
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

export async function retryDesktopSystemNotificationActivation(notificationId: string): Promise<void> {
  await tauriInvoke("desktop_system_notification_retry_activation", { notificationId })
}

export async function dismissDesktopSystemNotification(notificationId: string): Promise<void> {
  await tauriInvoke("desktop_system_notification_dismiss", { notificationId })
}

export async function dismissDesktopSystemNotificationConversation(
  viewerUserId: string,
  target: { kind: "server"; serverId: string; channelId: string } | { kind: "dm"; channelId: string },
): Promise<void> {
  await tauriInvoke("desktop_system_notification_dismiss_conversation", { viewerUserId, target })
}
