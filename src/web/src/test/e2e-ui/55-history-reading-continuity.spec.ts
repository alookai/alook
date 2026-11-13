import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import type { Locator, Page, Request, Response, TestInfo } from "@playwright/test"
import { CommunityConversationEntryReadSchema, CommunityMessagesReadSchema, communityReadSchemas } from "@alook/shared"
import { test, expect, type CaseActors } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { communityFixtureFetch, confirmCommunityFixtureApiResponse, currentCommunityFixtureError, CURRENT_COMMUNITY_FIXTURE_HEADERS } from "./_fixtures/business-contract"
import { proxyCommunityWebSockets, communityFrameEvents } from "./_fixtures/community-ws-proxy"
import { beginScrollTraceAnalysis, endScrollTraceAnalysis, withScrollTraceAnalysis, installScrollTrace, installScrollTraceInCurrentDocument, startScrollTrace, markScrollTrace } from "./_fixtures/scroll-trace"
import { finishAndAttach, holdNextRequest, identity, seedResizableHtmlPreview, waitForCommittedGeometry, waitForStableTail } from "./_fixtures/message-scroll-characterization"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import type { HistoricalRow } from "./_fixtures/historical-profile"

async function prepare(actors: CaseActors, kind: "channel" | "dm", html = false, htmlOptions?: { measuredResize: true }) {
  let opened = kind === "channel" ? await actors.asUser("alice") : undefined
  let serverId: string | undefined
  let channelId: string
  if (kind === "channel") {
    serverId = await actors.seed.seedServer("alice", `Reading continuity ${Date.now()}`)
    await actors.seed.seedJoinServer("alice", "bob", serverId)
    channelId = await actors.seed.seedChannel("alice", serverId, "reading-continuity")
  } else channelId = await actors.seed.seedDm("alice", actors.userId("bob"))
  let preview: Awaited<ReturnType<typeof seedResizableHtmlPreview>> | undefined
  const profile: HistoricalRow[] = Array.from({ length: 300 }, (_, index) => html && index === 145
    ? { author: "alice", create: async () => {
      if (!opened) throw new Error("HTML preparation requires the existing channel actor")
      preview = await seedResizableHtmlPreview(opened.page, channelId, htmlOptions)
      return preview
    } }
    : { author: "bob", content: `reading ${index}\n\ncontext ${index}\n\nthird line${index % 7 === 0 ? "\n\nvariable fourth line" : ""}` })
  const ids = await actors.seedHistory(channelId, profile)
  const path = kind === "channel" ? `/c/channels/${serverId}/${channelId}` : `/c/me/${channelId}`
  const endpoint = `/api/community/channels/${channelId}/messages`
  let checkpointSeq: number | null = null
  if (kind === "dm") {
    const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
      method: "PUT", headers: { Cookie: actors.sessionCookie("alice"), "Content-Type": "application/json", Origin: WEB_URL },
      body: JSON.stringify({ lastReadMessageId: ids[149] }),
    })
    expect(response.status).toBe(200)
    const checkpoint = communityReadSchemas().readAdvance.parse(await response.json())
    expect(checkpoint.channelId).toBe(channelId)
    expect(checkpoint.targetSeq).toBe(150)
    checkpointSeq = checkpoint.targetSeq
  }
  const response = await communityFixtureFetch(`${WEB_URL}${endpoint}?entry=1&anchor=${ids[150]}`, {
    headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL },
  })
  expect(response.status).toBe(200)
  const middle = CommunityConversationEntryReadSchema.parse(await response.json())
  expect(middle.selection.anchorMessageId).toBe(ids[150])
  expect(middle.page.hasMoreOlder).toBe(true)
  expect(middle.page.hasMoreNewer).toBe(true)
  opened ??= await actors.asUser("alice")
  return { ...opened, channelId, serverId, ids, path, endpoint, preview, kind, checkpointSeq, middle }
}

type ReadingCase = Awaited<ReturnType<typeof prepare>>
type ReadingPositions = Array<{ time: number; top: number; height: number; total: number; admission: string | undefined }>

async function enterDmMiddle(actors: CaseActors, value: ReadingCase) {
  const { page, path, endpoint, channelId, ids, checkpointSeq } = value
  if (checkpointSeq === null) throw new Error("A qualified DM checkpoint is required")
  const entryResponse = confirmCommunityFixtureApiResponse(page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === endpoint
      && url.searchParams.get("entry") === "1" && url.searchParams.get("window") === "tail"
  }))
  void entryResponse.catch(() => undefined)
  await gotoAfterUserWsAuth(page, path)
  const entryRead = await entryResponse
  expect(entryRead.status()).toBe(200)
  const entry = CommunityConversationEntryReadSchema.parse(await entryRead.json())
  expect(entry.channelId).toBe(channelId)
  expect(entry.viewerId).toBe(actors.userId("alice"))
  expect(entry.selection).toEqual({ reason: "tail", anchorMessageId: null })
  expect(entry.newBoundary.afterSeq).toBe(checkpointSeq)
  expect(entry.newBoundary.target?.id).toBe(ids[150])
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  const button = page.getByTestId(tid.scrollToNew)
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  const anchorResponse = confirmCommunityFixtureApiResponse(page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === endpoint
      && !url.searchParams.has("entry") && url.searchParams.get("anchor") === ids[150]
  }))
  void anchorResponse.catch(() => undefined)
  await button.click()
  const anchorRead = await anchorResponse
  expect(anchorRead.status()).toBe(200)
  const middle = CommunityMessagesReadSchema.parse(await anchorRead.json())
  expect(middle.channelId).toBe(channelId)
  expect(middle.messages.some(message => message.id === ids[150])).toBe(true)
  expect(middle.page.hasMoreOlder).toBe(true)
  expect(middle.page.hasMoreNewer).toBe(true)
  expect(middle.page.olderCursor).toEqual(expect.any(String))
  expect(middle.page.newerCursor).toEqual(expect.any(String))
  await expect(page.getByTestId(tid.message(ids[150]))).toBeInViewport()
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await waitForCommittedGeometry(root)
}

async function returnToDmMiddle(value: ReadingCase, fast: boolean): Promise<ReadingPositions> {
  const { page, ids } = value
  const root = page.getByTestId(tid.messageScroller)
  const positions: ReadingPositions = []
  await root.hover()
  for (let step = 0; step < 100; step++) {
    const current = await root.evaluate((element, ids) => {
      const viewport = element.getBoundingClientRect()
      const bottom = viewport.bottom - Number((element as HTMLElement).dataset.composerOcclusion ?? 0)
      const rows = Array.from(element.querySelectorAll<HTMLElement>("[data-msg-id]"))
      const body = rows.find(row => row.dataset.msgId === ids[150])
      const rect = body?.getBoundingClientRect()
      const first = rows.find(row => row.getBoundingClientRect().bottom > viewport.top + 1)
      return { visible: !!rect && rect.height > 0 && rect.bottom > viewport.top + 1 && rect.top < bottom - 1,
        targetOffset: rect && rect.height > 0 ? rect.top - viewport.top : null,
        firstIndex: ids.indexOf(first?.dataset.msgId ?? ""), height: element.clientHeight }
    }, ids)
    if (current.visible) break
    expect(current.height).toBeGreaterThan(0)
    const limit = current.height * (fast ? 3 : 0.35)
    const delta = current.targetOffset === null ? (current.firstIndex > 150 ? -limit : limit)
      : Math.max(-limit, Math.min(limit, current.targetOffset - current.height * 0.25))
    await page.mouse.wheel(0, delta)
    positions.push(await root.evaluate(element => ({ time: Date.now(), top: element.scrollTop,
      height: element.clientHeight, total: element.scrollHeight, admission: (element as HTMLElement).dataset.paginationEnabled })))
    await page.waitForTimeout(fast ? 8 : 32)
  }
  await expect(page.getByTestId(tid.message(ids[150]))).toBeInViewport()
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await waitForCommittedGeometry(root)
  return positions
}

async function readAuthoritativeState(actors: CaseActors, value: ReadingCase) {
  const response = await communityFixtureFetch(`${WEB_URL}${value.endpoint}?entry=1&window=tail`, {
    headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL },
  })
  expect(response.status).toBe(200)
  const entry = CommunityConversationEntryReadSchema.parse(await response.json())
  expect(entry.channelId).toBe(value.channelId)
  expect(entry.viewerId).toBe(actors.userId("alice"))
  return { state: entry.readState, revision: entry.readStateRevision }
}

type PageReceipt = { direction: "older" | "newer"; cursor: string; status: number; time: number; timing: ReturnType<ReturnType<Response["request"]>["timing"]>; ids: string[]; page?: ReturnType<typeof CommunityMessagesReadSchema.parse>["page"] }
type PageRequest = { direction: "older" | "newer"; cursor: string; time: number; finished: boolean; failure?: string; reading?: { id: string; offset: number; ready: boolean } | null }
type PageTraffic = { receipts: PageReceipt[]; requests: PageRequest[] }
function observePages(actors: CaseActors, page: Page, endpoint: string) {
  const receipts: PageReceipt[] = []
  const requests: PageRequest[] = []
  const requestEntries = new Map<Request, PageRequest>()
  const requestListener = (request: Request) => {
    const url = new URL(request.url())
    if (request.method() !== "GET" || url.pathname !== endpoint
      || !url.searchParams.has("cursor") && !url.searchParams.has("since")) return
    const entry: PageRequest = { direction: url.searchParams.has("cursor") ? "older" : "newer",
      cursor: url.searchParams.get("cursor") ?? url.searchParams.get("since")!, time: Date.now(), finished: false }
    requests.push(entry)
    requestEntries.set(request, entry)
    const operation = page.evaluate(rootId => {
      const root = document.querySelector<HTMLElement>(`[data-testid="${rootId}"]`)
      if (!root) return null
      const viewport = root.getBoundingClientRect()
      const bottom = viewport.bottom - Number(root.dataset.composerOcclusion ?? 0)
      const body = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(body => {
        const rect = body.getBoundingClientRect()
        return rect.height > 0 && rect.bottom > viewport.top + 1 && rect.top < bottom - 1
      })
      return body ? { id: body.dataset.msgId!, offset: body.getBoundingClientRect().top - viewport.top,
        ready: root.querySelector("[data-read-position-ready]")?.getAttribute("data-read-position-ready") === "true" } : null
    }, tid.messageScroller).then(reading => { entry.reading = reading }, () => { entry.reading = null })
    pending.add(operation)
    void operation.finally(() => pending.delete(operation))
  }
  const pending = new Set<Promise<void>>()
  const failures: unknown[] = []
  const listener = (response: Response) => {
    const url = new URL(response.url())
    if (response.request().method() !== "GET" || url.pathname !== endpoint
      || !url.searchParams.has("cursor") && !url.searchParams.has("since")) return
    const operation = (async () => {
      const receipt: PageReceipt = { direction: url.searchParams.has("cursor") ? "older" : "newer",
        cursor: url.searchParams.get("cursor") ?? url.searchParams.get("since")!, status: response.status(), time: Date.now(), timing: response.request().timing(), ids: [] }
      if (response.ok()) {
        const packet = CommunityMessagesReadSchema.parse(await response.json())
        receipt.ids = packet.messages.map(message => message.id)
        receipt.page = packet.page
      }
      await response.finished()
      receipt.timing = response.request().timing()
      receipts.push(receipt)
      const request = requestEntries.get(response.request())
      if (request) request.finished = true
    })()
    pending.add(operation)
    void operation.catch(error => failures.push(error)).finally(() => pending.delete(operation))
  }
  const failedListener = (request: Request) => {
    const entry = requestEntries.get(request)
    if (entry) { entry.finished = true; entry.failure = request.failure()?.errorText ?? "Request failed" }
  }
  page.on("requestfailed", failedListener)
  page.on("request", requestListener)
  page.on("response", listener)
  actors.onCleanup(async () => { page.off("requestfailed", failedListener); page.off("request", requestListener); page.off("response", listener); await Promise.allSettled([...pending]); if (failures.length) throw new AggregateError(failures, "Page receipt validation failed") })
  return { receipts, requests }
}

async function bodyOffset(root: Locator, id: string) {
  return root.locator(`[data-msg-id="${id}"]`).evaluate((body, rootId) => {
    const scroller = body.closest<HTMLElement>(`[data-testid="${rootId}"]`)!
    return body.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, tid.messageScroller)
}

async function settledPages(root: Locator, traffic: PageTraffic) {
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  await expect.poll(() => traffic.requests.every(request => request.finished)).toBe(true)
  const before = await waitForCommittedGeometry(root)
  expect(before.firstVisibleId).not.toBeNull()
  const requestCount = traffic.requests.length
  const after = await waitForCommittedGeometry(root)
  expect(traffic.requests).toHaveLength(requestCount)
  expect(Math.abs(await bodyOffset(root, before.firstVisibleId!) - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  return { requestCount, before, after }
}

async function twoPages(page: Page, root: Locator, traffic: PageTraffic, direction: "older" | "newer", fast: boolean,
  phase?: { initial: number; startedAt: number; returnToMiddle: () => Promise<ReadingPositions> },
  settledBefore?: Awaited<ReturnType<typeof settledPages>>) {
  const stoppedBefore = settledBefore ?? await settledPages(root, traffic)
  expect(traffic.requests).toHaveLength(stoppedBefore.requestCount)
  const { receipts, requests } = traffic
  const requestBaseline = requests.length
  const initial = phase?.initial ?? receipts.filter(receipt => receipt.direction === direction && receipt.status === 200).length
  const positions: Array<{ time: number; top: number; height: number; total: number; admission: string | undefined }> = []
  return withScrollTraceAnalysis(page, `${direction}-two-real-pages`, async () => {
    if (phase) positions.push(...await phase.returnToMiddle())
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
    if (phase) expect(accepted.every(receipt => receipt.timing.startTime >= phase.startedAt)).toBe(true)
    expect(new Set(accepted.map(receipt => receipt.cursor)).size).toBe(accepted.length)
    expect(new Set(accepted.flatMap(receipt => receipt.ids)).size).toBeGreaterThan(50)
    await expect(root).toHaveAttribute("data-pagination-enabled", "true")
    const issued = requests.slice(requestBaseline).filter(request => request.direction === direction)
    expect(issued.length).toBeGreaterThanOrEqual(2)
    await expect.poll(() => issued.every(request => request.reading !== undefined)).toBe(true)
    for (const request of issued) {
      expect(request.failure).toBeUndefined()
      const source = receipts.find(receipt => receipt.status === 200
        && (direction === "older" ? receipt.page?.olderCursor : receipt.page?.newerCursor) === request.cursor)
      expect(source, `${direction}: actual cursor producer`).toBeDefined()
      expect(request.reading, `${direction}: actual reading body at request`).not.toBeNull()
      expect(request.reading!.ready).toBe(true)
      expect(source!.ids).toContain(request.reading!.id)
    }
    const stoppedAfter = await settledPages(root, traffic)
    await markScrollTrace(page, `${direction}-page-owner-settled`, { detail: { observedAt: Date.now(), stoppedBefore, stoppedAfter, issued } })
    return positions
  }, { dataTransitionSource: direction === "older" ? "older-page" : "newer-page", commandDirection: direction === "older" ? "backward" : "forward" })
}

async function trace(actors: CaseActors, page: Page, info: TestInfo, channelId: string) {
  await installScrollTrace(page)
  await installScrollTraceInCurrentDocument(page)
  await startScrollTrace(page, { scenario: info.title, identity: identity(channelId) })
  await markScrollTrace(page, "clock-calibration", { detail: await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, performanceNow: performance.now(), epoch: Date.now() })) })
  await beginScrollTraceAnalysis(page, "reading-continuity-journey")
  let active = true
  const finish = async () => { if (active && !page.isClosed()) { active = false; await endScrollTraceAnalysis(page, "reading-continuity-journey"); await finishAndAttach(page, info) } }
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
        const traffic = observePages(actors, page, endpoint)
        const { receipts } = traffic
        const firstOlder = await holdNextRequest(actors, page, `**${endpoint}**`, url => url.searchParams.get("cursor") === value.middle.page.olderCursor)
        const proxy = await proxyCommunityWebSockets(context)
        if (kind === "dm") await enterDmMiddle(actors, value)
        else await gotoAfterUserWsAuth(page, `${path}?msg=${ids[150]}`)
        const root = page.getByTestId(tid.messageScroller)
        await expect(page.getByTestId(tid.message(ids[150]))).toBeInViewport()
        await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
        const finishOlderTrace = await trace(actors, page, info, channelId)
        const draft = `retained ${kind} ${narrow} ${fast}`
        await composerEditable(page).fill(draft)
        expect((await firstOlder.matched).searchParams.get("cursor")).toBe(value.middle.page.olderCursor)
        expect(receipts.filter(receipt => receipt.cursor === value.middle.page.olderCursor && receipt.status === 200)).toHaveLength(0)
        const initialBody = await waitForCommittedGeometry(root)
        expect(initialBody.firstVisibleId).not.toBeNull()
        firstOlder.release()
        await expect.poll(() => receipts.filter(receipt => receipt.cursor === value.middle.page.olderCursor && receipt.status === 200).length).toBe(1)
        await expect.poll(() => receipts.filter(receipt => receipt.cursor === value.middle.page.newerCursor && receipt.status === 200).length).toBe(1)
        await expect(root).toHaveAttribute("data-pagination-enabled", "true")
        expect(Math.abs(await bodyOffset(root, initialBody.firstVisibleId!) - initialBody.firstVisibleOffset!)).toBeLessThanOrEqual(1)
        const initialNeighborhood = await settledPages(root, traffic)
        await markScrollTrace(page, "initial-current-page-and-two-neighbors", { detail: { initialBody, initialNeighborhood,
          olderCursor: value.middle.page.olderCursor, newerCursor: value.middle.page.newerCursor } })
        await firstOlder.dispose()
        const olderPositions = await twoPages(page, root, traffic, "older", fast, undefined, initialNeighborhood)
        await finishOlderTrace()
        let newerPositions: ReadingPositions
        let finishNewerTrace: Awaited<ReturnType<typeof trace>>
        let newerPhase: { initial: number; startedAt: number } | undefined
        if (kind === "channel") {
          await page.goto(`${path}?msg=${ids[150]}`, { waitUntil: "commit" })
          await expect(page.getByTestId(tid.message(ids[150]))).toBeInViewport()
          await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
          await expect(composerEditable(page)).toHaveText(draft)
          finishNewerTrace = await trace(actors, page, info, channelId)
          newerPositions = await twoPages(page, root, traffic, "newer", fast)
        } else {
          await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
          await expect(composerEditable(page)).toHaveText(draft)
          newerPhase = Object.freeze({ initial: receipts.filter(receipt => receipt.direction === "newer" && receipt.status === 200).length, startedAt: Date.now() })
          finishNewerTrace = await trace(actors, page, info, channelId)
          newerPositions = await twoPages(page, root, traffic, "newer", fast, {
            ...newerPhase,
            returnToMiddle: async () => {
              const positions = await returnToDmMiddle(value, fast)
              await expect(composerEditable(page)).toHaveText(draft)
              return positions
            },
          })
        }
        await root.hover()
        const returnLatestHeight = await root.evaluate(element => element.clientHeight)
        expect(returnLatestHeight).toBeGreaterThan(0)
        await page.mouse.wheel(0, -returnLatestHeight)
        await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(CONVERSATION_TAIL_SPACE_PX)
        const returnLatestBefore = await waitForCommittedGeometry(root)
        expect(returnLatestBefore.firstVisibleId).not.toBeNull()
        expect(returnLatestBefore.distanceToEnd).toBeGreaterThan(CONVERSATION_TAIL_SPACE_PX)
        await expect(page.getByTestId(tid.scrollToPresent)).toBeVisible()
        await expect(page.getByTestId(tid.scrollToPresent)).toBeEnabled()
        await markScrollTrace(page, "return-latest-premise", { detail: { geometry: returnLatestBefore } })
        await page.getByTestId(tid.scrollToPresent).click()
        await expect(page.getByTestId(tid.message(ids.at(-1)!))).toBeVisible()
        await waitForStableTail(root, "return-latest")
        let before: Awaited<ReturnType<typeof waitForCommittedGeometry>> | undefined
        let dmReentry: unknown
        if (!fast) {
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
          const passiveBody = await waitForCommittedGeometry(root)
          before = passiveBody
          expect(passiveBody.firstVisibleId).not.toBeNull()
          const hiddenPeer = await actors.seed.seedMessage("bob", channelId, `history append ${info.title}`)
          await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).some(event =>
            event.type === "community:message.create" && event.message?.id === hiddenPeer)).toBe(true)
          await expect.poll(async () => Math.abs(await bodyOffset(root, passiveBody.firstVisibleId!) - passiveBody.firstVisibleOffset!)).toBeLessThanOrEqual(1)
          await expect(composerEditable(page)).toHaveText(draft)
          if (kind === "dm") {
            await finishNewerTrace()
            const readBefore = await readAuthoritativeState(actors, value)
            const reentryResponse = confirmCommunityFixtureApiResponse(page.waitForResponse(response => {
              const url = new URL(response.url())
              return response.request().method() === "GET" && url.pathname === endpoint
                && url.searchParams.get("entry") === "1" && url.searchParams.get("window") === "tail"
            }))
            void reentryResponse.catch(() => undefined)
            await page.goto(path, { waitUntil: "commit" })
            const reloaded = await reentryResponse
            expect(reloaded.status()).toBe(200)
            const entry = CommunityConversationEntryReadSchema.parse(await reloaded.json())
            expect(entry.channelId).toBe(channelId)
            expect(entry.viewerId).toBe(actors.userId("alice"))
            expect(entry.selection).toEqual({ reason: "tail", anchorMessageId: null })
            expect(entry.readState.lastReadSeq).toBeGreaterThanOrEqual(readBefore.state.lastReadSeq)
            await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
            await expect(composerEditable(page)).toHaveText(draft)
            await expect(page.getByTestId(tid.message(hiddenPeer))).toBeVisible()
            await waitForStableTail(root, "DM-hard-reentry-tail")
            const readAfter = await readAuthoritativeState(actors, value)
            expect(readAfter.state.lastReadSeq).toBeGreaterThanOrEqual(readBefore.state.lastReadSeq)
            dmReentry = { readBefore, selection: entry.selection, cutoff: entry.newBoundary.afterSeq,
              readAfter, geometry: await waitForCommittedGeometry(root) }
          }
        }
        await info.attach("reading-cursor-stages.json", { body: JSON.stringify({ kind, narrow, fast, receipts, requests: traffic.requests, olderPositions, newerPositions, newerPhase, returnLatestBefore, before, dmReentry }, null, 2), contentType: "application/json" })
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

async function prepareReadableRetry(actors: CaseActors, page: Page, root: Locator, retry: Locator, info: TestInfo, direction: "older" | "newer") {
  await retry.scrollIntoViewIfNeeded()
  await expect(retry).toBeEnabled()
  const read = () => retry.evaluate((button, scrollerId) => {
    const scroller = button.closest<HTMLElement>(`[data-testid="${scrollerId}"]`)
    if (!scroller) return { readable: false, hit: false, root: null }
    const rect = button.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
    const top = viewport.top + scroller.clientTop, left = viewport.left + scroller.clientLeft
    const right = left + scroller.clientWidth
    const capsuleHeight = Math.max(0, Number(scroller.dataset.composerOcclusion ?? 0))
    const bottom = top + scroller.clientHeight - capsuleHeight
    const hit = button.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      readable: button.isConnected && rect.width > 0 && rect.height > 0 && rect.top >= top && rect.bottom <= bottom && rect.left >= left && rect.right <= right,
      hit: button.contains(hit),
      bounds: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
      viewport: { top, bottom, left, right },
      hitElement: hit ? { tag: hit.tagName, testId: hit.getAttribute("data-testid"), slot: hit.getAttribute("data-slot"),
        role: hit.getAttribute("role"), ownerTestId: hit.closest(`[data-testid="${scrollerId}"]`)?.getAttribute("data-testid") ?? null } : null,
      root: { tag: scroller.tagName, testId: scroller.dataset.testid, connected: scroller.isConnected,
        scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
        clientWidth: scroller.clientWidth, clientTop: scroller.clientTop, clientLeft: scroller.clientLeft, capsuleHeight,
        ready: scroller.querySelector("[data-read-position-ready]")?.getAttribute("data-read-position-ready"),
        pagination: scroller.dataset.paginationEnabled },
    }
  }, tid.messageScroller)
  let sample: Awaited<ReturnType<typeof read>> | undefined
  actors.onCleanup(async () => { await info.attach(`${direction}-retry-preparation.json`, {
    body: JSON.stringify(sample ?? null, null, 2), contentType: "application/json",
  }) })
  sample = await read()
  if (sample.bounds && sample.viewport) {
    const delta = sample.bounds.bottom > sample.viewport.bottom ? Math.ceil(sample.bounds.bottom - sample.viewport.bottom)
      : sample.bounds.top < sample.viewport.top ? Math.floor(sample.bounds.top - sample.viewport.top) : 0
    if (delta !== 0) {
      await root.hover()
      await page.mouse.wheel(0, delta)
    }
  }
  await expect.poll(async () => { sample = await read(); return sample }).toMatchObject({ readable: true, hit: true })
}

async function lateNewGeometry(root: Locator, id: string) {
  return root.evaluate((element, target) => {
    const rootRect = element.getBoundingClientRect()
    const body = element.querySelector<HTMLElement>(`[data-msg-id="${target}"] [data-community-message-body]`)
    const divider = element.querySelector<HTMLElement>(`[data-message-divider-for="${target}"] [data-new-divider]`)
    const box = (node: HTMLElement | null) => {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { connected: node.isConnected, width: rect.width, height: rect.height,
        top: rect.top, bottom: rect.bottom, offset: rect.top - rootRect.top }
    }
    return { top: element.scrollTop, height: element.scrollHeight,
      ids: Array.from(element.querySelectorAll<HTMLElement>("[data-msg-id]")).map(body => body.dataset.msgId),
      keys: Array.from(element.querySelectorAll<HTMLElement>("[data-message-row-key]")).map(row => row.dataset.messageRowKey),
      ready: element.querySelector('[data-read-position-ready]')?.getAttribute("data-read-position-ready"),
      body: box(body), divider: box(divider), dividerFor: divider?.closest("[data-message-divider-for]")?.getAttribute("data-message-divider-for") }
  }, id)
}

test("channel older failure retries in the same window after a held real page", async ({ caseActors }, info) => {
  test.setTimeout(240_000)
  const actors = await caseActors(["alice", "bob"])
  const { page, path, ids, endpoint, channelId, middle } = await prepare(actors, "channel")
  const { receipts } = observePages(actors, page, endpoint)
  const heldCursor = middle.page.olderCursor
  expect(heldCursor).toEqual(expect.any(String))
  const held = await holdNextRequest(actors, page, `**${endpoint}**`, url => url.searchParams.get("cursor") === heldCursor)
  let olderGets = 0
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname === endpoint && url.searchParams.has("cursor")) olderGets++ })
  await gotoAfterUserWsAuth(page, `${path}?msg=${ids[150]}`)
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await trace(actors, page, info, channelId)
  await composerEditable(page).fill("keep older draft")
  await moveToEdge(root, "start")
  expect((await held.matched).searchParams.get("cursor")).toBe(heldCursor)
  await moveToEdge(root, "start")
  await page.waitForTimeout(250)
  expect(olderGets).toBe(1)
  held.release()
  await expect.poll(() => receipts.filter(receipt => receipt.status === 200 && receipt.cursor === heldCursor).length).toBe(1)
  const nextCursor = receipts.find(receipt => receipt.status === 200 && receipt.cursor === heldCursor)!.page!.olderCursor
  expect(nextCursor).toEqual(expect.any(String))
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  await held.dispose()
  let fail = true
  await page.route(`**${endpoint}**`, async route => {
    if (fail && new URL(route.request().url()).searchParams.get("cursor") === nextCursor) await route.fulfill(currentCommunityFixtureError("bounded page failure", 503))
    else await route.fallback()
  })
  await moveToEdge(root, "start")
  const retry = page.getByRole("alert").filter({ hasText: "Could not load older messages." }).getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible()
  await prepareReadableRetry(actors, page, root, retry, info, "older")
  const before = await waitForCommittedGeometry(root)
  const count = olderGets
  await page.waitForTimeout(250)
  expect(olderGets).toBe(count)
  fail = false
  await retry.click()
  await expect.poll(() => receipts.filter(receipt => receipt.status === 200 && receipt.cursor === nextCursor).length).toBe(1)
  expect(receipts.filter(receipt => receipt.status === 200 && [heldCursor, nextCursor].includes(receipt.cursor))).toHaveLength(2)
  await expect(root).toHaveAttribute("data-pagination-enabled", "true")
  expect(olderGets).toBe(count + 1)
  await expect.poll(async () => Math.abs(await bodyOffset(root, before.firstVisibleId!) - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await expect(composerEditable(page)).toHaveText("keep older draft")
})

test("DM newer and present recovery keep readable rows and retire a late present result", async ({ caseActors }, info) => {
  test.setTimeout(240_000)
  const actors = await caseActors(["alice", "bob"])
  const value = await prepare(actors, "dm")
  const { page, ids, endpoint, channelId } = value
  let failNewer = true
  await page.route(`**${endpoint}**`, async route => {
    if (failNewer && new URL(route.request().url()).searchParams.has("since")) await route.fulfill(currentCommunityFixtureError("bounded newer failure", 503))
    else await route.fallback()
  })
  await enterDmMiddle(actors, value)
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  const finishTrace = await trace(actors, page, info, channelId)
  await composerEditable(page).fill("keep DM draft")
  await moveToEdge(root, "end")
  const retry = page.getByRole("alert").filter({ hasText: "Could not load newer messages." }).getByRole("button", { name: "Retry" })
  await expect(retry).toBeVisible()
  await prepareReadableRetry(actors, page, root, retry, info, "newer")
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
  const { page, path, ids, endpoint, channelId, preview, middle } = await prepare(actors, "channel", true, { measuredResize: true })
  expect(preview).toBeDefined()
  const held = await holdNextRequest(actors, page, `**${endpoint}**`, url => url.searchParams.get("cursor") === middle.page.olderCursor)
  await gotoAfterUserWsAuth(page, `${path}?msg=${ids[150]}`)
  const root = page.getByTestId(tid.messageScroller)
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await trace(actors, page, info, channelId)
  await composerEditable(page).fill("keep HTML draft")
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
  await expect(page.getByTestId(tid.htmlPreview(preview!.attachmentId))).toHaveAttribute("data-html-preview-status", "ready")
  const before = await waitForCommittedGeometry(root)
  const box = await frame.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y + box!.height).toBeLessThanOrEqual(before.scrollerRect.top + 1)
  const resizeFromMeasuredChild = async (height: number) => {
    const receipt = await frame.evaluate((element, requestedHeight) => new Promise<{ sameFrame: boolean; origin: string; height: number; trusted: boolean }>((resolve, reject) => {
      const source = (element as HTMLIFrameElement).contentWindow
      if (!source) { reject(new Error("The measuring iframe must have its real WindowProxy")); return }
      const receive = (event: MessageEvent<unknown>) => {
        const data = event.data
        if (event.source !== source || event.origin !== "null" || typeof data !== "object" || data === null
          || !("type" in data) || data.type !== "alook-html-height" || !("height" in data)
          || typeof data.height !== "number" || data.height !== requestedHeight) return
        window.removeEventListener("message", receive)
        window.clearTimeout(timer)
        resolve({ sameFrame: event.source === source, origin: event.origin, height: data.height, trusted: event.isTrusted })
      }
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", receive)
        reject(new Error("The real sandboxed child did not publish its measured height"))
      }, 10_000)
      window.addEventListener("message", receive)
      source.postMessage({ type: "scroll-fixture-height", height: requestedHeight }, "*")
    }), height)
    const measured = await frame.contentFrame().locator("#content").evaluate(element => element.getBoundingClientRect().height)
    expect(receipt).toEqual({ sameFrame: true, origin: "null", height: measured, trusted: true })
    await info.attach(`html-measured-receipt-${height}`, { body: JSON.stringify({ requested: height, measured, receipt }), contentType: "application/json" })
  }
  for (const height of [600, 160]) {
    await markScrollTrace(page, `html-above-fold-${height}-before`, { detail: await waitForCommittedGeometry(root) })
    const measurement = resizeFromMeasuredChild(height)
    void measurement.catch(() => undefined)
    await expect(frame).toHaveCSS("height", `${height}px`)
    await measurement
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
  const spanningMeasurement = resizeFromMeasuredChild(1200)
  void spanningMeasurement.catch(() => undefined)
  await expect(frame).toHaveCSS("height", "1200px")
  await spanningMeasurement
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
  await root.hover()
  await page.mouse.wheel(0, -180)
  await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(1)
  await waitForCommittedGeometry(root)
  const unread = await actors.seed.seedMessage("bob", dmId, "late peer boundary")
  await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).some(event =>
    event.type === "community:message.create" && event.channelId === dmId && event.message?.id === unread)).toBe(true)
  const unreadBody = root.getByTestId(tid.message(unread)).locator("[data-community-message-body]")
  await expect(unreadBody).toBeVisible()
  await expect.poll(() => unreadBody.evaluate((body, scrollerId) => {
    const scroller = body.closest<HTMLElement>(`[data-testid="${scrollerId}"]`)
    if (!scroller) return { mounted: false, belowReadable: false }
    const rect = body.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
    const bottom = viewport.top + scroller.clientTop + scroller.clientHeight - Math.max(0, Number(scroller.dataset.composerOcclusion ?? 0))
    return { mounted: body.isConnected && rect.width > 0 && rect.height > 0, belowReadable: rect.top >= bottom,
      bodyTop: rect.top, bodyBottom: rect.bottom, readableBottom: bottom }
  }, tid.messageScroller)).toMatchObject({ mounted: true, belowReadable: true })
  const unreadStateResponse = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${dmId}/messages?entry=1`, {
    headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL },
  })
  expect(unreadStateResponse.status).toBe(200)
  const unreadState = CommunityConversationEntryReadSchema.parse(await unreadStateResponse.json())
  expect(unreadState.channelId).toBe(dmId)
  expect(unreadState.viewerId).toBe(actors.userId("alice"))
  expect(unreadState.readState.lastReadMessageId).toBe(readBob)
  await page.getByRole("link", { name: "Friends", exact: true }).click()
  await expect(page).toHaveURL(/\/c\/me\/friends$/)
  const held = await holdNextRequest(actors, page, `**/api/community/channels/${dmId}/messages**`, url => url.searchParams.get("entry") === "1")
  await page.locator(`a[href="${path}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`${dmId}$`))
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(warmDocument)
  await held.matched
  await expect(page.getByTestId(tid.message(unread))).toBeVisible()
  const before = await lateNewGeometry(root, unread)
  expect(before.body).not.toBeNull()
  expect(before.body!.connected).toBe(true)
  expect(before.body!.width).toBeGreaterThan(0)
  expect(before.body!.height).toBeGreaterThan(0)
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
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  await waitForStableTail(root, "late-new-fixed-tail")
  const after = await lateNewGeometry(root, unread)
  expect(after.ids.at(-1)).toBe(before.ids.at(-1))
  expect(after.ids.at(-1)).toBe(unread)
  expect(after.keys).not.toEqual(before.keys)
  expect(after.dividerFor).toBe(unread)
  expect(after.divider).not.toBeNull()
  expect(after.divider!.connected).toBe(true)
  expect(after.divider!.width).toBeGreaterThan(0)
  expect(after.divider!.height).toBeGreaterThan(0)
  expect(after.body).not.toBeNull()
  expect(after.body!.connected).toBe(true)
  expect(after.body!.width).toBeGreaterThan(0)
  expect(after.body!.height).toBeGreaterThan(0)
  expect(after.body!.top).toBeGreaterThanOrEqual(after.divider!.bottom - 1)
  expect(Math.abs(after.body!.offset - before.body!.offset)).toBeLessThanOrEqual(1)
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
  await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(1)
  const readHistoryCheckpoint = async () => {
    const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${dmId}/messages?entry=1`, {
      headers: { Cookie: actors.sessionCookie("alice"), Origin: WEB_URL },
    })
    expect(response.status).toBe(200)
    const entry = CommunityConversationEntryReadSchema.parse(await response.json())
    expect(entry.channelId).toBe(dmId)
    expect(entry.viewerId).toBe(actors.userId("alice"))
    return entry.readState
  }
  const historyReadBefore = await readHistoryCheckpoint()
  const secondPeer = await actors.seed.seedMessage("bob", dmId, "late New during manual history")
  await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).some(event =>
    event.type === "community:message.create" && event.message?.id === secondPeer)).toBe(true)
  const secondBody = root.getByTestId(tid.message(secondPeer)).locator("[data-community-message-body]")
  await expect(secondBody).toBeVisible()
  await expect.poll(() => secondBody.evaluate((body, scrollerId) => {
    const scroller = body.closest<HTMLElement>(`[data-testid="${scrollerId}"]`)
    if (!scroller) return { mounted: false, belowReadable: false }
    const rect = body.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
    const bottom = viewport.top + scroller.clientTop + scroller.clientHeight - Math.max(0, Number(scroller.dataset.composerOcclusion ?? 0))
    return { mounted: body.isConnected && rect.width > 0 && rect.height > 0, belowReadable: rect.top >= bottom,
      bodyTop: rect.top, bodyBottom: rect.bottom, readableBottom: bottom }
  }, tid.messageScroller)).toMatchObject({ mounted: true, belowReadable: true })
  expect(await readHistoryCheckpoint()).toEqual(historyReadBefore)
  await page.getByRole("link", { name: "Friends", exact: true }).click()
  await expect(page).toHaveURL(/\/c\/me\/friends$/)
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
  await expect.poll(() => root.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(1)
  const oldNewAway = await waitForCommittedGeometry(root)
  expect(oldNewAway.distanceToEnd).toBeGreaterThan(1)
  await expect.poll(() => root.evaluate((element, id) => {
    const divider = element.querySelector<HTMLElement>(`[data-message-divider-for="${id}"] [data-new-divider]`)
    const rect = divider?.getBoundingClientRect(), viewport = element.getBoundingClientRect()
    const top = viewport.top + element.clientTop, left = viewport.left + element.clientLeft
    const right = left + element.clientWidth
    const bottom = top + element.clientHeight - Math.max(0, Number(element.dataset.composerOcclusion ?? 0))
    return {
      away: element.scrollHeight - element.clientHeight - element.scrollTop > 1,
      oldNewReadable: !!rect && rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right,
      oldNewMounted: !!divider?.isConnected,
      oldNewMeasured: !!rect && rect.width > 0 && rect.height > 0,
      divider: rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null,
      readable: { top, bottom, left, right },
    }
  }, secondPeer)).toMatchObject({ away: true, oldNewMounted: true, oldNewMeasured: true, oldNewReadable: false })
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
    const original = state.event
    const event = new MessageEvent(original.type, { data: original.data, origin: original.origin, source: original.source,
      lastEventId: original.lastEventId, bubbles: original.bubbles, cancelable: original.cancelable, composed: original.composed })
    let delivered = 0
    const witness = (received: MessageEvent) => { if (received === event) delivered++ }
    window.addEventListener("message", witness)
    window.dispatchEvent(event)
    window.removeEventListener("message", witness)
    delete (window as typeof window & { __historyReading326?: unknown }).__historyReading326
    return { delivered, originalTrusted: state.originalTrusted, replayTrusted: event.isTrusted,
      originalSource: event.source === state.source, originalPayload: event.data === original.data,
      origin: event.origin, height: event.data.height, control: "fresh-event-from-captured-native-packet" }
  })
  expect(replay).toMatchObject({ delivered: 1, originalTrusted: true, replayTrusted: false, originalSource: true, originalPayload: true, origin: "null" })
  await expect.poll(async () => Math.abs(await bodyOffset(root, newBefore.firstVisibleId!) - newBefore.firstVisibleOffset!)).toBeLessThanOrEqual(1)
  await expect(newFrame).toHaveCSS("height", "160px")
  await expect(root.locator('[data-read-position-ready="true"]')).toBeVisible()
  expect(await readState()).toEqual(readBefore)
  await expect(page.getByTestId(tid.htmlPreviewFrame(html.attachmentId))).toHaveCount(0)
  await expect(page.getByTestId(tid.message(retiredPeer))).toHaveCount(0)
  await info.attach("retired-callback-receipts.json", { body: JSON.stringify({ replay, oldNewStatus: deliveredNew.status(),
    oldNewCutoff: retiredEntry.newBoundary.afterSeq, newBefore, newAfter: await waitForCommittedGeometry(root), readBefore }, null, 2), contentType: "application/json" })
})
