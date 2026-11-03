import { communityFixtureFetch } from "./_fixtures/business-contract"
import type { Page, Route } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"

import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import type { CaseActors, CaseResources } from "./_fixtures/case-fixture"

async function prepareCase(actors: CaseActors) {
  const { sessionCookie } = actors
  async function setReadCheckpoint(channelId: string, messageId: string): Promise<void> {
    const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
      method: "PUT",
      headers: {
        Cookie: sessionCookie("alice"),
        "Content-Type": "application/json",
        Origin: WEB_URL,
      },
      body: JSON.stringify({ lastReadMessageId: messageId }),
    })
    expect(response.ok).toBe(true)
  }
  return { setReadCheckpoint }
}

const VIEWPORT = { width: 1280, height: 800 }

for (const kind of ["channel", "dm"] as const) {
  test(`${kind} reply uses the current window or an independent ID context`, async ({ caseActors, caseResources }, testInfo) => {
    const actors = await caseActors(["alice", "bob"])
    const { seedServer, seedChannel, seedJoinServer, seedDm, seedMessage } = actors.seed
    let serverId: string | undefined
    let channelId: string
    if (kind === "channel") {
      serverId = await seedServer("alice", `Reply context ${Date.now()}`)
      await seedJoinServer("alice", "bob", serverId)
      channelId = await seedChannel("alice", serverId, "reply-context")
    } else channelId = await seedDm("alice", actors.userId("bob"))
    const olderId = await seedMessage("bob", channelId, "**Old target** ||hidden preview|| `file_name.ts`")
    let nearbyId = ""
    for (let index = 0; index < 51; index++) {
      const id = await seedMessage("bob", channelId, `context filler ${index}`)
      if (index === 28) nearbyId = id
    }
    const oldReplyId = await seedMessage("bob", channelId, "Reply to old target", { replyToId: olderId })
    const nearbyReplyId = await seedMessage("bob", channelId, "Reply to nearby target", { replyToId: nearbyId })
    await (await prepareCase(actors)).setReadCheckpoint(channelId, nearbyReplyId)
    const { page } = await actors.asUser("alice")
    await page.setViewportSize(VIEWPORT)
    await gotoAfterUserWsAuth(page, kind === "dm" ? `/c/me/${channelId}` : `/c/channels/${serverId}/${channelId}`)
    const scroller = page.getByTestId(tid.messageScroller)
    const requests: Array<{ url: string; method: string }> = []
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }))
    const nearReply = scroller.getByTestId(tid.message(nearbyReplyId))
    await expect(nearReply).toBeVisible()
    await nearReply.getByRole("button", { name: "Show original message" }).click()
    await expect(scroller.getByTestId(tid.message(nearbyId))).toBeInViewport()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(requests.filter(request => new URL(request.url).searchParams.has("anchor"))).toEqual([])
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
    const oldReply = scroller.getByTestId(tid.message(oldReplyId))
    await expect(oldReply).toBeVisible()
    const originalButton = oldReply.getByRole("button", { name: "Show original message" })
    await expect(originalButton).toContainText("Old target [Spoiler] file_name.ts")
    await expect(originalButton).not.toContainText("hidden preview")
    await expect(scroller.getByTestId(tid.message(olderId))).toHaveCount(0)
    const before = await waitForStableGeometry(page)
    const newCount = await scroller.getByTestId(tid.newDivider).count()
    const context = await holdNextPage(page, channelId, "anchor", caseResources)
    const start = requests.length
    await originalButton.click()
    await context.matched
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Old target", { exact: true })).toBeVisible()
    context.release()
    await expect(dialog.locator('[data-anchor-row="1"]')).toBeVisible()
    await expect(scroller.getByTestId(tid.message(olderId))).toHaveCount(0)
    expect(await scroller.getByTestId(tid.newDivider).count()).toBe(newCount)
    const after = await readGeometry(page)
    expect(after.firstVisibleId).toBe(before.firstVisibleId)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
    const contextRequests = requests.slice(start)
    expect(contextRequests.filter(request => new URL(request.url).pathname.includes("/messages/seq/"))).toEqual([])
    expect(contextRequests.filter(request => request.method === "PUT" && new URL(request.url).pathname.endsWith("/read"))).toEqual([])
    expect(contextRequests.filter(request => new URL(request.url).searchParams.get("anchor") === olderId)).toHaveLength(1)
    await context.dispose()
    await testInfo.attach("reply-context-window.json", { body: Buffer.from(JSON.stringify({ kind, channelId, olderId, nearbyId, oldReplyId, before, after, newCount, contextRequests }, null, 2)), contentType: "application/json" })
  })
}

type Geometry = {
  scrollTop: number
  scrollHeight: number
  firstVisibleId: string | null
  firstVisibleOffset: number | null
}

async function readGeometry(page: Page): Promise<Geometry> {
  return page.getByTestId(tid.messageScroller).evaluate((element) => {
    const root = element as HTMLElement
    const rootRect = root.getBoundingClientRect()
    const row = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1
      }) ?? null
    const rect = row?.getBoundingClientRect() ?? null
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      firstVisibleId: row?.dataset.msgId ?? null,
      firstVisibleOffset: rect ? rect.top - rootRect.top : null,
    }
  })
}

async function waitForStableGeometry(page: Page): Promise<Geometry> {
  let previous = ""
  let stable: Geometry | null = null
  await expect.poll(async () => {
    await page.getByTestId(tid.messageScroller).evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    const next = await readGeometry(page)
    const signature = JSON.stringify(next)
    if (signature === previous) stable = next
    previous = signature
    return stable !== null
  }, { timeout: 20_000 }).toBe(true)
  return stable!
}

async function readMessageOffset(page: Page, messageId: string): Promise<number | null> {
  return page.getByTestId(tid.messageScroller).evaluate((element, id) => {
    const root = element as HTMLElement
    const row = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((candidate) => candidate.dataset.msgId === id)
    return row ? row.getBoundingClientRect().top - root.getBoundingClientRect().top : null
  }, messageId)
}

async function holdNextPage(page: Page, channelId: string, param: "cursor" | "since" | "anchor", caseResources: CaseResources) {
  let release!: () => void
  let resolveMatched!: () => void
  let consumed = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  caseResources.own(release, async (captured) => { captured() })
  const matched = new Promise<void>((resolve) => { resolveMatched = resolve })
  caseResources.own(resolveMatched, async (captured) => { captured() })
  const pattern = `**/api/community/channels/${channelId}/messages**`
  const handler = async (route: Route) => {
    const url = new URL(route.request().url())
    if (!consumed && url.searchParams.has(param)) {
      consumed = true
      resolveMatched()
      await gate
    }
    await route.continue()
  }
  await page.route(pattern, handler)
  return {
    matched,
    release,
    dispose: async () => {
      release()
      await page.unroute(pattern, handler)
    },
  }
}

async function moveToEdge(page: Page, edge: "start" | "end"): Promise<void> {
  await page.getByTestId(tid.messageScroller).evaluate((element, target) => {
    element.scrollTop = target === "start" ? 0 : element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  }, edge)
}

function expectAnchorPreserved(before: Geometry, retainedOffset: number | null, label: string): void {
  expect(retainedOffset, `${label}: retained message`).not.toBeNull()
  expect(
    Math.abs((retainedOffset ?? 0) - (before.firstVisibleOffset ?? 0)),
    `${label}: viewport offset`,
  ).toBeLessThanOrEqual(1)
}

test("older and newer pages preserve a real-message anchor and do not replay", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(240_000)

  const actors = await caseActors(["alice", "bob"])
  const { asUser } = actors
  const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed
  const { setReadCheckpoint } = await prepareCase(actors)

  const stamp = Date.now()
  const serverId = await seedServer("alice", `Pagination anchor ${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  const channelId = await seedChannel("alice", serverId, `pagination-anchor-${stamp}`)
  const ids: string[] = []
  for (let index = 0; index < 130; index += 1) {
    const variable = index % 5 === 0
      ? Array.from({ length: 10 }, (_, line) => `row ${index} variable ${line} ${"x".repeat(line * 3)}`).join("\n")
      : `row ${index}`
    ids.push(await seedMessage(index <= 64 ? "alice" : "bob", channelId, variable))
  }
  await setReadCheckpoint(channelId, ids[64])

  const olderUser = await asUser("alice")
  await olderUser.page.setViewportSize(VIEWPORT)
  const olderRequests: string[] = []
  olderUser.page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith(`/channels/${channelId}/messages`) && url.searchParams.has("cursor")) {
      olderRequests.push(url.search)
    }
  })
  await olderUser.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  const olderNewDivider = olderUser.page.getByTestId(tid.newDivider)
  await expect(async () => {
    expect(await olderNewDivider.count()).toBe(1)
    expect(await olderNewDivider.isVisible()).toBe(true)
  }).toPass({ timeout: 30_000 })
  await expect(olderUser.page.getByTestId(tid.messageScroller).locator('[data-message-list-content][data-read-position-ready="true"][data-initial-position-phase="revealed"]')).toBeVisible()
  const olderPage = await holdNextPage(olderUser.page, channelId, "cursor", caseResources)
  await moveToEdge(olderUser.page, "start")
  await olderPage.matched
  const olderBefore = await waitForStableGeometry(olderUser.page)
  olderPage.release()
  await expect(olderUser.page.getByText("Loading older messages…", { exact: true })).toHaveCount(0)
  const olderAfter = await waitForStableGeometry(olderUser.page)
  const olderRetainedOffset = await readMessageOffset(olderUser.page, olderBefore.firstVisibleId!)
  await olderPage.dispose()

  await setReadCheckpoint(channelId, ids[64])
  const newerUser = await asUser("alice")
  await newerUser.page.setViewportSize(VIEWPORT)
  const newerRequests: string[] = []
  newerUser.page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith(`/channels/${channelId}/messages`) && url.searchParams.has("since")) {
      newerRequests.push(url.search)
    }
  })
  await newerUser.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  const newerNewDivider = newerUser.page.getByTestId(tid.newDivider)
  await expect(async () => {
    expect(await newerNewDivider.count()).toBe(1)
    expect(await newerNewDivider.isVisible()).toBe(true)
  }).toPass({ timeout: 30_000 })
  await expect(newerUser.page.getByTestId(tid.messageScroller).locator('[data-message-list-content][data-read-position-ready="true"][data-initial-position-phase="revealed"]')).toBeVisible()
  const newerPage = await holdNextPage(newerUser.page, channelId, "since", caseResources)
  await moveToEdge(newerUser.page, "end")
  await newerPage.matched
  const newerBefore = await waitForStableGeometry(newerUser.page)
  newerPage.release()
  await expect(newerUser.page.getByText("Loading newer messages…", { exact: true })).toHaveCount(0)
  const newerAfter = await waitForStableGeometry(newerUser.page)
  const newerRetainedOffset = await readMessageOffset(newerUser.page, newerBefore.firstVisibleId!)
  await newerPage.dispose()

  await testInfo.attach("pagination-anchor-trajectory.json", {
    body: JSON.stringify({
      sourceSha: "b1ea24a7f73778717662b5d894f1e14b019c8c08",
      older: { before: olderBefore, after: olderAfter, retainedOffset: olderRetainedOffset, requests: olderRequests },
      newer: { before: newerBefore, after: newerAfter, retainedOffset: newerRetainedOffset, requests: newerRequests },
    }, null, 2),
    contentType: "application/json",
  })

  expect(olderRequests).toHaveLength(1)
  expect(newerRequests).toHaveLength(1)
  expectAnchorPreserved(olderBefore, olderRetainedOffset, "older prepend")
  expectAnchorPreserved(newerBefore, newerRetainedOffset, "newer append")
})
