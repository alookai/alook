import { parseCommunityServerMembersRead, CommunityInvitesReadSchema, type CommunityInviteListItem, type CommunityResourceProfile } from "@alook/shared"
import { CommunityAcceptedFriendsReadSchema, CommunityBlockedFriendsReadSchema, CommunityPendingFriendsReadSchema, AccountAttentionSnapshotSchema, CommunityThreadsReadSchema, encodeCommunityBrowserEvent, BUSINESS_SCHEMA_VERSION, CommunityMachineSummarySchema, CommunityChannelResourceSchema, CommunityMessageResourceSchema, CommunityServerResourceSchema, CommunityCategoryResourceSchema, CommunityResourceBundleSchema,
  type CommunityChannelResource, type CommunityMessageResource, type CommunityResourceBundle } from "@alook/shared"

export function channelResourceFixture(fields: Partial<CommunityChannelResource> = {}): CommunityChannelResource {
  return CommunityChannelResourceSchema.parse({ id: "c1", type: "text", serverId: "s1", categoryId: null,
    name: "Channel", topic: "", parentChannelId: null, parentMessageId: null, creatorId: "viewer", position: 0,
    archived: false, createdAt: "2026-10-01T00:00:00.000Z", lastMessageAt: null, messageCount: 0, ...fields })
}

export function messageResourceFixture(fields: Partial<CommunityMessageResource> = {}): CommunityMessageResource {
  return CommunityMessageResourceSchema.parse({ id: "m1", channelId: "c1", seq: 1, authorId: "viewer", type: "chat",
    createdAt: "2026-10-01T00:00:01.000Z", content: "Body", replyToId: null, clientNonce: null, attachments: [], ...fields })
}

export function serverResourceFixture(fields: Partial<ReturnType<typeof CommunityServerResourceSchema.parse>> = {}) {
  return CommunityServerResourceSchema.parse({ id: "s1", position: 0, name: "Server", discriminator: "1234", description: "", ownerId: "viewer", icon: null, official: false, isOwner: true, ...fields })
}

export function categoryResourceFixture(fields: Partial<ReturnType<typeof CommunityCategoryResourceSchema.parse>> = {}) {
  return CommunityCategoryResourceSchema.parse({ id: "cat1", serverId: "s1", name: "Category", position: 0, private: false, creatorId: "viewer", ...fields })
}

export function resourceBundleFixture(fields: Partial<CommunityResourceBundle> = {}): CommunityResourceBundle {
  return CommunityResourceBundleSchema.parse({ viewerId: "viewer", servers: [], serverMemberships: [], channels: [], memberships: [], profiles: [], messages: [], ...fields })
}

type ChannelScenario = Partial<CommunityChannelResource> & { id: string; [field: string]: unknown }
type CategoryScenario = Partial<ReturnType<typeof CommunityCategoryResourceSchema.parse>> & { id: string; channels?: ChannelScenario[]; [field: string]: unknown }
type DirectoryScenario = Partial<ReturnType<typeof CommunityServerResourceSchema.parse>> & { id: string; categories?: CategoryScenario[]; channels?: ChannelScenario[]; [field: string]: unknown }

export function serverDirectoryFixture(scenario: DirectoryScenario) {
  const { categories = [], channels = [], ...serverFields } = scenario
  const server = serverResourceFixture(Object.fromEntries(Object.entries(serverFields).filter(([key]) => key in CommunityServerResourceSchema.shape)))
  return { server,
    categories: categories.map(({ channels: _channels, ...category }, position) => categoryResourceFixture(Object.fromEntries(Object.entries({ ...category, position: category.position ?? position, serverId: server.id }).filter(([key]) => key in CommunityCategoryResourceSchema.shape)))),
    channels: [...channels.map(channel => channelResourceFixture(Object.fromEntries(Object.entries({ ...channel, serverId: server.id }).filter(([key]) => key in CommunityChannelResourceSchema.shape)))),
      ...categories.flatMap(category => (category.channels ?? []).map((channel, position) => channelResourceFixture(Object.fromEntries(Object.entries({ ...channel, position: channel.position ?? position, serverId: server.id, categoryId: category.id }).filter(([key]) => key in CommunityChannelResourceSchema.shape)))))],
  }
}

export function fullResourceBundleFixture(viewerId: string, servers: CommunityResourceBundle["servers"], channels: CommunityResourceBundle["channels"], messages: CommunityResourceBundle["messages"] = [], profiles: CommunityResourceBundle["profiles"] = []) {
  return resourceBundleFixture({ viewerId, servers, channels, messages, profiles,
    serverMemberships: servers.map(server => ({ serverId: server.id, userId: viewerId, memberId: `member-${server.id}`, role: server.ownerId === viewerId ? "owner" : "member" })),
    memberships: channels.flatMap(channel => [{ channelId: channel.id, userId: viewerId, relation: "access" as const, source: "explicit" },
      ...(channel.type === "thread" ? [{ channelId: channel.id, userId: viewerId, relation: "notify" as const, source: "spoke" as const }] : [])]),
  })
}

export function forumSidebarEnvelopeFixture(serverId: string, ids = ["post_1"], viewerId = "viewer", content?: string) {
  const now = new Date().toISOString()
  const server = serverResourceFixture({ id: serverId, ownerId: viewerId })
  const parent = channelResourceFixture({ id: "forum_1", serverId, type: "forum" })
  const children = ids.map(id => channelResourceFixture({ id, serverId, type: "thread", name: `fallback-${id}`, parentChannelId: parent.id, parentMessageId: `opener-${id}`, lastMessageAt: now }))
  const summaries = children.map(channel => ({ id: channel.id, name: channel.name, serverId, parentChannelId: parent.id, parentMessageId: channel.parentMessageId!, activityAt: now, expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(), unread: false }))
  return { schemaVersion: BUSINESS_SCHEMA_VERSION, serverId, channels: summaries, canonicalChannels: summaries,
    retainedChannel: null, retainedDisposition: null, serverNow: now,
    resources: fullResourceBundleFixture(viewerId, [server], [parent, ...children], children.map(channel => messageResourceFixture({ id: channel.parentMessageId!, channelId: parent.id, content: content ?? `title-${channel.id}` }))),
  }
}

export function dmListRowFixture(fields: Partial<import("@/lib/community/models/people").DM> & { id: string; userId: string }, viewerId = "viewer") {
  const profile = { id: fields.userId, name: fields.name ?? "Peer", discriminator: fields.discriminator ?? "1234", avatar: null, avatarVersion: fields.avatarVersion ?? 0 }
  const channel = channelResourceFixture({ id: fields.id, type: "dm", serverId: null, name: null })
  return { id: fields.id, userId: fields.userId, preview: fields.preview ?? "", profile, channel,
    activityAt: fields.activityAt ?? channel.lastMessageAt ?? channel.createdAt,
    unread: fields.unread ?? false,
    ...(fields.lastUnreadSeq === undefined ? {} : { lastUnreadSeq: fields.lastUnreadSeq }),
    memberships: [viewerId, fields.userId].map(userId => ({ channelId: fields.id, userId, relation: "access" as const, source: "added" as const, isCreator: false, role: null, memberId: null })),
  }
}


export function machineResourceFixture(fields: Partial<ReturnType<typeof CommunityMachineSummarySchema.parse>> = {}) {
  return CommunityMachineSummarySchema.parse({ id: "m1", hostname: "host", displayName: "Host", platform: "darwin", arch: "arm64", osRelease: "26", daemonVersion: "0.1.53", lastSeenAt: null, status: "online", availableRuntimes: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...fields })
}


export function serverRailResponseFixture(scenario: { servers: Array<{ id: string; [field: string]: unknown }> }, viewerId: string | null = "viewer"): import("@/hooks/community/use-servers").ServersResponse {
  return { servers: scenario.servers.map((row, position) => {
    const fields = Object.fromEntries(Object.entries(row).filter(([key]) => key in CommunityServerResourceSchema.shape))
    const server = serverResourceFixture({ ...fields, id: row.id, position, isOwner: row.isOwner === undefined ? row.ownerId === viewerId : row.isOwner as boolean })
    const role = row.role === undefined ? server.isOwner ? "owner" : "member" : row.role
    if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("Invalid declared fixture role")
    return { ...server, initial: server.name[0] ?? "", active: false, unread: row.unread === true, mentions: typeof row.mentions === "number" ? row.mentions : 0,
      memberId: typeof row.memberId === "string" ? row.memberId : `member-${server.id}`, role }
  }) }
}


export function messageSeedFixture(channelId: string, scenario: ReadonlyArray<{ id: string; [field: string]: unknown }>) {
  return scenario.map(row => messageResourceFixture({ channelId, ...Object.fromEntries(Object.entries(row).filter(([key]) => key in CommunityMessageResourceSchema.shape)) }))
}

export function currentCommunityEventFixture(value: unknown) {
  const encoded = encodeCommunityBrowserEvent(value)
  if (!encoded.ok) throw new Error(`Invalid current event fixture: ${encoded.reason}`)
  return encoded.envelope
}

type ForumMessageScenario = Partial<CommunityMessageResource> & { id: string; authorImage?: string | null }
type ForumFeedScenario = {
  serverId: string
  parentType: "forum" | "text"
  threads: Array<Partial<CommunityChannelResource> & { id: string }>
  included: {
    parentMessages?: ForumMessageScenario[]
    firstMessages?: Array<Partial<CommunityMessageResource> & { channelId: string; content: string }>
    participants?: Array<{ channelId: string; userId: string; userName?: string | null; userImage?: string | null; userAvatarVersion?: number; participantCount?: number }>
    tags?: Array<{ messageId: string; tag: string }>
  }
  hasMore: boolean
  nextCursor?: string | null
}

export function forumFeedScenarioFixture(channelId: string, scenario: ForumFeedScenario) {
  const channel = channelResourceFixture({ id: channelId, serverId: scenario.serverId, type: scenario.parentType })
  const threads = scenario.threads.map(row => channelResourceFixture({ ...Object.fromEntries(Object.entries(row).filter(([key]) => key in CommunityChannelResourceSchema.shape)),
    id: row.id, serverId: scenario.serverId, type: "thread", parentChannelId: channelId }))
  const openers = (scenario.included.parentMessages ?? []).map(({ authorImage, ...row }) => messageResourceFixture({ channelId, ...row,
    ...(authorImage === undefined ? {} : { authorAvatar: authorImage }) }))
  const first = (scenario.included.firstMessages ?? []).map(row => messageResourceFixture({ id: `first-${row.channelId}`, ...row }))
  const profiles = new Map<string, { id: string; name: string; discriminator: null; avatar: string | null; avatarVersion: number }>()
  for (const row of openers) profiles.set(row.authorId, { id: row.authorId, name: row.authorName ?? "Author", discriminator: null, avatar: row.authorAvatar ?? null, avatarVersion: row.authorAvatarVersion ?? 0 })
  for (const row of scenario.included.participants ?? []) profiles.set(row.userId, { id: row.userId, name: row.userName ?? "Participant", discriminator: null, avatar: row.userImage ?? null, avatarVersion: row.userAvatarVersion ?? 0 })
  return CommunityThreadsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, channelId, channel, threads,
    included: { messages: [...openers, ...first], profiles: [...profiles.values()], tags: scenario.included.tags ?? [],
      members: (scenario.included.participants ?? []).map(row => ({ channelId: row.channelId, userId: row.userId, relation: "notify", source: "spoke", isCreator: false, role: null, memberId: null })),
      participantCounts: threads.map(thread => ({ channelId: thread.id, count: scenario.included.participants?.find(row => row.channelId === thread.id)?.participantCount ?? (scenario.included.participants ?? []).filter(row => row.channelId === thread.id).length })),
    }, page: { hasMore: scenario.hasMore, nextCursor: scenario.nextCursor ?? null },
  })
}

export function attentionSnapshotScenarioFixture(scenario: Omit<import("@alook/shared").AccountAttentionSnapshot, "resources">, viewerId = "viewer") {
  const { included } = scenario
  const servers = included.servers.map(row => serverResourceFixture({ ...row, ownerId: viewerId }))
  const channels = [
    ...included.channels.map(row => channelResourceFixture(Object.fromEntries(Object.entries(row).filter(([key]) => key in CommunityChannelResourceSchema.shape)))),
    ...included.dms.map(row => channelResourceFixture({ id: row.id, serverId: null, type: "dm", name: null, lastMessageAt: row.lastMessageAt })),
  ]
  const profiles = included.profiles.map(({ userId, ...profile }) => ({ id: userId, ...profile }))
  const messages = included.messages.map(row => messageResourceFixture({ ...row, authorId: row.authorId ?? "viewer" }))
  const resources = fullResourceBundleFixture(viewerId, servers, channels, messages, profiles)
  resources.memberships = resources.memberships.filter(row => row.relation === "access")
  return AccountAttentionSnapshotSchema.parse({ ...scenario, resources })
}


export function friendBucketScenarioFixture<K extends "friends" | "blocked" | "pending", R extends { id: string; userId: string; name: string; avatar: string; avatarVersion: number; discriminator?: string | null; sub?: string; kind?: string; needsOwnerApproval?: string | null }>(bucket: K, rows: R[], viewerId = "viewer") {
  const resources = resourceBundleFixture({ viewerId, profiles: rows.map(row => ({ id: row.userId, name: row.name, discriminator: row.discriminator ?? null, avatar: row.avatar, avatarVersion: row.avatarVersion })) })
  const descriptors = rows.map(row => ({ id: row.id, userId: row.userId,
    ...(bucket === "friends" && row.sub !== undefined ? { sub: row.sub } : {}),
    ...(bucket === "pending" ? { kind: row.kind, ...(row.needsOwnerApproval === undefined ? {} : { needsOwnerApproval: row.needsOwnerApproval }) } : {}),
  }))
  const schema = bucket === "friends" ? CommunityAcceptedFriendsReadSchema : bucket === "blocked" ? CommunityBlockedFriendsReadSchema : CommunityPendingFriendsReadSchema
  return schema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, [bucket]: descriptors, resources }) as Record<K, Array<{ id: string; userId: string; kind?: string }>> & { resources: CommunityResourceBundle }
}

export function staleFriendBucketFixture(bucket: "friends" | "blocked" | "pending") {
  const schema = bucket === "friends" ? CommunityAcceptedFriendsReadSchema : bucket === "blocked" ? CommunityBlockedFriendsReadSchema : CommunityPendingFriendsReadSchema
  return schema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, [bucket]: [], stale: true })
}

export function invitesReadFixture(serverId: string, invites: CommunityInviteListItem[] = [], profiles: CommunityResourceProfile[] = [], viewerId = "viewer") {
  return CommunityInvitesReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, serverId, invites,
    resources: fullResourceBundleFixture(viewerId, [serverResourceFixture({ id: serverId, ownerId: viewerId, isOwner: true })], [], [], profiles),
  })
}

export function serverMembersReadFixture(serverId: string, members: Array<{ id: string; userId: string; [field: string]: unknown }>, options: { viewerId?: string; search?: boolean; hasMore?: boolean; cursor?: string; limit?: number; total?: number } = {}) {
  const viewerId = options.viewerId ?? "viewer"
  const rows = members.map(row => ({ id: row.id, userId: row.userId, name: row.name, discriminator: row.discriminator, avatar: row.avatar, avatarVersion: row.avatarVersion,
    role: row.role, status: row.status ?? (row.userId === viewerId ? "online" : "offline"), sub: row.sub ?? "",
    statusEmoji: row.statusEmoji === undefined ? null : row.statusEmoji, statusText: row.statusText === undefined ? null : row.statusText,
  }))
  return parseCommunityServerMembersRead({ viewerId, serverId, members: rows, hasMore: options.hasMore ?? false, limit: options.limit ?? 100,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }), ...(options.search ? {} : { total: options.total ?? rows.length }),
  }, serverId, viewerId, options.search ?? false)
}
