import { CommunityConversationEntryReadSchema, CommunityMessagesReadSchema } from "@alook/shared"
import type { Response } from "@playwright/test"
import { communityFixtureFetch, confirmCommunityFixtureApiResponse } from "./_fixtures/business-contract"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets, type CapturedCommunityFrame } from "./_fixtures/community-ws-proxy"
import { holdNextRequest } from "./_fixtures/message-scroll-characterization"
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
