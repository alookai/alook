import { queries } from "@alook/shared"
import type { Database } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { requireReactableSurface } from "@/lib/community/channel-write-guard"

type ReactionAccessScope =
  | { kind: "server"; serverId: string; channelId: string }
  | { kind: "dm"; channelId: string }

export type ReactionAccessResult =
  | {
      ok: true
      channelId: string
      isDm: boolean
      scope: ReactionAccessScope
    }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string }

export async function authorizeReaction(
  db: Database,
  messageId: string,
  userId: string,
): Promise<ReactionAccessResult> {
  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return { ok: false, status: 404, error: "message not found" }

  // Preserve the existing surface-specific no-access contract before exposing
  // whether this message's channel supports emoji. In particular, a private
  // forum must remain 403 to a non-member rather than leaking its type via 400.
  const access = await requireMessageSurfaceAccess(db, message.channelId, userId)
  if (!access.ok) return access

  const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
  const reactable = requireReactableSurface(channelType)
  if (!reactable.ok) return reactable

  if (access.value.surface === "dm") {
    return {
      ok: true,
      channelId: message.channelId,
      isDm: true,
      scope: { kind: "dm", channelId: message.channelId },
    }
  }

  const serverId = access.value.channel.serverId
  if (!serverId) return { ok: false, status: 404, error: "channel not found" }
  return {
    ok: true,
    channelId: message.channelId,
    isDm: false,
    scope: { kind: "server", serverId, channelId: message.channelId },
  }
}
