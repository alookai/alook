import type { Locator, Page, Request } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import {
  composerEditable,
  expectMessageVisible,
  gotoAfterUserWsAuth,
  ignoreNextDevToolsPointerCapture,
  installInputCapability,
} from "./_fixtures/actions"
import {
  memberInfo,
  seedChannel,
  seedDm,
  seedJoinServer,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"
import { tid } from "./_fixtures/testids"

function frameHasMessage(
  frame: CapturedCommunityFrame,
  channelId: string,
  messageId: string,
): boolean {
  return communityFrameEvents(frame).some((event) => (
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.id === messageId
  ))
}

type ScrollerGeometry = {
  top: number
  bottom: number
  height: number
  clientHeight: number
  scrollTop: number
}

async function settledScrollerGeometry(page: Page): Promise<ScrollerGeometry> {
  const scroller = page.getByTestId(tid.messageScroller)
  let previous = ""
  let settled: ScrollerGeometry | null = null
  await expect.poll(async () => {
    const current = await scroller.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        clientHeight: element.clientHeight,
        scrollTop: element.scrollTop,
      }
    })
    const signature = JSON.stringify(current)
    const stable = signature === previous
    previous = signature
    if (stable) settled = current
    return stable
  }, { timeout: 10_000 }).toBe(true)
  return settled!
}

function expectStableScroller(before: ScrollerGeometry, after: ScrollerGeometry): void {
  for (const key of ["top", "bottom", "height", "clientHeight", "scrollTop"] as const) {
    expect(Math.abs(after[key] - before[key]), `${key}: ${JSON.stringify({ before, after })}`)
      .toBeLessThanOrEqual(1)
  }
}

async function dispatchSwipe(
  page: Page,
  messageId: string,
  delta: { x: number; y: number },
): Promise<void> {
  const message = page.getByTestId(tid.message(messageId))
  const row = message.locator("div.group").first()
  await expect(row).toBeVisible()
  await row.evaluate((element) => {
    ;(element as HTMLElement).setPointerCapture = () => {}
  })
  const box = await row.boundingBox()
  if (!box) throw new Error(`message row ${messageId} has no box`)
  const start = { x: box.x + Math.min(100, box.width / 2), y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 17, isPrimary: true, button: 0 }
  await row.dispatchEvent("pointerdown", { ...pointer, clientX: start.x, clientY: start.y })
  await row.dispatchEvent("pointermove", {
    ...pointer,
    buttons: 1,
    clientX: start.x + delta.x,
    clientY: start.y + delta.y,
  })
  await row.dispatchEvent("pointerup", {
    ...pointer,
    clientX: start.x + delta.x,
    clientY: start.y + delta.y,
  })
}

async function dispatchSwipePathAndClick(
  page: Page,
  messageId: string,
  deltas: Array<{ x: number; y: number }>,
): Promise<void> {
  const message = page.getByTestId(tid.message(messageId))
  const row = message.locator("div.group").first()
  await expect(row).toBeVisible()
  await row.evaluate((element) => {
    ;(element as HTMLElement).setPointerCapture = () => {}
  })
  const box = await row.boundingBox()
  if (!box) throw new Error(`message row ${messageId} has no box`)
  const start = { x: box.x + Math.min(100, box.width / 2), y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 19, isPrimary: true, button: 0 }
  await row.dispatchEvent("pointerdown", { ...pointer, clientX: start.x, clientY: start.y })
  for (const delta of deltas) {
    await row.dispatchEvent("pointermove", {
      ...pointer,
      buttons: 1,
      clientX: start.x + delta.x,
      clientY: start.y + delta.y,
    })
  }
  const release = deltas.at(-1) ?? { x: 0, y: 0 }
  await row.dispatchEvent("pointerup", {
    ...pointer,
    clientX: start.x + release.x,
    clientY: start.y + release.y,
  })
  await row.dispatchEvent("click", {
    clientX: start.x + release.x,
    clientY: start.y + release.y,
  })
}

async function dispatchLongPress(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error("long-press target has no box")
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 23, isPrimary: true, button: 0 }
  await target.dispatchEvent("pointerdown", { ...pointer, clientX: point.x, clientY: point.y })
  await page.waitForTimeout(550)
  await target.dispatchEvent("pointerup", { ...pointer, clientX: point.x, clientY: point.y })
}

async function dispatchCancelledAvatarPress(
  target: Locator,
  mode: "move" | "cancel",
): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error("avatar target has no box")
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const pointer = { pointerType: "touch", pointerId: 29, isPrimary: true, button: 0 }
  await target.dispatchEvent("pointerdown", { ...pointer, clientX: point.x, clientY: point.y })
  if (mode === "move") {
    await target.dispatchEvent("pointermove", {
      ...pointer,
      buttons: 1,
      clientX: point.x + 20,
      clientY: point.y,
    })
  } else {
    await target.dispatchEvent("pointercancel", { ...pointer, clientX: point.x, clientY: point.y })
  }
  await target.dispatchEvent("click", { clientX: point.x, clientY: point.y })
}

async function latestSeq(page: Page, channelId: string): Promise<number> {
  const response = await page.request.get(`/api/community/channels/${channelId}/messages`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { latestSeq: number }).latestSeq
}

type ReadState = {
  lastReadMessageId: string | null
  lastReadSeq: number
}

async function settledReadState(page: Page, channelId: string): Promise<ReadState> {
  let previous: ReadState | null = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await page.request.get(`/api/community/channels/${channelId}/read-state`)
    expect(response.ok()).toBe(true)
    const current = await response.json() as ReadState
    if (
      current.lastReadMessageId
      && previous?.lastReadMessageId === current.lastReadMessageId
      && previous.lastReadSeq === current.lastReadSeq
    ) {
      return current
    }
    previous = current
    await page.waitForTimeout(100)
  }
  throw new Error(`read state did not settle for ${channelId}: ${JSON.stringify(previous)}`)
}

type SurfaceGetTracker = {
  abortedMessageGets: number
  abortedReadStateGets: number
  failures: string[]
  messageUrls: string[]
  readStateUrls: string[]
  inFlight: () => number
  stop: () => void
}

function trackSurfaceGets(page: Page, channelId: string): SurfaceGetTracker {
  const observedRequests = new Set<Request>()
  const kind = (request: Request): "messages" | "read-state" | null => {
    if (request.method() !== "GET") return null
    const pathname = new URL(request.url()).pathname
    if (pathname === `/api/community/channels/${channelId}/messages`) return "messages"
    if (pathname === `/api/community/channels/${channelId}/read-state`) return "read-state"
    return null
  }
  const onRequest = (request: Request) => {
    if (kind(request)) observedRequests.add(request)
  }
  const tracker: SurfaceGetTracker = {
    abortedMessageGets: 0,
    abortedReadStateGets: 0,
    failures: [],
    messageUrls: [],
    readStateUrls: [],
    inFlight: () => observedRequests.size,
    stop: () => {
      page.off("request", onRequest)
      page.off("requestfinished", onFinished)
      page.off("requestfailed", onFailed)
    },
  }
  const onFinished = (request: Request) => {
    if (!observedRequests.delete(request)) return
    const requestKind = kind(request)
    if (requestKind === "messages") tracker.messageUrls.push(request.url())
    if (requestKind === "read-state") tracker.readStateUrls.push(request.url())
  }
  const onFailed = (request: Request) => {
    if (!observedRequests.delete(request)) return
    const requestKind = kind(request)
    if (!requestKind) return
    const error = request.failure()?.errorText ?? "unknown request failure"
    if (!error.includes("ERR_ABORTED")) {
      tracker.failures.push(`${requestKind}: ${error}`)
      return
    }
    if (requestKind === "messages") tracker.abortedMessageGets += 1
    else tracker.abortedReadStateGets += 1
  }
  page.on("request", onRequest)
  page.on("requestfinished", onFinished)
  page.on("requestfailed", onFailed)
  return tracker
}

async function expectRetainedMountGets(
  page: Page,
  channelId: string,
  departureReadState: ReadState,
  tracker: SurfaceGetTracker,
) {
  await expect.poll(() => tracker.readStateUrls.length).toBe(1)
  await page.waitForTimeout(300)
  await expect.poll(() => tracker.inFlight()).toBe(0)
  const settledMessageCount = tracker.messageUrls.length
  await page.waitForTimeout(300)
  expect(tracker.inFlight()).toBe(0)
  expect(tracker.messageUrls).toHaveLength(settledMessageCount)

  expect(tracker.messageUrls.length).toBeGreaterThanOrEqual(1)
  expect(tracker.messageUrls.length).toBeLessThanOrEqual(2)
  const anchors = tracker.messageUrls.map((url) => new URL(url).searchParams.get("anchor"))
  expect(anchors[0]).toBe(departureReadState.lastReadMessageId)
  const counts = new Map<string, number>()
  for (const anchor of anchors) {
    const identity = anchor ?? "<newest>"
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  for (const count of counts.values()) expect(count).toBe(1)

  if (anchors.length === 2) {
    const newerAnchor = anchors[1]
    expect(newerAnchor).not.toBeNull()
    expect(newerAnchor).not.toBe(anchors[0])
    await expect(page.getByTestId(tid.message(newerAnchor!))).toBeVisible()
    const advancedReadState = await settledReadState(page, channelId)
    expect(advancedReadState.lastReadSeq).toBeGreaterThan(departureReadState.lastReadSeq)
    expect(newerAnchor).toBe(advancedReadState.lastReadMessageId)
  }

  expect(tracker.readStateUrls).toHaveLength(1)
  expect(tracker.abortedReadStateGets).toBeLessThanOrEqual(1)
  expect(tracker.abortedMessageGets).toBeLessThanOrEqual(1)
  expect(tracker.failures).toEqual([])
}

test("mobile reply, avatar mention, and typing rail keep exact backend and WS identity", async ({ asUser }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const serverName = `Mobile-interactions-${stamp}`
  const serverId = await seedServer("alice", serverName)
  const channelId = await seedChannel("alice", serverId, "mobile-interactions")
  await seedJoinServer("alice", "bob", serverId)
  const channelBobMessageId = await seedMessage("bob", channelId, `channel **target** ${stamp}`)
  const channelBobSecondMessageId = await seedMessage("bob", channelId, `channel _alternate_ ${stamp}`)
  await seedMessage("alice", channelId, Array.from(
    { length: 80 },
    (_, index) => `scroll restoration line ${index} ${stamp}`,
  ).join("\n\n"))
  const openerId = await seedMessage("alice", channelId, `thread opener ${stamp}`)
  const threadId = await seedThread("alice", openerId, `mobile-thread-${stamp}`)
  const threadBobMessageId = await seedMessage("bob", threadId, `thread **target** ${stamp}`)
  const dmId = await seedDm("alice", userId("bob"))
  for (let index = 0; index < 24; index += 1) {
    await seedMessage(index % 2 === 0 ? "alice" : "bob", dmId, `dm scroll row ${index} ${stamp}`)
  }
  await seedMessage("bob", dmId, Array.from(
    { length: 70 },
    (_, index) => `dm scroll line ${index} ${stamp}`,
  ).join("\n\n"))
  const bobInfo = await memberInfo("alice", serverId, userId("bob"))
  const aliceInfo = await memberInfo("alice", serverId, userId("alice"))

  const alice = await asUser("alice")
  const bob = await asUser("bob")
  await installInputCapability(alice.page, false)
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await bob.page.setViewportSize({ width: 390, height: 844 })
  const aliceProxy = await proxyCommunityWebSockets(alice.context)
  const bobProxy = await proxyCommunityWebSockets(bob.context)
  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${channelId}`)
  await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${channelId}`)
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  await expect(alice.page.getByTestId(tid.message(channelBobMessageId))).toBeVisible()
  const channelWsReadyId = await seedMessage("alice", channelId, `channel ws ready ${stamp}`)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, channelId, channelWsReadyId)
  )), { timeout: 20_000 }).toBe(true)

  const channelTarget = alice.page.getByTestId(tid.message(channelBobMessageId))
  const beforeTapSeq = await latestSeq(alice.page, channelId)
  const channelAvatar = channelTarget.getByRole("button", {
    name: `Open ${bobInfo.name} profile; long press to mention`,
  })
  await dispatchCancelledAvatarPress(channelAvatar, "move")
  await expect(alice.page.getByTestId(tid.profileCard)).toBeHidden()
  await dispatchCancelledAvatarPress(channelAvatar, "cancel")
  await expect(alice.page.getByTestId(tid.profileCard)).toBeHidden()
  const profileCard = alice.page.getByTestId(tid.profileCard)
  await expect(async () => {
    await channelAvatar.click({ timeout: 5_000 })
    await expect(profileCard).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 30_000 })
  const mobileProfileSheet = alice.page.locator('[data-slot="sheet-content"][data-side="bottom"]')
  await expect(mobileProfileSheet).toHaveCSS("border-top-width", "0px")
  await alice.page.keyboard.press("Escape")
  await expect(alice.page.getByTestId(tid.profileCard)).toBeHidden()
  const manualMentionEditable = composerEditable(alice.page)
  await manualMentionEditable.click()
  await manualMentionEditable.pressSequentially(`@${bobInfo.name.slice(0, 3)}`)
  await alice.page.getByTestId(tid.mentionOption(bobInfo.id)).click()
  await expect(manualMentionEditable).toContainText(`@${bobInfo.name}`)
  await manualMentionEditable.fill("")
  expect(await latestSeq(alice.page, channelId)).toBe(beforeTapSeq)

  const beforeRejectedSwipeSeq = await latestSeq(alice.page, channelId)
  const beforeRejectedSwipeFrames = bobProxy.frames.length
  await dispatchSwipePathAndClick(alice.page, channelBobMessageId, [
    { x: 76, y: 1 },
    { x: 0, y: 1 },
  ])
  await expect(alice.page.getByText("Replying to", { exact: false })).toHaveCount(0)
  await expect(alice.page.getByRole("menuitem")).toHaveCount(0)
  await dispatchSwipePathAndClick(alice.page, channelBobMessageId, [{ x: 32, y: 1 }])
  await expect(alice.page.getByText("Replying to", { exact: false })).toHaveCount(0)
  await expect(alice.page.getByRole("menuitem")).toHaveCount(0)
  await dispatchSwipe(alice.page, channelBobMessageId, { x: 6, y: 48 })
  await expect(alice.page.getByText("Replying to", { exact: false })).toHaveCount(0)
  expect(await latestSeq(alice.page, channelId)).toBe(beforeRejectedSwipeSeq)
  expect(bobProxy.frames).toHaveLength(beforeRejectedSwipeFrames)

  await dispatchSwipe(alice.page, channelBobMessageId, { x: 72, y: 2 })
  const replyPreview = alice.page.locator('[data-slot="composer-reply-preview"]')
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · channel target ${stamp}`)
  await alice.page.getByRole("button", { name: "Cancel reply" }).click()
  await expect(replyPreview).toHaveCount(0)
  expect(await latestSeq(alice.page, channelId)).toBe(beforeRejectedSwipeSeq)

  await dispatchSwipe(alice.page, channelBobSecondMessageId, { x: 72, y: 2 })
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · channel alternate ${stamp}`)
  const replyBody = `swipe reply ${stamp}`
  const replyResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  await composerEditable(alice.page).fill(replyBody)
  await alice.page.getByTestId(tid.composerSend).click()
  const replyResponse = await replyResponsePromise
  expect(replyResponse.status()).toBe(201)
  const replyPayload = await replyResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(replyPayload.message.replyToId).toBe(channelBobSecondMessageId)
  expect(replyPayload.message.content).toContain(replyBody)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, channelId, replyPayload.message.id)
    && communityFrameEvents(frame).some((event) => (
      (event.message as { replyTo?: { id: string } } | undefined)?.replyTo?.id === channelBobSecondMessageId
    ))
  )), { timeout: 20_000 }).toBe(true)
  await expectMessageVisible(bob.page, replyBody)

  await alice.page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
  await bob.page.goto(`/c/channels/${serverId}/${threadId}`, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  const threadTarget = alice.page.getByTestId(tid.message(threadBobMessageId))
  await expect(threadTarget).toBeVisible()
  const restingThreadGap = await alice.page.evaluate(({ targetId, composerId }) => {
    const target = document.querySelector(`[data-testid="${targetId}"]`)?.getBoundingClientRect()
    const composer = document.querySelector(`[data-testid="${composerId}"]`)?.getBoundingClientRect()
    return target && composer ? composer.top - target.bottom : null
  }, {
    targetId: tid.message(threadBobMessageId),
    composerId: tid.channelComposerShell,
  })
  expect(restingThreadGap).not.toBeNull()
  expect(restingThreadGap!).toBeGreaterThanOrEqual(55)
  expect(restingThreadGap!).toBeLessThanOrEqual(58)
  const threadWsReadyId = await seedMessage("alice", threadId, `thread ws ready ${stamp}`)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, threadId, threadWsReadyId)
  )), { timeout: 20_000 }).toBe(true)
  const editable = composerEditable(alice.page)
  await editable.fill("openerhere")
  await editable.click()
  for (let index = 0; index < 4; index += 1) await alice.page.keyboard.press("ArrowLeft")
  await dispatchLongPress(
    alice.page,
    alice.page.locator("[data-thread-opener]").getByRole("button", {
      name: `Open ${aliceInfo.name} profile; long press to mention`,
    }),
  )
  await expect(editable).toHaveText(`opener @${aliceInfo.name} here`)
  await expect(editable.locator(".mention-highlight")).toHaveText(`@${aliceInfo.name}`)

  await editable.fill("helloworld")
  await editable.click()
  for (let index = 0; index < 5; index += 1) await alice.page.keyboard.press("ArrowLeft")
  const avatar = threadTarget.getByRole("button", {
    name: `Open ${bobInfo.name} profile; long press to mention`,
  })
  await dispatchLongPress(alice.page, avatar)
  const mentionBody = `hello @${bobInfo.name}#${bobInfo.discriminator} world`
  await expect(editable).toHaveText(`hello @${bobInfo.name} world`)
  const insertedMention = editable.locator(".mention-highlight")
  await expect(insertedMention).toHaveText(`@${bobInfo.name}`)
  await expect(insertedMention).toHaveAttribute("data-id", bobInfo.id)
  await expect(insertedMention).toHaveAttribute(
    "data-label",
    `${bobInfo.name}#${bobInfo.discriminator}`,
  )

  const mentionResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${threadId}/messages`
  ))
  await alice.page.getByTestId(tid.composerSend).click()
  const mentionResponse = await mentionResponsePromise
  expect(mentionResponse.status()).toBe(201)
  const mentionPayload = await mentionResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(mentionPayload.message).toMatchObject({ content: mentionBody, replyToId: null })
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, threadId, mentionPayload.message.id)
    && communityFrameEvents(frame).some((event) => event.type === "community:mention.create")
  )), { timeout: 20_000 }).toBe(true)
  await expect(bob.page.getByTestId(tid.message(mentionPayload.message.id))).toBeVisible()

  await dispatchSwipe(alice.page, threadBobMessageId, { x: 72, y: 1 })
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · thread target ${stamp}`)
  const threadReplyBody = `thread swipe reply ${stamp}`
  const threadReplyResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${threadId}/messages`
  ))
  await composerEditable(alice.page).fill(threadReplyBody)
  await alice.page.getByTestId(tid.composerSend).click()
  const threadReplyResponse = await threadReplyResponsePromise
  expect(threadReplyResponse.status()).toBe(201)
  const threadReplyPayload = await threadReplyResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(threadReplyPayload.message.replyToId).toBe(threadBobMessageId)
  expect(threadReplyPayload.message.content).toContain(threadReplyBody)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, threadId, threadReplyPayload.message.id)
    && communityFrameEvents(frame).some((event) => (
      (event.message as { replyTo?: { id: string } } | undefined)?.replyTo?.id === threadBobMessageId
    ))
  )), { timeout: 20_000 }).toBe(true)

  await alice.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await bob.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  await expect(alice.page.getByTestId(tid.message(replyPayload.message.id))).toBeVisible()
  const typingWsReadyId = await seedMessage("bob", channelId, `typing ws ready ${stamp}`)
  await expect.poll(() => aliceProxy.frames.some((frame) => (
    frameHasMessage(frame, channelId, typingWsReadyId)
  )), { timeout: 20_000 }).toBe(true)
  await expect(alice.page.getByTestId(tid.message(typingWsReadyId))).toBeVisible()
  await alice.page.getByTestId(tid.messageScroller).evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll"))
  })
  const channelScrollerBeforeTyping = await settledScrollerGeometry(alice.page)
  const beforeTypingSeq = await latestSeq(alice.page, channelId)
  const bobEditable = composerEditable(bob.page)
  await expect(async () => {
    await bobEditable.fill("")
    await bobEditable.pressSequentially("typing geometry")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })
  await expect.poll(() => aliceProxy.frames.some((frame) => (
    communityFrameEvents(frame).some((event) => (
      event.type === "community:typing.start" && event.channelId === channelId
    ))
  )), { timeout: 20_000 }).toBe(true)
  const channelScrollerDuringTyping = await settledScrollerGeometry(alice.page)
  expectStableScroller(channelScrollerBeforeTyping, channelScrollerDuringTyping)

  const geometry = await alice.page.evaluate(({
    scrollerId,
    railId,
    composerId,
    indicatorId,
    replyMessageTestId,
  }) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    return {
      scroller: rect(document.querySelector(`[data-testid="${scrollerId}"]`)),
      rail: rect(document.querySelector(`[data-testid="${railId}"]`)),
      indicator: rect(document.querySelector(`[data-testid="${indicatorId}"]`)),
      composer: rect(document.querySelector(`[data-testid="${composerId}"]`)),
      finalMessage: rect(document.querySelector(`[data-testid="${replyMessageTestId}"]`)),
      contentPaddingBottom: Number.parseFloat(getComputedStyle(
        document.querySelector<HTMLElement>("[data-message-list-content]")!,
      ).paddingBottom),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  }, {
    scrollerId: tid.messageScroller,
    railId: tid.composerAccessoryRail,
    composerId: tid.channelComposerShell,
    indicatorId: tid.typingIndicator,
    replyMessageTestId: tid.message(typingWsReadyId),
  })
  expect(geometry.contentPaddingBottom).toBe(56)
  expect(geometry.scroller!.bottom).toBeLessThanOrEqual(geometry.composer!.top + 1)
  expect(geometry.rail!.bottom).toBeLessThanOrEqual(geometry.scroller!.bottom + 1)
  expect(geometry.indicator!.top).toBeGreaterThanOrEqual(geometry.rail!.top - 1)
  expect(geometry.indicator!.bottom).toBeLessThanOrEqual(geometry.rail!.bottom + 1)
  expect(geometry.indicator!.top - geometry.finalMessage!.bottom).toBeGreaterThanOrEqual(7)
  expect(geometry.finalMessage!.bottom).toBeLessThanOrEqual(geometry.scroller!.bottom + 1)
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(0)

  const scroller = alice.page.getByTestId(tid.messageScroller)
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event("scroll"))
  })
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toBeVisible()
  const scrollTypingGeometry = await alice.page.evaluate((ids) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    return {
      scroller: rect(document.querySelector(`[data-testid="${ids.scroller}"]`)),
      rail: rect(document.querySelector(`[data-testid="${ids.rail}"]`)),
      scroll: rect(document.querySelector(`[data-testid="${ids.scroll}"]`)),
      indicator: rect(document.querySelector(`[data-testid="${ids.indicator}"]`)),
    }
  }, {
    scroller: tid.messageScroller,
    rail: tid.composerAccessoryRail,
    scroll: tid.scrollToPresent,
    indicator: tid.typingIndicator,
  })
  expect(scrollTypingGeometry.rail!.bottom).toBeLessThanOrEqual(scrollTypingGeometry.scroller!.bottom + 1)
  expect(scrollTypingGeometry.scroll!.bottom).toBeLessThanOrEqual(scrollTypingGeometry.scroller!.bottom + 1)
  expect(scrollTypingGeometry.indicator!.top).toBeGreaterThanOrEqual(scrollTypingGeometry.rail!.top - 1)

  await alice.page.getByTestId(tid.scrollToPresent).click()
  await expect(alice.page.getByTestId(tid.scrollToPresent)).toHaveCount(0)
  await bobEditable.pressSequentially(" selection")
  await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  const finalChannelMessage = alice.page.getByTestId(tid.message(typingWsReadyId))
  await finalChannelMessage.getByText(`typing ws ready ${stamp}`, { exact: true }).click()
  await alice.page.getByRole("menuitem", { name: "Share as Image" }).click()
  await expect(alice.page.getByTestId(tid.messageSelectionToolbar)).toBeVisible()
  await expect(alice.page.locator("[data-selection-typing-fit]"))
    .toHaveAttribute("data-selection-typing-fit", /^(visible|hidden)$/)
  const selectionTypingGeometry = await alice.page.evaluate((ids) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    const typingSlot = document.querySelector<HTMLElement>("[data-selection-typing-fit]")
    const typingPill = typingSlot?.firstElementChild as HTMLElement | null
    const typingIndicator = document.querySelector<HTMLElement>(`[data-testid="${ids.indicator}"]`)
    const typingText = typingIndicator?.querySelector<HTMLElement>("span.min-w-0.truncate")
    return {
      finalMessage: rect(document.querySelector(`[data-testid="${ids.finalMessage}"]`)),
      scroller: rect(document.querySelector(`[data-testid="${ids.scroller}"]`)),
      rail: rect(document.querySelector(`[data-testid="${ids.rail}"]`)),
      selection: rect(document.querySelector(`[data-testid="${ids.selection}"]`)),
      indicator: rect(typingIndicator),
      composer: rect(document.querySelector(`[data-testid="${ids.composer}"]`)),
      typingFit: typingSlot && typingPill && typingIndicator && typingText
        ? {
          state: typingSlot.dataset.selectionTypingFit,
          slotWidth: typingSlot.getBoundingClientRect().width,
          pillWidth: typingPill.getBoundingClientRect().width,
          visibility: getComputedStyle(typingIndicator).visibility,
          textClientWidth: typingText.clientWidth,
          textScrollWidth: typingText.scrollWidth,
        }
        : null,
    }
  }, {
    finalMessage: tid.message(typingWsReadyId),
    scroller: tid.messageScroller,
    rail: tid.composerAccessoryRail,
    selection: tid.messageSelectionToolbar,
    indicator: tid.typingIndicator,
    composer: tid.channelComposerShell,
  })
  expect(selectionTypingGeometry.selection!.top - selectionTypingGeometry.finalMessage!.bottom)
    .toBeGreaterThanOrEqual(7)
  expect(selectionTypingGeometry.rail!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.scroller!.bottom + 1)
  expect(selectionTypingGeometry.selection!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.scroller!.bottom + 1)
  expect(selectionTypingGeometry.scroller!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.composer!.top + 1)
  expect(selectionTypingGeometry.finalMessage!.bottom).toBeLessThanOrEqual(selectionTypingGeometry.scroller!.bottom + 1)
  expect(selectionTypingGeometry.typingFit).not.toBeNull()
  const selectionTypingFits = selectionTypingGeometry.typingFit!.pillWidth
    <= selectionTypingGeometry.typingFit!.slotWidth
  expect(selectionTypingGeometry.typingFit!.state)
    .toBe(selectionTypingFits ? "visible" : "hidden")
  expect(selectionTypingGeometry.typingFit!.visibility)
    .toBe(selectionTypingFits ? "visible" : "hidden")
  if (selectionTypingFits) {
    expect(selectionTypingGeometry.typingFit!.textScrollWidth)
      .toBeLessThanOrEqual(selectionTypingGeometry.typingFit!.textClientWidth)
  }
  await alice.page.getByRole("button", { name: "Cancel message selection" }).click()

  await bobEditable.fill("")
  await expect(alice.page.getByTestId(tid.typingIndicator)).toBeHidden({ timeout: 15_000 })
  expect(await latestSeq(alice.page, channelId)).toBe(beforeTypingSeq)

  const dmSeqBeforeDirect = await latestSeq(alice.page, dmId)
  const directDmBody = `profile direct dm ${stamp}`
  await finalChannelMessage.getByRole("button", {
    name: `Open ${bobInfo.name} profile; long press to mention`,
  }).click()
  const directProfileCard = alice.page.getByTestId(tid.profileCard)
  await expect(directProfileCard).toBeVisible()
  await directProfileCard.getByPlaceholder(`Message @${bobInfo.name}`).fill(directDmBody)
  const directResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/messages`
  ))
  await directProfileCard.getByRole("button", { name: "Send message" }).click()
  const directResponse = await directResponsePromise
  expect(directResponse.status()).toBe(201)
  const directPayload = await directResponse.json() as { message: { id: string } }
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/me/${dmId}`)
  expect(await latestSeq(alice.page, dmId)).toBe(dmSeqBeforeDirect + 1)
  await expect.poll(() => bobProxy.frames.filter((frame) => (
    frameHasMessage(frame, dmId, directPayload.message.id)
  )).length).toBe(1)
  await bob.page.goto(`/c/me/${dmId}`, { waitUntil: "commit" })
  await ignoreNextDevToolsPointerCapture(alice.page)
  await ignoreNextDevToolsPointerCapture(bob.page)
  await expect(composerEditable(alice.page)).toBeVisible()
  await expect(composerEditable(bob.page)).toBeVisible()
  const dmWsReadyId = await seedMessage("bob", dmId, `dm **reply target** ${stamp}`)
  await expect.poll(() => aliceProxy.frames.some((frame) => (
    frameHasMessage(frame, dmId, dmWsReadyId)
  )), { timeout: 20_000 }).toBe(true)
  const dmReplyTarget = alice.page.getByTestId(tid.message(dmWsReadyId))
  const dmScrollToPresent = alice.page.getByTestId(tid.scrollToPresent)
  await expect(dmReplyTarget.or(dmScrollToPresent).first()).toBeVisible()
  if (await dmScrollToPresent.isVisible()) await dmScrollToPresent.click()
  await expect(dmReplyTarget).toBeVisible()
  await dispatchSwipe(alice.page, dmWsReadyId, { x: 72, y: 1 })
  await expect(replyPreview).toHaveText(`Replying to ${bobInfo.name} · dm reply target ${stamp}`)
  await expect(composerEditable(alice.page)).toBeFocused()
  const dmReplyBody = `dm swipe reply ${stamp}`
  const dmReplyResponsePromise = alice.page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${dmId}/messages`
  ))
  await composerEditable(alice.page).fill(dmReplyBody)
  await alice.page.getByTestId(tid.composerSend).click()
  const dmReplyResponse = await dmReplyResponsePromise
  expect(dmReplyResponse.status()).toBe(201)
  const dmReplyPayload = await dmReplyResponse.json() as {
    message: { id: string; content: string; replyToId: string | null }
  }
  expect(dmReplyPayload.message.replyToId).toBe(dmWsReadyId)
  await expect.poll(() => bobProxy.frames.some((frame) => (
    frameHasMessage(frame, dmId, dmReplyPayload.message.id)
    && communityFrameEvents(frame).some((event) => (
      (event.message as { replyTo?: { id: string } } | undefined)?.replyTo?.id === dmWsReadyId
    ))
  )), { timeout: 20_000 }).toBe(true)
  const beforeDmTypingSeq = await latestSeq(alice.page, dmId)
  const dmScrollerBeforeTyping = await settledScrollerGeometry(alice.page)
  const bobDmEditable = composerEditable(bob.page)
  await expect(async () => {
    await bobDmEditable.fill("")
    await bobDmEditable.pressSequentially("dm typing geometry")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 20_000 })
  const dmScrollerDuringTyping = await settledScrollerGeometry(alice.page)
  expectStableScroller(dmScrollerBeforeTyping, dmScrollerDuringTyping)
  const dmGeometry = await alice.page.evaluate(({ scrollerId, railId, indicatorId }) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect() ?? null
    return {
      scroller: rect(document.querySelector(`[data-testid="${scrollerId}"]`)),
      rail: rect(document.querySelector(`[data-testid="${railId}"]`)),
      indicator: rect(document.querySelector(`[data-testid="${indicatorId}"]`)),
      composer: rect(document.querySelector('[data-onboarding-target="dm-composer"]')),
      contentPaddingBottom: Number.parseFloat(getComputedStyle(
        document.querySelector<HTMLElement>("[data-message-list-content]")!,
      ).paddingBottom),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  }, {
    scrollerId: tid.messageScroller,
    railId: tid.composerAccessoryRail,
    indicatorId: tid.typingIndicator,
  })
  expect(dmGeometry.contentPaddingBottom).toBe(56)
  expect(dmGeometry.scroller!.bottom).toBeLessThanOrEqual(dmGeometry.composer!.top + 1)
  expect(dmGeometry.rail!.bottom).toBeLessThanOrEqual(dmGeometry.scroller!.bottom + 1)
  expect(dmGeometry.indicator!.bottom).toBeLessThanOrEqual(dmGeometry.rail!.bottom + 1)
  expect(dmGeometry.horizontalOverflow).toBeLessThanOrEqual(0)
  await bobDmEditable.fill("")
  await expect(alice.page.getByTestId(tid.typingIndicator)).toBeHidden({ timeout: 15_000 })
  const dmScrollerAfterTyping = await settledScrollerGeometry(alice.page)
  expectStableScroller(dmScrollerBeforeTyping, dmScrollerAfterTyping)
  expect(await latestSeq(alice.page, dmId)).toBe(beforeDmTypingSeq)

  const dmScroller = alice.page.getByTestId(tid.messageScroller)
  await expect.poll(() => dmScroller.evaluate((element) => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThan(1600)
  const departedDmScrollTop = await dmScroller.evaluate((element) => {
    element.scrollTop = 900
    element.dispatchEvent(new Event("scroll"))
    return element.scrollTop
  })
  expect(departedDmScrollTop).toBe(900)
  const dmReadState = await settledReadState(alice.page, dmId)
  const dmReturnGets = trackSurfaceGets(alice.page, dmId)
  await alice.page.getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe("/c/me")
  await alice.page.getByTestId(tid.dmRow(dmId)).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/me/${dmId}`)
  await expect(alice.page.getByTestId(tid.message(dmReadState.lastReadMessageId!))).toBeVisible()
  await expectRetainedMountGets(alice.page, dmId, dmReadState, dmReturnGets)
  expect(Math.abs(await dmScroller.evaluate((element) => element.scrollTop) - departedDmScrollTop))
    .toBeGreaterThan(50)
  dmReturnGets.stop()

  const departedDmReloadScrollTop = await dmScroller.evaluate((element) => {
    element.scrollTop = 700
    element.dispatchEvent(new Event("scroll"))
    return element.scrollTop
  })
  expect(departedDmReloadScrollTop).toBe(700)
  const dmReloadReadState = await settledReadState(alice.page, dmId)
  const dmReloadGets = trackSurfaceGets(alice.page, dmId)
  await alice.page.reload({ waitUntil: "commit" })
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/me/${dmId}`)
  await expect(alice.page.getByTestId(tid.message(dmReloadReadState.lastReadMessageId!))).toBeVisible()
  await expectRetainedMountGets(alice.page, dmId, dmReloadReadState, dmReloadGets)
  expect(Math.abs(
    await dmScroller.evaluate((element) => element.scrollTop) - departedDmReloadScrollTop,
  )).toBeGreaterThan(50)
  expect(await latestSeq(alice.page, dmId)).toBe(beforeDmTypingSeq)
  dmReloadGets.stop()

  await alice.page.emulateMedia({ reducedMotion: "reduce" })
  await alice.page.evaluate(() => {
    const original = Element.prototype.animate
    ;(window as typeof window & { __mobileSurfaceAnimations?: number }).__mobileSurfaceAnimations = 0
    Element.prototype.animate = function (...args) {
      if ((this as HTMLElement).dataset.communityMobileSurface) {
        const state = window as typeof window & { __mobileSurfaceAnimations?: number }
        state.__mobileSurfaceAnimations = (state.__mobileSurfaceAnimations ?? 0) + 1
      }
      return original.apply(this, args)
    }
  })
  await alice.page.getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe("/c/me")
  await alice.page.getByTestId(tid.serverIcon(serverId)).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await alice.page.getByTestId(tid.channelRow(channelId)).evaluate((element) => (
    (element as HTMLElement).click()
  ))
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
  await expect(composerEditable(alice.page)).toBeVisible()
  expect(await alice.page.evaluate(() => (
    window as typeof window & { __mobileSurfaceAnimations?: number }
  ).__mobileSurfaceAnimations)).toBe(0)

  const navigationDraft = `navigation draft ${stamp}`
  const navigationEditable = composerEditable(alice.page)
  await navigationEditable.fill(navigationDraft)
  const readingPosition = await scroller.evaluate((element) => {
    element.scrollTop = Math.min(2200, Math.max(0, element.scrollHeight - element.clientHeight))
    element.dispatchEvent(new Event("scroll"))
    return element.scrollTop
  })
  expect(readingPosition).toBe(2200)
  const channelReadState = await settledReadState(alice.page, channelId)
  const channelReturnGets = trackSurfaceGets(alice.page, channelId)
  await alice.page.getByRole("button", { name: `Go to server ${serverName}` }).click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}`)
  await alice.page.getByTestId(tid.channelRow(channelId)).evaluate((element) => (
    (element as HTMLElement).click()
  ))
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
  await expect(composerEditable(alice.page)).toContainText(navigationDraft)
  await expect(alice.page.getByTestId(tid.message(channelReadState.lastReadMessageId!))).toBeVisible()
  expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - readingPosition))
    .toBeGreaterThan(50)
  await expectRetainedMountGets(alice.page, channelId, channelReadState, channelReturnGets)
  channelReturnGets.stop()
})

test("mobile thread return uses server read state instead of tab-local pixel memory", async ({ asUser }) => {
  const stamp = Date.now()
  const serverName = `Mobile-scroll-${stamp}`
  const serverId = await seedServer("alice", serverName)
  const channelId = await seedChannel("alice", serverId, "mobile-scroll")
  for (let index = 0; index < 24; index += 1) {
    await seedMessage("alice", channelId, `scroll row ${index} ${stamp}`)
  }
  await seedMessage("alice", channelId, Array.from(
    { length: 95 },
    (_, index) => `scroll line ${index} ${stamp}`,
  ).join("\n\n"))
  const openerId = await seedMessage("alice", channelId, `scroll thread opener ${stamp}`)
  const threadId = await seedThread("alice", openerId, `scroll-thread-${stamp}`)
  for (let index = 0; index < 24; index += 1) {
    await seedMessage("alice", threadId, `thread scroll row ${index} ${stamp}`)
  }
  await seedMessage("alice", threadId, Array.from(
    { length: 70 },
    (_, index) => `thread scroll line ${index} ${stamp}`,
  ).join("\n\n"))
  const threadReplyId = await seedMessage("alice", threadId, `scroll thread reply ${stamp}`)

  const alice = await asUser("alice")
  await alice.page.setViewportSize({ width: 390, height: 844 })
  await alice.page.goto(`/c/channels/${serverId}/${channelId}`, { waitUntil: "commit" })
  await alice.page.waitForLoadState("domcontentloaded")
  await ignoreNextDevToolsPointerCapture(alice.page)
  const editable = composerEditable(alice.page)
  const scroller = alice.page.getByTestId(tid.messageScroller)
  await expect(editable).toBeVisible()
  await expect.poll(() => scroller.evaluate((element) => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThanOrEqual(2200)

  const draft = `stable navigation draft ${stamp}`
  await editable.fill(draft)
  const threadIndicator = alice.page.getByTestId(tid.threadIndicator(openerId))
  await expect(threadIndicator).toBeVisible()
  await threadIndicator.click()
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${threadId}`)
  await expect(alice.page.getByTestId(tid.message(threadReplyId))).toBeVisible()
  const threadScroller = alice.page.getByTestId(tid.messageScroller)
  await expect.poll(() => threadScroller.evaluate((element) => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThan(1600)
  const departedThreadScrollTop = await threadScroller.evaluate((element) => {
    element.scrollTop = 900
    element.dispatchEvent(new Event("scroll"))
    return element.scrollTop
  })
  expect(departedThreadScrollTop).toBe(900)
  const threadReadState = await settledReadState(alice.page, threadId)
  const threadReturnGets = trackSurfaceGets(alice.page, threadId)
  await alice.page.goBack({ waitUntil: "commit" })
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${channelId}`)
  await expect(composerEditable(alice.page)).toContainText(draft)
  await alice.page.goForward({ waitUntil: "commit" })
  await expect.poll(() => new URL(alice.page.url()).pathname).toBe(`/c/channels/${serverId}/${threadId}`)
  await expect(alice.page.getByTestId(tid.message(threadReadState.lastReadMessageId!))).toBeVisible()
  await expectRetainedMountGets(alice.page, threadId, threadReadState, threadReturnGets)
  expect(Math.abs(await threadScroller.evaluate((element) => element.scrollTop) - departedThreadScrollTop))
    .toBeGreaterThan(50)
  threadReturnGets.stop()
})
