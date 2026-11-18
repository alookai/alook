import { describe, expect, it } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { AUXILIARY_READ_EPOCH_KEY, auxiliaryWindowScopeKey } from "./auxiliary-window-contract"
import { botDirectoryWindowComplete, botDirectoryWindowRetiredKeys, isBotDirectoryWindowKey, readBotDirectoryWindow } from "./bot-directory-window"

const date = "2026-11-01T12:00:00.000Z"
const marksKey = communityKeys.botMarks("bot")
const auditKey = communityKeys.botAuditLog("bot")
const mark = (index = 0) => ({ id: `mark-${index}`, server: "Private", serverId: "server", channel: "private", channelId: "private-channel", parentChannelId: null,
  m: { id: `message-${index}`, authorId: "author", authorName: "Saved author", authorAvatar: "A", authorAvatarVersion: 3, content: "Saved work", seq: index + 1, createdAt: date } })
const event = (index: number) => ({ id: `event-${String(index).padStart(4, "0")}`, kind: "text", payload: { text: "Saved thought", truncated: false, chars: 13 }, sessionId: null, launchId: null,
  createdAt: new Date(Date.parse(date) - index * 1000).toISOString() })
const page = (offset: number, size = 50) => ({ events: Array.from({ length: size }, (_, index) => event(offset + index)),
  nextCursor: { beforeCreatedAt: event(offset + size - 1).createdAt, beforeId: event(offset + size - 1).id }, authoritative: true, observed: true })
const botRows = { profiles: [profileResourceFixture({ id: "bot", kind: "bot", ownerUserId: "viewer" })] }

describe("C directory display windows", () => {
  it("admits only the exact seven resource keys", () => {
    for (const key of [marksKey, auditKey, communityKeys.botAuditPreview("bot"), communityKeys.botMemberships("bot"),
      communityKeys.botNotificationSetting("bot", "server", "scope"), communityKeys.botNotificationSetting("bot", "channel", "scope"), communityKeys.adminChannels("server")])
      expect(isBotDirectoryWindowKey(key)).toBe(true)
    for (const key of [[...marksKey, "command"], communityKeys.botMarks(""), communityKeys.adminChannels("__none__"),
      ["community", "bot", "bot", "notification-settings", "unknown", "scope"], ["community", "bot", "bot", "notification-settings", "server", ""]])
      expect(isBotDirectoryWindowKey(key)).toBe(false)
  })

  it("retains a complete owner-only preview without requiring the viewer's channel membership", () => {
    const data = { marked: [mark()], observed: true }
    const window = readBotDirectoryWindow(marksKey, data)!
    expect(window.data).toEqual({ marked: [mark()], observed: false })
    expect(botDirectoryWindowComplete(window, botRows, "viewer")).toBe(true)
    expect(botDirectoryWindowComplete(window, botRows, "other-viewer")).toBe(false)
    expect(botDirectoryWindowComplete(window, { profiles: [] }, "viewer")).toBe(false)
    expect(botDirectoryWindowComplete(window, botRows, "viewer", new Set([auxiliaryWindowScopeKey({ kind: "message", id: "message-0" })]))).toBe(false)
    expect(readBotDirectoryWindow(marksKey, { marked: [] })?.data).toEqual({ marked: [], observed: false })
    expect(readBotDirectoryWindow(marksKey, { marked: [mark(), mark()] })).toBeUndefined()
    expect(readBotDirectoryWindow(marksKey, { marked: Array.from({ length: 5 }, (_, index) => mark(index)) })).toBeUndefined()
  })

  it("keeps complete activity pages and the real continuation at the shared row limit", () => {
    const pages = Array.from({ length: 9 }, (_, index) => page(index * 50))
    const pageParams = [null, ...pages.slice(0, -1).map(page => page.nextCursor)]
    const window = readBotDirectoryWindow(auditKey, { pages, pageParams })
    expect(window?.kind).toBe("bot-audit")
    if (window?.kind !== "bot-audit") throw new Error("Missing audit window")
    expect(window.data.pages).toHaveLength(8)
    expect(window.data.pages.flatMap(page => page.events)).toHaveLength(400)
    expect(window.data.pages.at(-1)?.nextCursor).toEqual(pages[7].nextCursor)
    expect(window.data.pageParams).toEqual(pageParams.slice(0, 8))
    expect(window.data.pages.every(page => page.observed === false)).toBe(true)
    expect(readBotDirectoryWindow(auditKey, { pages, pageParams: [null, { beforeCreatedAt: date, beforeId: "wrong" }, ...pageParams.slice(2)] })).toBeUndefined()
  })

  it("preserves a legacy payload as an unavailable event and refuses WS-only completeness", () => {
    const first = page(0, 1)
    const window = readBotDirectoryWindow(auditKey, { pages: [{ ...first, events: [{ ...event(0), payload: { legacy: true } }] }], pageParams: [null] })
    if (window?.kind !== "bot-audit") throw new Error("Missing audit window")
    expect(window.data.pages[0].events[0]).toMatchObject({ id: "event-0000", payload: null })
    expect(readBotDirectoryWindow(auditKey, { pages: [{ ...first, authoritative: undefined }], pageParams: [null] })).toBeUndefined()
    expect(readBotDirectoryWindow(communityKeys.botAuditPreview("bot"), { pages: [{ ...first, events: [{ ...event(0), kind: "error" }] }], pageParams: [null] })).toBeUndefined()
  })

  it("does not let one fresh activity page requalify an older captured page", () => {
    const old = crypto.randomUUID(), fresh = crypto.randomUUID()
    const botKey = auxiliaryWindowScopeKey({ kind: "bot", id: "bot" })
    const retired = new Map([[botKey, { epoch: fresh }], [AUXILIARY_READ_EPOCH_KEY, { epoch: fresh }], ["physical-channel", { epoch: fresh }]])
    const pages = [{ ...page(0), auxiliaryReadEpoch: old }, { ...page(50), auxiliaryReadEpoch: fresh }]
    const read = (values: typeof pages) => readBotDirectoryWindow(auditKey, { pages: values, pageParams: [null, pages[0].nextCursor] })!
    expect(botDirectoryWindowRetiredKeys(read(pages), retired).has(botKey)).toBe(true)
    const qualified = botDirectoryWindowRetiredKeys(read(pages.map(page => ({ ...page, auxiliaryReadEpoch: fresh }))), retired)
    expect(qualified.has(botKey)).toBe(false)
    expect(qualified.has("physical-channel")).toBe(true)
  })

  it("keeps membership visibility while removing live Leave authority", () => {
    const channel = { id: "/Saved#1234/private", channelId: "private-channel", name: "Private", type: "text", visibility: "private", canLeave: true }
    const data = { servers: [{ id: "server", name: "Saved", handle: "Saved#1234", icon: null, canLeave: true, channels: [channel] }], observed: true }
    const window = readBotDirectoryWindow(communityKeys.botMemberships("bot"), data)!
    expect(window.data).toEqual({ servers: [{ id: "server", name: "Saved", handle: "Saved#1234", icon: null,
      channels: [{ id: channel.id, channelId: channel.channelId, name: channel.name, type: "text", visibility: "private" }] }], observed: false })
    expect(botDirectoryWindowComplete(window, botRows, "viewer")).toBe(true)
    expect(botDirectoryWindowComplete(window, botRows, "viewer", new Set([auxiliaryWindowScopeKey({ kind: "bot-server", botId: "bot", id: "server" })]))).toBe(false)
    expect(readBotDirectoryWindow(communityKeys.botMemberships("bot"), { servers: [{ ...data.servers[0], channels: [{ ...channel, id: "/Other#1234/private" }] }] })).toBeUndefined()
  })

  it("keeps explicit null notification separate from unknown and preserves exact scope", () => {
    const server = readBotDirectoryWindow(communityKeys.botNotificationSetting("bot", "server", "scope"), { level: null, serverId: "scope" })
    const channel = readBotDirectoryWindow(communityKeys.botNotificationSetting("bot", "channel", "scope"), { level: "mentions", serverId: "server" })
    expect(server).toMatchObject({ kind: "bot-notification", scope: { kind: "server", id: "scope" }, data: { level: null, observed: false } })
    expect(channel).toMatchObject({ kind: "bot-notification", scope: { kind: "channel", id: "scope" } })
    expect(readBotDirectoryWindow(communityKeys.botNotificationSetting("bot", "server", "scope"), {})).toBeUndefined()
  })

  it("requires the separate human admin dependency even for a known-empty directory", () => {
    const window = readBotDirectoryWindow(communityKeys.adminChannels("server"), { channels: [] })!
    const member = { id: "server:viewer", serverId: "server", userId: "viewer", memberId: "member", viewer: true, role: "admin" as const }
    const rows = { servers: [serverResourceFixture({ id: "server", ownerId: "owner" })], serverMemberships: [member] }
    expect(botDirectoryWindowComplete(window, rows, "viewer")).toBe(true)
    expect(botDirectoryWindowComplete(window, { ...rows, serverMemberships: [{ ...member, role: "member" }] }, "viewer")).toBe(false)
    expect(botDirectoryWindowComplete(window, rows, "viewer", new Set([auxiliaryWindowScopeKey({ kind: "server-admin", id: "server" })]))).toBe(false)
  })

  it("enforces actual page limits, cursor progress and the WS-only distinction", () => {
    expect(readBotDirectoryWindow(communityKeys.botAuditPreview("bot"), { pages: [page(0, 11)], pageParams: [null] })).toBeUndefined()
    expect(readBotDirectoryWindow(auditKey, { pages: [page(0, 51)], pageParams: [null] })).toBeUndefined()
    const first = page(0), second = page(50)
    expect(readBotDirectoryWindow(auditKey, { pages: [first, { ...second, nextCursor: first.nextCursor }], pageParams: [null, first.nextCursor] })).toBeUndefined()
    const live = { ...page(0, 51), liveIds: [event(50).id], nextCursor: first.nextCursor }
    expect(readBotDirectoryWindow(auditKey, { pages: [live], pageParams: [null] })).toMatchObject({ kind: "bot-audit" })
  })

  it("rejects an oversized complete directory and invalid handles even with no channels", () => {
    const server = (index: number) => ({ id: `server-${index}`, name: "Saved", handle: `Saved${index}#1234`, icon: null, channels: [] })
    expect(readBotDirectoryWindow(communityKeys.botMemberships("bot"), { servers: Array.from({ length: 400 }, (_, index) => server(index)) })).toBeDefined()
    expect(readBotDirectoryWindow(communityKeys.botMemberships("bot"), { servers: Array.from({ length: 401 }, (_, index) => server(index)) })).toBeUndefined()
    expect(readBotDirectoryWindow(communityKeys.botMemberships("bot"), { servers: [{ ...server(0), handle: "not-a-handle" }] })).toBeUndefined()
  })

  it("does not turn a fresh epoch into authority over an actually deleted resource", () => {
    const epoch = crypto.randomUUID(), deleted = auxiliaryWindowScopeKey({ kind: "server-resource", id: "server" })
    const window = readBotDirectoryWindow(marksKey, { marked: [mark()], auxiliaryReadEpoch: epoch })!
    const retired = botDirectoryWindowRetiredKeys(window, new Map([[AUXILIARY_READ_EPOCH_KEY, { epoch }], [deleted, { epoch }]]))
    expect(retired.has(deleted)).toBe(true)
    expect(botDirectoryWindowComplete(window, botRows, "viewer", retired)).toBe(false)
  })

  it("rejects an admin directory containing an actually deleted child channel", () => {
    const window = readBotDirectoryWindow(communityKeys.adminChannels("server"), { channels: [{ id: "deleted", name: "Deleted", type: "text", createdAt: date, category: null, creator: null }] })!
    const rows = { servers: [serverResourceFixture({ id: "server", ownerId: "viewer" })],
      serverMemberships: [{ id: "server:viewer", serverId: "server", userId: "viewer", memberId: "member", viewer: true, role: "owner" as const }] }
    expect(botDirectoryWindowComplete(window, rows, "viewer")).toBe(true)
    expect(botDirectoryWindowComplete(window, rows, "viewer", new Set([auxiliaryWindowScopeKey({ kind: "channel-resource", id: "deleted" })]))).toBe(false)
  })
})
