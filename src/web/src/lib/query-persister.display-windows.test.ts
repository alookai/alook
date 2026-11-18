import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { QueryClient, dehydrate } from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { clearAllPersistedCaches, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS } from "./query-persister"
import { communityKeys } from "./query-keys"
import { displayWindowComplete, readDisplayWindow } from "./community/display-window-persistence"
import { get } from "idb-keyval"
import { cacheStore } from "./query-cache-store"
import { blobKeyFor } from "./persisted-account-identity"
import { auxiliaryWindowScopeKey } from "./community/auxiliary-window-contract"
import { canonicalChannelRow, canonicalChannelMembershipRow } from "./community-db/schema"
import { channelResourceFixture, messageResourceFixture } from "@/test/community-resource-fixtures"

const viewer = "viewer"
const summary = { plan: { id: "free", displayName: "Free" }, isFounder: false, offers: [], subscription: null }
const catalog = { free: { plan: summary.plan, botLimit: 1, machineLimit: 1 }, offers: [] }
const code = { id: "code", name: "Code", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: null, permissions: [{ permission: "machine.read", limit: 1, period: "hour" }] }
const codesKey = ["community", "automation-access-codes", viewer]
const billingKey = ["application", viewer, "billing"]
const snapshot = (client: QueryClient): PersistedClient => ({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client, { shouldDehydrateQuery: () => true }) })
const data = (input: PersistedClient | undefined, key: readonly unknown[]) => input?.clientState.queries.find(query => JSON.stringify(query.queryKey) === JSON.stringify(key))?.state.data
beforeEach(clearAllPersistedCaches)

describe("D complete display windows", () => {
  it("keeps known empty, null and false distinct from unknown and strips one-time secrets", () => {
    expect(readDisplayWindow(codesKey, undefined)).toBeUndefined()
    expect(readDisplayWindow(codesKey, { accessCodes: [] })?.data).toEqual({ accessCodes: [], observed: false })
    expect(readDisplayWindow(codesKey, { accessCodes: [code], secret: "one-time", receipt: { secret: "one-time" } })?.data).toEqual({ accessCodes: [code], observed: false })
    expect(readDisplayWindow(codesKey, { accessCodes: [code, code] })).toBeUndefined()
    expect(readDisplayWindow(["public-pricing"], null)).toBeUndefined()
    expect(readDisplayWindow(["public-pricing"], catalog)?.data).toEqual({ ...catalog, observed: false })
    expect(readDisplayWindow(communityKeys.billing(), summary)?.data).toEqual({ ...summary, observed: false })
    expect(readDisplayWindow(communityKeys.messageMarked("message"), { marked: false })?.data).toEqual({ marked: false, observed: false })
    expect(readDisplayWindow([...communityKeys.messageMarked("message"), "command"], { marked: true })).toBeUndefined()
  })

  it("requires exact reaction scope and only the profiles the actual response permitted", () => {
    const key = communityKeys.reactionDetails("message")
    const value = { messageId: "message", scope: { kind: "dm", channelId: "dm" }, actors: [{ userId: "actor", profilePresent: true }] }
    const rows: Parameters<typeof displayWindowComplete>[1] = {
      channels: [canonicalChannelRow(channelResourceFixture({ id: "dm", type: "dm", serverId: null }))],
      messages: [messageResourceFixture({ id: "message", channelId: "dm" })],
      channelMemberships: [canonicalChannelMembershipRow("dm", viewer, "access", { source: "explicit" })], profiles: [],
    }
    expect(displayWindowComplete(readDisplayWindow(key, value)!, rows, viewer, "community")).toBe(false)
    const noProfile = readDisplayWindow(key, { ...value, actors: [{ userId: "actor", profilePresent: false }] })!
    expect(displayWindowComplete(noProfile, rows, viewer, "community")).toBe(true)
    expect(displayWindowComplete(noProfile, { ...rows, channelMemberships: [] }, viewer, "community")).toBe(false)
    expect(readDisplayWindow(key, { ...value, messageId: "different" })).toBeUndefined()
  })

  it("preserves last success through refresh error, resave and a third owner", async () => {
    const client = new QueryClient(), original = createIdbPersister(viewer)
    client.setQueryData(codesKey, { accessCodes: [code], secret: "one-time", observed: true })
    client.setQueryData(communityKeys.billing(), { ...summary, observed: true })
    client.setQueryData(communityKeys.messageMarked("message"), { marked: false, observed: true })
    const readAt = client.getQueryState(codesKey)!.dataUpdatedAt
    await original.persistClient(snapshot(client)); original.stopPersisting(); client.clear()
    const second = createIdbPersister(viewer), restored = await second.restoreClient()
    expect(data(restored, codesKey)).toEqual({ accessCodes: [code], observed: false })
    expect(data(restored, communityKeys.billing())).toEqual({ ...summary, observed: false })
    expect(data(restored, communityKeys.messageMarked("message"))).toEqual({ marked: false, observed: false })
    const failed = structuredClone(restored!)
    for (const query of failed.clientState.queries) Object.assign(query.state, { status: "error", error: new Error("503"), fetchFailureCount: 1 })
    await second.persistClient(failed); second.stopPersisting()
    const third = await createIdbPersister(viewer).restoreClient()
    expect(data(third, codesKey)).toEqual({ accessCodes: [code], observed: false })
    expect(third?.clientState.queries.find(query => JSON.stringify(query.queryKey) === JSON.stringify(codesKey))?.state).toMatchObject({ status: "success", error: null, dataUpdatedAt: readAt })
  })

  it("keeps application and community payloads separate and admits no private guest or foreign-owner billing", async () => {
    const community = new QueryClient(), app = new QueryClient()
    community.setQueryData(communityKeys.communityDbCollection(viewer, "profiles"), [{ id: viewer, name: "Viewer", discriminator: "0042", avatar: null, avatarVersion: 0 }])
    const main = createIdbPersister(viewer)
    await main.persistClient(snapshot(community))
    app.setQueryData(["public-pricing"], catalog)
    app.setQueryData(billingKey, summary)
    app.setQueryData(["application", "other", "billing"], summary)
    app.setQueryData(communityKeys.messageMarked("message"), { marked: true })
    const application = createIdbPersister(viewer, "application")
    await application.persistClient(snapshot(app))
    const mainRestore = await createIdbPersister(viewer).restoreClient(), appRestore = await createIdbPersister(viewer, "application").restoreClient()
    expect(data(mainRestore, communityKeys.communityDbCollection(viewer, "profiles"))).toHaveLength(1)
    expect(data(mainRestore, ["public-pricing"])).toBeUndefined()
    expect(data(appRestore, ["public-pricing"])).toEqual({ ...catalog, observed: false })
    expect(data(appRestore, billingKey)).toEqual({ ...summary, observed: false })
    expect(data(appRestore, ["application", "other", "billing"])).toBeUndefined()
    expect(data(appRestore, communityKeys.messageMarked("message"))).toBeUndefined()
    const guest = createIdbPersister(null, "application")
    await guest.persistClient(snapshot(app))
    expect(data(await guest.restoreClient(), ["public-pricing"])).toEqual({ ...catalog, observed: false })
    expect(data(await guest.restoreClient(), billingKey)).toBeUndefined()
    await application.retireAccount()
    expect(await main.restoreClient()).toBeUndefined()
    expect(await createIdbPersister(viewer, "application").restoreClient()).toBeUndefined()
    community.clear(); app.clear()
  })

  it("enforces twenty complete windows across both domains without renewing old read times", async () => {
    const community = new QueryClient(), app = new QueryClient(), now = Date.now()
    for (let index = 0; index < 20; index++) community.setQueryData(communityKeys.messageMarked(`m-${index}`), { marked: index % 2 === 0 }, { updatedAt: now - 100 + index })
    await createIdbPersister(viewer).persistClient(snapshot(community))
    app.setQueryData(["public-pricing"], catalog, { updatedAt: now })
    app.setQueryData(billingKey, summary, { updatedAt: now + 1 })
    await createIdbPersister(viewer, "application").persistClient(snapshot(app))
    const left = await createIdbPersister(viewer).restoreClient(), right = await createIdbPersister(viewer, "application").restoreClient()
    expect((left?.clientState.queries.length ?? 0) + (right?.clientState.queries.length ?? 0)).toBe(20)
    expect(data(left, communityKeys.messageMarked("m-0"))).toBeUndefined()
    expect(data(left, communityKeys.messageMarked("m-1"))).toBeUndefined()
    expect(data(left, communityKeys.messageMarked("m-2"))).toEqual({ marked: true, observed: false })
    expect(right?.clientState.queries.find(query => query.queryKey[0] === "public-pricing")?.state.dataUpdatedAt).toBe(now)
    community.clear(); app.clear()
  })

  it("fences an earlier queued Marked value and a deleted code while fresh confirmed false can persist", async () => {
    const client = new QueryClient(), writer = createIdbPersister(viewer)
    client.setQueryData(communityKeys.messageMarked("message"), { marked: true })
    client.setQueryData(codesKey, { accessCodes: [code] })
    const old = snapshot(client)
    await writer.persistClient(old)
    await writer.retireAuxiliaryScopes([{ kind: "message-marked", id: "message" }, { kind: "access-code", id: code.id }])
    await writer.persistClient(old)
    let restored = await createIdbPersister(viewer).restoreClient()
    expect(data(restored, communityKeys.messageMarked("message"))).toBeUndefined()
    expect(data(restored, codesKey)).toBeUndefined()
    const auxiliaryReadEpoch = await writer.captureAuxiliaryReadEpoch()
    client.setQueryData(communityKeys.messageMarked("message"), { marked: false, auxiliaryReadEpoch })
    client.setQueryData(codesKey, { accessCodes: [], auxiliaryReadEpoch })
    await writer.persistClient(snapshot(client))
    restored = await createIdbPersister(viewer).restoreClient()
    expect(data(restored, communityKeys.messageMarked("message"))).toMatchObject({ marked: false, observed: false })
    expect(data(restored, codesKey)).toMatchObject({ accessCodes: [] })
    client.clear()
  })

  it("does not turn an expired read into fresh display or persisted command state", async () => {
    const client = new QueryClient()
    client.setQueryData(communityKeys.messageMarked("expired"), { marked: true }, { updatedAt: Date.now() - PERSIST_MAX_AGE_MS - 1 })
    client.setQueryData(["community", "automation-access-codes", "other"], { accessCodes: [] })
    client.setQueryData(["public-pricing"], catalog)
    const writer = createIdbPersister(viewer)
    await writer.persistClient(snapshot(client))
    expect((await writer.restoreClient())?.clientState.queries).toEqual([])
    client.clear()
  })

  it("shares the same twenty-window pool with inherited B search and C Bot windows", async () => {
    const client = new QueryClient(), app = new QueryClient(), now = Date.now()
    client.setQueryData(communityKeys.communityDbCollection(viewer, "profiles"), [
      { id: viewer, name: "Viewer", discriminator: "0042", avatar: null, avatarVersion: 0 },
      { id: "bot", name: "Bot", discriminator: "0043", avatar: null, avatarVersion: 0, kind: "bot", ownerUserId: viewer },
      { id: "person", name: "Person", discriminator: "0044", avatar: null, avatarVersion: 0 },
    ])
    const searchKey = ["community", "user-search", "Person"]
    client.setQueryData(searchKey, { ids: ["person"] }, { updatedAt: now - 10 })
    client.setQueryData(communityKeys.botMarks("bot"), { marked: [] }, { updatedAt: now - 9 })
    for (let index = 0; index < 18; index++) client.setQueryData(communityKeys.messageMarked(`mixed-${index}`), { marked: true }, { updatedAt: now - 100 + index })
    await createIdbPersister(viewer).persistClient(snapshot(client))
    app.setQueryData(["public-pricing"], catalog, { updatedAt: now })
    app.setQueryData(billingKey, summary, { updatedAt: now + 1 })
    await createIdbPersister(viewer, "application").persistClient(snapshot(app))
    const left = await createIdbPersister(viewer).restoreClient(), right = await createIdbPersister(viewer, "application").restoreClient()
    expect(data(left, searchKey)).toMatchObject({ ids: ["person"] })
    expect(data(left, communityKeys.botMarks("bot"))).toMatchObject({ marked: [] })
    expect(data(left, communityKeys.messageMarked("mixed-0"))).toBeUndefined()
    expect(data(left, communityKeys.messageMarked("mixed-1"))).toBeUndefined()
    expect(left!.clientState.queries.filter(query => query.queryKey[1] !== "db").length + right!.clientState.queries.length).toBe(20)
    client.clear(); app.clear()
  })

  it("trims a peer payload without advancing its original read timestamp or retirement fences", async () => {
    const client = new QueryClient(), app = new QueryClient(), now = Date.now()
    const writer = createIdbPersister(viewer), application = createIdbPersister(viewer, "application")
    for (let index = 0; index < 20; index++) client.setQueryData(communityKeys.messageMarked(`peer-${index}`), { marked: true }, { updatedAt: now - 100 + index })
    await writer.persistClient(snapshot(client))
    const original = JSON.parse((await get<string>(blobKeyFor(viewer), cacheStore))!)
    await application.retireAuxiliaryScopes([{ kind: "message-marked", id: "peer-19" }])
    app.setQueryData(["public-pricing"], catalog, { updatedAt: now })
    app.setQueryData(billingKey, summary, { updatedAt: now + 1 })
    await application.persistClient(snapshot(app))
    const trimmed = JSON.parse((await get<string>(blobKeyFor(viewer), cacheStore))!)
    expect(trimmed.clientState.queries).toHaveLength(18)
    expect(trimmed.timestamp).toBe(original.timestamp)
    expect(trimmed.ownerEpochs).toEqual(original.ownerEpochs)
    expect(trimmed.channelFences).toEqual(original.channelFences)
    expect(data(await createIdbPersister(viewer).restoreClient(), communityKeys.messageMarked("peer-19"))).toBeUndefined()
    expect(data(await createIdbPersister(viewer).restoreClient(), communityKeys.messageMarked("peer-18"))).toMatchObject({ marked: true })
    client.clear(); app.clear()
  })

  it.each(["account", "device"])("rejects queued writers from both old domains after %s retirement", async retirement => {
    const main = createIdbPersister(viewer), application = createIdbPersister(viewer, "application"), client = new QueryClient()
    client.setQueryData(["public-pricing"], catalog)
    await application.persistClient(snapshot(client))
    const queued = application.persistClient(snapshot(client))
    if (retirement === "device") await clearAllPersistedCaches()
    else await main.retireAccount()
    await queued
    await application.persistClient(snapshot(client))
    client.setQueryData(communityKeys.messageMarked("old"), { marked: true })
    await main.persistClient(snapshot(client))
    expect(await createIdbPersister(viewer).restoreClient()).toBeUndefined()
    expect(await createIdbPersister(viewer, "application").restoreClient()).toBeUndefined()
    client.clear()
  })

  it("drops oversized complete windows and uses personal scope references only for actual deletion", () => {
    expect(readDisplayWindow(codesKey, { accessCodes: Array.from({ length: 401 }, (_, index) => ({ ...code, id: `code-${index}` })) })).toBeUndefined()
    const window = readDisplayWindow(communityKeys.messageMarked("personal"), { marked: true, scopeRef: { channelId: "private" } })!
    expect(displayWindowComplete(window, {}, viewer, "community", new Set(["private"]))).toBe(true)
    expect(displayWindowComplete(window, {}, viewer, "community", new Set([auxiliaryWindowScopeKey({ kind: "channel-resource", id: "private" })]))).toBe(false)
  })
})
