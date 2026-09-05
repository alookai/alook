import type { InfiniteData, QueryClient } from "@tanstack/react-query"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import type { ServersResponse, ServerDetail } from "@/hooks/community/use-servers"
import type { MessagesPage, MessagesPageParam, Msg } from "@/lib/community/models/message"
import type { Category, Channel, Server } from "@/lib/community/models/navigation"
import { communityKeys } from "@/lib/query-keys"
import type { CoveredReplicaProjection, ReplicaEntityRow } from "./store"

type SeedCoverage = {
  channelTails: Set<string>
}

const coverageByClient = new WeakMap<QueryClient, SeedCoverage>()

function rowsOfKind(projection: CoveredReplicaProjection, kind: string) {
  return projection.entities.filter((row) => (row.entity.kind as string) === kind)
}

function byPositionThenId(a: Record<string, unknown>, b: Record<string, unknown>) {
  const position = Number(a.position ?? 0) - Number(b.position ?? 0)
  return position || String(a.id).localeCompare(String(b.id))
}

function projectServers(rows: ReplicaEntityRow[]): ServersResponse {
  const servers = rows
    .map((row) => row.value)
    .sort((a, b) => Number(a.railOrder ?? 0) - Number(b.railOrder ?? 0) || String(a.id).localeCompare(String(b.id)))
    .map((value): Server => ({
      id: String(value.id),
      name: String(value.name),
      discriminator: String(value.discriminator),
      description: String(value.description),
      ownerId: String(value.ownerId),
      initial: String(value.initial),
      active: false,
      unread: value.unread === true,
      mentions: Number(value.mentions ?? 0),
      isOwner: value.isOwner === true,
      icon: typeof value.icon === "string" ? value.icon : null,
      unreadSources: value.unreadSources as Server["unreadSources"],
      mentionSources: value.mentionSources as Server["mentionSources"],
    }))
  return { servers }
}

function projectServerDetail(
  serverValue: Record<string, unknown>,
  categoryRows: ReplicaEntityRow[],
  channelRows: ReplicaEntityRow[],
  unreadRows: ReplicaEntityRow[],
): ServerDetail {
  const unreadSources = unreadRows.map((row) => row.value as {
    channelId: string
    serverId: string
    parentChannelId: string | null
    lastUnreadSeq: number
    lastAttentionSeq: number | null
  })
  const ownUnread = new Set(unreadSources.map((source) => source.channelId))
  const childSources = new Map<string, string[]>()
  for (const source of unreadSources) {
    if (!source.parentChannelId) continue
    const children = childSources.get(source.parentChannelId) ?? []
    children.push(source.channelId)
    childSources.set(source.parentChannelId, children)
  }
  const channels = channelRows
    .map((row) => row.value)
    .sort(byPositionThenId)
    .map((value): Channel & { categoryId: string | null } => ({
      id: String(value.id),
      name: String(value.name),
      active: false,
      unread: ownUnread.has(String(value.id)) || childSources.has(String(value.id)),
      type: value.type as Channel["type"],
      creatorId: typeof value.creatorId === "string" ? value.creatorId : null,
      categoryId: typeof value.categoryId === "string" ? value.categoryId : null,
    }))
  const categories: Category[] = categoryRows
    .map((row) => row.value)
    .sort(byPositionThenId)
    .map((value) => ({
      id: String(value.id),
      name: String(value.name),
      private: value.private === true,
      creatorId: typeof value.creatorId === "string" ? value.creatorId : null,
      channels: channels.filter((channel) => channel.categoryId === value.id),
    }))
  const uncategorized = channels.filter((channel) => channel.categoryId === null)
  if (uncategorized.length > 0) {
    categories.push({ id: UNCATEGORIZED_CATEGORY_ID, name: "", private: 0, channels: uncategorized })
  }
  const forumUnreadState = Object.fromEntries(channels
    .filter((channel) => channel.type === "forum")
    .map((channel) => [channel.id, {
      baseUnread: ownUnread.has(channel.id),
      childIds: (childSources.get(channel.id) ?? []).sort(),
    }]))
  return {
    id: String(serverValue.id),
    name: String(serverValue.name),
    discriminator: String(serverValue.discriminator),
    description: String(serverValue.description),
    icon: typeof serverValue.icon === "string" ? serverValue.icon : null,
    ownerId: String(serverValue.ownerId),
    categories,
    forumUnreadState,
    unreadSources: unreadSources.map(({ channelId, lastUnreadSeq, lastAttentionSeq }) => ({
      channelId,
      lastUnreadSeq,
      lastAttentionSeq,
    })),
  }
}

function projectMessagePage(
  rows: ReplicaEntityRow[],
  range: NonNullable<CoveredReplicaProjection["coverage"][number]["messageRange"]>,
): InfiniteData<MessagesPage, MessagesPageParam> {
  const messages = rows
    .map((row) => row.value as Msg)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
  const oldest = messages[0]
  const cursor = oldest?.createdAt ? `${oldest.createdAt}|${oldest.id}` : undefined
  return {
    pages: [{
      messages,
      latestSeq: range.lastSeq,
      hasMore: range.hasOlder,
      ...(cursor && range.hasOlder ? { cursor } : {}),
    }],
    pageParams: [{ mode: "newest" }],
  }
}

export function seedCommunityReplicaQueries(
  queryClient: QueryClient,
  projection: CoveredReplicaProjection,
) {
  const accountCoverage = projection.coverage.find((item) => item.scope.kind === "account")
  const serverCoverage = projection.coverage.find((item) => item.scope.kind === "server")
  const channelCoverage = projection.coverage.find((item) => item.scope.kind === "channel")
  const serverRows = rowsOfKind(projection, "server")
  if (accountCoverage?.completeness === "complete") {
    queryClient.setQueryData<ServersResponse>(communityKeys.servers(), projectServers(serverRows))
  }

  if (serverCoverage?.completeness === "complete") {
    const serverValue = serverRows.find((row) => row.entity.id === serverCoverage.scope.id)?.value
    if (serverValue) {
      queryClient.setQueryData<ServerDetail>(
        communityKeys.server(serverCoverage.scope.id),
        projectServerDetail(
          serverValue,
          rowsOfKind(projection, "category"),
          rowsOfKind(projection, "channel"),
          rowsOfKind(projection, "unread-source"),
        ),
      )
    }
  }

  const channelTails = new Set<string>()
  if (channelCoverage?.messageRange && !channelCoverage.messageRange.hasNewer) {
    const channelId = channelCoverage.scope.id
    queryClient.setQueryData(
      communityKeys.channelMessages(channelId),
      projectMessagePage(rowsOfKind(projection, "message"), channelCoverage.messageRange),
    )
    channelTails.add(channelId)
  }

  if (accountCoverage?.completeness === "complete" && channelCoverage) {
    const readState = rowsOfKind(projection, "read-state")
      .find((row) => row.entity.id === channelCoverage.scope.id)?.value
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot(channelCoverage.scope.id), readState
      ? {
          lastReadMessageId: readState.lastReadMessageId,
          lastReadAt: readState.lastReadAt,
          lastReadSeq: readState.lastReadSeq,
        }
      : { lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 })
  }
  coverageByClient.set(queryClient, { channelTails })
}

export function hasCoveredCommunityReplicaTarget(
  queryClient: QueryClient,
  channelId: string,
  anchorMessageId?: string,
) {
  if (!coverageByClient.get(queryClient)?.channelTails.has(channelId)) return false
  if (!anchorMessageId) return true
  const cached = queryClient.getQueryData<InfiniteData<MessagesPage, MessagesPageParam>>(
    communityKeys.channelMessages(channelId),
  )
  return cached?.pages.some((page) => page.messages.some((message) => message.id === anchorMessageId)) === true
}

export function clearCommunityReplicaQueryCoverage(
  queryClient: QueryClient,
  scopes: Array<{ kind: "account" | "server" | "channel"; id: string }>,
) {
  const coverage = coverageByClient.get(queryClient)
  if (!coverage) return
  if (scopes.some((scope) => scope.kind !== "channel")) {
    coverageByClient.delete(queryClient)
    return
  }
  for (const scope of scopes) coverage.channelTails.delete(scope.id)
  if (coverage.channelTails.size === 0) coverageByClient.delete(queryClient)
}
