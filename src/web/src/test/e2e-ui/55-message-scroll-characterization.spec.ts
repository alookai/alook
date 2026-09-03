import type { Locator, Page, Route, TestInfo } from "@playwright/test"
import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
} from "./_fixtures/community-ws-proxy"
import { seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import {
  abortScrollTrace,
  attachScrollTrace,
  beginScrollTraceAnalysis,
  createScrollTraceIdentity,
  endScrollTraceAnalysis,
  finishScrollTrace,
  installScrollTrace,
  installScrollTraceInCurrentDocument,
  markScrollTrace,
  scrollTraceSelfTest,
  startScrollTrace,
  summarizeScrollTrace,
  type ScrollTraceResult,
} from "./_fixtures/scroll-trace"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

const VIEWPORT = { width: 1280, height: 800 }

type HeldRequest = {
  matched: Promise<URL>
  release: () => void
  dispose: () => Promise<void>
}

async function holdNextRequest(
  page: Page,
  pattern: string,
  predicate: (url: URL) => boolean,
): Promise<HeldRequest> {
  let resolveMatched!: (url: URL) => void
  let release!: () => void
  let consumed = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const matched = new Promise<URL>((resolveValue, reject) => {
    resolveMatched = (url) => {
      if (timeout) clearTimeout(timeout)
      resolveValue(url)
    }
    timeout = setTimeout(() => reject(new Error(`held request did not match ${pattern}`)), 20_000)
  })
  const gate = new Promise<void>((resolveValue) => { release = resolveValue })
  const handler = async (route: Route) => {
    const url = new URL(route.request().url())
    if (!consumed && predicate(url)) {
      consumed = true
      resolveMatched(url)
      await gate
    }
    await route.continue()
  }
  await page.route(pattern, handler)
  return {
    matched,
    release,
    dispose: async () => {
      if (timeout) clearTimeout(timeout)
      release()
      await page.unroute(pattern, handler)
    },
  }
}

function profileContent(index: number): string {
  const shape = index % 8
  if (shape === 0) return `short row ${index}`
  if (shape === 1) return Array.from({ length: 4 }, (_, line) => `row ${index} line ${line}`).join("\n")
  if (shape === 2) return Array.from({ length: 12 }, (_, line) => `row ${index} variable line ${line} ${"x".repeat(line * 2)}`).join("\n")
  if (shape === 3) return `long-token-${"characterization".repeat(18)}-${index}`
  if (shape === 4) return `- list ${index}\n- second item ${"wide ".repeat(12)}\n- third item`
  if (shape === 5) return `> quote ${index}\n> ${"quoted content ".repeat(15)}`
  if (shape === 6) return `\`\`\`ts\nconst row${index} = ${JSON.stringify("code ".repeat(18))}\n\`\`\``
  return `**bold ${index}** ${"wrapping markdown ".repeat(22)}`
}

function estimatePlainMessage(content: string): number {
  return 24 + Math.min(Math.max(1, Math.ceil(content.length / 55)) * 20, 400)
}

async function seedProfile(
  channelId: string,
  count: number,
  imageAtTail = false,
  authors: "rotate" | "alice" = "rotate",
  checkpointAt?: number,
): Promise<{ ids: string[]; estimates: Record<string, number> }> {
  const ids: string[] = []
  const estimates: Record<string, number> = {}
  for (let index = 0; index < count; index += 1) {
    const content = imageAtTail && index === count - 1
      ? `async image row ${index}\n![async fixture](/icon-512.png?scroll-trace=1)`
      : profileContent(index)
    const afterCheckpoint = checkpointAt !== undefined && index > checkpointAt
    const author = afterCheckpoint
      ? index % 2 === 0 ? "bob" : "carol"
      : authors === "alice"
      ? "alice"
      : index % 3 === 0 ? "alice" : index % 3 === 1 ? "bob" : "carol"
    const id = await seedMessage(author, channelId, content)
    ids.push(id)
    estimates[id] = estimatePlainMessage(content)
    if (index === checkpointAt) await setReadCheckpoint(channelId, id)
  }
  return { ids, estimates }
}

async function setReadCheckpoint(channelId: string, messageId: string): Promise<void> {
  const response = await fetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
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

function identity(channelId: string) {
  return createScrollTraceIdentity({
    account: "alice",
    channel: channelId,
    viewport: { ...VIEWPORT, dpr: 1 },
  })
}

async function finishAndAttach(page: Page, testInfo: TestInfo): Promise<ScrollTraceResult> {
  await markScrollTrace(page, "final-stimulus")
  const result = await finishScrollTrace(page)
  await attachScrollTrace(testInfo, result)
  return result
}

async function establishScrollDistancePrecondition(
  scroller: Locator,
  label: string,
  targetDistanceToEnd: number,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number; distanceToEnd: number }> {
  const readGeometry = () => scroller.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceToEnd: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
  })).then((geometry) => ({
    ...geometry,
    targetDistanceToEnd,
    atTarget: Math.abs(geometry.distanceToEnd - targetDistanceToEnd) <= 1,
  }))
  const driveToTarget = async () => {
    const geometry = await readGeometry()
    if (geometry.atTarget) return geometry
    await scroller.evaluate((element, targetDistance) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - targetDistance)
      element.dispatchEvent(new Event("scroll"))
    }, targetDistanceToEnd)
    return readGeometry()
  }
  await scroller.evaluate((element, targetDistance) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - targetDistance)
    element.dispatchEvent(new Event("scroll"))
  }, targetDistanceToEnd)
  await expect.poll(driveToTarget, {
    timeout: 20_000,
    message: `${label}: scroller must reach ${targetDistanceToEnd}px from end before the stimulus`,
  }).toMatchObject({ atTarget: true })
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
  }))
  await expect.poll(driveToTarget, {
    timeout: 20_000,
    message: `${label}: ${targetDistanceToEnd}px distance must survive two committed RAFs`,
  }).toMatchObject({ atTarget: true })
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
  }))
  await expect.poll(readGeometry, {
    timeout: 20_000,
    message: `${label}: ${targetDistanceToEnd}px distance must remain stable without another write`,
  }).toMatchObject({ atTarget: true })
  const { atTarget: _atTarget, targetDistanceToEnd: _target, ...geometry } = await readGeometry()
  return geometry
}

async function establishExactPinnedPrecondition(
  scroller: Locator,
  label: string,
  targetDistanceToEnd: 0 | 1,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number; distanceToEnd: number }> {
  // The resize latch is intentionally monotonic: same-position/clamp events
  // at the end cannot recover false. Exercise its one valid recovery path by
  // first establishing away geometry, then scrolling forward into <=1px.
  await establishScrollDistancePrecondition(scroller, `${label}-away-first`, 8)
  return establishScrollDistancePrecondition(scroller, label, targetDistanceToEnd)
}

async function establishMidHistoryPrecondition(
  scroller: Locator,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number; distanceToEnd: number }> {
  const readGeometry = () => scroller.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceToEnd: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
  }))
  await scroller.evaluate((element) => {
    element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) / 2)
    element.dispatchEvent(new Event("scroll"))
  })
  await expect.poll(async () => {
    const geometry = await readGeometry()
    return {
      ...geometry,
      insideHistory: geometry.scrollTop > 300 && geometry.distanceToEnd > 300,
    }
  }, {
    timeout: 20_000,
    message: "remote-mid-history: scroller must be stably away from both boundaries",
  }).toMatchObject({ insideHistory: true })
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
  }))
  const before = await readGeometry()
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
  }))
  await expect.poll(async () => {
    const geometry = await readGeometry()
    return {
      ...geometry,
      stable: Math.abs(geometry.scrollTop - before.scrollTop) <= 1
        && geometry.scrollTop > 300
        && geometry.distanceToEnd > 300,
    }
  }, {
    timeout: 20_000,
    message: "remote-mid-history: actual geometry must remain stable across committed RAFs",
  }).toMatchObject({ stable: true })
  return readGeometry()
}

type MessageViewportGeometry = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceToEnd: number
  firstVisibleId: string | null
  firstVisibleOffset: number | null
  contentPaddingBottom: number
  railPosition: string | null
  railRect: { top: number; bottom: number } | null
  scrollerRect: { top: number; bottom: number }
}

async function readMessageViewportGeometry(scroller: Locator): Promise<MessageViewportGeometry> {
  return scroller.evaluate((element, accessoryRailTestId) => {
    const root = element as HTMLElement
    const rootRect = root.getBoundingClientRect()
    const firstVisible = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((row) => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1
      }) ?? null
    const firstRect = firstVisible?.getBoundingClientRect() ?? null
    const content = root.querySelector<HTMLElement>("[data-message-list-content]")
    const rail = root.querySelector<HTMLElement>(`[data-testid="${accessoryRailTestId}"]`)
    const railRect = rail?.getBoundingClientRect() ?? null
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      distanceToEnd: Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop),
      firstVisibleId: firstVisible?.dataset.msgId ?? null,
      firstVisibleOffset: firstRect ? firstRect.top - rootRect.top : null,
      contentPaddingBottom: content ? Number.parseFloat(getComputedStyle(content).paddingBottom) : 0,
      railPosition: rail ? getComputedStyle(rail).position : null,
      railRect: railRect ? { top: railRect.top, bottom: railRect.bottom } : null,
      scrollerRect: { top: rootRect.top, bottom: rootRect.bottom },
    }
  }, tid.composerAccessoryRail)
}

async function waitForCommittedGeometry(scroller: Locator): Promise<MessageViewportGeometry> {
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
  }))
  let previous = ""
  let settled: MessageViewportGeometry | null = null
  await expect.poll(async () => {
    const geometry = await readMessageViewportGeometry(scroller)
    const signature = JSON.stringify(geometry)
    const stable = signature === previous
    previous = signature
    if (stable) settled = geometry
    return stable
  }, { timeout: 20_000 }).toBe(true)
  return settled!
}

async function advanceScrollTraceFrame(scroller: Locator): Promise<void> {
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => resolveValue())
  }))
}

function expectAwayAnchorPreserved(
  before: MessageViewportGeometry,
  after: MessageViewportGeometry,
  label: string,
): void {
  expect(Math.abs(after.scrollTop - before.scrollTop), `${label}: scrollTop`).toBeLessThanOrEqual(1)
  expect(after.firstVisibleId, `${label}: first visible row`).toBe(before.firstVisibleId)
  expect(
    Math.abs((after.firstVisibleOffset ?? 0) - (before.firstVisibleOffset ?? 0)),
    `${label}: first visible offset`,
  ).toBeLessThanOrEqual(1)
}

function expectAwayLatchPreserved(
  after: MessageViewportGeometry,
  label: string,
): void {
  expect(after.distanceToEnd, `${label}: remains away`).toBeGreaterThan(1)
}

function expectFixedMessageGeometry(geometry: MessageViewportGeometry, label: string): void {
  expect(geometry.contentPaddingBottom, `${label}: desktop tail safe area`).toBe(72)
  if (geometry.railRect) {
    expect(geometry.railPosition, `${label}: rail position`).toBe("absolute")
    expect(geometry.railRect.top, `${label}: rail top`).toBeGreaterThanOrEqual(geometry.scrollerRect.top - 1)
    expect(geometry.railRect.bottom, `${label}: rail bottom`).toBeLessThanOrEqual(geometry.scrollerRect.bottom + 1)
  }
}

function messageCreateCount(
  frames: Awaited<ReturnType<typeof proxyCommunityWebSockets>>["frames"],
  channelId: string,
  body: string,
): number {
  return frames.filter((frame) => communityFrameEvents(frame).some((event) =>
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.content?.includes(body))).length
}

test.describe.serial("message scroll characterization", () => {
  let serverId: string
  let coldChannelId: string
  let loadingChannelId: string
  let upwardChannelId: string
  let composerChannelId: string
  let loadingProfile: Awaited<ReturnType<typeof seedProfile>>
  let upwardProfile: Awaited<ReturnType<typeof seedProfile>>
  let composerProfile: Awaited<ReturnType<typeof seedProfile>>

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const stamp = Date.now()
    serverId = await seedServer("alice", `Scroll characterization ${stamp}`)
    await seedJoinServer("alice", "bob", serverId)
    await seedJoinServer("alice", "carol", serverId)
    coldChannelId = await seedChannel("alice", serverId, `scroll-cold-${stamp}`)
    loadingChannelId = await seedChannel("alice", serverId, `scroll-loading-${stamp}`)
    upwardChannelId = await seedChannel("alice", serverId, `scroll-upward-${stamp}`)
    composerChannelId = await seedChannel("alice", serverId, `scroll-composer-${stamp}`)
    loadingProfile = await seedProfile(loadingChannelId, 130, false, "rotate", 64)
    upwardProfile = await seedProfile(upwardChannelId, 72, false, "rotate", 23)
    composerProfile = await seedProfile(composerChannelId, 36, true, "alice")
  })

  test("cold and warm loading, older prepend, and jump-to-present remain observable", async ({ asUser }, testInfo) => {
    test.setTimeout(180_000)
    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const initialMessages = await holdNextRequest(
      alice.page,
      `**/api/community/channels/${coldChannelId}/messages**`,
      () => true,
    )
    const image = await holdNextRequest(
      alice.page,
      "**/icon-512.png?scroll-trace=1",
      () => true,
    )
    await alice.page.goto(`/c/channels/${serverId}/${coldChannelId}`, { waitUntil: "commit" })
    const initialUrl = await initialMessages.matched
    expect(initialUrl.searchParams.has("anchor")).toBe(false)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    await expect(scroller.locator('[data-slot="skeleton"]').first()).toBeVisible({ timeout: 20_000 })
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
    const coldProfile = await seedProfile(coldChannelId, 12, true, "alice")
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

    await installScrollTraceInCurrentDocument(alice.page)
    await alice.page.getByTestId(tid.channelRow(loadingChannelId)).click()
    await alice.page.waitForURL(new RegExp(loadingChannelId), { waitUntil: "commit" })
    await expect(alice.page.getByTestId(tid.messageScroller)).toBeVisible()
    const warmRequest = await holdNextRequest(
      alice.page,
      `**/api/community/channels/${coldChannelId}/messages**`,
      () => true,
    )
    await alice.page.getByTestId(tid.channelRow(coldChannelId)).click()
    await alice.page.waitForURL(new RegExp(coldChannelId), { waitUntil: "commit" })
    await warmRequest.matched
    await expect(alice.page.getByTestId(tid.message(coldProfile.ids.at(-1)!))).toBeVisible({ timeout: 20_000 })
    await startScrollTrace(alice.page, {
      scenario: "warm-cache-revalidation",
      identity: identity(coldChannelId),
      estimatedSizes: coldProfile.estimates,
    })
    await beginScrollTraceAnalysis(alice.page, "warm-cache-revalidation", {
      dataTransitionSource: "initial-cache",
    })
    await markScrollTrace(alice.page, "cached-rows-painted", {
      dataTransitionSource: "initial-cache",
      detail: { renderedBeforeRelease: true },
    })
    warmRequest.release()
    await endScrollTraceAnalysis(alice.page, "warm-cache-revalidation")
    await finishAndAttach(alice.page, testInfo)
    await warmRequest.dispose()

    const anchored = await asUser("alice")
    await anchored.page.setViewportSize(VIEWPORT)
    await installScrollTrace(anchored.page)
    await anchored.page.goto(`/c/channels/${serverId}/${loadingChannelId}`, { waitUntil: "commit" })
    await expect(anchored.page.getByTestId(tid.newDivider)).toBeVisible({ timeout: 30_000 })
    const older = await holdNextRequest(
      anchored.page,
      `**/api/community/channels/${loadingChannelId}/messages**`,
      (url) => url.searchParams.has("cursor"),
    )
    await startScrollTrace(anchored.page, {
      scenario: "older-loading-prepend",
      identity: identity(loadingChannelId),
      estimatedSizes: loadingProfile.estimates,
    })
    await beginScrollTraceAnalysis(anchored.page, "older-loading-prepend", {
      dataTransitionSource: "older-page",
      commandDirection: "backward",
    })
    await markScrollTrace(anchored.page, "stimulus:older-boundary", { dataTransitionSource: "older-page" })
    await anchored.page.getByTestId(tid.messageScroller).evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event("scroll"))
    })
    await older.matched
    await expect(anchored.page.getByText("Loading older messages…", { exact: true })).toBeVisible()
    older.release()
    await expect(anchored.page.getByText("Loading older messages…", { exact: true })).toHaveCount(0)
    await endScrollTraceAnalysis(anchored.page, "older-loading-prepend")
    const olderTrace = await finishAndAttach(anchored.page, testInfo)
    expect(olderTrace.marks.filter((mark) =>
      mark.name === "stimulus:older-boundary"
      && mark.dataTransitionSource === "older-page")).toHaveLength(1)
    await older.dispose()

    await installScrollTraceInCurrentDocument(anchored.page)
    const present = anchored.page.getByTestId(tid.scrollToPresent)
    await expect(present).toBeVisible({ timeout: 30_000 })
    let newestGets = 0
    anchored.page.on("request", (request) => {
      const url = new URL(request.url())
      if (
        request.method() === "GET"
        && url.pathname === `/api/community/channels/${loadingChannelId}/messages`
        && url.search === ""
      ) newestGets += 1
    })
    const newest = await holdNextRequest(
      anchored.page,
      `**/api/community/channels/${loadingChannelId}/messages**`,
      (url) => url.search === "",
    )
    await startScrollTrace(anchored.page, {
      scenario: "newer-loading-present",
      identity: identity(loadingChannelId),
      estimatedSizes: loadingProfile.estimates,
    })
    await beginScrollTraceAnalysis(anchored.page, "newer-loading-present", {
      dataTransitionSource: "newer-page",
      commandDirection: "forward",
    })
    await markScrollTrace(anchored.page, "stimulus:jump-present", { dataTransitionSource: "newer-page" })
    await present.click()
    await newest.matched
    newest.release()
    await expect(anchored.page.getByTestId(tid.message(loadingProfile.ids.at(-1)!))).toBeVisible({ timeout: 30_000 })
    await expect(present).toHaveCount(0)
    await endScrollTraceAnalysis(anchored.page, "newer-loading-present")
    await finishAndAttach(anchored.page, testInfo)
    await expect.poll(() => newestGets).toBe(1)
    await anchored.page.waitForTimeout(500)
    expect(newestGets).toBe(1)
    await newest.dispose()
  })

  test("remote receive states and sustained upward input produce diagnostic traces", async ({ asUser }, testInfo) => {
    test.setTimeout(180_000)
    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const proxy = await proxyCommunityWebSockets(alice.context)
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${upwardChannelId}`)
    await expect(alice.page.getByTestId(tid.newDivider)).toBeVisible({ timeout: 30_000 })
    const scroller = alice.page.getByTestId(tid.messageScroller)
    await startScrollTrace(alice.page, {
      scenario: "remote-receive-and-upward-input",
      commandDirection: "backward",
      identity: identity(upwardChannelId),
      estimatedSizes: upwardProfile.estimates,
    })

    await markScrollTrace(alice.page, "stimulus:pin-tail")
    const pinnedPrecondition = await establishScrollDistancePrecondition(scroller, "remote-pinned", 0)
    await markScrollTrace(alice.page, "remote-pinned-precondition", {
      detail: pinnedPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "remote-pinned", {
      dataTransitionSource: "overlay-ws",
    })
    const pinnedBody = `remote pinned ${Date.now()}`
    await markScrollTrace(alice.page, "remote-pinned", { dataTransitionSource: "overlay-ws" })
    const pinnedId = await seedMessage("bob", upwardChannelId, pinnedBody)
    await expect(alice.page.getByTestId(tid.message(pinnedId))).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => scroller.evaluate((element) =>
      Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    await endScrollTraceAnalysis(alice.page, "remote-pinned")

    await markScrollTrace(alice.page, "stimulus:away-101")
    const awayPrecondition = await establishScrollDistancePrecondition(scroller, "remote-away-101", 101)
    await markScrollTrace(alice.page, "remote-away-precondition", {
      detail: awayPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "remote-away-101", {
      dataTransitionSource: "overlay-ws",
    })
    const awayBody = `remote away ${Date.now()}`
    await markScrollTrace(alice.page, "remote-away", { dataTransitionSource: "overlay-ws" })
    await seedMessage("carol", upwardChannelId, awayBody)
    await expect.poll(() => messageCreateCount(proxy.frames, upwardChannelId, awayBody)).toBe(1)
    const awayObservation = await scroller.evaluate((element, pillTestId) => ({
      distanceToEnd: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
      pillVisible: !!document.querySelector(`[data-testid='${pillTestId}']`),
    }), tid.scrollToPresent)
    await markScrollTrace(alice.page, "remote-away-observed", { detail: awayObservation })
    await endScrollTraceAnalysis(alice.page, "remote-away-101")

    await markScrollTrace(alice.page, "stimulus:mid-history")
    const midHistoryPrecondition = await establishMidHistoryPrecondition(scroller)
    await markScrollTrace(alice.page, "remote-mid-history-precondition", {
      detail: midHistoryPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "remote-mid-history-burst", {
      dataTransitionSource: "overlay-ws",
    })
    for (let index = 0; index < 3; index += 1) {
      await markScrollTrace(alice.page, `remote-burst-${index}`, { dataTransitionSource: "overlay-ws" })
      await seedMessage(index % 2 === 0 ? "bob" : "carol", upwardChannelId, `remote burst ${index} ${Date.now()}`)
    }
    await endScrollTraceAnalysis(alice.page, "remote-mid-history-burst")
    await beginScrollTraceAnalysis(alice.page, "remote-during-smooth", {
      dataTransitionSource: "overlay-ws",
      commandDirection: "forward",
    })
    const smoothBody = `remote during smooth ${Date.now()}`
    await markScrollTrace(alice.page, "remote-during-smooth", { dataTransitionSource: "overlay-ws" })
    await scroller.evaluate((element) => element.scrollTo({
      top: element.scrollHeight,
      behavior: "smooth",
    }))
    await seedMessage("bob", upwardChannelId, smoothBody)
    await expect.poll(() => messageCreateCount(proxy.frames, upwardChannelId, smoothBody)).toBe(1)
    await endScrollTraceAnalysis(alice.page, "remote-during-smooth")

    await markScrollTrace(alice.page, "stimulus:reset-tail")
    const upwardPrecondition = await establishScrollDistancePrecondition(scroller, "upward-60x24", 0)
    await markScrollTrace(alice.page, "upward-precondition", { detail: upwardPrecondition })
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await alice.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await beginScrollTraceAnalysis(alice.page, "upward-60x24", {
      dataTransitionSource: "overlay-ws",
      commandDirection: "backward",
    })
    await markScrollTrace(alice.page, "stimulus:upward-60x24")
    const liveAppend = (async () => {
      await alice.page.waitForTimeout(250)
      await markScrollTrace(alice.page, "upward-live-append", { dataTransitionSource: "overlay-ws" })
      return seedMessage("carol", upwardChannelId, `upward live ${Date.now()}`)
    })()
    for (let index = 0; index < 60; index += 1) {
      await alice.page.mouse.wheel(0, -24)
      await alice.page.waitForTimeout(24)
    }
    await liveAppend
    await endScrollTraceAnalysis(alice.page, "upward-60x24")
    const trace = await finishAndAttach(alice.page, testInfo)
    expect(trace.externalEvents.filter((event) => event.type === "wheel")).toHaveLength(60)
    expect(trace.marks.filter((mark) => mark.dataTransitionSource === "overlay-ws").length)
      .toBeGreaterThanOrEqual(7)
  })

  test("manual draft clear and optimistic send stay distinct through viewport changes", async ({ asUser }, testInfo) => {
    test.setTimeout(180_000)
    const alice = await asUser("alice")
    await alice.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const proxy = await proxyCommunityWebSockets(alice.context)
    let messagePosts = 0
    alice.page.on("request", (request) => {
      if (
        request.method() === "POST"
        && new URL(request.url()).pathname === `/api/community/channels/${composerChannelId}/messages`
      ) messagePosts += 1
    })
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${composerChannelId}`)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    const editable = composerEditable(alice.page)
    await expect(editable).toBeVisible()
    await startScrollTrace(alice.page, {
      scenario: "composer-clear-send-and-viewport",
      identity: identity(composerChannelId),
      estimatedSizes: composerProfile.estimates,
    })

    const typeSixLines = async (prefix: string) => {
      await editable.click()
      for (let line = 0; line < 6; line += 1) {
        await editable.pressSequentially(`${prefix} line ${line} ${"content ".repeat(8)}`)
        if (line < 5) await alice.page.keyboard.press("Shift+Enter")
      }
    }
    await markScrollTrace(alice.page, "stimulus:prepare-pinned-draft")
    await typeSixLines("pinned")
    const pinnedDraftPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "manual-delete-pinned",
      0,
    )
    await markScrollTrace(alice.page, "manual-delete-pinned-precondition", {
      detail: pinnedDraftPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "manual-delete-pinned")
    await markScrollTrace(alice.page, "manual-delete-pinned")
    await alice.page.keyboard.press("ControlOrMeta+A")
    await alice.page.keyboard.press("Backspace")
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveText("")
    expect(messagePosts).toBe(0)
    expect(proxy.frames.flatMap(communityFrameEvents).filter((event) =>
      event.type === "community:message.create" && event.channelId === composerChannelId)).toHaveLength(0)
    await endScrollTraceAnalysis(alice.page, "manual-delete-pinned")

    await markScrollTrace(alice.page, "stimulus:prepare-away-draft")
    await typeSixLines("away")
    const awayDraftPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "manual-delete-away",
      300,
    )
    await markScrollTrace(alice.page, "manual-delete-away-precondition", {
      detail: awayDraftPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "manual-delete-away")
    await markScrollTrace(alice.page, "manual-delete-away")
    await alice.page.keyboard.press("ControlOrMeta+A")
    await alice.page.keyboard.press("Backspace")
    await expect(alice.page.getByTestId(tid.composerInput)).toHaveText("")
    expect(messagePosts).toBe(0)
    await endScrollTraceAnalysis(alice.page, "manual-delete-away")

    await markScrollTrace(alice.page, "stimulus:pin-for-send")
    const pinnedSendPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "optimistic-send-pinned",
      0,
    )
    await markScrollTrace(alice.page, "optimistic-send-pinned-precondition", {
      detail: pinnedSendPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "optimistic-send-pinned", {
      dataTransitionSource: "optimistic-send",
    })
    const pinnedSend = `optimistic pinned ${Date.now()}`
    await markScrollTrace(alice.page, "optimistic-pinned", { dataTransitionSource: "optimistic-send" })
    await sendMessage(alice.page, pinnedSend)
    await expect(alice.page.getByText(pinnedSend, { exact: true })).toHaveCount(1)
    await markScrollTrace(alice.page, "post-ack-pinned", { dataTransitionSource: "post-ack" })
    await expect.poll(() => messageCreateCount(proxy.frames, composerChannelId, pinnedSend)).toBe(1)
    await markScrollTrace(alice.page, "ws-dedupe-pinned", { dataTransitionSource: "ws-dedupe" })
    await endScrollTraceAnalysis(alice.page, "optimistic-send-pinned")

    await markScrollTrace(alice.page, "stimulus:send-away")
    const awaySendPrecondition = await establishScrollDistancePrecondition(
      scroller,
      "optimistic-send-away",
      300,
    )
    await markScrollTrace(alice.page, "optimistic-send-away-precondition", {
      detail: awaySendPrecondition,
    })
    await beginScrollTraceAnalysis(alice.page, "optimistic-send-away", {
      dataTransitionSource: "optimistic-send",
    })
    const awaySend = `optimistic away ${Date.now()}`
    await markScrollTrace(alice.page, "optimistic-away", { dataTransitionSource: "optimistic-send" })
    await sendMessage(alice.page, awaySend)
    await expect(alice.page.getByText(awaySend, { exact: true })).toHaveCount(1)
    await markScrollTrace(alice.page, "post-ack-away", { dataTransitionSource: "post-ack" })
    await expect.poll(() => messageCreateCount(proxy.frames, composerChannelId, awaySend)).toBe(1)
    await markScrollTrace(alice.page, "ws-dedupe-away", { dataTransitionSource: "ws-dedupe" })
    await expect.poll(() => scroller.evaluate((element) =>
      Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    expect(messagePosts).toBe(2)
    await endScrollTraceAnalysis(alice.page, "optimistic-send-away")

    await beginScrollTraceAnalysis(alice.page, "viewport-keyboard-profile")
    await markScrollTrace(alice.page, "stimulus:viewport-keyboard-profile")
    await alice.page.setViewportSize({ width: 1280, height: 560 })
    await alice.page.setViewportSize(VIEWPORT)
    await endScrollTraceAnalysis(alice.page, "viewport-keyboard-profile")
    const trace = await finishAndAttach(alice.page, testInfo)
    expect(trace.marks.filter((mark) =>
      ["optimistic-pinned", "optimistic-away"].includes(mark.name)
      && mark.dataTransitionSource === "optimistic-send")).toHaveLength(2)
    expect(trace.marks.filter((mark) => mark.dataTransitionSource === "post-ack")).toHaveLength(2)
    expect(trace.marks.filter((mark) => mark.dataTransitionSource === "ws-dedupe")).toHaveLength(2)
    expect(messageCreateCount(proxy.frames, composerChannelId, pinnedSend)).toBe(1)
    expect(messageCreateCount(proxy.frames, composerChannelId, awaySend)).toBe(1)
  })

  test("exact-pinned composer and accessory resizes preserve geometry boundaries", async ({ asUser }, testInfo) => {
    test.setTimeout(180_000)
    const alice = await asUser("alice")
    const bob = await asUser("bob")
    await alice.page.setViewportSize(VIEWPORT)
    await bob.page.setViewportSize(VIEWPORT)
    await installScrollTrace(alice.page)
    const proxy = await proxyCommunityWebSockets(alice.context)
    let mutationPosts = 0
    alice.page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (
        request.method() === "POST"
        && (pathname.endsWith("/messages") || pathname.includes("/attachments"))
      ) mutationPosts += 1
    })
    await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${composerChannelId}`)
    await gotoAfterUserWsAuth(bob.page, `/c/channels/${serverId}/${composerChannelId}`)
    const scroller = alice.page.getByTestId(tid.messageScroller)
    const editable = composerEditable(alice.page)
    const bobEditable = composerEditable(bob.page)
    await expect(editable).toBeVisible()
    await expect(bobEditable).toBeVisible()
    await startScrollTrace(alice.page, {
      scenario: "composer-exact-pinned-resize-policy",
      identity: identity(composerChannelId),
      estimatedSizes: composerProfile.estimates,
    })

    const composerLines = (prefix: string, count: number) => Array.from(
      { length: count },
      (_, line) => `${prefix} line ${line} ${"content ".repeat(8)}`,
    ).join("\n")

    for (const distance of [0, 1, 2, 99, 100, 101, 300]) {
      await editable.fill("")
      const precondition = distance <= 1
        ? await establishExactPinnedPrecondition(
          scroller,
          `composer-resize-${distance}`,
          distance as 0 | 1,
        )
        : await establishScrollDistancePrecondition(
          scroller,
          `composer-resize-${distance}`,
          distance,
        )
      await markScrollTrace(alice.page, `composer-resize-${distance}-precondition`, {
        detail: precondition,
      })
      const before = await waitForCommittedGeometry(scroller)
      expectFixedMessageGeometry(before, `resize-${distance}-before`)

      await beginScrollTraceAnalysis(alice.page, `composer-grow-${distance}`)
      await editable.fill(composerLines(`boundary-${distance}`, 6))
      await expect.poll(() => scroller.evaluate((element) => element.clientHeight))
        .toBeLessThan(before.clientHeight)
      const grown = await waitForCommittedGeometry(scroller)
      expectFixedMessageGeometry(grown, `resize-${distance}-grown`)
      if (distance <= 1) {
        expect(grown.distanceToEnd, `resize-${distance}-grown pinned`).toBeLessThanOrEqual(1)
      } else {
        expectAwayAnchorPreserved(before, grown, `resize-${distance}-grown away`)
      }
      await endScrollTraceAnalysis(alice.page, `composer-grow-${distance}`)
      await advanceScrollTraceFrame(scroller)

      await beginScrollTraceAnalysis(alice.page, `composer-shrink-${distance}`)
      await editable.fill("")
      await expect.poll(() => scroller.evaluate((element) => element.clientHeight))
        .toBeGreaterThan(grown.clientHeight)
      const shrunk = await waitForCommittedGeometry(scroller)
      expectFixedMessageGeometry(shrunk, `resize-${distance}-shrunk`)
      if (distance <= 1) {
        expect(shrunk.distanceToEnd, `resize-${distance}-shrunk pinned`).toBeLessThanOrEqual(1)
      } else {
        expectAwayAnchorPreserved(before, shrunk, `resize-${distance}-shrunk away`)
      }
      await endScrollTraceAnalysis(alice.page, `composer-shrink-${distance}`)
      await advanceScrollTraceFrame(scroller)
    }

    const rapidPrecondition = await establishScrollDistancePrecondition(scroller, "rapid-resize-away", 2)
    await markScrollTrace(alice.page, "rapid-resize-away-precondition", { detail: rapidPrecondition })
    await beginScrollTraceAnalysis(alice.page, "rapid-composer-resizes")
    const rapidBase = await waitForCommittedGeometry(scroller)
    await editable.fill(composerLines("rapid-small", 2))
    const rapidGrowOne = await waitForCommittedGeometry(scroller)
    await editable.fill(composerLines("rapid-large", 6))
    const rapidGrowTwo = await waitForCommittedGeometry(scroller)
    await editable.fill(composerLines("rapid-small", 2))
    const rapidShrinkOne = await waitForCommittedGeometry(scroller)
    await editable.fill("")
    const rapidShrinkTwo = await waitForCommittedGeometry(scroller)
    expect(rapidGrowOne.clientHeight).toBeLessThan(rapidBase.clientHeight)
    expect(rapidGrowTwo.clientHeight).toBeLessThan(rapidGrowOne.clientHeight)
    expect(rapidShrinkOne.clientHeight).toBeGreaterThan(rapidGrowTwo.clientHeight)
    expect(rapidShrinkTwo.clientHeight).toBeGreaterThan(rapidShrinkOne.clientHeight)
    for (const [label, geometry] of [
      ["grow-one", rapidGrowOne],
      ["grow-two", rapidGrowTwo],
      ["shrink-one", rapidShrinkOne],
      ["shrink-two", rapidShrinkTwo],
    ] as const) {
      expectAwayLatchPreserved(geometry, `rapid-${label}`)
      expectFixedMessageGeometry(geometry, `rapid-${label}`)
    }
    await endScrollTraceAnalysis(alice.page, "rapid-composer-resizes")
    await advanceScrollTraceFrame(scroller)

    await establishExactPinnedPrecondition(scroller, "reply-resize-pinned", 0)
    const replyBase = await waitForCommittedGeometry(scroller)
    await beginScrollTraceAnalysis(alice.page, "reply-banner-pinned")
    const replyTarget = scroller.locator("[data-msg-id]").last()
    const replyTargetBox = await replyTarget.boundingBox()
    expect(replyTargetBox).not.toBeNull()
    await alice.page.mouse.move(
      replyTargetBox!.x + replyTargetBox!.width / 2,
      replyTargetBox!.y + replyTargetBox!.height / 2,
    )
    const replyButton = replyTarget.getByRole("button", { name: "Reply" })
    await expect(replyButton).toBeVisible()
    await expect(replyButton).toBeInViewport()
    expect((await waitForCommittedGeometry(scroller)).distanceToEnd).toBeLessThanOrEqual(1)
    await replyButton.click()
    await expect(alice.page.locator('[data-slot="composer-reply-preview"]')).toBeVisible()
    const replyOpen = await waitForCommittedGeometry(scroller)
    expect(replyOpen.clientHeight).toBeLessThan(replyBase.clientHeight)
    expect(replyOpen.distanceToEnd).toBeLessThanOrEqual(1)
    expectFixedMessageGeometry(replyOpen, "reply-open")
    await alice.page.getByRole("button", { name: "Cancel reply" }).click()
    await expect(alice.page.locator('[data-slot="composer-reply-preview"]')).toHaveCount(0)
    const replyClosed = await waitForCommittedGeometry(scroller)
    expect(replyClosed.clientHeight).toBe(replyBase.clientHeight)
    expect(replyClosed.distanceToEnd).toBeLessThanOrEqual(1)
    await endScrollTraceAnalysis(alice.page, "reply-banner-pinned")
    await advanceScrollTraceFrame(scroller)

    await establishScrollDistancePrecondition(scroller, "attachment-resize-away", 300)
    const attachmentBase = await waitForCommittedGeometry(scroller)
    await beginScrollTraceAnalysis(alice.page, "attachment-chip-away")
    await alice.page.getByTestId(tid.composerFileInput).setInputFiles({
      name: "geometry-only.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("geometry only"),
    })
    await expect(alice.page.getByText("geometry-only.txt", { exact: true })).toBeVisible()
    const attachmentOpen = await waitForCommittedGeometry(scroller)
    expect(attachmentOpen.clientHeight).toBeLessThan(attachmentBase.clientHeight)
    expectAwayAnchorPreserved(attachmentBase, attachmentOpen, "attachment-open-away")
    expectFixedMessageGeometry(attachmentOpen, "attachment-open-away")
    await alice.page.getByRole("button", { name: "Remove file" }).click()
    await expect(alice.page.getByText("geometry-only.txt", { exact: true })).toHaveCount(0)
    const attachmentClosed = await waitForCommittedGeometry(scroller)
    expect(attachmentClosed.clientHeight).toBe(attachmentBase.clientHeight)
    expectAwayAnchorPreserved(attachmentBase, attachmentClosed, "attachment-closed-away")
    await endScrollTraceAnalysis(alice.page, "attachment-chip-away")
    await advanceScrollTraceFrame(scroller)

    await establishScrollDistancePrecondition(scroller, "typing-rail-away", 101)
    const typingBase = await waitForCommittedGeometry(scroller)
    await beginScrollTraceAnalysis(alice.page, "typing-rail-away")
    await bobEditable.fill("typing rail geometry")
    await expect(alice.page.getByTestId(tid.typingIndicator)).toBeVisible({ timeout: 20_000 })
    const typingOpen = await waitForCommittedGeometry(scroller)
    expect(typingOpen.clientHeight).toBe(typingBase.clientHeight)
    expectAwayAnchorPreserved(typingBase, typingOpen, "typing-rail-away")
    expectFixedMessageGeometry(typingOpen, "typing-rail-away")
    await bobEditable.fill("")
    await endScrollTraceAnalysis(alice.page, "typing-rail-away")
    await advanceScrollTraceFrame(scroller)

    const trace = await finishAndAttach(alice.page, testInfo)
    const resizeSegments = new Map(
      summarizeScrollTrace(trace).analysisSegments.map((segment) => [segment.name, segment]),
    )
    for (const distance of [0, 1, 2, 99, 100, 101, 300]) {
      const grow = resizeSegments.get(`composer-grow-${distance}`)
      const shrink = resizeSegments.get(`composer-shrink-${distance}`)
      expect(grow, `missing composer-grow-${distance}`).toBeDefined()
      expect(shrink, `missing composer-shrink-${distance}`).toBeDefined()
      if (distance <= 1) {
        expect(grow!.writerCount, `composer-grow-${distance} writer`).toBeGreaterThanOrEqual(1)
        expect(shrink!.writerCount, `composer-shrink-${distance} writer`).toBeGreaterThanOrEqual(1)
      } else {
        expect(grow!.writerCount, `composer-grow-${distance} writer`).toBe(0)
        expect(shrink!.writerCount, `composer-shrink-${distance} writer`).toBe(0)
      }
    }
    expect(resizeSegments.get("rapid-composer-resizes")?.writerCount).toBe(0)
    expect(resizeSegments.get("attachment-chip-away")?.writerCount).toBe(0)
    expect(resizeSegments.get("typing-rail-away")?.writerCount).toBe(0)
    expect(mutationPosts).toBe(0)
    expect(proxy.frames.flatMap(communityFrameEvents).filter((event) =>
      event.type === "community:message.create" && event.channelId === composerChannelId)).toHaveLength(0)
  })

  test.afterEach(async ({ page }) => {
    await abortScrollTrace(page)
  })
})
