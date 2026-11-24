import { CommunityConversationEntryReadSchema, CommunityMessagesReadSchema } from "@alook/shared"
import type { Page, Route } from "@playwright/test"
import { communityFixtureFetch, confirmCommunityFixtureApiResponse } from "./_fixtures/business-contract"
import { test, expect, type CaseActors, type CaseResources } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import {
  beginScrollTraceAnalysis,
  createScrollTraceIdentity,
  endScrollTraceAnalysis,
  installScrollTrace,
  installScrollTraceInCurrentDocument,
  markScrollTrace,
  scrollTraceSelfTest,
  startScrollTrace,
} from "./_fixtures/scroll-trace"
import {
  VIEWPORT,
  establishExactPinnedPrecondition,
  expectSkeletonTailGeometry,
  finishAndAttach,
  holdNextRequest,
  identity,
  messageCreateCount,
  readScrollEntry,
  seedProfile,
  seedScrollCase,
  tracedAsUser,
  waitForCommittedGeometry,
  waitForStableTail,
} from "./_fixtures/message-scroll-characterization"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

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

async function holdNextPage(page: Page, channelId: string, param: "cursor" | "since" | "anchor", caseResources: CaseResources, cursor?: string) {
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
    if (!consumed && url.searchParams.has(param) && (cursor === undefined || url.searchParams.get(param) === cursor)) {
      consumed = true
      resolveMatched()
      await gate
    }
    await route.fallback()
  }
  await page.route(pattern, handler)
  return {
    matched,
    release,
    wasMatched: () => consumed,
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

test("anchored channel jumps to the newest tail with one request and follows the next peer message", async ({ caseActors }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice", "bob", "carol"])
  const { asUser, sessionCookie } = actors
  const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

  const serverId = await seedServer("alice", `Jump Present ${Date.now()}`)
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)
  const channelId = await seedChannel("alice", serverId, `jump-present-${Date.now()}`)
  const anchorId = await seedMessage("alice", channelId, "jump anchor")
  let latestId = ""
  for (let index = 1; index <= 120; index++) {
    latestId = await seedMessage(index % 2 === 0 ? "bob" : "carol", channelId, `newer message ${index}`)
  }
  const readResponse = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: {
      Cookie: sessionCookie("alice"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ lastReadMessageId: anchorId }),
  })
  expect(readResponse.ok).toBe(true)

  const { page, context } = await asUser("alice")
  const proxy = await proxyCommunityWebSockets(context)
  const endpoint = `/api/community/channels/${channelId}/messages`
  const entryResponse = confirmCommunityFixtureApiResponse(page.waitForResponse(response => response.request().method() === "GET"
    && new URL(response.url()).pathname === endpoint && new URL(response.url()).searchParams.get("entry") === "1"))
  const neighborResponse = confirmCommunityFixtureApiResponse(page.waitForResponse(response => response.request().method() === "GET"
    && new URL(response.url()).pathname === endpoint && new URL(response.url()).searchParams.has("since")))
  void entryResponse.catch(() => undefined)
  void neighborResponse.catch(() => undefined)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}?msg=${anchorId}`)
  await expect(page.getByTestId(tid.message(anchorId))).toBeVisible({ timeout: 30_000 })
  const entryRead = await entryResponse
  expect(entryRead.status()).toBe(200)
  const entry = CommunityConversationEntryReadSchema.parse(await entryRead.json())
  expect(entry.selection.anchorMessageId).toBe(anchorId)
  expect(entry.page.hasMoreNewer).toBe(true)
  const neighborRead = await neighborResponse
  expect(neighborRead.status()).toBe(200)
  expect(new URL(neighborRead.url()).searchParams.get("since")).toBe(entry.page.newerCursor)
  const neighbor = CommunityMessagesReadSchema.parse(await neighborRead.json())
  expect(neighbor.page.hasMoreNewer).toBe(true)
  expect([...entry.messages, ...neighbor.messages].map(message => message.id)).not.toContain(latestId)
  const jumpButton = page.getByRole("button", { name: "Jump to present", exact: true })
  await expect(jumpButton).toBeVisible({ timeout: 20_000 })
  await expect(jumpButton).toHaveText("")

  let newestGets = 0
  let anchorGets = 0
  page.on("request", (request) => {
    if (request.method() !== "GET") return
    const url = new URL(request.url())
    if (url.pathname !== `/api/community/channels/${channelId}/messages`) return
    if (url.search === "") newestGets += 1
    if (url.searchParams.has("anchor")) anchorGets += 1
  })

  const editable = composerEditable(page)
  await editable.fill("retained while returning to present")
  await editable.click()
  const root = page.getByTestId(tid.messageScroller)
  const beforeViewport = await waitForCommittedGeometry(root)
  const viewport = page.viewportSize()!
  await page.setViewportSize({ ...viewport, height: viewport.height - 180 })
  await expect.poll(() => root.evaluate(element => element.clientHeight)).toBeLessThan(beforeViewport.clientHeight)
  await jumpButton.click()
  await expect(page.getByTestId(tid.message(latestId))).toBeVisible({ timeout: 30_000 })
  await expect(jumpButton).toBeHidden()
  await waitForStableTail(root, "requested-present-reduced-viewport")
  await expect(editable).toHaveText("retained while returning to present")
  await expect(page.getByTestId(tid.scrollToPresent)).toBeHidden()
  await page.setViewportSize(viewport)
  await waitForStableTail(root, "requested-present-restored-viewport")
  await expect(page.getByText("Loading newer messages…", { exact: true })).toHaveCount(0)
  await expect.poll(() => newestGets).toBe(1)
  await page.waitForTimeout(1_000) // duplicate newest-fetch exclusion window
  expect(newestGets).toBe(1)
  expect(anchorGets).toBe(0)

  await establishExactPinnedPrecondition(root, "remote-pinned", 0)
  const pinnedBody = `remote pinned ${Date.now()}`
  const pinnedId = await seedMessage("bob", channelId, pinnedBody)
  await expect.poll(() => messageCreateCount(proxy.frames, channelId, pinnedBody)).toBe(1)
  await expect(page.getByTestId(tid.message(pinnedId))).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => root.evaluate((element) =>
    Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
})

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
    const requests: Array<{ url: string; method: string }> = []
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }))
    const olderPage = await holdNextPage(page, channelId, "cursor", caseResources)
    const entryResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET"
        && url.pathname === `/api/community/channels/${channelId}/messages`
        && url.searchParams.get("entry") === "1"
    })
    await gotoAfterUserWsAuth(page, kind === "dm" ? `/c/me/${channelId}` : `/c/channels/${serverId}/${channelId}`)
    const entryResponse = await entryResponsePromise
    expect(entryResponse.ok()).toBe(true)
    const entry = CommunityConversationEntryReadSchema.parse(await entryResponse.json())
    const rootIds = entry.messages.map(message => message.id)
    const relatedIds = (entry.relatedMessages ?? []).map(message => message.id)
    expect(rootIds).toEqual(expect.arrayContaining([nearbyId, oldReplyId, nearbyReplyId]))
    expect(rootIds).not.toContain(olderId)
    expect(relatedIds).toContain(olderId)
    const scroller = page.getByTestId(tid.messageScroller)
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
    await testInfo.attach("reply-context-window.json", { body: Buffer.from(JSON.stringify({ kind, channelId, olderId, nearbyId, oldReplyId, rootIds, relatedIds, olderCursorRequested: olderPage.wasMatched(), olderCursorHeldThroughAssertions: true, before, after, newCount, contextRequests }, null, 2)), contentType: "application/json" })
    await olderPage.dispose()
  })
}

test("older and newer pages preserve a real-message anchor and do not replay", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(180_000)

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

  const window = await readScrollEntry(actors, channelId, ids[65])
  expect(window.page.olderCursor).toEqual(expect.any(String))
  expect(window.page.newerCursor).toEqual(expect.any(String))
  const olderUser = await asUser("alice")
  await olderUser.page.setViewportSize(VIEWPORT)
  const olderRequests: string[] = []
  olderUser.page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith(`/channels/${channelId}/messages`) && url.searchParams.has("cursor")) {
      olderRequests.push(url.search)
    }
  })
  const olderPage = await holdNextPage(olderUser.page, channelId, "cursor", caseResources, window.page.olderCursor!)
  await olderUser.page.goto(`/c/channels/${serverId}/${channelId}?msg=${ids[65]}`, { waitUntil: "commit" })
  await expect(olderUser.page.getByTestId(tid.message(ids[65]))).toBeInViewport({ timeout: 30_000 })
  await expect(olderUser.page.getByTestId(tid.messageScroller).locator('[data-message-list-content][data-read-position-ready="true"][data-initial-position-phase="revealed"]')).toBeVisible()
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
  const newerPage = await holdNextPage(newerUser.page, channelId, "since", caseResources, window.page.newerCursor!)
  await newerUser.page.goto(`/c/channels/${serverId}/${channelId}?msg=${ids[65]}`, { waitUntil: "commit" })
  await expect(newerUser.page.getByTestId(tid.message(ids[65]))).toBeInViewport({ timeout: 30_000 })
  await expect(newerUser.page.getByTestId(tid.messageScroller).locator('[data-message-list-content][data-read-position-ready="true"][data-initial-position-phase="revealed"]')).toBeVisible()
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
      sourceSha: createScrollTraceIdentity({ account: actors.userId("alice"), channel: channelId, viewport: VIEWPORT }).sourceSha,
      older: { before: olderBefore, after: olderAfter, retainedOffset: olderRetainedOffset, requests: olderRequests },
      newer: { before: newerBefore, after: newerAfter, retainedOffset: newerRetainedOffset, requests: newerRequests },
    }, null, 2),
    contentType: "application/json",
  })

  expect(new URLSearchParams(olderRequests[0]).get("cursor")).toBe(window.page.olderCursor)
  expect(new URLSearchParams(newerRequests[0]).get("since")).toBe(window.page.newerCursor)
  expect(olderRequests).toHaveLength(1)
  expect(newerRequests).toHaveLength(1)
  expectAnchorPreserved(olderBefore, olderRetainedOffset, "older prepend")
  expectAnchorPreserved(newerBefore, newerRetainedOffset, "newer append")
})

test("cold skeleton geometry, async image load, and warm cache channel switch remain observable", async ({ caseActors }, testInfo) => {
  test.setTimeout(120_000)
  const actors = await caseActors(["alice", "bob", "carol"])
  const asUser = tracedAsUser(actors)
  const { serverId, coldChannelId, upwardChannelId } = await seedScrollCase(actors, { loadingCount: 24 })

  const alice = await asUser("alice")
  await alice.page.setViewportSize(VIEWPORT)
  await installScrollTrace(alice.page)
  const initialMessages = await holdNextRequest(
    actors,
    alice.page,
    `**/api/community/channels/${coldChannelId}/messages**`,
    () => true,
  )
  const image = await holdNextRequest(
    actors,
    alice.page,
    "**/icon-512.png?scroll-trace=1",
    () => true,
  )
  await alice.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
  await alice.page.getByTestId(tid.channelRow(coldChannelId)).click()
  const initialUrl = await initialMessages.matched
  expect(initialUrl.searchParams.has("anchor")).toBe(false)
  const scroller = alice.page.getByTestId(tid.messageScroller)
  await expect(scroller.locator('[data-slot="skeleton"]').first()).toBeVisible({ timeout: 20_000 })
  await expectSkeletonTailGeometry(alice.page, 1280, "desktop cold skeleton")
  const selfTest = await scrollTraceSelfTest(alice.page)
  expect(selfTest).toMatchObject({
    getterValue: 7,
    methodValue: 8,
    setterError: "RangeError",
    methodError: "RangeError",
    receiverPreserved: true,
    restored: true,
    unsupportedUntouched: true,
  })
  await startScrollTrace(alice.page, {
    scenario: "cold-load-and-async-row",
    identity: identity(coldChannelId),
  })
  await beginScrollTraceAnalysis(alice.page, "cold-load-and-async-row", {
    dataTransitionSource: "initial-cold",
  })
  await markScrollTrace(alice.page, "cold-request-held", { dataTransitionSource: "initial-cold" })
  const coldProfile = await seedProfile(actors, coldChannelId, 12, true, "alice")
  initialMessages.release()
  await image.matched
  await expect(alice.page.getByTestId(tid.message(coldProfile.ids.at(-1)!))).toBeVisible({ timeout: 30_000 })
  await markScrollTrace(alice.page, "async-image-release", {
    detail: { position: "tail", asset: "local-fixture" },
  })
  image.release()
  await expect(alice.page.getByTestId(tid.message(coldProfile.ids.at(-1)!)).locator("img")).toBeVisible()
  await endScrollTraceAnalysis(alice.page, "cold-load-and-async-row")
  const cold = await finishAndAttach(alice.page, testInfo)
  expect(cold.frames.some((frame) => frame.loaders.top.mounted || frame.rows.length === 0)).toBe(true)
  await initialMessages.dispose()
  await image.dispose()

  const mobile = await asUser("alice")
  await mobile.page.setViewportSize({ width: 390, height: 844 })
  const mobileInitialMessages = await holdNextRequest(
    actors,
    mobile.page,
    `**/api/community/channels/${coldChannelId}/messages**`,
    () => true,
  )
  await mobile.page.goto(`/c/channels/${serverId}`, { waitUntil: "commit" })
  await mobile.page.getByTestId(tid.channelRow(coldChannelId)).click()
  await mobileInitialMessages.matched
  await expect(mobile.page.getByTestId(tid.messageScroller)
    .locator('[data-slot="skeleton"]').first()).toBeVisible({ timeout: 20_000 })
  await expectSkeletonTailGeometry(mobile.page, 390, "mobile cold skeleton")
  mobileInitialMessages.release()
  await expect(mobile.page.getByTestId(tid.message(coldProfile.ids.at(-1)!)))
    .toBeVisible({ timeout: 30_000 })
  await mobileInitialMessages.dispose()

  await installScrollTraceInCurrentDocument(alice.page)
  await alice.page.getByTestId(tid.channelRow(upwardChannelId)).click()
  await alice.page.waitForURL(new RegExp(upwardChannelId), { waitUntil: "commit" })
  await expect(alice.page.getByTestId(tid.messageScroller)).toBeVisible()
  const warmRequest = await holdNextRequest(
    actors,
    alice.page,
    `**/api/community/channels/${coldChannelId}/messages**`,
    () => true,
    { required: false },
  )
  await alice.page.getByTestId(tid.channelRow(coldChannelId)).click()
  await alice.page.waitForURL(new RegExp(coldChannelId), { waitUntil: "commit" })
  await expect(alice.page.getByTestId(tid.message(coldProfile.ids.at(-1)!))).toBeVisible({ timeout: 20_000 })
  await startScrollTrace(alice.page, {
    scenario: "warm-cache-reuse",
    identity: identity(coldChannelId),
    estimatedSizes: coldProfile.estimates,
  })
  await beginScrollTraceAnalysis(alice.page, "warm-cache-reuse", {
    dataTransitionSource: "initial-cache",
  })
  await markScrollTrace(alice.page, "cached-rows-painted", {
    dataTransitionSource: "initial-cache",
    detail: { renderedBeforeRelease: true, revalidationMatched: warmRequest.hasMatched() },
  })
  warmRequest.release()
  await endScrollTraceAnalysis(alice.page, "warm-cache-reuse")
  await finishAndAttach(alice.page, testInfo)
  await warmRequest.dispose()
})
