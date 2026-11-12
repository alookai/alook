import type { Locator, Page, Response, TestInfo } from "@playwright/test"
import { CommunityConversationEntryReadSchema, CommunityMessagesReadSchema } from "@alook/shared"
import { test, expect, type CaseActors } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { communityFixtureFetch, confirmCommunityFixtureApiResponse, currentCommunityFixtureError, CURRENT_COMMUNITY_FIXTURE_HEADERS } from "./_fixtures/business-contract"
import { proxyCommunityWebSockets, communityFrameEvents } from "./_fixtures/community-ws-proxy"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, installScrollTrace, installScrollTraceInCurrentDocument, startScrollTrace, markScrollTrace } from "./_fixtures/scroll-trace"
import { finishAndAttach, holdNextRequest, identity, seedResizableHtmlPreview, waitForCommittedGeometry, waitForStableTail } from "./_fixtures/message-scroll-characterization"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

async function prepare(actors: CaseActors, kind: "channel" | "dm", html = false) {
  const opened = await actors.asUser("alice")
  let serverId: string | undefined
  let channelId: string
  if (kind === "channel") {
    serverId = await actors.seed.seedServer("alice", `Reading continuity ${Date.now()}`)
    await actors.seed.seedJoinServer("alice", "bob", serverId)
    channelId = await actors.seed.seedChannel("alice", serverId, "reading-continuity")
  } else channelId = await actors.seed.seedDm("alice", actors.userId("bob"))
  const ids: string[] = []
  let preview: Awaited<ReturnType<typeof seedResizableHtmlPreview>> | undefined
  for (let index = 0; index < 300; index++) {
    if (html && index === 145) {
      preview = await seedResizableHtmlPreview(opened.page, channelId)
      ids.push(preview.messageId)
    } else ids.push(await actors.seed.seedMessage("bob", channelId,
      `reading ${index}\n\ncontext ${index}\n\nthird line${index % 7 === 0 ? "\n\nvariable fourth line" : ""}`))
  }
  const path = kind === "channel" ? `/c/channels/${serverId}/${channelId}` : `/c/me/${channelId}`
  const endpoint = `/api/community/channels/${channelId}/messages`
  const response = await communityFixtureFetch(`${WEB_URL}${endpoint}?entry=1&anchor=${ids[150]}`, {
    headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL },
  })
  expect(response.status).toBe(200)
  const middle = CommunityConversationEntryReadSchema.parse(await response.json())
  expect(middle.selection.anchorMessageId).toBe(ids[150])
  expect(middle.page.hasMoreOlder).toBe(true)
  expect(middle.page.hasMoreNewer).toBe(true)
  return { ...opened, channelId, serverId, ids, path, endpoint, preview }
}

type PageReceipt = { direction: "older" | "newer"; cursor: string; status: number; time: number; timing: ReturnType<ReturnType<Response["request"]>["timing"]>; ids: string[] }
function observePages(actors: CaseActors, page: Page, endpoint: string) {
  const receipts: PageReceipt[] = []
  const pending = new Set<Promise<void>>()
  const failures: unknown[] = []
  const listener = (response: Response) => {
    const url = new URL(response.url())
    if (response.request().method() !== "GET" || url.pathname !== endpoint
      || !url.searchParams.has("cursor") && !url.searchParams.has("since")) return
    const operation = (async () => {
      const receipt: PageReceipt = { direction: url.searchParams.has("cursor") ? "older" : "newer",
        cursor: url.searchParams.get("cursor") ?? url.searchParams.get("since")!, status: response.status(), time: Date.now(), timing: response.request().timing(), ids: [] }
      if (response.ok()) receipt.ids = CommunityMessagesReadSchema.parse(await response.json()).messages.map(message => message.id)
      await response.finished()
      receipt.timing = response.request().timing()
      receipts.push(receipt)
    })()
    pending.add(operation)
    void operation.catch(error => failures.push(error)).finally(() => pending.delete(operation))
  }
  page.on("response", listener)
  actors.onCleanup(async () => { page.off("response", listener); await Promise.allSettled([...pending]); if (failures.length) throw new AggregateError(failures, "Page receipt validation failed") })
  return receipts
}

async function bodyOffset(root: Locator, id: string) {
  return root.locator(`[data-msg-id="${id}"]`).evaluate((body, rootId) => {
    const scroller = body.closest<HTMLElement>(`[data-testid="${rootId}"]`)!
    return body.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, tid.messageScroller)
}

async function twoPages(page: Page, root: Locator, receipts: PageReceipt[], direction: "older" | "newer", fast: boolean) {
  const initial = receipts.filter(receipt => receipt.direction === direction && receipt.status === 200).length
  const positions: Array<{ time: number; top: number; height: number; total: number; admission: string | undefined }> = []
  await beginScrollTraceAnalysis(page, `${direction}-two-real-pages`, { dataTransitionSource: direction === "older" ? "older-page" : "newer-page", commandDirection: direction === "older" ? "backward" : "forward" })
  await root.hover()
  for (let step = 0; step < 100; step++) {
    if (receipts.filter(receipt => receipt.direction === direction && receipt.status === 200).length >= initial + 2) break
    const height = await root.evaluate(element => element.clientHeight)
    await page.mouse.wheel(0, (direction === "older" ? -1 : 1) * height * (fast ? 3 : 0.35))
    positions.push(await root.evaluate(element => ({ time: Date.now(), top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight, admission: (element as HTMLElement).dataset.paginationEnabled })))
    await page.waitForTimeout(fast ? 8 : 32)
  }
  await expect.poll(() => receipts.filter(receipt => receipt.direction === direction && receipt.status === 200).length).toBeGreaterThanOrEqual(initial + 2)
  const accepted = receipts.filter(receipt => receipt.direction === direction && receipt.status === 200).slice(initial)
  expect(new Set(accepted.map(receipt => receipt.cursor)).size).toBe(accepted.length)
  expect(new Set(accepted.flatMap(receipt => receipt.ids)).size).toBeGreaterThan(50)
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  await markScrollTrace(page, `${direction}-page-owner-settled`, { detail: { observedAt: Date.now() } })
  await endScrollTraceAnalysis(page, `${direction}-two-real-pages`)
  return positions
}

async function trace(actors: CaseActors, page: Page, info: TestInfo, channelId: string) {
  await installScrollTrace(page)
  await installScrollTraceInCurrentDocument(page)
  await startScrollTrace(page, { scenario: info.title, identity: identity(channelId) })
  await markScrollTrace(page, "clock-calibration", { detail: await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, performanceNow: performance.now(), epoch: Date.now() })) })
  let active = true
  const finish = async () => { if (active && !page.isClosed()) { active = false; await finishAndAttach(page, info) } }
  actors.onCleanup(finish)
  return finish
}

for (const kind of ["channel", "dm"] as const) {
  for (const narrow of [false, true]) {
    for (const fast of [false, true]) {
      test(`${kind} ${narrow ? "narrow" : "desktop"} ${fast ? "fast" : "slow"} preserves reading across two real pages in both directions`, async ({ caseActors }, info) => {
        test.setTimeout(240_000)
        const actors = await caseActors(["alice", "bob"])
        const value = await prepare(actors, kind)
        const { page, context, path, ids, endpoint, channelId } = value
        await page.setViewportSize(narrow ? { width: 390, height: 844 } : { width: 1280, height: 800 })
        const receipts = observePages(actors, page, endpoint)
        const proxy = await proxyCommunityWebSockets(context)
        await gotoAfterUserWsAuth(page, `${path}?msg=${ids[150]}`)
        const finishOlderTrace = await trace(actors, page, info, channelId)
        const root = page.getByTestId(tid.messageScroller)
        await expect(page.getByTestId(tid.message(ids[150]))).toBeInViewport()
        await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
        const draft = `retained ${kind} ${narrow} ${fast}`
        await composerEditable(page).fill(draft)
        const olderPositions = await twoPages(page, root, receipts, "older", fast)
        await finishOlderTrace()
        await page.goto(`${path}?msg=${ids[150]}`, { waitUntil: "commit" })
        await expect(page.getByTestId(tid.message(ids[150]))).toBeInViewport()
        await expect(composerEditable(page)).toHaveText(draft)
        await trace(actors, page, info, channelId)
        const newerPositions = await twoPages(page, root, receipts, "newer", fast)
        await root.hover()
        const returnLatestHeight = await root.evaluate(element => element.clientHeight)
        expect(returnLatestHeight).toBeGreaterThan(0)
        await page.mouse.wheel(0, -returnLatestHeight)
        await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(1)
        const returnLatestBefore = await waitForCommittedGeometry(root)
        expect(returnLatestBefore.firstVisibleId).not.toBeNull()
        expect(returnLatestBefore.distanceToEnd).toBeGreaterThan(1)
        await expect(page.getByTestId(tid.scrollToPresent)).toBeVisible()
        await expect(page.getByTestId(tid.scrollToPresent)).toBeEnabled()
        await markScrollTrace(page, "return-latest-premise", { detail: { geometry: returnLatestBefore } })
        await page.getByTestId(tid.scrollToPresent).click()
        await expect(page.getByTestId(tid.message(ids.at(-1)!))).toBeVisible()
        await waitForStableTail(root, "return-latest")
        const peer = await actors.seed.seedMessage("bob", channelId, `peer append ${info.title}`)
        await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).filter(event =>
          event.type === "community:message.create" && event.channelId === channelId && event.message?.id === peer).length).toBe(1)
        await expect(page.getByTestId(tid.message(peer))).toBeVisible()
        await waitForStableTail(root, "peer-append")
        const html = await seedResizableHtmlPreview(page, channelId)
        const frame = page.getByTestId(tid.htmlPreviewFrame(html.attachmentId))
        await expect(page.getByTestId(tid.htmlPreview(html.attachmentId))).toHaveAttribute("data-html-preview-status", "ready")
        await frame.evaluate(element => (element as HTMLIFrameElement).contentWindow?.postMessage({ type: "scroll-fixture-height", height: 420 }, "*"))
        await expect(frame).toHaveCSS("height", "420px")
        await waitForStableTail(root, "real-html-growth")
        await root.hover()
        await page.mouse.wheel(0, -300)
        await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(1)
        const before = await waitForCommittedGeometry(root)
        expect(before.firstVisibleId).not.toBeNull()
        const hiddenPeer = await actors.seed.seedMessage("bob", channelId, `history append ${info.title}`)
        await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).some(event =>
          event.type === "community:message.create" && event.message?.id === hiddenPeer)).toBe(true)
        await expect.poll(async () => Math.abs(await bodyOffset(root, before.firstVisibleId!) - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
        await expect(composerEditable(page)).toHaveText(draft)
        await info.attach("reading-cursor-stages.json", { body: JSON.stringify({ kind, narrow, fast, receipts, olderPositions, newerPositions, returnLatestBefore, before }, null, 2), contentType: "application/json" })
      })
    }
  }
}

async function moveToEdge(root: Locator, edge: "start" | "end") {
  await root.evaluate((element, target) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: target === "start" ? -400 : 400, bubbles: true }))
    element.scrollTop = target === "start" ? 0 : element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  }, edge)
}

test("channel older failure retries in the same window after a held real page", async ({ caseActors }, info) => {
  test.setTimeout(240_000)
  const actors = await caseActors(["alice", "bob"])
  const { page, path, ids, endpoint, channelId } = await prepare(actors, "channel")
  const receipts = observePages(actors, page, endpoint)
  await gotoAfterUserWsAuth(page, `${path}?msg=${ids[150]}`)
  await trace(actors, page, info, channelId)
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await composerEditable(page).fill("keep older draft")
  const held = await holdNextRequest(actors, page, `**${endpoint}**`, url => url.searchParams.has("cursor"))
  let olderGets = 0
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname === endpoint && url.searchParams.has("cursor")) olderGets++ })
  await moveToEdge(root, "start")
  await held.matched
  await moveToEdge(root, "start")
  await page.waitForTimeout(250)
  expect(olderGets).toBe(1)
  held.release()
  await expect.poll(() => receipts.filter(receipt => receipt.status === 200 && receipt.direction === "older").length).toBe(1)
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  await held.dispose()
  let fail = true
  await page.route(`**${endpoint}**`, async route => {
    if (fail && new URL(route.request().url()).searchParams.has("cursor")) await route.fulfill(currentCommunityFixtureError("bounded page failure", 503))
    else await route.fallback()
  })
  await moveToEdge(root, "start")
  const retry = page.getByRole("alert").filter({ hasText: "Could not load older messages." }).getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible()
  const before = await waitForCommittedGeometry(root)
  const count = olderGets
  await page.waitForTimeout(250)
  expect(olderGets).toBe(count)
  fail = false
  await retry.click()
  await expect.poll(() => receipts.filter(receipt => receipt.status === 200 && receipt.direction === "older").length).toBe(2)
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  expect(olderGets).toBe(count + 1)
  await expect.poll(async () => Math.abs(await bodyOffset(root, before.firstVisibleId!) - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await expect(composerEditable(page)).toHaveText("keep older draft")
})

test("DM newer and present recovery keep readable rows and retire a late present result", async ({ caseActors }, info) => {
  test.setTimeout(240_000)
  const actors = await caseActors(["alice", "bob"])
  const { page, path, ids, endpoint, channelId } = await prepare(actors, "dm")
  let failNewer = true
  await page.route(`**${endpoint}**`, async route => {
    if (failNewer && new URL(route.request().url()).searchParams.has("since")) await route.fulfill(currentCommunityFixtureError("bounded newer failure", 503))
    else await route.fallback()
  })
  await gotoAfterUserWsAuth(page, `${path}?msg=${ids[150]}`)
  const finishTrace = await trace(actors, page, info, channelId)
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await composerEditable(page).fill("keep DM draft")
  await moveToEdge(root, "end")
  const retry = page.getByRole("alert").filter({ hasText: "Could not load newer messages." }).getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible()
  const before = await waitForCommittedGeometry(root)
  failNewer = false
  await retry.click()
  await expect(retry).toBeHidden()
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  await expect.poll(async () => Math.abs(await bodyOffset(root, before.firstVisibleId!) - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  let failPresent = true
  let presentGets = 0
  page.on("request", request => { const url = new URL(request.url()); if (request.method() === "GET" && url.pathname === endpoint && url.search === "") presentGets++ })
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === "GET" && new URL(route.request().url()).search === "") {
      if (failPresent) { await route.fulfill(currentCommunityFixtureError("bounded present failure", 503)); return }
    }
    await route.fallback()
  })
  await page.getByTestId(tid.scrollToPresent).click()
  await expect(page.getByRole("button", { name: "Could not load recent messages. Retry" })).toBeVisible()
  await expect(composerEditable(page)).toHaveText("keep DM draft")
  failPresent = false
  const held = await holdNextRequest(actors, page, `**${endpoint}**`, url => url.search === "")
  await page.getByTestId(tid.scrollToPresent).click()
  await held.matched
  const pending = page.getByRole("button", { name: "Loading messages", exact: true })
  await expect(pending).toBeDisabled()
  const requestsBefore = presentGets
  await pending.evaluate(button => (button as HTMLButtonElement).click())
  await page.waitForTimeout(250)
  expect(presentGets).toBe(requestsBefore)
  await finishTrace()
  await page.goto("/c/me", { waitUntil: "commit" })
  held.release()
  await held.dispose()
  await expect(page).toHaveURL(/\/c\/me$/)
  await expect(page.getByTestId(tid.message(ids.at(-1)!))).toHaveCount(0)
})

test("history preserves real HTML body geometry while an older receipt is pending", async ({ caseActors }, info) => {
  test.setTimeout(240_000)
  const actors = await caseActors(["alice", "bob"])
  const { page, path, ids, endpoint, channelId, preview } = await prepare(actors, "channel", true)
  expect(preview).toBeDefined()
  await gotoAfterUserWsAuth(page, `${path}?msg=${ids[150]}`)
  await trace(actors, page, info, channelId)
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await composerEditable(page).fill("keep HTML draft")
  const held = await holdNextRequest(actors, page, `**${endpoint}**`, url => url.searchParams.has("cursor"))
  await moveToEdge(root, "start")
  await held.matched
  await root.evaluate(element => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 500, bubbles: true }))
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(page.getByTestId(tid.message(ids[150]))).toBeAttached()
  await root.evaluate((element, id) => {
    const body = element.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
    if (!body) throw new Error("The existing middle body must remain mounted")
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }))
    element.scrollTop += body.getBoundingClientRect().top - element.getBoundingClientRect().top
    element.dispatchEvent(new Event("scroll"))
  }, ids[150])
  const frame = page.getByTestId(tid.htmlPreviewFrame(preview!.attachmentId))
  await expect(frame).toBeAttached()
  const before = await waitForCommittedGeometry(root)
  const box = await frame.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y + box!.height).toBeLessThanOrEqual(before.scrollerRect.top + 1)
  for (const height of [600, 160]) {
    await markScrollTrace(page, `html-above-fold-${height}-before`, { detail: await waitForCommittedGeometry(root) })
    await frame.evaluate((element, nextHeight) => (element as HTMLIFrameElement).contentWindow?.postMessage({ type: "scroll-fixture-height", height: nextHeight }, "*"), height)
    await expect(frame).toHaveCSS("height", `${height}px`)
    await expect.poll(async () => Math.abs(await bodyOffset(root, before.firstVisibleId!) - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  }
  await root.evaluate((element, id) => {
    const body = element.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
    if (!body) throw new Error("The actual HTML message must remain mounted")
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }))
    element.scrollTop += body.getBoundingClientRect().top - element.getBoundingClientRect().top + 80
    element.dispatchEvent(new Event("scroll"))
  }, preview!.messageId)
  const spanningTop = await bodyOffset(root, preview!.messageId)
  await frame.evaluate(element => (element as HTMLIFrameElement).contentWindow?.postMessage({ type: "scroll-fixture-height", height: 1200 }, "*"))
  await expect(frame).toHaveCSS("height", "1200px")
  await expect.poll(async () => Math.abs(await bodyOffset(root, preview!.messageId) - spanningTop)).toBeLessThanOrEqual(1)
  held.release()
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  await expect(composerEditable(page)).toHaveText("keep HTML draft")
  await held.dispose()
})

test("warm late New preserves a fixed DM tail through media growth, takeover and retired callbacks", async ({ caseActors }, info) => {
  test.setTimeout(240_000)
  const actors = await caseActors(["alice", "bob", "carol"])
  const dmId = await actors.seed.seedDm("alice", actors.userId("bob"))
  const nextDm = await actors.seed.seedDm("alice", actors.userId("carol"))
  for (let index = 0; index < 24; index++) await actors.seed.seedMessage("alice", nextDm, `new conversation ${index}`)
  const ids: string[] = []
  for (let index = 0; index < 36; index++) ids.push(await actors.seed.seedMessage("bob", dmId, `warm same-author body ${index}`))
  const { page, context } = await actors.asUser("alice")
  const nextPreview = await seedResizableHtmlPreview(page, nextDm)
  const proxy = await proxyCommunityWebSockets(context)
  const path = `/c/me/${dmId}`
  await gotoAfterUserWsAuth(page, path)
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await waitForStableTail(root, "warm-null-boundary")
  const html = await seedResizableHtmlPreview(page, dmId)
  const frame = page.getByTestId(tid.htmlPreviewFrame(html.attachmentId))
  await expect(page.getByTestId(tid.htmlPreview(html.attachmentId))).toHaveAttribute("data-html-preview-status", "ready")
  await waitForStableTail(root, "warm-html-tail")
  const readBob = await actors.seed.seedMessage("bob", dmId, "read peer before the late boundary")
  await expect(page.getByTestId(tid.message(readBob))).toBeVisible()
  await waitForStableTail(root, "warm-read-peer")
  const checkpoint = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${dmId}/read`, {
    method: "PUT", headers: { Cookie: actors.sessionCookie("alice"), "Content-Type": "application/json", Origin: WEB_URL },
    body: JSON.stringify({ lastReadMessageId: readBob }),
  })
  expect(checkpoint.status).toBe(200)
  const warmDocument = await page.evaluate(() => performance.timeOrigin)
  await page.getByRole("link", { name: "Friends", exact: true }).click()
  await expect(page).toHaveURL(/\/c\/me\/friends$/)
  const unread = await actors.seed.seedMessage("bob", dmId, "late peer boundary")
  await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).some(event =>
    event.type === "community:message.create" && event.channelId === dmId && event.message?.id === unread)).toBe(true)
  const held = await holdNextRequest(actors, page, `**/api/community/channels/${dmId}/messages**`, url => url.searchParams.get("entry") === "1")
  await page.locator(`a[href="${path}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`${dmId}$`))
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(warmDocument)
  await held.matched
  await expect(page.getByTestId(tid.message(unread))).toBeVisible()
  const before = await root.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight,
    ids: Array.from(element.querySelectorAll<HTMLElement>("[data-msg-id]")).map(body => body.dataset.msgId),
    keys: Array.from(element.querySelectorAll<HTMLElement>("[data-message-row-key]")).map(row => row.dataset.messageRowKey),
    ready: element.querySelector('[data-read-position-ready]')?.getAttribute("data-read-position-ready") }))
  expect(before.height - await root.evaluate(element => element.clientHeight) - before.top).toBeLessThanOrEqual(1)
  const finishTrace = await trace(actors, page, info, dmId)
  const entryResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/community/channels/${dmId}/messages`
    && new URL(response.url()).searchParams.get("entry") === "1")
  held.release()
  const confirmed = CommunityConversationEntryReadSchema.parse(await (await entryResponse).json())
  expect(confirmed.newBoundary.target?.id).toBe(unread)
  expect(confirmed.messages.map(message => message.id)).toEqual([...ids, html.messageId, readBob, unread])
  await held.dispose()
  await expect(page.getByTestId(tid.newDivider)).toBeAttached()
  await waitForStableTail(root, "late-new-fixed-tail")
  const after = await root.evaluate(element => ({ ids: Array.from(element.querySelectorAll<HTMLElement>("[data-msg-id]")).map(body => body.dataset.msgId),
    keys: Array.from(element.querySelectorAll<HTMLElement>("[data-message-row-key]")).map(row => row.dataset.messageRowKey),
    height: element.scrollHeight }))
  expect(after.ids.at(-1)).toBe(before.ids.at(-1))
  expect(after.ids.at(-1)).toBe(unread)
  expect(after.keys).not.toEqual(before.keys)
  expect(after.height).toBeGreaterThan(before.height)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await frame.evaluate(element => (element as HTMLIFrameElement).contentWindow?.postMessage({ type: "scroll-fixture-height", height: 420 }, "*"))
  await expect(frame).toHaveCSS("height", "420px")
  await waitForStableTail(root, "following-html-growth")
  const uploaded = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${dmId}/attachments`, {
    headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
    multipart: { file: { name: "fixed-ratio.png", mimeType: "image/png", buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") } },
  }))
  expect(uploaded.status()).toBe(200)
  const imageAttachment = await uploaded.json() as { id: string }
  const imageHold = await holdNextRequest(actors, page, `**/api/community/channels/${dmId}/attachments/${imageAttachment.id}**`, () => true)
  const imagePost = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${dmId}/messages`, {
    headers: CURRENT_COMMUNITY_FIXTURE_HEADERS, data: { content: "fixed ratio decode", attachments: [imageAttachment.id] },
  }))
  expect(imagePost.status()).toBe(201)
  const imageMessage = await imagePost.json() as { message: { id: string } }
  const imageBox = page.getByTestId(tid.messageImage(imageMessage.message.id, 0))
  await imageHold.matched
  const imageBefore = await imageBox.boundingBox()
  expect(imageBefore?.height).toBeGreaterThan(0)
  await root.hover()
  await page.mouse.wheel(0, -100)
  const decodeAnchor = await waitForCommittedGeometry(root)
  imageHold.release()
  await imageBox.evaluate(image => (image as HTMLImageElement).decode())
  const imageAfter = await imageBox.boundingBox()
  expect(Math.abs(imageAfter!.height - imageBefore!.height)).toBeLessThanOrEqual(1)
  await expect.poll(async () => Math.abs(await bodyOffset(root, decodeAnchor.firstVisibleId!) - decodeAnchor.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await imageHold.dispose()
  await root.hover()
  await page.mouse.wheel(0, -180)
  await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(1)
  const history = await waitForCommittedGeometry(root)
  const viewport = page.viewportSize()!
  await page.setViewportSize({ ...viewport, height: viewport.height - 120 })
  await expect.poll(async () => Math.abs(await bodyOffset(root, history.firstVisibleId!) - history.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await page.setViewportSize(viewport)
  await expect.poll(async () => Math.abs(await bodyOffset(root, history.firstVisibleId!) - history.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await page.getByRole("link", { name: "Friends", exact: true }).click()
  await expect(page).toHaveURL(/\/c\/me\/friends$/)
  const secondPeer = await actors.seed.seedMessage("bob", dmId, "late New during manual history")
  await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).some(event =>
    event.type === "community:message.create" && event.message?.id === secondPeer)).toBe(true)
  const historyEntry = await holdNextRequest(actors, page, `**/api/community/channels/${dmId}/messages**`, url =>
    url.searchParams.get("entry") === "1" && !url.searchParams.has("newAfterSeq"))
  await page.locator(`a[href="${path}"]`).first().click()
  await historyEntry.matched
  await expect(page.getByTestId(tid.message(secondPeer))).toBeAttached()
  await root.hover()
  await page.mouse.wheel(0, -120)
  const lateHistory = await waitForCommittedGeometry(root)
  expect(lateHistory.distanceToEnd).toBeGreaterThan(1)
  historyEntry.release()
  await expect(root.locator(`[data-message-divider-for="${secondPeer}"] [data-new-divider]`)).toBeAttached()
  await expect.poll(async () => Math.abs(await bodyOffset(root, lateHistory.firstVisibleId!) - lateHistory.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await historyEntry.dispose()
  const readSecondPeer = page.waitForResponse(response => response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/read`
    && response.request().postDataJSON().lastReadMessageId === secondPeer)
  void readSecondPeer.catch(() => undefined)
  await page.getByTestId(tid.scrollToPresent).click()
  await expect(page.getByTestId(tid.message(secondPeer))).toBeInViewport()
  await waitForStableTail(root, "consume-current-New-before-next-batch")
  expect((await readSecondPeer).status()).toBe(200)
  await root.hover()
  await page.mouse.wheel(0, -400)
  const oldLookup = await holdNextRequest(actors, page, `**/api/community/channels/${dmId}/messages**`, url => url.searchParams.has("newAfterSeq"))
  const retiredPeer = await actors.seed.seedMessage("bob", dmId, "retired New lookup")
  await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).some(event =>
    event.type === "community:message.create" && event.message?.id === retiredPeer)).toBe(true)
  await oldLookup.matched
  await frame.evaluate((element) => {
    const source = (element as HTMLIFrameElement).contentWindow
    if (!source) throw new Error("The retiring iframe must have its real WindowProxy")
    const state: { event: MessageEvent | null; source: Window; capture: (event: MessageEvent) => void; originalTrusted: boolean } = {
      event: null, source, originalTrusted: false, capture: () => undefined,
    }
    state.capture = event => {
      if (event.source !== source || event.origin !== "null" || event.data?.type !== "alook-html-height" || event.data.height < 850) return
      event.stopImmediatePropagation()
      state.event = event
      state.originalTrusted = event.isTrusted
    }
    ;(window as typeof window & { __historyReading326?: typeof state }).__historyReading326 = state
    window.addEventListener("message", state.capture, true)
    source.postMessage({ type: "scroll-fixture-height", height: 900 }, "*")
  })
  await expect.poll(() => page.evaluate(() => {
    const state = (window as typeof window & { __historyReading326?: { event: MessageEvent | null } }).__historyReading326
    return state?.event?.data.height ?? 0
  })).toBeGreaterThanOrEqual(850)
  await info.attach("late-new-layout.json", { body: JSON.stringify({ before, after, history, lateHistory }, null, 2), contentType: "application/json" })
  await finishTrace()
  await page.locator(`a[href="/c/me/${nextDm}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`${nextDm}$`))
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(warmDocument)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  const newFrame = page.getByTestId(tid.htmlPreviewFrame(nextPreview.attachmentId))
  await expect(page.getByTestId(tid.htmlPreview(nextPreview.attachmentId))).toHaveAttribute("data-html-preview-status", "ready")
  await expect(newFrame).toHaveCSS("height", "160px")
  await waitForStableTail(root, "new-owner-before-retired-delivery")
  await root.hover()
  await page.mouse.wheel(0, -120)
  const newBefore = await waitForCommittedGeometry(root)
  await trace(actors, page, info, nextDm)
  const readState = async () => {
    const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${nextDm}/messages?entry=1`, {
      headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL },
    })
    expect(response.status).toBe(200)
    const entry = CommunityConversationEntryReadSchema.parse(await response.json())
    return { state: entry.readState, revision: entry.readStateRevision }
  }
  const readBefore = await readState()
  const lateResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === `/api/community/channels/${dmId}/messages` && url.searchParams.has("newAfterSeq")
  })
  oldLookup.release()
  const deliveredNew = await lateResponse
  expect(deliveredNew.status()).toBe(200)
  const retiredEntry = CommunityConversationEntryReadSchema.parse(await deliveredNew.json())
  expect(retiredEntry.channel.id).toBe(dmId)
  expect(retiredEntry.newBoundary.afterSeq).toBe(Number(new URL(deliveredNew.url()).searchParams.get("newAfterSeq")))
  await oldLookup.dispose()
  const replay = await page.evaluate(() => {
    const state = (window as typeof window & { __historyReading326?: {
      event: MessageEvent | null; source: Window; capture: (event: MessageEvent) => void; originalTrusted: boolean;
    } }).__historyReading326
    if (!state?.event) throw new Error("A real old-frame height event must have been captured")
    window.removeEventListener("message", state.capture, true)
    const event = state.event
    let delivered = 0
    const witness = (received: MessageEvent) => { if (received === event) delivered++ }
    window.addEventListener("message", witness)
    window.dispatchEvent(event)
    window.removeEventListener("message", witness)
    delete (window as typeof window & { __historyReading326?: unknown }).__historyReading326
    return { delivered, originalTrusted: state.originalTrusted, replayTrusted: event.isTrusted,
      originalSource: event.source === state.source, origin: event.origin, height: event.data.height }
  })
  expect(replay).toMatchObject({ delivered: 1, originalTrusted: true, replayTrusted: false, originalSource: true, origin: "null" })
  await expect.poll(async () => Math.abs(await bodyOffset(root, newBefore.firstVisibleId!) - newBefore.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await expect(newFrame).toHaveCSS("height", "160px")
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  expect(await readState()).toEqual(readBefore)
  await expect(page.getByTestId(tid.htmlPreviewFrame(html.attachmentId))).toHaveCount(0)
  await expect(page.getByTestId(tid.message(retiredPeer))).toHaveCount(0)
  await info.attach("retired-callback-receipts.json", { body: JSON.stringify({ replay, oldNewStatus: deliveredNew.status(),
    oldNewCutoff: retiredEntry.newBoundary.afterSeq, newBefore, newAfter: await waitForCommittedGeometry(root), readBefore }, null, 2), contentType: "application/json" })
})
