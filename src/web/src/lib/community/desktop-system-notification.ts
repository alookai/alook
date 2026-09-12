import {
  isDesktop,
  stripInlineMarkup,
  tauriInvoke,
  truncateMessagePreview,
  type CommunityMessageCreate,
  type CommunityWsEvent,
} from "@alook/shared"
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

function attachmentFallback(message: CommunityMessageCreate["message"]): string {
  const contentType = message.attachments?.[0]?.contentType?.toLowerCase() ?? ""
  if (contentType.startsWith("image/")) return "Photo"
  if (contentType.startsWith("video/")) return "Video"
  if (contentType.startsWith("audio/")) return "Audio"
  if ((message.attachments?.length ?? 0) > 0) return "Attachment"
  return "New message"
}

export function buildDesktopSystemNotificationCandidate(
  create: CommunityMessageCreate,
  bump: CommunityUnreadBump,
  viewerUserId: string | null,
): DesktopSystemNotificationCandidate | null {
  if (!viewerUserId || bump.userId !== viewerUserId) return null
  if (create.channelId !== bump.channelId || create.serverId !== bump.serverId) return null
  if (create.message.authorId === viewerUserId) return null

  const readable = stripInlineMarkup(create.message.content).replace(/\s+/g, " ").trim()
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

  return {
    viewerUserId,
    title: create.message.authorName.trim() || "Alook",
    body: truncateMessagePreview(readable || attachmentFallback(create.message)),
    target,
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
