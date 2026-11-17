import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import type { Page, Route } from "@playwright/test"
import { communityKeys } from "@/lib/query-keys"
import { test, expect, type CaseActors, type CaseResources } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { CURRENT_COMMUNITY_FIXTURE_HEADERS, confirmCommunityFixtureApiResponse, currentCommunityFixtureError } from "./_fixtures/business-contract"
import { tid } from "./_fixtures/testids"

type Surface = "tags" | "pins" | "threads" | "counts"
const surfaces: Surface[] = ["tags", "pins", "threads", "counts"]

async function persistedSnapshot(page: Page, viewerId: string, queryKey: readonly unknown[]) {
  return page.evaluate(({ key, queryKey }) => new Promise<{ timestamp: number; data: unknown } | undefined>((resolve, reject) => {
    const open = indexedDB.open("keyval-store")
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains("keyval")) { db.close(); resolve(undefined); return }
      const read = db.transaction("keyval", "readonly").objectStore("keyval").get(key)
      read.onerror = () => { db.close(); reject(read.error) }
      read.onsuccess = () => {
        db.close()
        const value = typeof read.result === "string" ? JSON.parse(read.result) as { timestamp: number; clientState: { queries: Array<{ queryKey: unknown[]; state: { data: unknown } }> } } : undefined
        resolve(value ? { timestamp: value.timestamp, data: value.clientState.queries.find(query => JSON.stringify(query.queryKey) === JSON.stringify(queryKey))?.state.data } : undefined)
      }
    }
  }), { key: `alook:business:v${BUSINESS_SCHEMA_VERSION}:${viewerId}:client`, queryKey })
}

async function persisted(page: Page, viewerId: string, queryKey: readonly unknown[]) {
  return (await persistedSnapshot(page, viewerId, queryKey))?.data
}

async function delayedFailure(page: Page, path: string, resources: CaseResources) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let fail = true, held = 0, failedAt = 0
  const pending: Promise<void>[] = []
  const matches = (url: URL) => url.pathname === path
  const handler = (route: Route) => {
    const completion = (async () => {
      held += 1
      await gate
      if (page.isClosed()) return
      if (fail) { failedAt = Date.now(); await route.fulfill(currentCommunityFixtureError("Auxiliary refresh unavailable", 503)) }
      else await route.continue()
    })()
    pending.push(completion)
    return completion
  }
  await page.route(matches, handler)
  resources.own(release, async done => { done(); await Promise.all(pending); if (!page.isClosed()) await page.unroute(matches, handler) })
  return { held: () => held, failedAt: () => failedAt, release, recover: () => { fail = false } }
}

async function prepare(actors: CaseActors, surface: Surface, empty: boolean) {
  const serverId = await actors.seed.seedServer("alice", `Auxiliary ${surface}`)
  const forum = surface === "tags" || surface === "counts"
  const channelId = await actors.seed.seedChannel("alice", serverId, `saved-${surface}`, forum ? "forum" : "text")
  let targetId: string | undefined
  const body = `Saved ${surface} body`
  if (!empty) {
    if (forum) targetId = await actors.seed.seedForumThread("alice", channelId, "Saved work post", body)
    else {
      const messageId = await actors.seed.seedMessage("alice", channelId, body)
      targetId = surface === "threads" ? await actors.seed.seedThread("alice", messageId, "Saved ordinary thread") : messageId
    }
  }
  const { page } = await actors.asUser("alice", { viewport: { width: 1280, height: 900 } })
  if (!empty && surface === "pins") {
    const response = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${channelId}/pins`, {
      data: { messageId: targetId }, headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
    }))
    expect(response.status()).toBe(201)
  }
  if (!empty && surface === "tags") {
    const otherId = await actors.seed.seedForumThread("alice", channelId, "Catalog-only post", "Outside selected feed")
    const response = await confirmCommunityFixtureApiResponse(page.request.get(`/api/community/channels/${channelId}/threads?order=createdAt&limit=50`, { headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
    expect(response.status()).toBe(200)
    const feed = await response.json() as { threads: Array<{ id: string; parentMessageId: string }> }
    for (const [id, tag] of [[targetId!, "work"], [otherId, "catalog-only"]]) {
      const opener = feed.threads.find(thread => thread.id === id)?.parentMessageId
      expect(opener).toBeTruthy()
      const tagged = await confirmCommunityFixtureApiResponse(page.request.put(`/api/community/messages/${opener}/tags`, { data: { tags: [tag] }, headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
      expect(tagged.status()).toBe(200)
    }
  }
  const key = surface === "tags" ? communityKeys.forumTags(channelId) : surface === "pins" ? communityKeys.pins(channelId) : surface === "threads" ? communityKeys.threads(channelId) : communityKeys.forumPostCounts(serverId)
  const path = surface === "tags" ? `/api/community/channels/${channelId}/messages/tags` : surface === "counts" ? `/api/community/servers/${serverId}/forum-counts` : `/api/community/channels/${channelId}/${surface}`
  const href = `/c/channels/${serverId}/${channelId}${surface === "tags" && !empty ? "?tag=work" : ""}`
  const retry = page.getByRole("button", { name: surface === "tags" ? "Retry tags" : surface === "counts" ? "Retry post counts" : `Retry ${surface === "pins" ? "pinned messages" : "threads"}`, exact: true })
  const open = async () => {
    if (forum) return
    await page.getByRole("button", { name: "More channel options", exact: true }).click()
    await page.getByRole("menuitem", { name: surface === "pins" ? "Pinned messages" : "Threads", exact: true }).click()
  }
  const assertKnown = async () => {
    if (surface === "tags") {
      await expect(page.getByTestId(tid.forumTagAll)).toBeVisible()
      if (!empty) {
        await expect(page.getByTestId(tid.forumTagChip("catalog-only"))).toBeVisible()
        await expect(page.getByTestId(tid.forumTagChip("work"))).toHaveAttribute("aria-pressed", "true")
        await expect(page.getByText("Outside selected feed", { exact: true })).toHaveCount(0)
      }
    } else if (surface === "counts") {
      const row = page.getByTestId(tid.channelRow(channelId))
      await expect(row.getByLabel("Loading unarchived post count")).toHaveCount(0)
      await expect(row.getByLabel("Unarchived post count unavailable")).toHaveCount(0)
      if (!empty) await expect(row.getByLabel("1 unarchived posts", { exact: true })).toBeVisible()
      else await expect(row).not.toContainText("open")
    } else {
      const panel = page.getByRole("dialog", { name: surface === "pins" ? "Pinned Messages" : "Threads", exact: true })
      await expect(panel).toBeVisible()
      if (surface === "pins") await expect(panel.getByText(empty ? "No pinned messages yet." : body, { exact: true })).toBeVisible()
      else await expect(panel.getByText(empty ? "0 threads" : "Saved ordinary thread", { exact: true })).toBeVisible()
    }
  }
  return { page, key, path, href, retry, open, assertKnown, channelId, targetId }
}

for (const surface of surfaces) for (const empty of [false, true]) {
  test(`${surface} restores committed ${empty ? "empty" : "populated"} read before delayed failure in fresh documents`, async ({ caseActors, caseResources }, testInfo) => {
    const actors = await caseActors(["alice"])
    const scene = await prepare(actors, surface, empty)
    const { page, key, path, href, open, assertKnown, retry } = scene
    const initial = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === path && response.ok())
    await gotoAfterUserWsAuth(page, href)
    await open()
    expect((await confirmCommunityFixtureApiResponse(initial)).status()).toBe(200)
    await assertKnown()
    await expect.poll(() => persisted(page, actors.userId("alice"), key)).toBeDefined()
    const saved = await persisted(page, actors.userId("alice"), key)
    const failure = await delayedFailure(page, path, caseResources)
    await gotoAfterUserWsAuth(page, href)
    await open()
    await expect.poll(failure.held).toBeGreaterThan(0)
    await assertKnown()
    failure.release()
    await expect(retry).toBeVisible()
    await assertKnown()
    await expect.poll(async () => (await persistedSnapshot(page, actors.userId("alice"), key))?.timestamp ?? 0).toBeGreaterThanOrEqual(failure.failedAt())
    await expect.poll(() => persisted(page, actors.userId("alice"), key)).toEqual(saved)
    await gotoAfterUserWsAuth(page, href)
    await open()
    await expect(retry).toBeVisible()
    await assertKnown()
    failure.recover()
    const recovered = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === path && response.ok())
    await retry.click()
    expect((await confirmCommunityFixtureApiResponse(recovered)).status()).toBe(200)
    await expect(retry).toHaveCount(0)
    await assertKnown()
    await testInfo.attach("auxiliary-cold-boundaries", { contentType: "application/json", body: JSON.stringify({ surface, empty, key, committed: saved, newDocuments: 2, heldRequests: failure.held(), targetId: scene.targetId, retryStatus: 200 }) })
  })
}

for (const surface of surfaces) {
  test(`${surface} first read failure stays unknown and retries the real endpoint`, async ({ caseActors, caseResources }) => {
    const actors = await caseActors(["alice"])
    const { page, path, href, key, open, retry, assertKnown, channelId } = await prepare(actors, surface, true)
    const failure = await delayedFailure(page, path, caseResources)
    await gotoAfterUserWsAuth(page, href)
    await open()
    await expect.poll(failure.held).toBeGreaterThan(0)
    failure.release()
    await expect(retry).toBeVisible()
    expect(await persisted(page, actors.userId("alice"), key)).toBeUndefined()
    if (surface === "pins") await expect(page.getByText("No pinned messages yet.", { exact: true })).toHaveCount(0)
    if (surface === "threads") await expect(page.getByText("0 threads", { exact: true })).toHaveCount(0)
    if (surface === "counts") await expect(page.getByTestId(tid.channelRow(channelId)).getByLabel("Unarchived post count unavailable")).toBeVisible()
    if (surface === "tags") await expect(page.getByTestId(tid.forumTagAll)).toHaveCount(0)
    failure.recover()
    await retry.click()
    await expect(retry).toHaveCount(0)
    await assertKnown()
    await expect.poll(() => persisted(page, actors.userId("alice"), key)).toBeDefined()
  })
}
