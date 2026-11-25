import {
  canSeePrivateChannel,
  communityChannelResourceFromStorage,
  CommunityMessageRefsSchema,
  CommunityServerResourceSchema,
  extractChannelRefsFromText,
  formatRef,
  isServerOwner,
  queries,
  withD1Retry,
  type CommunityChannelResource,
  type CommunityMessageRefs,
  type CommunityResolvedChannelRef,
  type CommunityServerResource,
  type Database,
} from "@alook/shared"
import { parseChannelRefDestination, type ChannelRefResources, type ChannelRefTarget } from "./channel-ref"
import { requireChannelAccess } from "./permissions"
import { resolveTargetForMember } from "./resolve-ref"
import { serverIconUrl } from "./storage"

const MAX_BATCH_CHANNEL_REFS = 100

type ChannelRefTargetResult =
  | { target: ChannelRefTarget; resources?: ChannelRefResources }
  | { error: 400 | 403 | 404 }

function asciiNoCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

function serverResourceFromRow(
  row: {
    id: string
    name: string
    discriminator: string
    description: string | null
    ownerId: string
    icon: string | null
    official: boolean
    role?: string | null
  },
  position: number,
  role?: string | null,
): CommunityServerResource {
  return CommunityServerResourceSchema.parse({
    id: row.id,
    position,
    name: row.name,
    discriminator: row.discriminator,
    description: row.description ?? "",
    ownerId: row.ownerId,
    icon: serverIconUrl(row),
    official: row.official,
    isOwner: isServerOwner(role ?? row.role ?? "member"),
  })
}

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
  const parentChannel = parentAccess.value.channel
  let channel = parentChannel
  let role = parentAccess.value.member.role
  if (destination.threadRootSeq !== undefined) {
    if (destination.threadRootSeq === 0) return { error: 404 }
    const root = await withD1Retry(() => queries.communityMessage.getMessageByChannelAndSeq(
      db, { channelId: parentChannel.id }, destination.threadRootSeq!,
    ), { route: "community/channel-ref:root" })
    if (!root) return { error: 404 }
    const thread = await withD1Retry(() => queries.communityChannel.getThreadChannelByParentMessage(
      db, parentChannel.id, root.id,
    ), { route: "community/channel-ref:thread" })
    if (!thread) return { error: 404 }
    const access = await requireChannelAccess(db, thread.id, userId)
    if (!access.ok) return { error: 403 }
    channel = access.value.channel
    role = access.value.member.role
  }
  const serverRow = await withD1Retry(
    () => queries.communityServer.getServer(db, channel.serverId!),
    { route: "community/channel-ref:server" },
  )
  const serverName = serverRow?.name ?? destination.serverName
  const channels = new Map<string, CommunityChannelResource>()
  const rawChannels = channel.id === parentChannel.id ? [channel] : [parentChannel, channel]
  let resources: ChannelRefResources | undefined
  if (serverRow) {
    for (const raw of rawChannels) {
      channels.set(raw.id, communityChannelResourceFromStorage(raw))
    }
    resources = {
      servers: [serverResourceFromRow(serverRow, 0, role)],
      channels: [...channels.values()],
    }
  }
  return {
    target: {
      server: { id: channel.serverId!, name: serverName },
      channel: { id: channel.id, name: channel.name, parentChannelId: channel.parentChannelId },
    },
    ...(resources ? { resources } : {}),
  }
}

export async function resolveChannelRefTargetsBatch(
  db: Database,
  viewerId: string,
  rawRefs: readonly string[],
): Promise<CommunityMessageRefs> {
  const destinations = new Map<string, NonNullable<ReturnType<typeof parseChannelRefDestination>>>()
  for (const rawRef of rawRefs) {
    const destination = parseChannelRefDestination(rawRef)
    if (!destination || destinations.has(destination.ref)) continue
    destinations.set(destination.ref, destination)
    if (destinations.size >= MAX_BATCH_CHANNEL_REFS) break
  }
  if (destinations.size === 0) {
    return { servers: [], channels: [], resolvedRefs: [] }
  }

  const userServers = await withD1Retry(
    () => queries.communityServer.listUserServers(db, viewerId),
    { route: "community/messages:refs-servers" },
  )
  const serverByHandle = new Map<string, { row: (typeof userServers)[number]; position: number }>()
  for (let position = 0; position < userServers.length; position++) {
    const row = userServers[position]!
    serverByHandle.set(`${asciiNoCase(row.name)}#${row.discriminator}`, { row, position })
  }

  const outcomes = new Map<string, CommunityResolvedChannelRef>()
  const channelNamesByServerId = new Map<string, Set<string>>()
  const matchedByServer = new Map<string, { server: (typeof userServers)[number]; position: number }>()

  for (const [refKey, destination] of destinations) {
    const match = serverByHandle.get(destination.server)
    if (!match) {
      outcomes.set(refKey, { ref: refKey, status: "missing" })
      continue
    }
    matchedByServer.set(match.row.id, { server: match.row, position: match.position })
    let names = channelNamesByServerId.get(match.row.id)
    if (!names) {
      names = new Set()
      channelNamesByServerId.set(match.row.id, names)
    }
    names.add(destination.channel)
  }

  type ParentAccessEntry = Awaited<ReturnType<typeof queries.communityChannel.resolveTopLevelChannelsForRefBatch>>[number]
  const parentByServerAndName = new Map<string, ParentAccessEntry>()
  if (channelNamesByServerId.size > 0) {
    const parentBatches = await Promise.all(
      [...channelNamesByServerId.entries()].map(([serverId, names]) =>
        withD1Retry(
          () => queries.communityChannel.resolveTopLevelChannelsForRefBatch(db, serverId, viewerId, [...names]),
          { route: "community/messages:refs-channels" },
        ),
      ),
    )
    for (const batch of parentBatches) {
      for (const entry of batch) {
        if (entry.channel.serverId && entry.channel.name !== null) {
          parentByServerAndName.set(`${entry.channel.serverId}\0${entry.channel.name}`, entry)
        }
      }
    }
  }

  const serversOut = new Map<string, CommunityServerResource>()
  const channelsOut = new Map<string, CommunityChannelResource>()

  type PendingThreadRef = {
    refKey: string
    serverId: string
    server: (typeof userServers)[number]
    serverPosition: number
    parentChannel: ParentAccessEntry["channel"]
    threadRootSeq: number
  }
  const pendingThreads: PendingThreadRef[] = []
  const seqsByParentChannelId = new Map<string, Set<number>>()

  for (const [refKey, destination] of destinations) {
    if (outcomes.has(refKey)) continue
    const serverMatch = serverByHandle.get(destination.server)!
    const parentEntry = parentByServerAndName.get(`${serverMatch.row.id}\0${destination.channel}`)
    if (!parentEntry) {
      outcomes.set(refKey, { ref: refKey, status: "missing" })
      continue
    }
    const hasAccess = parentEntry.isPrivate
      ? canSeePrivateChannel({ isCreator: parentEntry.isCreator, isChannelMember: parentEntry.isChannelMember })
      : true
    if (!hasAccess) {
      outcomes.set(refKey, { ref: refKey, status: "forbidden" })
      continue
    }
    if (destination.threadRootSeq === undefined) {
      serversOut.set(serverMatch.row.id, serverResourceFromRow(serverMatch.row, serverMatch.position))
      channelsOut.set(parentEntry.channel.id, communityChannelResourceFromStorage(parentEntry.channel))
      outcomes.set(refKey, { ref: refKey, status: "ready", serverId: serverMatch.row.id, channelId: parentEntry.channel.id })
      continue
    }
    if (destination.threadRootSeq === 0) {
      outcomes.set(refKey, { ref: refKey, status: "missing" })
      continue
    }
    pendingThreads.push({
      refKey,
      serverId: serverMatch.row.id,
      server: serverMatch.row,
      serverPosition: serverMatch.position,
      parentChannel: parentEntry.channel,
      threadRootSeq: destination.threadRootSeq,
    })
    let seqs = seqsByParentChannelId.get(parentEntry.channel.id)
    if (!seqs) {
      seqs = new Set()
      seqsByParentChannelId.set(parentEntry.channel.id, seqs)
    }
    seqs.add(destination.threadRootSeq)
  }

  if (pendingThreads.length > 0) {
    const rootBatches = await Promise.all(
      [...seqsByParentChannelId.entries()].map(([parentChannelId, seqs]) =>
        withD1Retry(
          () => queries.communityMessage.listMessagesByChannelAndSeqs(db, parentChannelId, [...seqs]),
          { route: "community/messages:refs-roots" },
        ),
      ),
    )
    const rootIdByChannelAndSeq = new Map<string, string>()
    const rootIdsByParentChannelId = new Map<string, Set<string>>()
    for (const batch of rootBatches) {
      for (const row of batch) {
        rootIdByChannelAndSeq.set(`${row.channelId}\0${row.seq}`, row.id)
        let ids = rootIdsByParentChannelId.get(row.channelId)
        if (!ids) {
          ids = new Set()
          rootIdsByParentChannelId.set(row.channelId, ids)
        }
        ids.add(row.id)
      }
    }

    const threadByParentAndMsgId = new Map<string, Awaited<ReturnType<typeof queries.communityChannel.listChildChannelsByParentMessageIds>>[number]>()
    if (rootIdsByParentChannelId.size > 0) {
      const threadBatches = await Promise.all(
        [...rootIdsByParentChannelId.entries()].map(([parentChannelId, messageIds]) =>
          withD1Retry(
            () => queries.communityChannel.listChildChannelsByParentMessageIds(db, parentChannelId, [...messageIds], null),
            { route: "community/messages:refs-threads" },
          ),
        ),
      )
      for (const batch of threadBatches) {
        for (const thread of batch) {
          if (thread.parentChannelId && thread.parentMessageId) {
            threadByParentAndMsgId.set(`${thread.parentChannelId}\0${thread.parentMessageId}`, thread)
          }
        }
      }
    }

    for (const item of pendingThreads) {
      const rootId = rootIdByChannelAndSeq.get(`${item.parentChannel.id}\0${item.threadRootSeq}`)
      if (!rootId) {
        outcomes.set(item.refKey, { ref: item.refKey, status: "missing" })
        continue
      }
      const thread = threadByParentAndMsgId.get(`${item.parentChannel.id}\0${rootId}`)
      if (!thread || thread.serverId !== item.serverId) {
        outcomes.set(item.refKey, { ref: item.refKey, status: "missing" })
        continue
      }
      serversOut.set(item.serverId, serverResourceFromRow(item.server, item.serverPosition))
      channelsOut.set(item.parentChannel.id, communityChannelResourceFromStorage(item.parentChannel))
      channelsOut.set(thread.id, communityChannelResourceFromStorage(thread))
      outcomes.set(item.refKey, { ref: item.refKey, status: "ready", serverId: item.serverId, channelId: thread.id })
    }
  }

  return CommunityMessageRefsSchema.parse({
    servers: [...serversOut.values()],
    channels: [...channelsOut.values()],
    resolvedRefs: [...destinations.keys()].flatMap((refKey) => {
      const outcome = outcomes.get(refKey)
      return outcome ? [outcome] : []
    }),
  })
}

export function resolveMessagePageRefs(
  db: Database,
  viewerId: string,
  messages: readonly { content?: string | null }[],
): Promise<CommunityMessageRefs> {
  const rawRefs: string[] = []
  for (const message of messages) {
    if (typeof message.content === "string" && message.content.includes("/")) {
      rawRefs.push(...extractChannelRefsFromText(message.content))
    }
  }
  return resolveChannelRefTargetsBatch(db, viewerId, rawRefs)
}
