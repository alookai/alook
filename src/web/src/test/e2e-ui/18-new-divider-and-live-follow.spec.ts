import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import { CommunityConversationEntryReadSchema, CommunityMessagesReadSchema, type CommunityConversationEntryRead } from "@alook/shared"
import type { Request, Response, Route } from "@playwright/test"
import { communityFixtureFetch, confirmCommunityFixtureApiResponse } from "./_fixtures/business-contract"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets, type CapturedCommunityFrame } from "./_fixtures/community-ws-proxy"
import { expectPublicCommunityDocument } from "./_fixtures/community-ssr-frame"
import { cancelControlledBackwardGrowth, controlledBackwardGrowth } from "./_fixtures/backward-growth"
import {
  beginScrollTraceAnalysis,
  endScrollTraceAnalysis,
  installScrollTrace,
  installScrollTraceInCurrentDocument,
  markScrollTrace,
  startAnalyzedScrollTrace,
  startScrollTrace,
  type ScrollTraceResult,
} from "./_fixtures/scroll-trace"
import {
  VIEWPORT,
  advanceScrollTraceFrame,
  establishScrollDistancePrecondition,
  expectMessageCreateIdentity,
  finishAndAttach,
  holdNextRequest,
  identity,
  messageCreateCount,
  seedProfile,
  seedResizableHtmlPreview,
  seedScrollServer,
  setReadCheckpoint,
  tracedAsUser,
  waitForCommittedGeometry,
  waitForStableTail,
  type PostedMessageIdentity,
} from "./_fixtures/message-scroll-characterization"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

type BodySample = {
  scrollTop: number
  bodies: Array<{ id: string; top: number; bottom: number; height: number }>
}

test("manual New arrival consumes its capsule without reading the unseen batch tail", async ({ caseActors }) => {
  const actors = await caseActors(["alice", "bob"])
  const { asUser, sessionCookie } = actors
  const { seedServer, seedChannel, seedJoinServer, seedMessage } = actors.seed
  const serverId = await seedServer("alice", `Manual New ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "manual-new")
  await seedJoinServer("alice", "bob", serverId)
  const history: string[] = []
  for (let index = 0; index < 6; index++) history.push(await seedMessage("alice", channelId,
    `read history ${index}\n${Array.from({ length: 10 }, (_, line) => `history line ${line}`).join("\n\n")}`))
  const initialRead = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT", headers: { Cookie: sessionCookie("alice"), "Content-Type": "application/json", Origin: WEB_URL },
    body: JSON.stringify({ lastReadMessageId: history.at(-1) }),
  })
  expect(initialRead.status).toBe(200)
  const initialState = await initialRead.json() as { targetSeq: number }
  const unread: string[] = []
  for (let index = 0; index < 10; index++) unread.push(await seedMessage("bob", channelId,
    `unread batch ${index}\n${Array.from({ length: 8 }, (_, line) => `peer line ${line}`).join("\n\n")}`))
  const entryResponse = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/messages?entry=1&anchor=${history[0]}`, {
    headers: { Cookie: sessionCookie("alice"), Origin: WEB_URL },
  })
  expect(entryResponse.status).toBe(200)
  const entry = await entryResponse.json() as { page: { latestSeq: number }; newBoundary: { target: { id: string } | null } }
  expect(entry.newBoundary.target?.id).toBe(unread[0])
  expect(entry.page.latestSeq).toBeGreaterThan(initialState.targetSeq)
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}?msg=${history[0]}`)
  const scroller = page.getByTestId(tid.messageScroller)
  await expect(page.getByTestId(tid.message(history[0]!))).toBeInViewport()
  await expect(page.getByTestId(tid.message(unread.at(-1)!))).not.toBeInViewport()
  const readResponse = page.waitForResponse(response => response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/read`)
  void readResponse.catch(() => undefined)
  const firstPeerIsReadable = () => page.evaluate(({ rootId, id }) => {
    const root = document.querySelector<HTMLElement>(`[data-testid="${rootId}"]`)
    const body = root?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
    if (!root || !body) return false
    const viewport = root.getBoundingClientRect(), rect = body.getBoundingClientRect()
    return rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom - Number(root.dataset.composerOcclusion ?? 0)
  }, { rootId: tid.messageScroller, id: unread[0]! })
  await scroller.hover()
  for (let step = 0; step < 24 && !await firstPeerIsReadable(); step++) {
    const before = await scroller.evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, 160)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(before)
  }
  expect(await firstPeerIsReadable()).toBe(true)
  await expect(page.getByTestId(tid.newDivider)).toBeInViewport()
  const confirmed = await readResponse
  expect(confirmed.status()).toBe(200)
  expect(confirmed.request().postDataJSON().lastReadMessageId).not.toBe(unread.at(-1))
  const advanced = await confirmed.json() as { targetSeq: number }
  expect(advanced.targetSeq).toBeGreaterThan(initialState.targetSeq)
  expect(advanced.targetSeq).toBeLessThan(entry.page.latestSeq)
  const before = await scroller.evaluate(element => element.scrollTop)
  await page.mouse.wheel(0, 600)
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(before)
  await expect.poll(() => page.getByTestId(tid.newDivider).evaluate((element, rootId) => {
    const root = element.closest<HTMLElement>(`[data-testid="${rootId}"]`)!
    return element.getBoundingClientRect().bottom <= root.getBoundingClientRect().top
  }, tid.messageScroller)).toBe(true)
  await expect(page.getByTestId(tid.scrollToNew)).toHaveCount(0)
  await page.mouse.wheel(0, -600)
  await expect(page.getByTestId(tid.newDivider)).toBeInViewport()
  await expect(page.getByTestId(tid.scrollToNew)).toHaveCount(0)
})

test("NEW divider does not fight upward scrolling while a peer message arrives", async ({ caseActors }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice", "bob", "carol"])
  const { asUser, sessionCookie } = actors
  const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

  const serverId = await seedServer("alice", `NEW scroll ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "new-scroll")
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)

  let readThroughId = ""
  let beforeNewId = ""
  for (let index = 0; index < 24; index++) {
    readThroughId = await seedMessage(
      "alice",
      channelId,
      `read history ${index}\n${Array.from({ length: 10 + (index % 8) }, (_, line) => `line ${line} variable width ${"x".repeat((line % 4) * 18)}`).join("\n")}`,
    )
    if (index === 22) beforeNewId = readThroughId
  }

  const readResponse = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: {
      Cookie: sessionCookie("alice"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ lastReadMessageId: readThroughId }),
  })
  expect(readResponse.status).toBe(200)

  for (let index = 0; index < 48; index++) {
    await seedMessage(
      index % 2 === 0 ? "bob" : "carol",
      channelId,
      `unread history ${index}\n${Array.from({ length: 8 + (index % 10) }, (_, line) => `line ${line} variable height ${"y".repeat((line % 5) * 15)}`).join("\n")}`,
    )
  }

  const { page, context } = await asUser("alice")
  const liveBody = `live during upward scroll ${Date.now()}`
  const liveFrame = (frame: Parameters<typeof communityFrameEvents>[0]) => communityFrameEvents(frame).some(event =>
    event.type === "community:message.create" && event.channelId === channelId && event.message?.content === liveBody)
  const proxy = await proxyCommunityWebSockets(context, { decide: frame => liveFrame(frame) ? "hold" : "forward" })
  await page.addInitScript(() => {
    const frames: Array<{ type: string }> = []
    Object.defineProperty(window, "__e2eScrollReceivedFrames", { value: frames })
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args)
        if (new URL(this.url).pathname !== "/api/ws/user") return
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return
          try {
            const frame = JSON.parse(event.data) as { type?: unknown }
            if (typeof frame?.type === "string" && frame.type.startsWith("community:")) {
              frames.push(frame as { type: string })
            }
          } catch {}
        })
      }
    }
  })
  const firstOlder = await holdNextRequest(actors, page, `**/api/community/channels/${channelId}/messages**`,
    url => url.searchParams.has("cursor"))
  const preparation: { older: Response | null; issued: boolean; failure: { error: unknown } | null } = {
    older: null, issued: false, failure: null,
  }
  const observeOlderPage = (response: Response) => {
    const url = new URL(response.url())
    if (!preparation.older && response.request().method() === "GET"
      && url.pathname === `/api/community/channels/${channelId}/messages` && url.searchParams.has("cursor")) {
      preparation.older = response
    }
  }
  page.on("response", observeOlderPage)
  actors.onCleanup(async () => { page.off("response", observeOlderPage) })
  const entryResponse = confirmCommunityFixtureApiResponse(page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages`
      && url.searchParams.get("entry") === "1"
  }))
  void entryResponse.catch(() => undefined)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  await page.waitForURL(new RegExp(channelId), { timeout: 20_000, waitUntil: "commit" })
  const scroller = page.getByTestId(tid.messageScroller)
  await expect(scroller).toHaveCount(1)
  await expect.poll(() => scroller.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
  const jumpToNew = page.getByTestId(tid.scrollToNew)
  await expect(jumpToNew).toBeVisible({ timeout: 30_000 })
  const preparationDeadline = Date.now() + 10_000
  const remainingPreparation = () => Math.max(1, preparationDeadline - Date.now())
  const entryRead = await entryResponse
  expect(entryRead.status()).toBe(200)
  const entry = CommunityConversationEntryReadSchema.parse(await entryRead.json())
  expect(entry.page.olderCursor).toEqual(expect.any(String))
  try {
    await scroller.evaluate(element => element.scrollTo({ top: 0, behavior: "auto" }))
    await expect(page.getByTestId(tid.message(beforeNewId))).toBeInViewport({ timeout: remainingPreparation() })
    await expect(jumpToNew).toBeHidden({ timeout: remainingPreparation() })
    expect(entry.messages[0]?.id).toBe(beforeNewId)
    await expect.poll(() => firstOlder.hasMatched(), { timeout: remainingPreparation() }).toBe(true)
    expect((await firstOlder.matched).searchParams.get("cursor")).toBe(entry.page.olderCursor)
    firstOlder.release()
    await expect.poll(async () => {
      if (preparation.failure) throw preparation.failure.error
      if (!preparation.issued) {
        if (!preparation.older || Date.now() >= preparationDeadline) return Number.POSITIVE_INFINITY
        expect(preparation.older.status()).toBe(200)
        expect(new URL(preparation.older.url()).searchParams.get("cursor")).toBe(entry.page.olderCursor)
        const older = CommunityMessagesReadSchema.parse(await preparation.older.json())
        expect([...entry.messages, ...older.messages].some(message => message.id === beforeNewId)).toBe(true)
        const ownerReleased = await scroller.evaluate(root => root.dataset.paginationEnabled === "true")
        if (!ownerReleased || Date.now() >= preparationDeadline) return Number.POSITIVE_INFINITY
        preparation.issued = true
        try {
          await scroller.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: "auto" }))
        } catch (error) {
          preparation.failure = { error }
          throw error
        }
      }
      return scroller.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop)
    }, { timeout: remainingPreparation() }).toBeLessThanOrEqual(1)
  } finally {
    page.off("response", observeOlderPage)
    await firstOlder.dispose()
  }
  await expect(jumpToNew).toBeVisible()
  await jumpToNew.click()
  const divider = page.getByTestId(tid.newDivider)
  await expect(divider).toBeInViewport()
  await expect.poll(() => divider.evaluate((element, scrollerTestId) => {
    const root = element.closest(`[data-testid="${scrollerTestId}"]`)!
    return Math.abs(element.getBoundingClientRect().top - root.getBoundingClientRect().top)
  }, tid.messageScroller)).toBeLessThanOrEqual(1)
  await expect(jumpToNew).toBeHidden()

  const box = await scroller.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)

  const liveMessageId = await seedMessage("bob", channelId, liveBody)
  const receivedCount = async () => {
    const frames = await page.evaluate(() => (window as typeof window & {
      __e2eScrollReceivedFrames: CapturedCommunityFrame[]
    }).__e2eScrollReceivedFrames)
    return frames.flatMap(communityFrameEvents).filter(event => event.type === "community:message.create"
      && event.channelId === channelId && event.message?.id === liveMessageId).length
  }
  await expect.poll(() => proxy.heldCount()).toBe(1)
  expect(await receivedCount()).toBe(0)

  const recorder = await scroller.evaluateHandle((element) => {
    const root = element as HTMLElement
    const samples: BodySample[] = []
    const sample = () => {
      const viewport = root.getBoundingClientRect()
      const bodies = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
        .flatMap((body) => {
          const rect = body.getBoundingClientRect()
          const id = body.dataset.msgId
          return id && rect.height > 0 && rect.width > 0
            && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - Number(root.dataset.composerOcclusion ?? 0) - 1
            ? [{ id, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top, height: rect.height }]
            : []
        })
      samples.push({ scrollTop: root.scrollTop, bodies })
    }
    let frame: number
    const onFrame = () => {
      sample()
      frame = requestAnimationFrame(onFrame)
    }
    sample()
    root.addEventListener("scroll", sample, { passive: true })
    frame = requestAnimationFrame(onFrame)
    return {
      sample,
      finish: () => {
        cancelAnimationFrame(frame)
        root.removeEventListener("scroll", sample)
        sample()
        return samples
      },
    }
  })

  let bodySamples: BodySample[] = []
  try {
    for (let index = 0; index < 60; index++) {
      await page.mouse.wheel(0, -24)
      if (index === 10) expect(proxy.releaseHeld(liveFrame)).toBe(1)
      await page.waitForTimeout(24) // fixed wheel-event cadence under test
      await recorder.evaluate((recording) => recording.sample())
      if (index === 30) {
        expect(await receivedCount()).toBe(1)
      }
    }
    await page.waitForTimeout(250) // post-append scroll-correction exclusion window
  } finally {
    proxy.releaseHeld(liveFrame)
    bodySamples = await recorder.evaluate((recording) => recording.finish())
    await recorder.dispose()
  }

  expect(proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
    event.type === "community:message.create" && event.channelId === channelId && event.message?.id === liveMessageId,
  )).length).toBe(1)
  expect(bodySamples.length).toBeGreaterThan(1)
  let upwardProgress = 0
  for (let index = 1; index < bodySamples.length; index++) {
    const before = bodySamples[index - 1]!
    const after = bodySamples[index]!
    const common = before.bodies.flatMap((body) => {
      const next = after.bodies.find((candidate) => candidate.id === body.id)
      return next ? [{ id: body.id, delta: next.top - body.top }] : []
    })
    const diagnostic = JSON.stringify({ index, before, after, common })
    expect(common.length, diagnostic).toBeGreaterThan(0)
    for (const body of common) {
      expect(body.delta, diagnostic).toBeGreaterThanOrEqual(-4)
    }
    const deltas = common.map((body) => body.delta).sort((a, b) => a - b)
    upwardProgress += deltas[Math.floor(deltas.length / 2)]!
  }
  expect(upwardProgress).toBeGreaterThan(600)
})

test("New reading near the tail survives peer and remote-self messages until the current composer submits", async ({ caseActors }) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice", "bob", "carol"])
  const { asUser, sessionCookie } = actors
  const { seedChannel, seedJoinServer, seedMessage, seedServer } = actors.seed

  const serverId = await seedServer("alice", `NEW near tail ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "new-near-tail")
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)
  let readThroughId = ""
  for (let index = 0; index < 18; index++) readThroughId = await seedMessage("alice", channelId, `read ${index}`)
  const read = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: { Cookie: sessionCookie("alice"), "Content-Type": "application/json", Origin: WEB_URL },
    body: JSON.stringify({ lastReadMessageId: readThroughId }),
  })
  expect(read.status).toBe(200)
  let lastUnreadId = ""
  for (let index = 0; index < 5; index++) lastUnreadId = await seedMessage(index % 2 ? "bob" : "carol", channelId, `unread ${index}`)
  const { page, context } = await asUser("alice")
  await page.setViewportSize({ width: 1280, height: 360 })
  const proxy = await proxyCommunityWebSockets(context)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const scroller = page.getByTestId(tid.messageScroller)
  const divider = page.getByTestId(tid.newDivider)
  await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  await expect.poll(() => scroller.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
  await expect(page.getByTestId(tid.scrollToNew)).toBeVisible()
  await page.getByTestId(tid.scrollToNew).click()
  await expect(divider).toBeInViewport()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  await expect(divider).toBeInViewport()
  await expect(page.getByTestId(tid.scrollToNew)).toBeHidden()
  await expect.poll(() => scroller.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
  await expect.poll(() => page.getByTestId(tid.message(lastUnreadId)).evaluate((body, scrollerTestId) => {
    const root = body.closest<HTMLElement>(`[data-testid="${scrollerTestId}"]`)!
    return Math.abs(root.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom - 40)
  }, tid.messageScroller)).toBeLessThanOrEqual(1)
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 20
    element.dispatchEvent(new Event("scroll"))
  })
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(20)
  await expect(divider).toBeVisible()
  const before = await divider.evaluate(element => element.getBoundingClientRect().top)
  for (const author of ["bob", "alice"] as const) {
    const id = await seedMessage(author, channelId, `remote ${author} near New ${Date.now()}`)
    await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
      event.type === "community:message.create" && event.channelId === channelId && event.message?.id === id,
    )).length).toBe(1)
    await expect(divider).toBeVisible()
    await page.waitForTimeout(250)
    expect(Math.abs(await divider.evaluate(element => element.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(1)
  }
  const content = `local composer near New ${Date.now()}`
  await sendMessage(page, content)
  await expect(page.getByText(content, { exact: true })).toHaveCount(1)
  await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
    event.type === "community:message.create" && event.channelId === channelId && event.message?.content === content,
  )).length).toBe(1)
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
})

test("local history submission and passive remote append use distinct owners", async ({ caseActors }, testInfo) => {
  test.setTimeout(120_000)
  const actors = await caseActors(["alice", "bob", "carol"])
  const asUser = tracedAsUser(actors)
  const { userId, sessionCookie } = actors
  const serverId = await seedScrollServer(actors)
  const { seedChannel } = actors.seed
  const channelId = await seedChannel("alice", serverId, `scroll-passive-threshold-${Date.now()}`)
  await seedProfile(actors, channelId, 130, false, "rotate", 18)
  const alice = await asUser("alice")
  let releaseLateOlder!: () => void
  const olderGate = new Promise<void>(resolve => { releaseLateOlder = resolve })
  let heldLateOlder = false
  const olderHandler = async (route: Route) => {
    const url = new URL(route.request().url())
    if (!heldLateOlder && url.searchParams.has("cursor") && !url.searchParams.has("direction")) {
      heldLateOlder = true
      await olderGate
    }
    await route.continue()
  }
  await alice.page.route(`**/api/community/channels/${channelId}/messages**`, olderHandler)
  actors.onCleanup(async () => { releaseLateOlder(); if (!alice.page.isClosed()) await alice.page.unroute(`**/api/community/channels/${channelId}/messages**`, olderHandler) })
  await alice.page.setViewportSize(VIEWPORT)
  await installScrollTrace(alice.page)
  const proxy = await proxyCommunityWebSockets(alice.context)
  let composerPosts = 0
  alice.page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`) composerPosts += 1
  })
  const documentResponse = alice.page.waitForResponse(response => response.request().isNavigationRequest()
    && new URL(response.url()).pathname === `/c/channels/${serverId}/${channelId}`)
  const anchorResponse = alice.page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages` && url.searchParams.get("entry") === "1"
  })
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  const scroller = alice.page.getByTestId(tid.messageScroller)
  await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  const anchored = await anchorResponse
  expect(anchored.status()).toBe(200)
  expectPublicCommunityDocument(await (await documentResponse).text())
  const anchorPage = await anchored.json() as CommunityConversationEntryRead
  expect(anchorPage.selection.reason).toBe("tail")
  expect(anchorPage.page.hasMoreNewer).toBe(false)
  await expect.poll(() => scroller.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
  const newTarget = anchorPage.newBoundary.target
  expect(newTarget).not.toBeNull()
  const historyResponse = alice.page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages`
      && url.searchParams.get("anchor") === newTarget!.id && !url.searchParams.has("entry")
  })
  const newAction = alice.page.getByTestId(tid.scrollToNew)
  await expect(newAction).toBeVisible()
  const newTargetRequest = await holdNextRequest(actors, alice.page, `**/api/community/channels/${channelId}/messages**`,
    url => url.searchParams.get("anchor") === newTarget!.id && !url.searchParams.has("entry"))
  let newTargetGets = 0
  const countNewTargetRequest = (request: Request) => {
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages`
      && url.searchParams.get("anchor") === newTarget!.id && !url.searchParams.has("entry")) newTargetGets += 1
  }
  alice.page.on("request", countNewTargetRequest)
  actors.onCleanup(async () => { alice.page.off("request", countNewTargetRequest) })
  await newAction.click()
  await newTargetRequest.matched
  expect(heldLateOlder).toBe(true)
  await alice.page.waitForTimeout(75)
  releaseLateOlder()
  await expect(newAction).toBeVisible()
  await expect(newAction).toHaveText("New")
  await expect(newAction).toHaveAccessibleName("Jump to New")
  await expect(newAction).toHaveAttribute("aria-busy", "true")
  await expect(newAction).toBeDisabled()
  await expect(newAction.locator("svg")).toHaveClass(/animate-spin/)
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await expect(alice.page.getByText("Loading messages…", { exact: true })).toHaveCount(0)
  await newAction.evaluate(button => (button as HTMLButtonElement).click())
  await alice.page.waitForTimeout(250)
  expect(newTargetGets).toBe(1)
  newTargetRequest.release()
  const history = await historyResponse
  expect(history.ok()).toBe(true)
  const historyPage = CommunityMessagesReadSchema.parse(await history.json())
  expect(historyPage.page.hasMoreNewer).toBe(true)
  expect(historyPage.messages.some(message => message.id === newTarget!.id)).toBe(true)
  const newDivider = alice.page.getByTestId(tid.newDivider)
  await expect.poll(() => newDivider.evaluate((element, scrollerTestId) => Math.abs(element.getBoundingClientRect().top
    - element.closest(`[data-testid="${scrollerTestId}"]`)!.getBoundingClientRect().top), tid.messageScroller)).toBeLessThanOrEqual(1)
  await expect(newAction).toBeHidden()
  expect(newTargetGets).toBe(1)
  await newTargetRequest.dispose()
  await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  let newestGets = 0
  const isNewestMessagesUrl = (url: URL) =>
    !url.searchParams.has("entry") && !url.searchParams.has("cursor") && !url.searchParams.has("since") && !url.searchParams.has("anchor")
  alice.page.on("request", request => {
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname === `/api/community/channels/${channelId}/messages` && isNewestMessagesUrl(url)) newestGets += 1
  })
  const newestResponse = alice.page.waitForResponse(response => response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
    && isNewestMessagesUrl(new URL(response.url())))
  void newestResponse.catch(() => undefined)
  const newest = await holdNextRequest(actors, alice.page, `**/api/community/channels/${channelId}/messages**`, isNewestMessagesUrl)
  await startScrollTrace(alice.page, {
    scenario: "local-history-submission",
    identity: identity(channelId),
  })
  await beginScrollTraceAnalysis(alice.page, "local-history-submission", {
    dataTransitionSource: "optimistic-send",
    commandDirection: "forward",
  })
  let localTracePending = true
  const attachLocalTrace = async () => {
    if (!localTracePending) return
    localTracePending = false
    await endScrollTraceAnalysis(alice.page, "local-history-submission")
    await finishAndAttach(alice.page, testInfo)
  }
  actors.onCleanup(attachLocalTrace)
  const localContent = `local history submission ${Date.now()}`
  const localPost = alice.page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
    && response.request().postDataJSON().content === localContent)
  try {
    await sendMessage(alice.page, localContent)
    await newest.matched
    newest.release()
    const latest = await newestResponse
    expect(latest.status()).toBe(200)
    expect(CommunityMessagesReadSchema.parse(await latest.json()).page.hasMoreNewer).toBe(false)
    const response = await localPost
    expect(response.status()).toBe(201)
    const nonce = response.request().postDataJSON().nonce as string
    expect(nonce.length).toBeGreaterThan(0)
    const result = await response.json() as { message: PostedMessageIdentity }
    expect(result.message).toMatchObject({ authorId: userId("alice"), channelId, content: localContent })
    await expect.poll(() => messageCreateCount(proxy.frames, channelId, localContent)).toBe(1)
    await expectMessageCreateIdentity(proxy.frames, channelId, result.message, nonce)
    await expect(alice.page.getByTestId(tid.message(result.message.id))).toBeVisible()
    await expect(alice.page.getByText(localContent, { exact: true })).toHaveCount(1)
    await waitForStableTail(scroller, "local-history-submission-ack")
    expect(newestGets).toBe(1)
    expect(composerPosts).toBe(1)
  } finally {
    await newest.dispose()
  }
  await attachLocalTrace()
  const finishPassiveTrace = await startAnalyzedScrollTrace(alice.page, {
    scenario: "passive-append-position-admission",
    identity: identity(channelId),
    dataTransitionSource: "overlay-ws",
  })
  const attachPassiveTrace = async () => {
    await finishPassiveTrace(testInfo)
  }
  actors.onCleanup(attachPassiveTrace)
  for (const author of ["bob", "alice"] as const) {
    for (const distance of [0, 1, 2, 20, CONVERSATION_TAIL_SPACE_PX, CONVERSATION_TAIL_SPACE_PX + 1, 100, 101]) {
      await markScrollTrace(alice.page, `${author}-${distance}-admission-start`)
      await establishScrollDistancePrecondition(scroller, `${author}-${distance}`, distance, 0.01)
      const before = await waitForCommittedGeometry(scroller)
      expect(before.firstVisibleId).not.toBeNull()
      expect(Math.abs(before.distanceToEnd - distance)).toBeLessThanOrEqual(0.01)
      await markScrollTrace(alice.page, `${author}-${distance}-precondition`, { detail: before })
      const nonce = `scroll186_${author}_${distance}_${Date.now()}`
      const content = `passive ${author} at ${distance} ${nonce}`
      const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Cookie: sessionCookie(author), "Content-Type": "application/json", Origin: WEB_URL },
        body: JSON.stringify({ content, nonce }),
      })
      expect(response.status).toBe(201)
      const result = await response.json() as { message: PostedMessageIdentity }
      expect(result.message).toMatchObject({ authorId: userId(author), channelId, content })
      await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
        event.type === "community:message.create" && event.channelId === channelId && event.message?.id === result.message.id,
      )).length).toBe(1)
      await expectMessageCreateIdentity(proxy.frames, channelId, result.message, nonce)
      if (distance <= CONVERSATION_TAIL_SPACE_PX) {
        await expect(alice.page.getByTestId(tid.message(result.message.id))).toBeVisible()
        await waitForStableTail(scroller, `${author}-${distance}-received`)
      } else {
        await alice.page.waitForTimeout(250)
        const bodyOffset = await scroller.locator(`[data-msg-id="${before.firstVisibleId}"]`).evaluate((element, scrollerTestId) => {
          const root = element.closest<HTMLElement>(`[data-testid="${scrollerTestId}"]`)!
          return element.getBoundingClientRect().top - root.getBoundingClientRect().top
        }, tid.messageScroller)
        expect(Math.abs(bodyOffset - before.firstVisibleOffset!)).toBeLessThanOrEqual(1)
        const after = await waitForCommittedGeometry(scroller)
        expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
        expect(after.distanceToEnd).toBeGreaterThan(distance)
      }
      expect(composerPosts).toBe(1)
    }
  }
  expect(newestGets).toBe(1)
  await attachPassiveTrace()
})

test("peer receives follow after clamped bottom input without movement", async ({ caseActors }) => {
  test.setTimeout(90_000)
  const actors = await caseActors(["alice", "bob", "carol"])
  const asUser = tracedAsUser(actors)
  const serverId = await seedScrollServer(actors)
  const { seedChannel, seedMessage } = actors.seed

  const channelId = await seedChannel("alice", serverId, `scroll-bottom-input-${Date.now()}`)
  await seedProfile(actors, channelId, 18)
  let tailId = await seedMessage("bob", channelId, "bottom input start\n[keyboard target](https://example.com)")
  await setReadCheckpoint(actors, channelId, tailId)
  const alice = await asUser("alice")
  await alice.page.setViewportSize(VIEWPORT)
  const proxy = await proxyCommunityWebSockets(alice.context)
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  const scroller = alice.page.getByTestId(tid.messageScroller)
  await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  for (const input of ["click", "wheel", "ArrowDown", "PageDown", "End", "Space"]) {
    await waitForStableTail(scroller, `bottom-${input}`)
    if (input !== "click" && input !== "wheel") {
      await alice.page.getByTestId(tid.message(tailId)).getByRole("link", { name: "Link: https://example.com/" }).focus()
    }
    const before = await waitForCommittedGeometry(scroller)
    expect(before.distanceToEnd).toBeLessThanOrEqual(1)
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await alice.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 16)
    if (input === "click") await alice.page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 16)
    else if (input === "wheel") await alice.page.mouse.wheel(0, 120)
    else await alice.page.keyboard.press(input)
    const after = await waitForCommittedGeometry(scroller)
    expect(after.distanceToEnd).toBeLessThanOrEqual(1)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
    const body = `bottom input ${input} ${Date.now()}\n[keyboard target](https://example.com)`
    tailId = await seedMessage("carol", channelId, body)
    await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
      event.type === "community:message.create" && event.channelId === channelId && event.message?.id === tailId,
    )).length).toBe(1)
    await expect(alice.page.getByTestId(tid.message(tailId))).toBeVisible()
    await waitForStableTail(scroller, `received-${input}`)
    await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  }
})

test("measured reaction updates above the fold preserve reading during repeated controlled backward input", async ({ caseActors }, testInfo) => {
  test.setTimeout(90_000)
  const actors = await caseActors(["alice"])
  const serverId = await actors.seed.seedServer("alice", `Measured reactions ${Date.now()}`)
  const channelId = await actors.seed.seedChannel("alice", serverId, "measured-reactions")
  const { page } = await tracedAsUser(actors)("alice")
  await page.setViewportSize({ width: 390, height: 800 })
  await seedProfile(actors, channelId, 4, false, "alice")
  const messageId = await actors.seed.seedMessage("alice", channelId, "A measured historical message")
  await seedProfile(actors, channelId, 24, false, "alice")
  const reactionFrame = (frame: Parameters<typeof communityFrameEvents>[0]) => communityFrameEvents(frame).some(event =>
    event.type === "community:reaction.add" && event.messageId === messageId)
  const proxy = await proxyCommunityWebSockets(page.context(), { decide: frame => reactionFrame(frame) ? "hold" : "forward" })
  const batches = [["👍", "❤️", "😂", "🎉", "👀"], ["🚀", "✅", "🔥", "💯", "🤔"]]
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const scroller = page.getByTestId(tid.messageScroller)
  await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  await waitForCommittedGeometry(scroller)
  await scroller.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")) })
  await expect(page.getByTestId(tid.message(messageId))).toHaveCount(1)
  await waitForCommittedGeometry(scroller)
  await scroller.evaluate((element, id) => {
    const row = element.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
    if (!row) throw new Error("The measured reaction message is required")
    element.scrollTop += row.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 256
    element.dispatchEvent(new Event("scroll"))
  }, messageId)
  await waitForCommittedGeometry(scroller)
  await installScrollTraceInCurrentDocument(page)
  await startScrollTrace(page, { scenario: "measured-reactions-backward-growth", identity: identity(channelId, { width: 390, height: 800 }) })
  await beginScrollTraceAnalysis(page, "above-fold-repeated-growth", { commandDirection: "backward" })
  const samples: Array<{ at: number; rowHeight: number; lastInputAt: number }> = []
  let trace: ScrollTraceResult | undefined
  try {
    for (const [round, emojis] of batches.entries()) {
      for (const emoji of emojis) await actors.seed.seedReaction("alice", messageId, emoji)
      await expect.poll(() => proxy.frames.flatMap(communityFrameEvents).filter(event =>
        event.type === "community:reaction.add" && event.messageId === messageId).length).toBe((round + 1) * 5)
      await markScrollTrace(page, `stimulus:reactions-${round}`, { detail: { input: "controlled-wheel-and-scroll", emojis, messageId } })
      const before = await scroller.evaluate(controlledBackwardGrowth, { start: messageId })
      expect(before.growingBottom).toBeLessThan(0)
      expect(proxy.releaseHeld(reactionFrame)).toBeGreaterThan(0)
      await expect.poll(() => page.getByTestId(tid.message(messageId)).evaluate(element => element.closest("[data-index]")!.getBoundingClientRect().height))
        .toBeGreaterThan(before.rowHeight)
      const input = await scroller.evaluate(controlledBackwardGrowth, { finish: true as const })
      expect(input.measurement, "Native row growth must be measured during controlled input").not.toBeNull()
      expect(input.measurement!.direction).toBe("backward")
      expect(input.measurement!.at - input.measurement!.lastInputAt).toBeLessThan(150)
      expect(input.inputDelta).toBeLessThan(0)
      samples.push({ at: before.at, rowHeight: before.rowHeight, lastInputAt: input.measurement!.lastInputAt })
      await advanceScrollTraceFrame(scroller)
      const after = await page.getByTestId(tid.message(before.id)).evaluate(element => {
        const root = element.closest<HTMLElement>("[data-message-scroller-boundary]")?.querySelector<HTMLElement>("[data-pagination-enabled]")
        if (!root) throw new Error("The reading scroller is required")
        return element.getBoundingClientRect().top - root.getBoundingClientRect().top
      })
      await markScrollTrace(page, `observed:reactions-${round}`, { detail: { before, after, input } })
      expect.soft(Math.abs(after - before.top + input.inputDelta), `Reading drift after reaction batch ${round}`).toBeLessThanOrEqual(1)
    }
  } finally {
    await scroller.evaluate(cancelControlledBackwardGrowth)
    await endScrollTraceAnalysis(page, "above-fold-repeated-growth")
    trace = await finishAndAttach(page, testInfo)
  }
  if (!trace) throw new Error("The reaction-growth trace is required")
  for (const sample of samples) {
    const measurement = trace.measurements.find(row => row.id === messageId && row.timestamp >= sample.at && row.height > sample.rowHeight + 1)
    expect(measurement, "A real growing-row measurement must precede the 150ms backward reset").toBeDefined()
    expect(measurement!.timestamp - sample.lastInputAt).toBeLessThan(150)
  }
})

test("controlled upward release before native movement prevents HTML tail resize follow", async ({ caseActors }, testInfo) => {
  test.setTimeout(90_000)
  const actors = await caseActors(["alice"])
  const serverId = await actors.seed.seedServer("alice", `Released HTML ${Date.now()}`)
  const channelId = await actors.seed.seedChannel("alice", serverId, "released-html")
  const { page } = await tracedAsUser(actors)("alice", { baseURL: WEB_URL })
  await page.setViewportSize(VIEWPORT)
  await seedProfile(actors, channelId, 24, false, "alice")
  const { attachmentId } = await seedResizableHtmlPreview(page, channelId)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const scroller = page.getByTestId(tid.messageScroller)
  const iframe = page.getByTestId(tid.htmlPreviewFrame(attachmentId))
  await expect(page.getByTestId(tid.htmlPreview(attachmentId))).toHaveAttribute("data-html-preview-status", "ready")
  await expect(iframe).toHaveCSS("height", "160px")
  await installScrollTraceInCurrentDocument(page)
  await startScrollTrace(page, { scenario: "released-html-tail-growth", identity: identity(channelId) })
  try {
    for (const distance of [0, 1, 2]) {
      await iframe.evaluate(element => (element as HTMLIFrameElement).contentWindow?.postMessage({ type: "scroll-fixture-height", height: 160 }, "*"))
      await expect(iframe).toHaveCSS("height", "160px")
      await establishScrollDistancePrecondition(scroller, `released-tail-${distance}`, distance, 0.05)
      await beginScrollTraceAnalysis(page, `released-tail-${distance}`)
      try {
        const before = await scroller.evaluate((element, frameId) => {
          const frame = element.querySelector<HTMLIFrameElement>(`[data-testid="${frameId}"]`)
          if (!frame?.contentWindow) throw new Error("A real mounted HTML preview is required")
          const wheel = new WheelEvent("wheel", { deltaY: -20, bubbles: true })
          element.dispatchEvent(wheel)
          const result = { top: element.scrollTop, distance: element.scrollHeight - element.clientHeight - element.scrollTop,
            trusted: wheel.isTrusted }
          frame.contentWindow.postMessage({ type: "scroll-fixture-height", height: 260 }, "*")
          return result
        }, tid.htmlPreviewFrame(attachmentId))
        await markScrollTrace(page, `stimulus:released-tail-${distance}`, { detail: before })
        await expect(iframe).toHaveCSS("height", "260px")
        await advanceScrollTraceFrame(scroller)
        const after = await scroller.evaluate(element => element.scrollTop)
        await markScrollTrace(page, `observed:released-tail-${distance}`, { detail: { before, after } })
        expect.soft(Math.abs(after - before.top), `Released reader movement at ${distance}px`).toBeLessThanOrEqual(1)
      } finally {
        await endScrollTraceAnalysis(page, `released-tail-${distance}`)
      }
    }
  } finally {
    await finishAndAttach(page, testInfo)
  }
})
