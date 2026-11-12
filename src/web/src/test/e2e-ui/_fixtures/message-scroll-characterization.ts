import { communityFixtureFetch, confirmCommunityFixtureApiResponse, CURRENT_COMMUNITY_FIXTURE_HEADERS } from "./business-contract"
import type { Locator, Page, Route, TestInfo } from "@playwright/test"
import { expect, type CaseActors } from "./case-fixture"
import { communityFrameEvents, proxyCommunityWebSockets } from "./community-ws-proxy"
import { abortScrollTrace, attachScrollTrace, createScrollTraceIdentity, finishScrollTrace, markScrollTrace, type ScrollTraceResult } from "./scroll-trace"
import { tid } from "./testids"
import { WEB_URL } from "../_setup/paths"

export const VIEWPORT = { width: 1280, height: 800 }

type HeldRequest = {
  matched: Promise<URL>
  hasMatched: () => boolean
  release: () => void
  dispose: () => Promise<void>
}

export async function holdNextRequest(
  actors: CaseActors,
  page: Page,
  pattern: string,
  predicate: (url: URL) => boolean,
  options: { required?: boolean } = {},
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
    if (options.required !== false) timeout = setTimeout(() => reject(new Error(`held request did not match ${pattern}`)), 20_000)
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
  const held = {
    matched,
    hasMatched: () => consumed,
    release,
    dispose: async () => {
      if (timeout) clearTimeout(timeout)
      release()
      if (!page.isClosed()) await page.unroute(pattern, handler)
    },
  }
  actors.onCleanup(() => held.dispose())
  return held
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

export async function seedResizableHtmlPreview(page: Page, channelId: string) {
  const html = '<!doctype html><html><body><div id="content" style="height:160px">Asynchronous content</div><script>addEventListener("message",event=>{if(event.source===parent&&event.data?.type==="scroll-fixture-height"&&Number.isFinite(event.data.height))document.getElementById("content").style.height=event.data.height+"px"})</script></body></html>'
  const upload = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${channelId}/attachments`, {
    headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
    multipart: { file: { name: "scroll-resize.html", mimeType: "text/html", buffer: Buffer.from(html) } },
  }))
  expect(upload.status()).toBe(200)
  const attachmentId = (await upload.json() as { id: string }).id
  const posted = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${channelId}/messages`, {
    headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
    data: { content: `[alook-html-preview](${attachmentId})`, attachments: [attachmentId] },
  }))
  expect(posted.status()).toBe(201)
  const messageId = (await posted.json() as { message: { id: string } }).message.id
  return { messageId, attachmentId }
}

export async function seedProfile(
  actors: CaseActors,
  channelId: string,
  count: number,
  imageAtTail = false,
  authors: "rotate" | "alice" = "rotate",
  checkpointAt?: number,
): Promise<{ ids: string[]; estimates: Record<string, number> }> {
  const { seedMessage } = actors.seed
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
    if (index === checkpointAt) await setReadCheckpoint(actors, channelId, id)
  }
  return { ids, estimates }
}

export async function seedDmProfile(
  actors: CaseActors,
  dmId: string,
  count: number,
): Promise<{ ids: string[]; estimates: Record<string, number> }> {
  const { seedDmMessage } = actors.seed
  const ids: string[] = []
  const estimates: Record<string, number> = {}
  for (let index = 0; index < count; index += 1) {
    const content = profileContent(index)
    const id = await seedDmMessage("alice", dmId, content)
    ids.push(id)
    estimates[id] = estimatePlainMessage(content)
  }
  return { ids, estimates }
}

export async function setReadCheckpoint(actors: CaseActors, channelId: string, messageId: string): Promise<void> {
  const response = await communityFixtureFetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: {
      Cookie: actors.sessionCookie("alice"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ lastReadMessageId: messageId }),
  })
  expect(response.ok).toBe(true)
}

export function identity(channelId: string, viewport = VIEWPORT) {
  return createScrollTraceIdentity({
    account: "alice",
    channel: channelId,
    viewport: { ...viewport, dpr: 1 },
  })
}

export async function finishAndAttach(page: Page, testInfo: TestInfo): Promise<ScrollTraceResult> {
  await markScrollTrace(page, "final-stimulus")
  const result = await finishScrollTrace(page)
  await attachScrollTrace(testInfo, result)
  return result
}

export async function establishScrollDistancePrecondition(
  scroller: Locator,
  label: string,
  targetDistanceToEnd: number,
  tolerance = 1,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number; distanceToEnd: number }> {
  const readGeometry = () => scroller.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceToEnd: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
  })).then((geometry) => ({
    ...geometry,
    targetDistanceToEnd,
    atTarget: Math.abs(geometry.distanceToEnd - targetDistanceToEnd) <= tolerance,
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

export async function establishExactPinnedPrecondition(
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

export async function establishTailMessageBelowViewportPrecondition(
  scroller: Locator,
  label: string,
  tailMessageId: string,
): Promise<void> {
  const driveTailBelowViewport = () => scroller.evaluate((element, messageId) => {
    const root = element as HTMLElement
    const rootRect = root.getBoundingClientRect()
    const tail = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((row) => row.dataset.msgId === messageId)
    const distanceToEnd = Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
    // A fresh virtualizer may not have mounted the known tail row yet even
    // while the viewport is still pinned. Only accept an absent row after an
    // actual away position has been established.
    const tailBelowViewport = tail
      ? tail.getBoundingClientRect().top >= rootRect.bottom - 1
      : distanceToEnd >= Math.max(1, root.clientHeight / 2)
    if (!tailBelowViewport) {
      root.scrollTop = Math.max(0, root.scrollTop - Math.max(400, root.clientHeight / 2))
      root.dispatchEvent(new Event("scroll"))
    }
    return { tailBelowViewport, scrollTop: root.scrollTop, distanceToEnd }
  }, tailMessageId)

  await expect.poll(driveTailBelowViewport, {
    timeout: 20_000,
    message: `${label}: tail row must leave the viewport so the accessory rail is semantically required`,
  }).toMatchObject({ tailBelowViewport: true })
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
  }))
}

type MessageViewportGeometry = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  readableHeight: number
  composerOcclusion: number
  composerGutterReachesScroller: boolean
  distanceToEnd: number
  firstVisibleId: string | null
  firstVisibleOffset: number | null
  contentPaddingBottom: number
  railPosition: string | null
  railRect: { top: number; bottom: number; height: number } | null
  accessoryPosition: string | null
  accessoryRect: { top: number; bottom: number; height: number } | null
  railInFooter: boolean
  railInScroller: boolean
  composerRect: { top: number; bottom: number } | null
  surfaceChannelId: string | null
  scrollerRect: { top: number; bottom: number }
}

async function readMessageViewportGeometry(scroller: Locator): Promise<MessageViewportGeometry> {
  return scroller.evaluate((element, accessoryRailTestId) => {
    const root = element as HTMLElement
    const rootRect = root.getBoundingClientRect()
    const surface = root.closest<HTMLElement>('[data-slot="community-conversation-surface"]')
    const composerOcclusion = Number(root.dataset.composerOcclusion ?? 0)
    const firstVisible = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find((row) => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - composerOcclusion - 1
      }) ?? null
    const firstRect = firstVisible?.getBoundingClientRect() ?? null
    const content = root.querySelector<HTMLElement>("[data-message-list-content]")
    const composer = surface?.querySelector<HTMLElement>('[data-slot="community-conversation-footer"]')
    const composerRect = composer?.getBoundingClientRect() ?? null
    const baseRect = composer?.querySelector<HTMLElement>('[data-slot="community-composer-base"]')?.getBoundingClientRect()
    const gutterTarget = baseRect ? document.elementFromPoint(baseRect.left - 2, baseRect.top + 10) : null
    const accessory = composer?.querySelector<HTMLElement>('[data-slot="community-composer-accessory-slot"]')
    const accessoryRect = accessory?.getBoundingClientRect() ?? null
    const rail = accessory?.querySelector<HTMLElement>(`[data-testid="${accessoryRailTestId}"]`)
    const railRect = rail?.getBoundingClientRect() ?? null
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      readableHeight: root.clientHeight - composerOcclusion,
      composerOcclusion,
      composerGutterReachesScroller: !!gutterTarget && root.contains(gutterTarget),
      distanceToEnd: Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop),
      firstVisibleId: firstVisible?.dataset.msgId ?? null,
      firstVisibleOffset: firstRect ? firstRect.top - rootRect.top : null,
      contentPaddingBottom: content ? Number.parseFloat(getComputedStyle(content).paddingBottom) : 0,
      railPosition: rail ? getComputedStyle(rail).position : null,
      railRect: railRect ? { top: railRect.top, bottom: railRect.bottom, height: railRect.height } : null,
      accessoryPosition: accessory ? getComputedStyle(accessory).position : null,
      accessoryRect: accessoryRect ? { top: accessoryRect.top, bottom: accessoryRect.bottom, height: accessoryRect.height } : null,
      railInFooter: !!rail && rail.parentElement === accessory && rail.closest('[data-slot="community-conversation-footer"]') === composer,
      railInScroller: !!rail && !!rail.closest("[data-message-scroller-boundary]"),
      composerRect: composerRect ? { top: composerRect.top, bottom: composerRect.bottom } : null,
      surfaceChannelId: surface?.dataset.channelId ?? null,
      scrollerRect: { top: rootRect.top, bottom: rootRect.bottom },
    }
  }, tid.composerAccessoryRail)
}

export async function waitForCommittedGeometry(scroller: Locator): Promise<MessageViewportGeometry> {
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

export async function expectSkeletonTailGeometry(
  page: Page,
  _width: 390 | 1280,
  label: string,
): Promise<void> {
  const geometry = await page.locator("[data-message-list-skeleton-tail]").first().evaluate((tail, scrollerTestId) => {
    const tailRect = tail.getBoundingClientRect()
    const scroller = tail.closest<HTMLElement>("[data-message-list-content]")
      ?.closest<HTMLElement>(`[data-testid="${scrollerTestId}"]`)
    const scrollerRect = scroller?.getBoundingClientRect()
    const content = tail.closest<HTMLElement>("[data-message-list-content]")
    const footer = scroller?.closest('[data-slot="community-conversation-surface"]')
      ?.querySelector<HTMLElement>('[data-slot="community-conversation-footer"]')
    const footerRect = footer?.getBoundingClientRect()
    const overlayHeight = footerRect && scrollerRect && footer?.dataset.selectionActive !== "true"
      && Math.abs(footerRect.bottom - scrollerRect.bottom) <= 1 ? footerRect.height : 0
    return {
      overlayHeight,
      tailHeight: tailRect.height,
      tailBottom: tailRect.bottom,
      scrollerBottom: scrollerRect?.bottom ?? null,
      contentPaddingBottom: content
        ? Number.parseFloat(getComputedStyle(content).paddingBottom)
        : null,
    }
  }, tid.messageScroller)
  const expectedTail = 40 + geometry.overlayHeight
  expect(geometry.contentPaddingBottom, `${label}: outer padding`).toBe(0)
  expect(geometry.tailHeight, `${label}: placeholder height`).toBe(expectedTail)
  expect(geometry.scrollerBottom, `${label}: scroller boundary`).not.toBeNull()
  expect(
    Math.abs(geometry.tailBottom - geometry.scrollerBottom!),
    `${label}: placeholder ends at scroller bottom`,
  ).toBeLessThanOrEqual(1)
}

export async function waitForStableTail(scroller: Locator, label: string): Promise<void> {
  await expect.poll(async () => {
    const before = await readMessageViewportGeometry(scroller)
    await scroller.evaluate(() => new Promise<void>((resolveValue) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
    }))
    const after = await readMessageViewportGeometry(scroller)
    return {
      atTail: after.distanceToEnd <= 1,
      stable: Math.abs(after.scrollTop - before.scrollTop) <= 1
        && Math.abs(after.scrollHeight - before.scrollHeight) <= 1,
    }
  }, {
    timeout: 20_000,
    message: `${label}: product scroll-to-bottom must finish before exact-pinned setup`,
  }).toMatchObject({ atTail: true, stable: true })
}

export async function advanceScrollTraceFrame(scroller: Locator): Promise<void> {
  await scroller.evaluate(() => new Promise<void>((resolveValue) => {
    requestAnimationFrame(() => resolveValue())
  }))
}

export function expectViewportAnchorPreserved(
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

export function expectResizeAnchorPreserved(
  before: MessageViewportGeometry,
  after: MessageViewportGeometry,
  distance: number,
  label: string,
): void {
  if (distance <= 1) {
    expect(
      Math.abs(after.distanceToEnd - before.distanceToEnd),
      `${label}: distance to tail`,
    ).toBeLessThanOrEqual(1)
    return
  }
  const expectedTop = Math.min(before.scrollTop, Math.max(0, after.scrollHeight - after.clientHeight))
  expect(Math.abs(after.scrollTop - expectedTop), `${label}: historical top within physical bounds`).toBeLessThanOrEqual(1)
  if (Math.abs(expectedTop - before.scrollTop) <= 1) expectViewportAnchorPreserved(before, after, label)
}

export function expectContinuousResizeAnchorPreserved(
  trace: ScrollTraceResult,
  segmentName: string,
  distance: number,
): void {
  const start = trace.marks.find((mark) => mark.name === `analysis-start:${segmentName}`)
  const end = trace.marks.find((mark) => mark.name === `analysis-end:${segmentName}`)
  expect(start, `${segmentName}: start mark`).toBeDefined()
  expect(end, `${segmentName}: end mark`).toBeDefined()
  const frames = trace.frames.filter((frame) => (
    frame.frame >= start!.frame && frame.frame <= end!.frame
  ))
  expect(frames.length, `${segmentName}: continuous frames`).toBeGreaterThan(1)

  const baseline = frames[0]!
  if (distance <= 1) {
    for (const frame of frames) {
      expect(
        Math.abs(frame.distanceToEnd - baseline.distanceToEnd),
        `${segmentName}: frame ${frame.frame} tail-distance drift`,
      ).toBeLessThanOrEqual(1)
    }
    return
  }

  for (const frame of frames) {
    const expectedTop = Math.min(baseline.scrollTop, frame.browserMax)
    expect(Math.abs(frame.scrollTop - expectedTop), `${segmentName}: frame ${frame.frame} historical top`).toBeLessThanOrEqual(1)
    const anchor = frame.rows.find(row => row.id === baseline.firstVisibleId)
    expect(anchor, `${segmentName}: frame ${frame.frame} retained body`).toBeDefined()
    const expectedBodyOffset = (baseline.firstVisibleOffset ?? 0) + baseline.scrollTop - expectedTop
    expect(Math.abs(anchor!.top - (frame.scrollerRect?.top ?? 0) - expectedBodyOffset),
      `${segmentName}: frame ${frame.frame} body offset within physical bounds`).toBeLessThanOrEqual(1)
  }
}

export function expectComposerOverlayGeometry(geometry: MessageViewportGeometry, label: string): void {
  expect(geometry.contentPaddingBottom, `${label}: outer tail padding removed`).toBe(0)
  expect(geometry.composerRect, `${label}: scoped composer`).not.toBeNull()
  expect(geometry.composerOcclusion, `${label}: positive overlay reservation`).toBeGreaterThan(0)
  expect(Math.abs(geometry.scrollerRect.bottom - geometry.composerRect!.bottom), `${label}: scroller extends behind composer`).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.composerRect!.bottom - geometry.composerRect!.top - geometry.composerOcclusion), `${label}: reserved composer height`).toBeLessThanOrEqual(1)
  expect(geometry.composerGutterReachesScroller, `${label}: transparent gutter hit target`).toBe(true)
  if (geometry.railRect) {
    expect(geometry.railPosition, `${label}: rail position`).toBe("static")
    expect(geometry.railInFooter, `${label}: Footer owns rail`).toBe(true)
    expect(geometry.railInScroller, `${label}: rail outside scroller`).toBe(false)
    expect(geometry.accessoryPosition, `${label}: accessory position`).toBe("absolute")
    expect(geometry.accessoryRect, `${label}: accessory slot`).not.toBeNull()
    expect(geometry.accessoryRect!.height, `${label}: accessory height`).toBe(40)
    expect(geometry.railRect.height, `${label}: rail height`).toBe(32)
    expect(Math.abs(geometry.railRect.top - geometry.accessoryRect!.top - 4), `${label}: upper center gap`).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.accessoryRect!.bottom - geometry.railRect.bottom - 4), `${label}: lower center gap`).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.accessoryRect!.bottom - geometry.composerRect!.top), `${label}: slot ends at Footer`).toBeLessThanOrEqual(1)
    expect(geometry.railRect.top, `${label}: rail top`).toBeGreaterThanOrEqual(geometry.scrollerRect.top - 1)
    expect(geometry.railRect.bottom, `${label}: rail bottom`).toBeLessThanOrEqual(geometry.scrollerRect.bottom + 1)
    expect(geometry.railRect.bottom, `${label}: rail clears composer`).toBeLessThanOrEqual(
      geometry.composerRect!.top + 1,
    )
  }
}

export function messageCreateCount(
  frames: Awaited<ReturnType<typeof proxyCommunityWebSockets>>["frames"],
  channelId: string,
  body: string,
): number {
  return frames.filter((frame) => communityFrameEvents(frame).some((event) =>
    event.type === "community:message.create"
    && event.channelId === channelId
    && event.message?.content?.includes(body))).length
}

export type PostedMessageIdentity = { id: string; seq: number; channelId: string; authorId: string; content: string }

export async function expectMessageCreateIdentity(
  frames: Awaited<ReturnType<typeof proxyCommunityWebSockets>>["frames"],
  channelId: string,
  message: PostedMessageIdentity,
  nonce: string,
): Promise<void> {
  expect(message.id.length).toBeGreaterThan(0)
  expect(message.seq).toBeGreaterThan(0)
  await expect.poll(() => frames.flatMap(communityFrameEvents).filter(event =>
    event.type === "community:message.create" && event.channelId === channelId && event.message?.id === message.id,
  ).length).toBe(1)
  const created = frames.flatMap(communityFrameEvents).find(event =>
    event.type === "community:message.create" && event.channelId === channelId && event.message?.id === message.id,
  )!
  expect(created.message).toMatchObject({ id: message.id, seq: message.seq, authorId: message.authorId, clientNonce: nonce })
}

export async function seedScrollServer(actors: CaseActors) {
  const { seedServer, seedJoinServer } = actors.seed
  const serverId = await seedServer("alice", `Scroll characterization ${Date.now()}`)
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)
  return serverId
}

export async function seedScrollCase(actors: CaseActors) {
  const { seedChannel, seedDm } = actors.seed
  const { userId } = actors
  const stamp = Date.now()
  const serverId = await seedScrollServer(actors)
  const coldChannelId = await seedChannel("alice", serverId, `scroll-cold-${stamp}`)
  const loadingChannelId = await seedChannel("alice", serverId, `scroll-loading-${stamp}`)
  const upwardChannelId = await seedChannel("alice", serverId, `scroll-upward-${stamp}`)
  const composerChannelId = await seedChannel("alice", serverId, `scroll-composer-${stamp}`)
  const composerDmId = await seedDm("alice", userId("bob"))
  const loadingProfile = await seedProfile(actors, loadingChannelId, 130, false, "rotate", 64)
  const upwardProfile = await seedProfile(actors, upwardChannelId, 72, false, "rotate", 23)
  const composerProfile = await seedProfile(actors, composerChannelId, 36, true, "alice")
  const composerDmProfile = await seedDmProfile(actors, composerDmId, 36)
  return { serverId, coldChannelId, loadingChannelId, upwardChannelId, composerChannelId, composerDmId, loadingProfile, upwardProfile, composerProfile, composerDmProfile }
}

export function tracedAsUser(actors: CaseActors): CaseActors["asUser"] {
  return async (key, options) => {
    const opened = await actors.asUser(key, options)
    actors.onCleanup(async () => {
      if (!opened.page.isClosed()) await abortScrollTrace(opened.page)
    })
    return opened
  }
}
