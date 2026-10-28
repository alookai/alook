import { formatRef, queries, withD1Retry, type Database } from "@alook/shared"
import { parseChannelRefDestination, type ChannelRefTarget } from "./channel-ref"
import { requireChannelAccess } from "./permissions"
import { resolveTargetForMember } from "./resolve-ref"

type ChannelRefTargetResult = { target: ChannelRefTarget } | { error: 400 | 403 | 404 }

export async function resolveChannelRefTarget(db: Database, userId: string, ref: string): Promise<ChannelRefTargetResult> {
  const destination = parseChannelRefDestination(ref)
  if (!destination) return { error: 400 }
  const base = await resolveTargetForMember(db, userId, formatRef({
    server: destination.server, channel: destination.channel,
  }), { createDmIfMissing: false, createThreadIfMissing: false })
  if ("error" in base) return { error: base.error }
  if (base.kind !== "channel") return { error: 400 }
  const parentAccess = await requireChannelAccess(db, base.channelId, userId)
  if (!parentAccess.ok) return { error: 403 }
  let channel = parentAccess.value.channel
  if (destination.threadRootSeq !== undefined) {
    if (destination.threadRootSeq === 0) return { error: 404 }
    const root = await withD1Retry(() => queries.communityMessage.getMessageByChannelAndSeq(
      db, { channelId: channel.id }, destination.threadRootSeq!,
    ), { route: "community/channel-ref:root" })
    if (!root) return { error: 404 }
    const thread = await withD1Retry(() => queries.communityChannel.getThreadChannelByParentMessage(
      db, channel.id, root.id,
    ), { route: "community/channel-ref:thread" })
    if (!thread) return { error: 404 }
    const access = await requireChannelAccess(db, thread.id, userId)
    if (!access.ok) return { error: 403 }
    channel = access.value.channel
  }
  return { target: {
    server: { id: channel.serverId!, name: destination.serverName },
    channel: { id: channel.id, name: channel.name, parentChannelId: channel.parentChannelId },
  } }
}
