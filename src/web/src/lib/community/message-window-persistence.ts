import { z } from "zod"
import { communityMessageProfileIds, type CommunityCollectionRows } from "@alook/shared"
import type { QueryKey } from "@tanstack/react-query"
import { messageWindowIdentity, type MessageWindowData } from "./message-window-contract"

export { messageWindowIdentity } from "./message-window-contract"

const id = z.string().min(1)
const cursor = id.optional()
const param = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("newest") }), z.object({ mode: z.literal("anchor"), anchor: id }),
  z.object({ mode: z.literal("since"), since: id }), z.object({ mode: z.literal("older"), cursor: id }),
  z.object({ mode: z.literal("newer"), cursor: id }),
])
const page = z.object({
  messages: z.array(z.object({ id, seq: z.number().int().positive().optional() })),
  hasMoreOlder: z.boolean().optional(), hasMoreNewer: z.boolean().optional(), hasMore: z.boolean().optional(),
  olderCursor: cursor, newerCursor: cursor, newestCursor: cursor, cursor,
  latestSeq: z.number().int().nonnegative().optional(),
}).refine(value => new Set(value.messages.map(row => row.id)).size === value.messages.length)
const window = z.object({ pages: z.array(page).min(1), pageParams: z.array(param).min(1) })
  .refine(value => value.pages.length === value.pageParams.length)

export type PersistedMessageWindow = { key: QueryKey; channelId: string; data: MessageWindowData; updatedAt: number }
type Rows = { [N in "channels" | "servers" | "channelMemberships" | "messages" | "profiles"]?: readonly CommunityCollectionRows[N][] }

export function readPersistedMessageWindow(key: QueryKey, value: unknown, updatedAt: number): PersistedMessageWindow | undefined {
  const identity = messageWindowIdentity(key)
  if (!identity || identity.initial.mode === "since" || !Number.isFinite(updatedAt) || updatedAt < 0) return
  const parsed = window.safeParse(value)
  if (parsed.success) return { key, channelId: identity.channelId, data: parsed.data, updatedAt }
}

export function messageWindowMessageIds(value: PersistedMessageWindow) {
  return [...new Set(value.data.pages.flatMap(page => page.messages.map(row => row.id)))]
}

export function messageWindowDependencies(value: PersistedMessageWindow, messages: readonly CommunityCollectionRows["messages"][]) {
  const ids = messageWindowMessageIds(value), byId = new Map(messages.map(row => [row.id, row]))
  return [...new Set([...ids, ...ids.flatMap(id => {
    const row = byId.get(id)
    return row?.replyTo && !row.replyTo.deleted && row.replyToId ? [row.replyToId] : []
  })])]
}

export function persistedMessageWindowComplete(value: PersistedMessageWindow, rows: Rows, viewer: string, retired: ReadonlySet<string> = new Set()) {
  const channels = new Map(rows.channels?.map(row => [row.id, row])), channel = channels.get(value.channelId)
  const parent = channel?.parentChannelId ? channels.get(channel.parentChannelId) : undefined
  const accessible = (id: string) => rows.channelMemberships?.some(row => row.channelId === id && row.userId === viewer && row.relation === "access")
  if (!channel || channel.pending || channel.archived || channel.type === "forum" || retired.has(channel.id) || !accessible(channel.id)
    || channel.type === "thread" && (!parent || parent.pending || parent.archived || retired.has(parent.id) || !accessible(parent.id)
      || parent.serverId !== channel.serverId || parent.type !== "forum" && parent.type !== "text" || !channel.parentMessageId)
    || channel.type !== "thread" && channel.parentChannelId) return false
  const messages = new Map(rows.messages?.map(row => [row.id, row]))
  for (const page of value.data.pages) {
    const sequences = new Set<number>()
    for (const ref of page.messages) {
      const row = messages.get(ref.id)
      if (!row || row.channelId !== channel.id || typeof row.seq !== "number" || row.seq <= 0
        || ref.seq !== undefined && ref.seq !== row.seq || sequences.has(row.seq)) return false
      sequences.add(row.seq)
    }
  }
  const dependencies = messageWindowDependencies(value, rows.messages ?? []).map(id => messages.get(id))
  if (dependencies.some(row => !row || row.channelId !== channel.id)) return false
  const profiles = new Set(rows.profiles?.map(row => row.id))
  return communityMessageProfileIds(dependencies as CommunityCollectionRows["messages"][]).every(id => profiles.has(id))
}

export function boundPersistedMessageWindow(value: PersistedMessageWindow, messages: readonly CommunityCollectionRows["messages"][], limit: number): PersistedMessageWindow | undefined {
  if (messageWindowMessageIds(value).length <= limit && value.data.pages.length <= limit) return value
  const first = value.data.pages[0], refs = first.messages.slice(-limit)
  if (!refs.length) return
  const oldest = messages.find(row => row.id === refs[0].id)
  if (!oldest) return
  return { ...value, data: { pages: [{ ...first, messages: refs, hasMoreOlder: true,
    olderCursor: `${oldest.createdAt}|${oldest.id}`, ...(first.hasMore === undefined ? {} : { hasMore: true, cursor: `${oldest.createdAt}|${oldest.id}` }) }],
    pageParams: [value.data.pageParams[0]] } }
}
