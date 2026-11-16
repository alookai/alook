import { z } from "zod"
import { communityMessageProfileIds, type CommunityCollectionRows } from "@alook/shared"

const id = z.string().min(1)
const ids = z.array(id).refine(rows => new Set(rows).size === rows.length)
const friendsSchema = z.object({ ids })
const forumEnvelopeSchema = z.object({ pages: z.array(z.unknown()).min(1), pageParams: z.array(z.unknown()).min(1) })
const forumPageSchema = z.object({
  serverId: id,
  parentType: z.literal("forum"),
  threads: z.array(z.object({ id, openerMessageId: id.nullable(), participantIds: ids })).max(100),
  hasMore: z.boolean(),
  nextCursor: id.optional(),
}).refine(page => (!page.hasMore || !!page.nextCursor) && new Set(page.threads.map(row => row.id)).size === page.threads.length)
const markedSchema = z.object({ marked: z.array(z.object({
  id, server: z.string(), serverId: id.nullable(), channel: z.string(), channelId: id,
  parentChannelId: id.nullable().optional(), m: z.object({ id }),
})).max(200) }).refine(data => new Set(data.marked.map(row => row.id)).size === data.marked.length
  && new Set(data.marked.map(row => row.m.id)).size === data.marked.length)

export type PageListWindow =
  | { kind: "friends"; data: z.infer<typeof friendsSchema> }
  | { kind: "forum"; channelId: string; tag: string | null; data: { pages: [z.infer<typeof forumPageSchema>]; pageParams: [null] } }
  | { kind: "marked"; data: z.infer<typeof markedSchema> }

export function isPageListQueryKey(key: readonly unknown[]) {
  return key[0] === "community" && (
    key.length === 2 && key[1] === "friends"
    || key.length === 3 && key[1] === "inbox" && key[2] === "marked"
    || key.length === 6 && key[1] === "channel" && typeof key[2] === "string" && !!key[2]
      && key[3] === "threads" && key[4] === "feed" && (key[5] === null || typeof key[5] === "string")
  )
}

export function readPageListWindow(key: readonly unknown[], value: unknown): PageListWindow | undefined {
  if (!isPageListQueryKey(key)) return
  if (key[1] === "friends") {
    const parsed = friendsSchema.safeParse(value)
    if (parsed.success) return { kind: "friends", data: parsed.data }
  } else if (key[1] === "inbox") {
    const parsed = markedSchema.safeParse(value)
    if (parsed.success) return { kind: "marked", data: parsed.data }
  } else {
    const envelope = forumEnvelopeSchema.safeParse(value)
    if (!envelope.success || envelope.data.pages.length !== envelope.data.pageParams.length || envelope.data.pageParams[0] !== null) return
    const page = forumPageSchema.safeParse(envelope.data.pages[0])
    if (page.success) return { kind: "forum", channelId: key[2] as string, tag: key[5] as string | null, data: { pages: [page.data], pageParams: [null] } }
  }
}

type PageListRows = Pick<CommunityCollectionRows, "servers" | "channels" | "messages" | "profiles" | "friendships">
type Rows = { [N in keyof PageListRows]: readonly PageListRows[N][] }

function pageListRootMessageIds(window: PageListWindow, channels: readonly CommunityCollectionRows["channels"][]) {
  if (window.kind === "marked") return window.data.marked.map(row => row.m.id)
  if (window.kind === "friends") return []
  const byId = new Map(channels.map(row => [row.id, row]))
  return window.data.pages[0].threads.flatMap(row => [
    ...(row.openerMessageId ? [row.openerMessageId] : []),
    ...(byId.get(row.id)?.firstMessageId ? [byId.get(row.id)!.firstMessageId!] : []),
  ])
}

export function pageListMessageIds(window: PageListWindow, channels: readonly CommunityCollectionRows["channels"][], messages: readonly CommunityCollectionRows["messages"][]) {
  const roots = pageListRootMessageIds(window, channels), byId = new Map(messages.map(row => [row.id, row]))
  return [...new Set([...roots, ...roots.flatMap(id => {
    const row = byId.get(id)
    return row?.replyTo && !row.replyTo.deleted && row.replyToId ? [row.replyToId] : []
  })])]
}

export function pageListWindowComplete(window: PageListWindow, rows: Rows, retired: ReadonlySet<string> = new Set()) {
  const channels = new Map(rows.channels.map(row => [row.id, row]))
  const messages = new Map(rows.messages.map(row => [row.id, row]))
  const profiles = new Set(rows.profiles.map(row => row.id))
  const servers = new Set(rows.servers.map(row => row.id))
  const channelAvailable = (channelId: string) => {
    const channel = channels.get(channelId)
    const parent = channel?.parentChannelId ? channels.get(channel.parentChannelId) : undefined
    return channel && !channel.pending && !retired.has(channelId)
      && (!channel.parentChannelId || parent && !parent.pending && parent.serverId === channel.serverId && !retired.has(parent.id))
      && (!channel.serverId || servers.has(channel.serverId))
  }
  if (window.kind === "friends") {
    const friends = new Map(rows.friendships.map(row => [row.id, row]))
    return window.data.ids.every(id => { const row = friends.get(id); return row && profiles.has(row.userId) })
  }
  if (window.kind === "forum") {
    const page = window.data.pages[0], parent = channels.get(window.channelId)
    if (!channelAvailable(window.channelId) || parent?.type !== "forum" || parent.serverId !== page.serverId) return false
    if (!page.threads.every(row => {
      const child = channels.get(row.id), opener = row.openerMessageId ? messages.get(row.openerMessageId) : undefined
      return channelAvailable(row.id) && child?.type === "thread" && child.serverId === page.serverId
        && child.parentChannelId === parent.id && child.parentMessageId === row.openerMessageId
        && opener?.channelId === parent.id && row.participantIds.every(id => profiles.has(id))
        && (!child.firstMessageId || messages.get(child.firstMessageId)?.channelId === child.id)
    })) return false
  } else if (!window.data.marked.every(row => {
    const channel = channels.get(row.channelId)
    return channelAvailable(row.channelId) && (channel?.serverId ?? null) === row.serverId
      && (row.parentChannelId === undefined || row.parentChannelId === channel?.parentChannelId)
      && messages.get(row.m.id)?.channelId === row.channelId
  })) return false
  if (!pageListRootMessageIds(window, rows.channels).every(id => {
    const row = messages.get(id)
    return row && (!row.replyTo || row.replyTo.deleted || !row.replyToId || messages.get(row.replyToId)?.channelId === row.channelId)
  })) return false
  const dependencies = pageListMessageIds(window, rows.channels, rows.messages).map(id => messages.get(id))
  return dependencies.every(row => row !== undefined && !retired.has(row.channelId))
    && communityMessageProfileIds(dependencies as CommunityCollectionRows["messages"][]).every(id => profiles.has(id))
}
