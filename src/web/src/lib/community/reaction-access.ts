import { queries } from "@alook/shared"
import type { Database } from "@alook/shared"
import {
  requireChannelMember,
  requireDMAccess,
} from "@/lib/community/permissions"
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

  const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
  const reactable = requireReactableSurface(channelType)
  if (!reactable.ok) return reactable

  if (channelType === "dm") {
    const check = await requireDMAccess(db, message.channelId, userId)
    if (!check.ok) return check
    return {
      ok: true,
      channelId: message.channelId,
      isDm: true,
      scope: { kind: "dm", channelId: message.channelId },
    }
  }

  const check = await requireChannelMember(db, message.channelId, userId)
  if (!check.ok) return check
  const serverId = check.value.serverId
  if (!serverId) return { ok: false, status: 404, error: "channel not found" }
  return {
    ok: true,
    channelId: message.channelId,
    isDm: false,
    scope: { kind: "server", serverId, channelId: message.channelId },
  }
}
