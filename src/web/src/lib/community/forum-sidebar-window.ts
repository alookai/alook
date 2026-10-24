import { z } from "zod"
import { projectForumSidebar } from "./forum-sidebar"
import type { CommunityCollectionRows } from "@/lib/community-db/schema"

const referenceSchema = z.object({ id: z.string().min(1), parentChannelId: z.string().min(1), parentMessageId: z.string().min(1) })
const retainedSchema = z.discriminatedUnion("disposition", [
  z.object({ id: z.string().min(1), disposition: z.literal("eligible"), reference: referenceSchema }),
  z.object({ id: z.string().min(1), disposition: z.enum(["opener-archived", "genuine-negative"]) }),
])
const resultSchema = z.object({
  serverNow: z.string().refine(value => Number.isFinite(Date.parse(value))),
  serverClockOffsetMs: z.number(),
  window: z.object({
    version: z.literal(1), accountId: z.string().min(1), serverId: z.string().min(1),
    parents: z.array(z.string().min(1)), base: z.array(referenceSchema), retained: retainedSchema.nullable(),
  }),
})
export type ForumSidebarWindow = z.infer<typeof resultSchema>["window"]
type WindowRows = Pick<CommunityCollectionRows, "servers" | "channels" | "channelMemberships" | "messages">
type ForumSidebarWindowRows = { [N in keyof WindowRows]: readonly WindowRows[N][] }

export function isForumSidebarWindowKey(key: readonly unknown[]): boolean {
  return key.length === 4 && key[0] === "community" && key[1] === "servers" && typeof key[2] === "string" && key[3] === "forum-sidebar-base"
}

export function readForumSidebarWindowResult(data: unknown) {
  const parsed = resultSchema.safeParse(data)
  if (!parsed.success) return undefined
  const { window } = parsed.data
  const parents = new Set(window.parents)
  const ids = new Set(window.base.map(row => row.id))
  if (parents.size !== window.parents.length || ids.size !== window.base.length
    || window.base.some(row => !parents.has(row.parentChannelId))
    || window.parents.some(id => window.base.filter(row => row.parentChannelId === id).length > 5)
    || window.retained?.disposition === "eligible" && (window.retained.reference.id !== window.retained.id || !parents.has(window.retained.reference.parentChannelId))) return undefined
  return { ...parsed.data, threads: [], verifiedEpoch: -1 }
}

export function forumSidebarWindowComplete(
  window: ForumSidebarWindow, rows: ForumSidebarWindowRows, accountId: string | null, serverId: string, retainId?: string | null, serverNowMs = Date.now(),
) {
  if (window.accountId !== accountId || window.serverId !== serverId
    || !rows.servers.some(row => row.id === serverId && row.detailComplete)) return false
  const parents = rows.channels.filter(row => row.serverId === serverId && row.type === "forum")
  if (window.parents.some(id => !parents.some(row => row.id === id))) return false
  const visible = projectForumSidebar(rows.channels, rows.channelMemberships, rows.messages, accountId, serverId,
    retainId ?? (window.retained?.disposition === "eligible" ? window.retained.id : null), serverNowMs).threads
  const references = [...window.base, ...(window.retained?.disposition === "eligible" ? [window.retained.reference] : []), ...visible]
  if (!references.every(reference => rows.channels.some(row => row.id === reference.id && row.serverId === serverId
    && row.type === "thread" && row.parentChannelId === reference.parentChannelId && row.parentMessageId === reference.parentMessageId)
    && rows.messages.some(row => row.id === reference.parentMessageId && row.channelId === reference.parentChannelId)
    && rows.channelMemberships.some(row => row.channelId === reference.id && row.userId === accountId && row.relation === "notify"))) return false
  return !retainId || window.base.some(row => row.id === retainId) || window.retained?.id === retainId
}
