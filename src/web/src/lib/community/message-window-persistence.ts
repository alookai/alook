import { z } from "zod"
import { communityMessageProfileIds, type CommunityCollectionRows } from "@alook/shared"
import type { QueryKey } from "@tanstack/react-query"
import { messageWindowIdentity, type MessageWindowData } from "./message-window-contract"
import { messageWindowPage } from "./models/message"

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

export function boundPersistedMessageWindow(value: PersistedMessageWindow, messages: ReadonlyMap<string, CommunityCollectionRows["messages"]>, limit: number): PersistedMessageWindow | undefined {
  const { pages, pageParams } = value.data
  const references = pages.flatMap(page => page.messages)
  const ids = new Set(references.map(row => row.id))
  if (references.length === ids.size && ids.size <= limit && pages.length <= limit) return value

  const rows = new Map<string, CommunityCollectionRows["messages"]>()
  for (const reference of references) {
    const row = messages.get(reference.id)
    if (!row || row.channelId !== value.channelId || reference.seq !== undefined && reference.seq !== row.seq) return
    rows.set(row.id, row)
  }
  const retained = [...rows.values()].sort((a, b) => {
    const left = `${a.createdAt}|${a.id}`
    const right = `${b.createdAt}|${b.id}`
    return left < right ? -1 : left > right ? 1 : 0
  }).slice(-limit)
  const oldestPage = pages[pages.length - 1]
  const hasMoreOlder = ids.size > limit ? true : oldestPage.hasMoreOlder ?? oldestPage.hasMore
  const hasMoreNewer = pages[0].hasMoreNewer
  const oldest = retained[0], newest = retained.at(-1)
  const page = messageWindowPage({ messages: retained, hasMoreOlder, hasMoreNewer,
    olderCursor: hasMoreOlder && oldest ? `${oldest.createdAt}|${oldest.id}` : undefined,
    newerCursor: hasMoreNewer && newest ? `${newest.createdAt}|${newest.id}` : undefined,
    latestSeq: Math.max(0, ...pages.map(part => part.latestSeq ?? 0)),
  })
  return { ...value, data: { pages: [page], pageParams: [pageParams[0]] } }
}
