import { z } from "zod"
import { BotAuditEventSchema, parseNameAndTag, parseRef, type CommunityCollectionRows } from "@alook/shared"
import type { AuditKind } from "./models/audit"
import { compareAuditEventsNewestFirst } from "./models/audit"
import { auxiliaryWindowRetiredKeys, auxiliaryWindowScopeKey, MAX_PERSISTED_AUXILIARY_ROWS, type AuxiliaryReadReference } from "./auxiliary-window-contract"

const id = z.string().min(1)
const timestamp = z.iso.datetime({ offset: true })
const proof = { observed: z.boolean().optional(), auxiliaryReadEpoch: z.uuid().optional() }
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length
const cursor = z.object({ beforeCreatedAt: timestamp, beforeId: id })
const mark = z.object({
  id, server: z.string(), serverId: id.nullable(), channel: z.string(), channelId: id,
  parentChannelId: id.nullable().optional(),
  m: z.object({ id, authorId: id, authorName: z.string(), authorAvatar: z.string(), authorAvatarVersion: z.number().int().nonnegative(),
    content: z.string(), seq: z.number().int().positive(), createdAt: timestamp }),
})
const marks = z.object({ marked: z.array(mark).max(4), ...proof })
  .refine(value => unique(value.marked.map(row => row.id)) && unique(value.marked.map(row => row.m.id)))
const auditEvent = z.object({
  id, kind: z.custom<AuditKind>(value => BotAuditEventSchema.options.some(option => option.shape.kind.value === value)),
  payload: z.unknown(), sessionId: id.nullable(), launchId: id.nullable(), createdAt: timestamp,
}).transform(event => {
  const parsed = BotAuditEventSchema.safeParse(event)
  return { ...event, payload: parsed.success ? parsed.data.payload : null }
})
const auditPage = z.object({
  events: z.array(auditEvent), nextCursor: cursor.nullable(), liveIds: z.array(id).optional(),
  authoritative: z.literal(true), ...proof,
}).refine(page => unique(page.events.map(event => event.id)) && unique(page.liveIds ?? [])
  && (page.liveIds ?? []).every(id => page.events.some(event => event.id === id))
  && page.events.every((event, index) => index === 0 || compareAuditEventsNewestFirst(page.events[index - 1], event) <= 0))
const audit = z.object({ pages: z.array(auditPage).min(1), pageParams: z.array(cursor.nullable()).min(1) })
  .refine(value => value.pages.length === value.pageParams.length && value.pageParams[0] === null
    && unique(value.pages.flatMap(page => page.events.map(event => event.id)))
    && value.pages.every((page, index) => (page.nextCursor === null || !value.pageParams.slice(0, index + 1).some(param => param?.beforeId === page.nextCursor?.beforeId && param?.beforeCreatedAt === page.nextCursor?.beforeCreatedAt))
      && (index === 0 || value.pages[index - 1].nextCursor !== null
      && value.pageParams[index]?.beforeCreatedAt === value.pages[index - 1].nextCursor?.beforeCreatedAt
      && value.pageParams[index]?.beforeId === value.pages[index - 1].nextCursor?.beforeId)))
const membershipChannel = z.object({ id, channelId: id, name: z.string(), type: z.enum(["text", "forum"]), visibility: z.enum(["public", "private"]) })
const membershipServer = z.object({ id, name: z.string(), handle: id, icon: z.string().nullable(), channels: z.array(membershipChannel) })
const memberships = z.object({ servers: z.array(membershipServer), ...proof }).refine(value => {
  if (!unique(value.servers.map(server => server.id)) || !unique(value.servers.map(server => server.handle))
    || !unique(value.servers.flatMap(server => server.channels.map(channel => channel.id)))
    || !unique(value.servers.flatMap(server => server.channels.map(channel => channel.channelId)))) return false
  try { return value.servers.every(server => !!parseNameAndTag(server.handle) && server.channels.every(channel => channel.id.startsWith("/") && parseRef(channel.id).server === server.handle)) }
  catch { return false }
})
const notification = z.object({ level: z.enum(["all", "mentions", "nothing"]).nullable(), serverId: id.nullable(), ...proof })
const adminChannel = z.object({
  id, name: z.string(), type: z.enum(["text", "forum"]), createdAt: timestamp,
  category: z.object({ id, name: z.string(), private: z.boolean() }).nullable(),
  creator: z.object({ name: z.string(), handle: id }).nullable(),
})
const admin = z.object({ channels: z.array(adminChannel), ...proof })
  .refine(value => unique(value.channels.map(channel => channel.id)) && value.channels.every(channel => !channel.category
    || value.channels.every(other => other.category?.id !== channel.category!.id || JSON.stringify(other.category) === JSON.stringify(channel.category))))

export type BotReadProof = z.infer<z.ZodObject<typeof proof>>
type BotMembershipWindow = z.infer<typeof memberships>
export type BotDirectoryWindow =
  | { kind: "bot-marks"; botId: string; data: z.infer<typeof marks> }
  | { kind: "bot-audit"; botId: string; textOnly: boolean; data: z.infer<typeof audit> }
  | { kind: "bot-memberships"; botId: string; data: BotMembershipWindow }
  | { kind: "bot-notification"; botId: string; scope: { kind: "server" | "channel"; id: string }; data: z.infer<typeof notification> }
  | { kind: "admin-channels"; serverId: string; data: z.infer<typeof admin> }

export function isBotDirectoryWindowKey(key: readonly unknown[]) {
  if (key[0] !== "community" || typeof key[2] !== "string" || !key[2]) return false
  if (key[1] === "servers") return key.length === 4 && key[3] === "admin-channels" && !key[2].startsWith("__")
  return key[1] === "bot" && (key.length === 4 && ["marks", "audit-log", "audit-preview", "memberships"].includes(key[3] as string)
    || key.length === 6 && key[3] === "notification-settings" && (key[4] === "server" || key[4] === "channel") && typeof key[5] === "string" && !!key[5])
}

export function readBotDirectoryWindow(key: readonly unknown[], value: unknown): BotDirectoryWindow | undefined {
  if (!isBotDirectoryWindowKey(key)) return
  if (key[1] === "servers") {
    const parsed = admin.safeParse(value)
    if (parsed.success && parsed.data.channels.length <= MAX_PERSISTED_AUXILIARY_ROWS)
      return { kind: "admin-channels", serverId: key[2] as string, data: { ...parsed.data, observed: false } }
    return
  }
  const botId = key[2] as string
  if (key[3] === "marks") {
    const parsed = marks.safeParse(value)
    if (parsed.success) return { kind: "bot-marks", botId, data: { ...parsed.data, observed: false } }
  } else if (key[3] === "memberships") {
    const parsed = memberships.safeParse(value)
    if (parsed.success && parsed.data.servers.reduce((size, server) => size + 1 + server.channels.length, 0) <= MAX_PERSISTED_AUXILIARY_ROWS)
      return { kind: "bot-memberships", botId, data: { ...parsed.data, observed: false } }
  } else if (key[3] === "notification-settings") {
    const parsed = notification.safeParse(value)
    if (parsed.success && (key[4] !== "server" || parsed.data.serverId === key[5])) return { kind: "bot-notification", botId, scope: { kind: key[4] as "server" | "channel", id: key[5] as string }, data: { ...parsed.data, observed: false } }
  } else {
    const parsed = audit.safeParse(value)
    if (!parsed.success || key[3] === "audit-preview" && parsed.data.pages.some(page => page.events.some(event => event.kind !== "text"))) return
    const limit = key[3] === "audit-preview" ? 10 : 50
    if (parsed.data.pages.some(page => {
      const confirmed = page.events.filter(event => !page.liveIds?.includes(event.id))
      const last = confirmed.at(-1)
      return confirmed.length > limit || page.nextCursor !== null && (!last || page.nextCursor.beforeId !== last.id || page.nextCursor.beforeCreatedAt !== last.createdAt)
    })) return
    const pages: z.infer<typeof auditPage>[] = []
    let size = 0
    for (const page of parsed.data.pages) {
      if (size + page.events.length > MAX_PERSISTED_AUXILIARY_ROWS) break
      pages.push({ ...page, observed: false })
      size += page.events.length
    }
    if (pages.length) return { kind: "bot-audit", botId, textOnly: key[3] === "audit-preview", data: { pages, pageParams: parsed.data.pageParams.slice(0, pages.length) } }
  }
}

export function botDirectoryWindowRetiredKeys(window: BotDirectoryWindow, retired: ReadonlyMap<string, { epoch: string }>, reference?: AuxiliaryReadReference) {
  return auxiliaryWindowRetiredKeys(window.kind === "bot-audit" ? window.data.pages : [window.data], retired, reference)
}

export function botDirectoryWindowScopeKeys(window: BotDirectoryWindow) {
  if (window.kind === "admin-channels") return new Set([auxiliaryWindowScopeKey({ kind: "server-admin", id: window.serverId })])
  const scopes = new Set([auxiliaryWindowScopeKey({ kind: "bot", id: window.botId })])
  if (window.kind === "bot-memberships") {
    scopes.add(auxiliaryWindowScopeKey({ kind: "bot-memberships", id: window.botId }))
    for (const server of window.data.servers) scopes.add(auxiliaryWindowScopeKey({ kind: "bot-server", botId: window.botId, id: server.id }))
  }
  if (window.kind === "bot-notification") {
    scopes.add(auxiliaryWindowScopeKey({ kind: window.scope.kind === "server" ? "bot-server" : "bot-channel", botId: window.botId, id: window.scope.id }))
    if (window.data.serverId) scopes.add(auxiliaryWindowScopeKey({ kind: "bot-server", botId: window.botId, id: window.data.serverId }))
  }
  return scopes
}

type Rows = { [N in "profiles" | "servers" | "serverMemberships"]?: readonly CommunityCollectionRows[N][] }

export function botDirectoryWindowComplete(window: BotDirectoryWindow, rows: Rows, viewer: string, retired: ReadonlySet<string> = new Set()) {
  const serverDeleted = (id: string) => retired.has(auxiliaryWindowScopeKey({ kind: "server-resource", id }))
  const channelDeleted = (id: string) => retired.has(auxiliaryWindowScopeKey({ kind: "channel-resource", id }))
  if (window.kind === "admin-channels") return !serverDeleted(window.serverId) && !retired.has(auxiliaryWindowScopeKey({ kind: "server-admin", id: window.serverId }))
    && window.data.channels.every(channel => !channelDeleted(channel.id))
    && rows.servers?.some(server => server.id === window.serverId) === true
    && rows.serverMemberships?.some(member => member.serverId === window.serverId && member.userId === viewer && member.viewer && (member.role === "owner" || member.role === "admin")) === true
  if (retired.has(auxiliaryWindowScopeKey({ kind: "bot", id: window.botId }))
    || !rows.profiles?.some(profile => profile.id === window.botId && profile.kind === "bot" && profile.ownerUserId === viewer)) return false
  if (window.kind === "bot-marks") return window.data.marked.every(mark => !retired.has(auxiliaryWindowScopeKey({ kind: "message", id: mark.m.id }))
    && !channelDeleted(mark.channelId) && (!mark.parentChannelId || !channelDeleted(mark.parentChannelId)) && (!mark.serverId || !serverDeleted(mark.serverId)))
  if (window.kind === "bot-memberships") return !retired.has(auxiliaryWindowScopeKey({ kind: "bot-memberships", id: window.botId }))
    && window.data.servers.every(server => !serverDeleted(server.id) && !retired.has(auxiliaryWindowScopeKey({ kind: "bot-server", botId: window.botId, id: server.id }))
      && server.channels.every(channel => !channelDeleted(channel.channelId)))
  if (window.kind === "bot-notification") return !retired.has(auxiliaryWindowScopeKey({ kind: window.scope.kind === "server" ? "bot-server" : "bot-channel", botId: window.botId, id: window.scope.id }))
    && (window.scope.kind !== "channel" || !channelDeleted(window.scope.id))
    && (window.data.serverId === null || !serverDeleted(window.data.serverId) && !retired.has(auxiliaryWindowScopeKey({ kind: "bot-server", botId: window.botId, id: window.data.serverId })))
  return true
}
