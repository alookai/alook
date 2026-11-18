import { z } from "zod"
import { MAX_MEMBERS_PAGE_SIZE, MIN_SEARCH_LENGTH, type CommunityCollectionRows } from "@alook/shared"
import type { InfiniteData } from "@tanstack/react-query"
import { auxiliaryWindowRetiredKeys, auxiliaryWindowScopeKey, MAX_PERSISTED_AUXILIARY_ROWS, MAX_PERSISTED_AUXILIARY_WINDOWS, type AuxiliaryReadReference } from "./auxiliary-window-contract"

export const MAX_PERSISTED_DIRECTORY_WINDOWS = MAX_PERSISTED_AUXILIARY_WINDOWS
const MAX_PERSISTED_DIRECTORY_ROWS = MAX_PERSISTED_AUXILIARY_ROWS

const id = z.string().min(1)
const ids = z.array(id).refine(values => new Set(values).size === values.length)
const identity = z.object({ id, userId: id })
const identities = z.array(identity)
  .refine(values => new Set(values.map(value => value.id)).size === values.length && new Set(values.map(value => value.userId)).size === values.length)
const observed = z.boolean().optional()
const auxiliaryReadEpoch = z.uuid().optional()
const memberPage = z.object({ members: identities, hasMore: z.boolean(), cursor: id.optional(), limit: z.number().int().min(1).max(MAX_MEMBERS_PAGE_SIZE),
  total: z.number().int().nonnegative().optional(), liveRevision: z.number().int().nonnegative(), observed, auxiliaryReadEpoch })
  .refine(page => !page.hasMore || !!page.cursor)
const memberPages = z.object({ pages: z.array(memberPage).min(1), pageParams: z.array(z.union([id, z.null(), z.undefined()])).min(1) })
  .refine(value => value.pages.length === value.pageParams.length && value.pageParams[0] == null
    && value.pages.every((_, index) => index === 0 || value.pages[index - 1].hasMore && value.pageParams[index] === value.pages[index - 1].cursor))
const channelRoster = z.object({ serverId: id.nullable(), relation: z.enum(["access", "notify"]), creatorIds: ids, members: identities, observed, auxiliaryReadEpoch })
  .refine(value => value.creatorIds.every(userId => value.members.some(member => member.userId === userId)))
const addable = z.object({ serverId: id, relation: z.enum(["access", "notify"]), members: identities, observed, auxiliaryReadEpoch })
const invitable = z.object({ serverId: id, friendIds: ids, totalFriends: z.number().int().nonnegative(), observed, auxiliaryReadEpoch })
  .refine(value => value.totalFriends >= value.friendIds.length)
const search = z.object({ ids, observed, auxiliaryReadEpoch })
const invite = z.object({ code: id, creatorId: id.nullable(), uses: z.number().int().nonnegative(), maxUses: z.number().int().nonnegative().nullable(), expiresAt: id.nullable() })
const invites = z.object({ invites: z.array(invite), observed, auxiliaryReadEpoch })
  .refine(value => new Set(value.invites.map(row => row.code)).size === value.invites.length)
export const inviteInfoReadSchema = z.object({ serverId: id, serverName: id, serverIcon: z.string().nullable(), memberCount: z.number().int().nonnegative(), observed, auxiliaryReadEpoch })

export type MemberIdentity = z.infer<typeof identity>
export type MemberWindow = z.infer<typeof memberPage>
export type MembersWindowCache = InfiniteData<MemberWindow, string | null | undefined>
export type ChannelRosterWindow = z.infer<typeof channelRoster>
export type AddableMembersWindow = z.infer<typeof addable>
export type InvitableFriendsWindow = z.infer<typeof invitable>
export type UserSearchWindow = z.infer<typeof search>
export type InvitesWindow = z.infer<typeof invites>
export type InviteInfoWindow = z.infer<typeof inviteInfoReadSchema>

export type DirectoryWindow =
  | { kind: "members"; serverId: string; data: MembersWindowCache }
  | { kind: "channel-members"; channelId: string; data: ChannelRosterWindow }
  | { kind: "addable"; channelId: string; data: AddableMembersWindow }
  | { kind: "invitable"; serverId: string; data: InvitableFriendsWindow }
  | { kind: "search"; data: UserSearchWindow }
  | { kind: "invites"; serverId: string; data: InvitesWindow }
  | { kind: "invite-info"; token: string; data: InviteInfoWindow }

type Rows = { [N in "servers" | "channels" | "serverMemberships" | "channelMemberships" | "friendships" | "profiles"]?: readonly CommunityCollectionRows[N][] }

export function directoryWindowRetiredKeys(window: DirectoryWindow, retired: ReadonlyMap<string, { epoch: string }>, reference?: AuxiliaryReadReference) {
  return auxiliaryWindowRetiredKeys(window.kind === "members" ? window.data.pages : [window.data], retired, reference)
}

export function directoryWindowScopeKeys(window: DirectoryWindow, rows: Pick<Rows, "serverMemberships">, viewer: string) {
  const scopes = new Set<string>()
  const serverId = window.kind === "members" || window.kind === "invitable" || window.kind === "invites" ? window.serverId
    : window.kind === "channel-members" || window.kind === "addable" ? window.data.serverId : null
  if (serverId) {
    scopes.add(auxiliaryWindowScopeKey({ kind: "server", id: serverId }))
    for (const row of rows.serverMemberships ?? []) if (row.viewer && row.userId === viewer && row.serverId === serverId)
      scopes.add(auxiliaryWindowScopeKey({ kind: "server-member", serverId, memberId: row.memberId }))
  }
  const members = window.kind === "members" ? window.data.pages.flatMap(page => page.members)
    : window.kind === "channel-members" || window.kind === "addable" ? window.data.members : []
  for (const member of members) {
    if (serverId) scopes.add(auxiliaryWindowScopeKey({ kind: "server-member", serverId, memberId: member.id }))
    if (window.kind === "channel-members") scopes.add(auxiliaryWindowScopeKey({ kind: "channel-member", channelId: window.channelId, userId: member.userId, relation: window.data.relation }))
  }
  if (window.kind === "invitable") for (const id of window.data.friendIds) scopes.add(auxiliaryWindowScopeKey({ kind: "friendship", id }))
  if (window.kind === "invites") for (const row of window.data.invites) scopes.add(auxiliaryWindowScopeKey({ kind: "invite", id: row.code }))
  if (window.kind === "invite-info") scopes.add(auxiliaryWindowScopeKey({ kind: "invite", id: window.token }))
  return scopes
}

export function isDirectoryWindowKey(key: readonly unknown[]) {
  if (key[0] !== "community") return false
  if (key[1] === "servers" && typeof key[2] === "string" && key[2]) {
    if (key[3] === "members") return key.length === 4 || key.length === 6 && (
      key[4] === "search" && typeof key[5] === "string" && key[5].length > 0
      || key[4] === "complete" && key[5] === MAX_MEMBERS_PAGE_SIZE)
    return key.length === 4 && (key[3] === "invites" || key[3] === "invitable-friends")
  }
  if (key[1] === "channel" && typeof key[2] === "string" && key[2]) return key[3] === "members" && key.length === 5
    && (key[4] === "access" || key[4] === "notify") || key[3] === "addable-members" && key.length === 4
  return key.length === 3 && typeof key[2] === "string" && (key[1] === "user-search" && key[2].trim().length >= MIN_SEARCH_LENGTH
    || key[1] === "invite-info" && key[2].length > 0)
}

export function readDirectoryWindow(key: readonly unknown[], value: unknown): DirectoryWindow | undefined {
  const window = readLiveDirectoryWindow(key, value)
  if (!window) return
  if (window.kind === "members") {
    const pages: MemberWindow[] = []
    let count = 0
    for (const page of window.data.pages) {
      if (count + page.members.length > MAX_PERSISTED_DIRECTORY_ROWS) break
      pages.push({ ...page, observed: false })
      count += page.members.length
    }
    if (!pages.length) return
    const total = window.data.pages.at(-1)?.total
    if (total !== undefined) pages[pages.length - 1] = { ...pages.at(-1)!, total }
    return { ...window, data: { pages, pageParams: window.data.pageParams.slice(0, pages.length) } }
  }
  const size = window.kind === "channel-members" || window.kind === "addable" ? window.data.members.length
    : window.kind === "invitable" ? window.data.friendIds.length : window.kind === "search" ? window.data.ids.length
      : window.kind === "invites" ? window.data.invites.length : 1
  if (size > MAX_PERSISTED_DIRECTORY_ROWS) return
  return { ...window, data: { ...window.data, observed: false } } as DirectoryWindow
}

export function readLiveDirectoryWindow(key: readonly unknown[], value: unknown): DirectoryWindow | undefined {
  if (!isDirectoryWindowKey(key)) return
  if (key[1] === "servers" && key[3] === "members") {
    const parsed = memberPages.safeParse(value)
    if (!parsed.success) return
    return { kind: "members", serverId: key[2] as string, data: parsed.data }
  }
  if (key[1] === "channel") {
    if (key[3] === "members") {
      const parsed = channelRoster.safeParse(value)
      if (parsed.success && parsed.data.relation === key[4]) return { kind: "channel-members", channelId: key[2] as string, data: parsed.data }
    } else {
      const parsed = addable.safeParse(value)
      if (parsed.success) return { kind: "addable", channelId: key[2] as string, data: parsed.data }
    }
    return
  }
  if (key[1] === "servers" && key[3] === "invitable-friends") {
    const parsed = invitable.safeParse(value)
    if (parsed.success && parsed.data.serverId === key[2]) return { kind: "invitable", serverId: parsed.data.serverId, data: parsed.data }
  } else if (key[1] === "servers" && key[3] === "invites") {
    const parsed = invites.safeParse(value)
    if (parsed.success) return { kind: "invites", serverId: key[2] as string, data: parsed.data }
  } else if (key[1] === "user-search") {
    const parsed = search.safeParse(value)
    if (parsed.success) return { kind: "search", data: parsed.data }
  } else if (key[1] === "invite-info") {
    const parsed = inviteInfoReadSchema.safeParse(value)
    if (parsed.success) return { kind: "invite-info", token: key[2] as string, data: parsed.data }
  }
}

export function directoryWindowProfileIds(window: DirectoryWindow, rows: Pick<Rows, "friendships"> = {}) {
  if (window.kind === "members") return window.data.pages.flatMap(page => page.members.map(member => member.userId))
  if (window.kind === "channel-members" || window.kind === "addable") return window.data.members.map(member => member.userId)
  if (window.kind === "search") return window.data.ids
  if (window.kind === "invites") return window.data.invites.flatMap(invite => invite.creatorId ? [invite.creatorId] : [])
  if (window.kind === "invitable") {
    const friends = new Map(rows.friendships?.map(row => [row.id, row]))
    return window.data.friendIds.flatMap(id => { const row = friends.get(id); return row ? [row.userId] : [] })
  }
  return []
}

export function directoryWindowServerMembershipIds(window: DirectoryWindow) {
  if (window.kind === "members") return window.data.pages.flatMap(page => page.members.map(member => `${window.serverId}:${member.userId}`))
  if (window.kind === "addable" || window.kind === "channel-members" && window.data.serverId !== null)
    return window.data.members.map(member => `${window.data.serverId}:${member.userId}`)
  return []
}

export function directoryWindowChannelMembershipIds(window: DirectoryWindow) {
  return window.kind === "channel-members" ? window.data.members.map(member => `${window.channelId}:${member.userId}:${window.data.relation}`) : []
}

export function projectDirectoryWindow(window: DirectoryWindow, rows: Rows, retired: ReadonlySet<string> = new Set()): DirectoryWindow {
  if (window.kind === "invites") return { ...window, data: { ...window.data, invites: window.data.invites.filter(invite => !retired.has(auxiliaryWindowScopeKey({ kind: "invite", id: invite.code }))) } }
  if (window.kind === "addable") {
    const present = new Set(rows.channelMemberships?.filter(row => row.channelId === window.channelId && row.relation === window.data.relation).map(row => row.userId))
    return { ...window, data: { ...window.data, members: window.data.members.filter(member => !present.has(member.userId)) } }
  }
  if (window.kind === "invitable") {
    const friends = new Map(rows.friendships?.map(row => [row.id, row]))
    const present = new Set(rows.serverMemberships?.filter(row => row.serverId === window.serverId).map(row => row.userId))
    return { ...window, data: { ...window.data, friendIds: window.data.friendIds.filter(id => { const row = friends.get(id); return !row || !present.has(row.userId) }) } }
  }
  return window
}

export function directoryWindowComplete(window: DirectoryWindow, rows: Rows, viewer: string, retired: ReadonlySet<string> = new Set()) {
  const profiles = new Set(rows.profiles?.map(row => row.id))
  if (directoryWindowProfileIds(window, rows).some(id => !profiles.has(id))) return false
  const servers = new Set(rows.servers?.map(row => row.id))
  const serverMembers = new Map(rows.serverMemberships?.map(row => [row.id, row]))
  const channels = new Map(rows.channels?.map(row => [row.id, row]))
  const channelMembers = new Map(rows.channelMemberships?.map(row => [row.id, row]))
  const memberAvailable = (serverId: string, memberId: string) => !retired.has(auxiliaryWindowScopeKey({ kind: "server-member", serverId, memberId }))
  const serverAvailable = (serverId: string) => !retired.has(auxiliaryWindowScopeKey({ kind: "server", id: serverId })) && servers.has(serverId)
    && rows.serverMemberships?.some(row => row.serverId === serverId && row.viewer && row.userId === viewer && memberAvailable(serverId, row.memberId)) === true
  const channelAvailable = (channelId: string, serverId: string | null) => {
    const channel = channels.get(channelId)
    const parent = channel?.parentChannelId ? channels.get(channel.parentChannelId) : undefined
    return !!channel && !channel.pending && !retired.has(channelId) && channel.serverId === serverId
      && (serverId === null ? channel.type === "dm" : serverAvailable(serverId))
      && channelMembers.has(`${channelId}:${viewer}:access`)
      && (!channel.parentChannelId || !!parent && !parent.pending && parent.serverId === serverId && !retired.has(parent.id)
        && channelMembers.has(`${parent.id}:${viewer}:access`))
  }
  if (window.kind === "members") return serverAvailable(window.serverId) && window.data.pages.every(page => page.members.every(member => memberAvailable(window.serverId, member.id) && serverMembers.get(`${window.serverId}:${member.userId}`)?.memberId === member.id))
  if (window.kind === "channel-members") return channelAvailable(window.channelId, window.data.serverId)
    && window.data.members.every(member => !retired.has(auxiliaryWindowScopeKey({ kind: "channel-member", channelId: window.channelId, userId: member.userId, relation: window.data.relation }))
      && channelMembers.has(`${window.channelId}:${member.userId}:${window.data.relation}`)
      && (window.data.serverId === null ? member.id === member.userId : memberAvailable(window.data.serverId, member.id) && serverMembers.get(`${window.data.serverId}:${member.userId}`)?.memberId === member.id))
  if (window.kind === "addable") return channelAvailable(window.channelId, window.data.serverId)
    && window.data.members.every(member => memberAvailable(window.data.serverId, member.id) && serverMembers.get(`${window.data.serverId}:${member.userId}`)?.memberId === member.id)
  if (window.kind === "invitable") {
    const friends = new Map(rows.friendships?.map(row => [row.id, row]))
    return serverAvailable(window.serverId) && window.data.friendIds.every(id => !retired.has(auxiliaryWindowScopeKey({ kind: "friendship", id })) && friends.get(id)?.kind === "accepted")
  }
  if (window.kind === "invites") return serverAvailable(window.serverId)
  if (window.kind === "invite-info") return !retired.has(auxiliaryWindowScopeKey({ kind: "invite", id: window.token }))
  return true
}
