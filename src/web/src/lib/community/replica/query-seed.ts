import type { InfiniteData, QueryClient } from "@tanstack/react-query"
import {
  UNCATEGORIZED_CATEGORY_ID,
  communityReplicaScopeKey,
  type CommunityReplicaBootstrapResponse,
} from "@alook/shared"
import type { ServersResponse, ServerDetail } from "@/hooks/community/use-servers"
import type { MessagesPage, MessagesPageParam, Msg } from "@/lib/community/models/message"
import type { Category, Channel, Server } from "@/lib/community/models/navigation"
import { communityKeys } from "@/lib/query-keys"
import type { ChildChannelMeta } from "@/hooks/community/use-forum-sidebar-threads"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { CoveredReplicaProjection, ReplicaEntityRow } from "./store"
import {
  listCommunityReplicaReadWal,
  settleCommunityReplicaReadWal,
} from "./read-wal"
import { settleCommunityReplicaReadMutations } from "./read-mutation"

type SeedCoverage = {
  channelTails: Map<string, CommunityReplicaMessageSearchCoverage>
}

export type CommunityReplicaMessageSearchCoverage = {
  completeness: "complete" | "partial"
  firstSeq: number | null
  lastSeq: number | null
}

const coverageByClient = new WeakMap<QueryClient, SeedCoverage>()

export function seedCommunityReplicaBootstrapQueries(
  queryClient: QueryClient,
  snapshot: CommunityReplicaBootstrapResponse,
) {
  seedCommunityReplicaQueries(queryClient, {
    meta: {
      key: "snapshot",
      protocolVersion: snapshot.protocolVersion,
      snapshotId: snapshot.snapshotId,
      takenAt: snapshot.takenAt,
    },
    frontier: snapshot.frontier,
    coverage: snapshot.coverage,
    entities: snapshot.facts.map((fact, index) => ({
      key: `${index}`,
      scopeKey: communityReplicaScopeKey(fact.scope),
      entity: fact.entity,
      value: fact.value as Record<string, unknown>,
    })),
  }, { resetCoverage: true })
}

function rowsOfKind(projection: CoveredReplicaProjection, kind: string) {
  return projection.entities.filter((row) => (row.entity.kind as string) === kind)
}

function byPositionThenId(a: Record<string, unknown>, b: Record<string, unknown>) {
  const position = Number(a.position ?? 0) - Number(b.position ?? 0)
  return position || String(a.id).localeCompare(String(b.id))
}

function byPositionThenCreatedAtThenId(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
) {
  const position = Number(a.position ?? 0) - Number(b.position ?? 0)
  return position
    || String(a.createdAt).localeCompare(String(b.createdAt))
    || String(a.id).localeCompare(String(b.id))
}

function projectServers(rows: ReplicaEntityRow[]): ServersResponse {
  const servers = rows
    .map((row) => row.value)
    .sort((a, b) => (
      Number(a.railOrder ?? 0) - Number(b.railOrder ?? 0)
      || String(a.joinedAt).localeCompare(String(b.joinedAt))
      || String(a.id).localeCompare(String(b.id))
    ))
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
    .sort(byPositionThenCreatedAtThenId)
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
  range: NonNullable<CoveredReplicaProjection["coverage"][number]["messageRange"]> | null,
): InfiniteData<MessagesPage, MessagesPageParam> {
  const messages = rows
    .map((row) => row.value as Msg)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
  const oldest = messages[0]
  const cursor = oldest?.createdAt ? `${oldest.createdAt}|${oldest.id}` : undefined
  return {
    pages: [{
      messages,
      latestSeq: range?.lastSeq ?? 0,
      hasMore: range?.hasOlder ?? false,
      ...(cursor && range?.hasOlder ? { cursor } : {}),
    }],
    pageParams: [{ mode: "newest" }],
  }
}

function mergeReplicaIntoAnchoredMessageWindow(
  current: InfiniteData<MessagesPage, MessagesPageParam> | undefined,
  projected: InfiniteData<MessagesPage, MessagesPageParam>,
  coverage: CoveredReplicaProjection["coverage"][number],
) {
  if (!current?.pageParams.some((pageParam) => pageParam.mode === "anchor")) {
    return projected
  }

  // An anchored window expresses where the user is reading. Replica tails
  // describe newer durable facts, but they do not grant permission to turn
  // that window into a newest-tail view; only the explicit Jump to present
  // action may do that. Refresh canonical rows already present in the window
  // while preserving its pages, pageParams, edge cursors, and scroll target.
  // A missing row is canonical deletion evidence only inside the exact range
  // Replica covers (or when the complete scope is canonically empty). Older
  // anchored history and optimistic rows outside that range remain unknown
  // rather than being mistaken for deletes.
  const replicaMessages = new Map(
    projected.pages.flatMap((page) => page.messages).map((message) => [message.id, message]),
  )
  const isCanonicallyCovered = (message: Msg) => {
    const range = coverage.messageRange
    if (!range) return coverage.completeness === "complete"
    return typeof message.seq === "number"
      && Number.isInteger(message.seq)
      && message.seq >= range.firstSeq
      && message.seq <= range.lastSeq
  }
  let changed = false
  const pages = current.pages.map((page) => {
    let pageChanged = false
    const messages = page.messages.flatMap((message) => {
      const canonical = replicaMessages.get(message.id)
      if (!canonical && isCanonicallyCovered(message)) {
        changed = true
        pageChanged = true
        return []
      }
      if (!canonical || canonical === message) return [message]
      changed = true
      pageChanged = true
      return [canonical]
    })
    return pageChanged ? { ...page, messages } : page
  })
  return changed ? { ...current, pages } : current
}

export function seedCommunityReplicaQueries(
  queryClient: QueryClient,
  projection: CoveredReplicaProjection,
  options: { resetCoverage?: boolean } = {},
) {
  const accountCoverage = projection.coverage.find((item) => item.scope.kind === "account")
  const serverCoverage = projection.coverage.find((item) => item.scope.kind === "server")
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

  const channelTails = options.resetCoverage
    ? new Map<string, CommunityReplicaMessageSearchCoverage>()
    : new Map(coverageByClient.get(queryClient)?.channelTails)
  const channelCoverageItems = projection.coverage.filter((item) => item.scope.kind === "channel")
  for (const channelCoverage of channelCoverageItems) {
    const isCoveredTail = channelCoverage.messageRange
      ? !channelCoverage.messageRange.hasNewer
      : channelCoverage.completeness === "complete"
    if (!isCoveredTail) continue
    const channelId = channelCoverage.scope.id
    const projected = projectMessagePage(
      rowsOfKind(projection, "message").filter((row) => row.scopeKey === `channel:${channelId}`),
      channelCoverage.messageRange,
    )
    queryClient.setQueryData<InfiniteData<MessagesPage, MessagesPageParam>>(
      communityKeys.channelMessages(channelId),
      (current) => mergeReplicaIntoAnchoredMessageWindow(current, projected, channelCoverage),
    )
    channelTails.set(channelId, {
      completeness: channelCoverage.messageRange?.hasOlder === true ? "partial" : "complete",
      firstSeq: channelCoverage.messageRange?.firstSeq ?? null,
      lastSeq: channelCoverage.messageRange?.lastSeq ?? null,
    })
  }

  // A covered child tail is navigable only when route resolution can identify
  // its parent without a GET. The enriched parent message already carries the
  // canonical thread identity, so project that relationship into the existing
  // child-meta query instead of widening the wire protocol with duplicate
  // channel facts.
  if (serverCoverage?.completeness === "complete") {
    const verifiedEpoch = useCommunityWsStore.getState().accessEpoch
    for (const row of rowsOfKind(projection, "message")) {
      const value = row.value as {
        id?: unknown
        channelId?: unknown
        authorId?: unknown
        createdAt?: unknown
        thread?: { id?: unknown; name?: unknown; lastReplyAt?: unknown }
      }
      const threadId = typeof value.thread?.id === "string" ? value.thread.id : null
      if (
        !threadId
        || !channelTails.has(threadId)
        || typeof value.id !== "string"
        || typeof value.channelId !== "string"
      ) continue
      const meta: ChildChannelMeta = {
        id: threadId,
        serverId: serverCoverage.scope.id,
        name: typeof value.thread?.name === "string" ? value.thread.name : "Thread",
        type: "thread",
        parentChannelId: value.channelId,
        parentMessageId: value.id,
        creatorId: null,
        archived: false,
        activityAt: typeof value.thread?.lastReplyAt === "string"
          ? value.thread.lastReplyAt
          : typeof value.createdAt === "string"
            ? value.createdAt
            : projection.meta.takenAt,
        verifiedEpoch,
      }
      queryClient.setQueryData(
        communityKeys.channelMeta(serverCoverage.scope.id, threadId),
        meta,
      )
    }
  }

  if (accountCoverage?.completeness === "complete") {
    const readStates = rowsOfKind(projection, "read-state")
    const durableReads = new Map(
      listCommunityReplicaReadWal(accountCoverage.scope.id)
        .map((intent) => [intent.channelId, intent]),
    )
    for (const channelCoverage of channelCoverageItems) {
      const readState = readStates.find((row) => row.entity.id === channelCoverage.scope.id)?.value
      const durable = durableReads.get(channelCoverage.scope.id)
      const canonicalSeq = Number(readState?.lastReadSeq ?? 0)
      if (durable && canonicalSeq >= durable.seq) {
        settleCommunityReplicaReadWal(
          accountCoverage.scope.id,
          channelCoverage.scope.id,
          canonicalSeq,
        )
        settleCommunityReplicaReadMutations(
          accountCoverage.scope.id,
          channelCoverage.scope.id,
          canonicalSeq,
        )
      }
      queryClient.setQueryData(
        communityKeys.channelReadStateSnapshot(channelCoverage.scope.id),
        durable && durable.seq > canonicalSeq
          ? {
              lastReadMessageId: durable.messageId,
              lastReadAt: durable.observedAt,
              lastReadSeq: durable.seq,
            }
          : readState
            ? {
                lastReadMessageId: readState.lastReadMessageId,
                lastReadAt: readState.lastReadAt,
                lastReadSeq: readState.lastReadSeq,
              }
            : { lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 },
      )
    }
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

export function communityReplicaMessageSearchCoverage(
  queryClient: QueryClient,
  channelId: string,
): CommunityReplicaMessageSearchCoverage | null {
  return coverageByClient.get(queryClient)?.channelTails.get(channelId) ?? null
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

export function retireCommunityReplicaQueryScopes(
  queryClient: QueryClient,
  scopes: Array<{ kind: "account" | "server" | "channel"; id: string }>,
) {
  clearCommunityReplicaQueryCoverage(queryClient, scopes)
  for (const scope of scopes) {
    if (scope.kind === "account") {
      queryClient.removeQueries({ queryKey: communityKeys.all })
      continue
    }
    if (scope.kind === "server") {
      queryClient.removeQueries({ queryKey: communityKeys.server(scope.id) })
      queryClient.setQueryData<ServersResponse | undefined>(communityKeys.servers(), (current) => (
        current ? { ...current, servers: current.servers.filter((server) => server.id !== scope.id) } : current
      ))
      continue
    }
    // The canonical server tree is itself a render projection. Retire the
    // channel there in the same publish turn as its message/read queries so a
    // revoked private route cannot remain clickable until a later bootstrap.
    queryClient.setQueryData<ChannelRefDirectory | undefined>(
      communityKeys.channelRefDirectory(),
      (current) => current?.map((server) => ({
        ...server,
        channels: server.channels.filter((channel) => channel.id !== scope.id),
      })),
    )
    queryClient.setQueryData<ServersResponse | undefined>(communityKeys.servers(), (current) => (
      current ? {
        ...current,
        servers: current.servers.map((server) => {
          const unreadSources = server.unreadSources
            ?.filter((source) => source.channelId !== scope.id)
          const mentionSources = server.mentionSources
            ?.filter((source) => source.channelId !== scope.id)
          return {
            ...server,
            unreadSources,
            mentionSources,
            unread: unreadSources ? unreadSources.length > 0 : server.unread,
            mentions: mentionSources
              ? mentionSources.reduce((count, source) => count + source.count, 0)
              : server.mentions,
          }
        }),
      } : current
    ))
    queryClient.setQueriesData<ServerDetail | undefined>({
      predicate: ({ queryKey }) => (
        queryKey.length === 3
        && queryKey[0] === communityKeys.all[0]
        && queryKey[1] === "servers"
        && typeof queryKey[2] === "string"
      ),
    }, (current) => {
      if (!current || !Array.isArray(current.categories)) return current
      return {
        ...current,
        categories: current.categories.map((category) => ({
          ...category,
          channels: category.channels.filter((channel) => channel.id !== scope.id),
        })),
        forumUnreadState: Object.fromEntries(
          Object.entries(current.forumUnreadState ?? {})
            .filter(([channelId]) => channelId !== scope.id)
            .map(([channelId, state]) => [channelId, {
              ...state,
              childIds: state.childIds.filter((childId) => childId !== scope.id),
            }]),
        ),
        unreadSources: current.unreadSources?.filter((source) => source.channelId !== scope.id) ?? [],
      }
    })
    queryClient.removeQueries({
      predicate: ({ queryKey }) => (
        queryKey[0] === communityKeys.all[0]
        && queryKey[1] === "channel"
        && queryKey[2] === scope.id
      ),
    })
    queryClient.removeQueries({
      predicate: ({ queryKey }) => (
        queryKey[0] === communityKeys.all[0]
        && queryKey.includes("channel-meta")
        && queryKey.at(-1) === scope.id
      ),
    })
  }
}
