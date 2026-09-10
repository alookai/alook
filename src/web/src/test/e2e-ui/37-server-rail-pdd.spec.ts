import { devices, type Locator, type Page } from "@playwright/test"
import { expect, test, userId } from "./_fixtures/community-fixture"
import { seedChannel, seedDm, seedJoinServer, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const RAIL_ENDPOINT = "/api/community/users/me/server-rail"

type RailGeometry = {
  rootScrollTop: number
  railScrollTop: number
  railMaxScrollTop: number
  railClientHeight: number
  railScrollHeight: number
  target: { top: number; bottom: number }
  userBar: { top: number; bottom: number }
  add: { top: number; bottom: number }
  targetOwnsCenter: boolean
}

async function railGeometry(page: Page, serverId: string): Promise<RailGeometry> {
  return page.getByTestId(tid.serverIcon(serverId)).evaluate((target, ids) => {
    const nav = target.closest("nav")
    const rail = nav?.querySelector<HTMLElement>(`[data-testid='${ids.rail}']`)
    const userBar = document.querySelector<HTMLElement>("[data-slot='community-user-bar-overlay']")
      ?.firstElementChild as HTMLElement | null
    const add = nav?.querySelector<HTMLElement>(`[data-testid='${ids.add}']`)
    let root = nav?.parentElement ?? null
    while (root && getComputedStyle(root).position !== "fixed") root = root.parentElement
    if (!root || !rail || !userBar || !add) throw new Error("missing server rail geometry node")
    const targetRect = target.getBoundingClientRect()
    const userBarRect = userBar.getBoundingClientRect()
    const addRect = add.getBoundingClientRect()
    const hit = document.elementFromPoint(
      targetRect.left + targetRect.width / 2,
      targetRect.top + targetRect.height / 2,
    )
    return {
      rootScrollTop: root.scrollTop,
      railScrollTop: rail.scrollTop,
      railMaxScrollTop: rail.scrollHeight - rail.clientHeight,
      railClientHeight: rail.clientHeight,
      railScrollHeight: rail.scrollHeight,
      target: { top: targetRect.top, bottom: targetRect.bottom },
      userBar: { top: userBarRect.top, bottom: userBarRect.bottom },
      add: { top: addRect.top, bottom: addRect.bottom },
      targetOwnsCenter: target.contains(hit),
    }
  }, { rail: tid.serverRailScroll, add: tid.serverAdd })
}

async function dispatchTouchGesture(
  page: Page,
  origin: Locator,
  start: { x: number; y: number },
  end: { x: number; y: number },
  holdMs: number,
  probe?: { source: Locator; target: Locator },
  liveTargetRatio = 0.5,
  previewScreenshotPath?: string,
) {
  await page.evaluate(() => {
    Reflect.set(window, "__railTouchEvents", [])
    if (Reflect.get(window, "__railTouchProbeInstalled")) return
    Reflect.set(window, "__railTouchProbeInstalled", true)
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "contextmenu"]) {
      document.addEventListener(type, () => {
        const events = Reflect.get(window, "__railTouchEvents") as string[] | undefined
        events?.push(type)
      }, { capture: true })
    }
  })
  const dispatch = (type: "touchstart" | "touchmove" | "touchend", point: { x: number; y: number }) =>
    origin.evaluate((element, args) => {
      const touch = new Touch({
        identifier: 1,
        target: element,
        clientX: args.point.x,
        clientY: args.point.y,
        screenX: args.point.x,
        screenY: args.point.y,
      })
      element.dispatchEvent(new TouchEvent(args.type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: args.type === "touchend" ? [] : [touch],
        targetTouches: args.type === "touchend" ? [] : [touch],
        changedTouches: [touch],
      }))
    }, { type, point })
  await dispatch("touchstart", start)
  await page.waitForTimeout(20)
  if (holdMs > 0) await page.waitForTimeout(holdMs)
  let sawDragging = false
  let sawPreview = false
  let sawFloatingPreview = false
  let sawFloatingPreviewFollowTouch = false
  let floatingPreviewKind: string | null = null
  let floatingPreviewSize: { width: number; height: number } | null = null
  let capturedPreview = false
  let currentEnd = end
  for (let step = 1; step <= 8; step += 1) {
    const ratio = step / 8
    if (probe) {
      const liveTarget = await probe.target.boundingBox()
      if (liveTarget) {
        currentEnd = {
          x: liveTarget.x + liveTarget.width / 2,
          y: liveTarget.y + liveTarget.height * liveTargetRatio,
        }
      }
    }
    const currentPoint = {
      x: start.x + (currentEnd.x - start.x) * ratio,
      y: start.y + (currentEnd.y - start.y) * ratio,
    }
    await dispatch("touchmove", currentPoint)
    await page.waitForTimeout(20)
    const floatingPreview = page.locator("[data-rail-floating-preview]")
    if (await floatingPreview.count() === 1) {
      sawFloatingPreview = true
      floatingPreviewKind = await floatingPreview.getAttribute("data-rail-floating-preview")
      const box = await floatingPreview.boundingBox()
      if (box) {
        floatingPreviewSize = { width: box.width, height: box.height }
        sawFloatingPreviewFollowTouch ||= (
          Math.abs(box.x + box.width / 2 - currentPoint.x) <= 0.5
          && Math.abs(box.y + box.height / 2 - currentPoint.y) <= 0.5
        )
      }
    }
    if (probe) {
      sawDragging ||= await probe.source.getAttribute("data-dragging") === "true"
      sawPreview ||= await probe.target.getAttribute("data-rail-preview") !== null
      if (sawPreview && previewScreenshotPath && !capturedPreview) {
        capturedPreview = true
        await page.screenshot({ path: previewScreenshotPath })
      }
    }
  }
  await dispatch("touchend", currentEnd)
  await page.waitForTimeout(20)
  await expect(page.locator("[data-rail-floating-preview]")).toHaveCount(0)
  return {
    events: await page.evaluate(() => Reflect.get(window, "__railTouchEvents") as string[]),
    sawDragging,
    sawPreview,
    sawFloatingPreview,
    sawFloatingPreviewFollowTouch,
    floatingPreviewKind,
    floatingPreviewSize,
  }
}

async function dispatchNativeTouchSwipe(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const session = await page.context().newCDPSession(page)
  try {
    const point = (x: number, y: number) => [{
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
      id: 1,
    }]
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(start.x, start.y),
    })
    for (let step = 1; step <= 8; step += 1) {
      const ratio = step / 8
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(
          start.x + (end.x - start.x) * ratio,
          start.y + (end.y - start.y) * ratio,
        ),
      })
      await page.waitForTimeout(20)
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })
  } finally {
    await session.detach()
  }
}

async function touchDrag(
  page: Page,
  source: Locator,
  target: Locator,
  targetRatio = 0.5,
  previewScreenshotPath?: string,
) {
  const scrollIntoView = async (locator: Locator) => {
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await locator.scrollIntoViewIfNeeded()
        await expect(locator).toBeVisible()
        return
      } catch (error) {
        lastError = error
        await page.waitForTimeout(50)
      }
    }
    throw lastError
  }
  await scrollIntoView(source)
  await scrollIntoView(target)
  const sourceTestId = await source.getAttribute("data-testid")
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("touch drag target is outside the viewport")
  const result = await dispatchTouchGesture(
    page,
    source,
    { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 },
    { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height * targetRatio },
    660,
    { source, target },
    targetRatio,
    previewScreenshotPath,
  )
  const expectedPreviewKind = sourceTestId?.startsWith(tid.serverRailFolder(""))
    ? "folder"
    : "server"
  expect(result.sawFloatingPreview).toBe(true)
  expect(result.sawFloatingPreviewFollowTouch).toBe(true)
  expect(result.floatingPreviewKind).toBe(expectedPreviewKind)
  expect(result.floatingPreviewSize).toEqual({ width: 40, height: 40 })
  return { ...result, sourceTestId }
}

async function startStationaryTouch(page: Page, origin: Locator) {
  const box = await origin.boundingBox()
  if (!box) throw new Error("touch target is outside the viewport")
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const dispatch = (type: "touchstart" | "touchend") => origin.evaluate((element, args) => {
    const touch = new Touch({
      identifier: 2,
      target: element,
      clientX: args.point.x,
      clientY: args.point.y,
      screenX: args.point.x,
      screenY: args.point.y,
    })
    const allowed = element.dispatchEvent(new TouchEvent(args.type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      touches: args.type === "touchend" ? [] : [touch],
      targetTouches: args.type === "touchend" ? [] : [touch],
      changedTouches: [touch],
    }))
    // Synthetic TouchEvents do not synthesize the browser's trailing click.
    // Mirror that default only when the production handler did not cancel it.
    if (args.type === "touchend" && allowed) (element as HTMLElement).click()
  }, { type, point })
  await dispatch("touchstart")
  return () => dispatch("touchend")
}

async function expectTouchPatch(
  page: Page,
  action: () => Promise<{ sourceTestId: string | null }>,
) {
  const response = page.waitForResponse((candidate) => (
    candidate.request().method() === "PATCH"
    && new URL(candidate.url()).pathname === RAIL_ENDPOINT
  ), { timeout: 15_000 })
  const reconcile = Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === "GET"
      && new URL(candidate.url()).pathname === "/api/community/servers"),
    page.waitForResponse((candidate) => candidate.request().method() === "GET"
      && new URL(candidate.url()).pathname === "/api/community/users/me/server-folders"),
  ])
  const { sourceTestId } = await action()
  expect((await response).status()).toBe(200)
  expect((await reconcile).every((candidate) => candidate.status() === 200)).toBe(true)
  if (sourceTestId) await expect(page.getByTestId(sourceTestId)).toBeFocused()
}

async function dragUntilNativeDrop(
  page: Page,
  source: Locator,
  target: Locator,
  hasCommitted: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await source.dragTo(target, {
      targetPosition: { x: 28, y: 34 },
      force: true,
    })
    await page.waitForTimeout(250)
    const dropped = await page.evaluate(() => (
      (Reflect.get(window, "__railDragEvents") as string[]).includes("drop")
    ))
    // A commit without our capture listener seeing `drop` should still fail
    // the assertions below, but it must never trigger a second PATCH.
    if (dropped || hasCommitted()) return
  }
}

async function expectFirstNativeServerTap(
  page: Page,
  serverId: string,
  railPatches: string[],
) {
  const target = page.getByTestId(tid.serverIcon(serverId))
  const targetTestId = tid.serverIcon(serverId)
  const destination = `/c/channels/${serverId}`
  await expect(target).toBeVisible({ timeout: 30_000 })
  const patchesBeforeTap = railPatches.length
  await target.evaluate((element, args) => {
    const state = {
      touchStarts: 0,
      clicks: 0,
      pushes: [] as string[],
      sameNodeAtTouchStart: false,
      sameNodeAtClick: false,
    }
    Reflect.set(window, "__railFirstTapProbe", state)
    element.addEventListener("touchstart", () => {
      state.touchStarts += 1
      state.sameNodeAtTouchStart = element.isConnected
        && document.querySelector(`[data-testid="${args.testId}"]`) === element
    }, { once: true })
    element.addEventListener("click", () => {
      state.clicks += 1
      state.sameNodeAtClick = element.isConnected
        && document.querySelector(`[data-testid="${args.testId}"]`) === element
    }, { once: true })
    const pushState = history.pushState
    history.pushState = function (data, unused, url) {
      const pathname = url === undefined || url === null
        ? location.pathname
        : new URL(String(url), location.href).pathname
      if (pathname === args.destination) state.pushes.push(pathname)
      return pushState.call(history, data, unused, url)
    }
  }, { destination, testId: targetTestId })

  await target.tap()
  await expect.poll(() => new URL(page.url()).pathname).toBe(destination)
  expect(await page.evaluate(() => {
    const state = Reflect.get(window, "__railFirstTapProbe") as {
      touchStarts: number
      clicks: number
      pushes: string[]
      sameNodeAtTouchStart: boolean
      sameNodeAtClick: boolean
    }
    return {
      touchStarts: state.touchStarts,
      clicks: state.clicks,
      pushes: state.pushes,
      sameNodeAtTouchStart: state.sameNodeAtTouchStart,
      sameNodeAtClick: state.sameNodeAtClick,
    }
  })).toEqual({
    touchStarts: 1,
    clicks: 1,
    pushes: [destination],
    sameNodeAtTouchStart: true,
    sameNodeAtClick: true,
  })
  expect(railPatches).toHaveLength(patchesBeforeTap)
}

test("first native Server tap is one root push with a stable handle and zero rail PATCH", async ({ asUser }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const serverId = await seedServer("alice", `First tap ${stamp}`)
  await seedChannel("alice", serverId, `first-tap-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  const dmId = await seedDm("alice", userId("bob"))

  const cold = await asUser("alice", devices["Pixel 7"])
  const coldPatches: string[] = []
  cold.page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === RAIL_ENDPOINT) {
      coldPatches.push(request.postData() ?? "")
    }
  })
  await cold.page.goto("/c/me")
  await expectFirstNativeServerTap(cold.page, serverId, coldPatches)

  const warm = await asUser("bob", devices["Pixel 7"])
  const warmPatches: string[] = []
  warm.page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === RAIL_ENDPOINT) {
      warmPatches.push(request.postData() ?? "")
    }
  })
  await warm.page.goto(`/c/channels/${serverId}`)
  await expect(warm.page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 30_000 })
  await warm.page.getByTestId(tid.homeButton).click()
  await expect.poll(() => new URL(warm.page.url()).pathname).toBe("/c/me")
  await warm.page.getByTestId(tid.dmRow(dmId)).click()
  await expect.poll(() => new URL(warm.page.url()).pathname).toBe(`/c/me/${dmId}`)
  await warm.page.reload()
  await expect.poll(() => new URL(warm.page.url()).pathname).toBe(`/c/me/${dmId}`)
  await expectFirstNativeServerTap(warm.page, serverId, warmPatches)
})

test("server rail keeps scroll separate from native, touch, and keyboard drag", async ({ asUser }, testInfo) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const first = await seedServer("alice", `Rail first ${stamp}`)
  const second = await seedServer("alice", `Rail second ${stamp}`)
  const overflowServers: string[] = []
  for (let index = 0; index < 18; index++) {
    overflowServers.push(await seedServer("alice", `Rail overflow ${index} ${stamp}`))
  }
  const tail = overflowServers.at(-1)!
  const swipeServer = overflowServers.at(-2)!
  const scrollSwipeServer = overflowServers.at(-5)!
  const channel = await seedChannel("alice", first, `rail-${stamp}`)
  const { page } = await asUser("alice", {
    ...devices["Pixel 7"],
    viewport: { width: 1280, height: 900 },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/channels/${first}/${channel}`)
  await expect(page.getByTestId(tid.serverIcon(first))).toBeVisible({ timeout: 30_000 })

  const railRequests: Array<{ body: unknown; status?: number }> = []
  page.on("request", (request) => {
    if (request.method() !== "PATCH" || new URL(request.url()).pathname !== RAIL_ENDPOINT) return
    railRequests.push({ body: request.postDataJSON() })
  })
  page.on("response", (response) => {
    if (response.request().method() !== "PATCH" || new URL(response.url()).pathname !== RAIL_ENDPOINT) return
    const current = railRequests.at(-1)
    if (current) current.status = response.status()
  })

  const source = page.getByTestId(tid.serverIcon(first))
  const target = page.getByTestId(tid.serverIcon(second))
  await source.focus()
  await expect(source.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
  await target.focus()
  await expect(target.locator("xpath=ancestor::*[@data-slot='context-menu-trigger'][1]")).toBeVisible()
  await page.evaluate(() => {
    const events: string[] = []
    Reflect.set(window, "__railDragEvents", events)
    for (const type of ["dragstart", "dragenter", "dragover", "drop", "dragend"]) {
      document.addEventListener(type, () => events.push(type), { capture: true })
    }
  })
  const sourceDraggable = source.locator("xpath=ancestor::*[@draggable='true'][1]")
  const targetDraggable = target.locator("xpath=ancestor::*[@draggable='true'][1]")
  await expect(sourceDraggable).toHaveCount(1)
  await expect(targetDraggable).toHaveCount(1)
  await dragUntilNativeDrop(page, sourceDraggable, targetDraggable, () => railRequests.length > 0)
  const dragEvents = await page.evaluate(() => Reflect.get(window, "__railDragEvents"))
  expect(dragEvents).toContain("dragstart")
  expect(dragEvents).toContain("drop")
  await expect.poll(() => railRequests.length, { timeout: 10_000 }).toBe(1)
  expect(railRequests).toHaveLength(1)
  expect(railRequests[0]?.body).toMatchObject({
    commands: [{ kind: "reorder-servers" }],
  })
  await expect.poll(() => railRequests[0]?.status).toBe(200)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${first}`)
  const rail = page.getByTestId(tid.serverRailScroll)
  await rail.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(async () => (await railGeometry(page, tail)).railScrollTop)
    .toBeGreaterThan(0)
  await expect.poll(async () => (await railGeometry(page, tail)).targetOwnsCenter)
    .toBe(true)
  const mobileTail = await railGeometry(page, tail)
  expect(mobileTail.rootScrollTop).toBe(0)
  expect(mobileTail.railScrollTop).toBe(mobileTail.railMaxScrollTop)
  expect(mobileTail.target.bottom).toBeLessThanOrEqual(mobileTail.userBar.top + 0.5)
  expect(mobileTail.targetOwnsCenter).toBe(true)
  await rail.evaluate((element) => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 120) })
  const beforeSwipe = await rail.evaluate((element) => element.scrollTop)
  const swipeTarget = page.getByTestId(tid.serverIcon(scrollSwipeServer))
  await expect(swipeTarget).toBeInViewport()
  const swipeBox = await swipeTarget.boundingBox()
  expect(swipeBox).not.toBeNull()
  await expect(swipeTarget).toHaveCSS("touch-action", "auto")
  await dispatchNativeTouchSwipe(
    page,
    { x: swipeBox!.x + 22, y: swipeBox!.y + 22 },
    { x: swipeBox!.x + 22, y: Math.max(20, swipeBox!.y - 120) },
  )
  expect(railRequests).toHaveLength(1)
  await expect.poll(() => rail.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforeSwipe)
  expect(new URL(page.url()).pathname).toBe(`/c/channels/${first}`)
  await page.waitForTimeout(300)

  await rail.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(page.getByTestId(tid.serverIcon(tail))).toBeInViewport()
  await expect(page.getByTestId(tid.serverIcon(swipeServer))).toBeInViewport()
  const tapTarget = page.getByTestId(tid.serverIcon(tail))
  await tapTarget.evaluate((element) => {
    Reflect.set(window, "__railTapClicks", 0)
    element.addEventListener("click", () => {
      Reflect.set(window, "__railTapClicks", Number(Reflect.get(window, "__railTapClicks")) + 1)
    })
  })
  await tapTarget.tap()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__railTapClicks"))).toBe(1)
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${tail}`)
  expect(railRequests).toHaveLength(1)
  await page.goto(`/c/channels/${first}/${channel}`)
  await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${first}`)
  await expect(page.getByTestId(tid.serverIcon(first))).toBeVisible({ timeout: 30_000 })
  await rail.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(page.getByTestId(tid.serverIcon(tail))).toBeInViewport()
  await expect(page.getByTestId(tid.serverIcon(swipeServer))).toBeInViewport()
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname === RAIL_ENDPOINT
  ), { timeout: 15_000 })
  const createReconcilePromise = Promise.all([
    page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/servers"),
    page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/community/users/me/server-folders"),
  ])
  const firstTouch = await touchDrag(
    page,
    page.getByTestId(tid.serverIcon(tail)),
    page.getByTestId(tid.serverIcon(swipeServer)),
    0.5,
    testInfo.outputPath("server-rail-touch-preview-390-light.png"),
  )
  expect(firstTouch.events).toContain("touchstart")
  expect(firstTouch.events).toContain("touchmove")
  expect(firstTouch.events).toContain("touchend")
  expect(firstTouch.events).not.toContain("contextmenu")
  expect(firstTouch.sawDragging).toBe(true)
  expect(firstTouch.sawPreview).toBe(true)
  const createResponse = await createResponsePromise
  expect(createResponse.status()).toBe(200)
  expect((await createReconcilePromise).every((response) => response.status() === 200)).toBe(true)
  if (firstTouch.sourceTestId) {
    await expect(page.getByTestId(firstTouch.sourceTestId)).toBeFocused()
  }
  expect(railRequests).toHaveLength(2)
  expect(railRequests[1]?.body).toMatchObject({
    commands: [{ kind: "create-folder", name: "Group", serverIds: [tail, swipeServer] }],
  })
  const folderSelector = `[data-testid^="${tid.serverRailFolder("")}"]`
  const firstFolder = page.locator(folderSelector).first()
  await expect(firstFolder).toBeVisible()

  await expectTouchPatch(page, () => touchDrag(
    page,
    page.getByTestId(tid.serverIcon(tail)),
    page.getByTestId(tid.serverIcon(swipeServer)),
    0.85,
  ))
  expect(railRequests[2]?.body).toMatchObject({
    commands: [{ kind: "replace-folder-items" }],
  })

  const nearbyTopLevel = overflowServers.at(-3)!
  await expectTouchPatch(page, () => touchDrag(
    page,
    page.getByTestId(tid.serverIcon(tail)),
    page.getByTestId(tid.serverIcon(nearbyTopLevel)),
    0.15,
  ))
  expect(railRequests[3]?.body).toMatchObject({
    commands: [
      { kind: "reorder-servers" },
      { kind: "replace-folder-items" },
    ],
  })

  await expectTouchPatch(page, () => touchDrag(
    page,
    page.getByTestId(tid.serverIcon(tail)),
    firstFolder,
  ))
  expect(railRequests[4]?.body).toMatchObject({
    commands: [{ kind: "replace-folder-items" }],
  })

  const secondGroupSource = overflowServers.at(-4)!
  await expectTouchPatch(page, () => touchDrag(
    page,
    page.getByTestId(tid.serverIcon(secondGroupSource)),
    page.getByTestId(tid.serverIcon(nearbyTopLevel)),
  ))
  expect(railRequests[5]?.body).toMatchObject({
    commands: [{ kind: "create-folder" }],
  })
  const secondFolder = page.locator(folderSelector).nth(1)
  await expect(secondFolder).toBeVisible()

  await expectTouchPatch(page, () => touchDrag(
    page,
    page.getByTestId(tid.serverIcon(tail)),
    secondFolder,
  ))
  expect(railRequests[6]?.body).toMatchObject({
    commands: [
      { kind: "replace-folder-items" },
      { kind: "replace-folder-items" },
    ],
  })

  await expectTouchPatch(page, () => touchDrag(page, secondFolder, firstFolder, 0.15))
  expect(railRequests[7]?.body).toMatchObject({
    commands: [{ kind: "reorder-folders" }],
  })
  await expect(page.getByTestId(tid.serverIcon(tail))).toBeVisible()
  await expect(page.getByTestId(tid.serverIcon(first))).toBeVisible()
  await expect(page.getByTestId(tid.serverIcon(second))).toBeVisible()
  const beforeLongPress = railRequests.length
  await firstFolder.scrollIntoViewIfNeeded()
  await firstFolder.evaluate((element) => {
    Reflect.set(window, "__railStationaryClicks", 0)
    element.addEventListener("click", () => {
      Reflect.set(
        window,
        "__railStationaryClicks",
        Number(Reflect.get(window, "__railStationaryClicks")) + 1,
      )
    })
  })
  const endLongPress = await startStationaryTouch(page, firstFolder)
  await page.waitForTimeout(700)
  await expect(firstFolder).not.toHaveAttribute("data-dragging", "true")
  const stationaryFolderPreview = page.locator('[data-rail-floating-preview="folder"]')
  await expect(stationaryFolderPreview).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Ungroup" })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Move…" })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Create group" })).toHaveCount(0)
  await endLongPress()
  await expect(stationaryFolderPreview).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__railStationaryClicks")))
    .toBe(1)
  expect(railRequests).toHaveLength(beforeLongPress)
  await firstFolder.click()
  await page.getByTestId(tid.serverIcon(tail)).scrollIntoViewIfNeeded()
  await expect.poll(async () => (await railGeometry(page, tail)).targetOwnsCenter)
    .toBe(true)
  const expandedTail = await railGeometry(page, tail)
  expect(expandedTail.rootScrollTop).toBe(0)
  expect(expandedTail.target.bottom).toBeLessThanOrEqual(expandedTail.userBar.top + 0.5)
  expect(expandedTail.targetOwnsCenter).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("server-rail-touch-combine-390.png") })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/dark/)
  const darkKeyboardSource = page.getByTestId(tid.serverIcon(first))
  await darkKeyboardSource.focus()
  await page.keyboard.press("Space")
  await expect(darkKeyboardSource).toBeFocused()
  await expect(darkKeyboardSource).toHaveAttribute("data-dragging", "true")
  await page.keyboard.press("ArrowDown")
  const keyboardInsert = page.locator(`[data-testid^="${tid.serverRailInsert("")}"]`).first()
  await expect(keyboardInsert).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("server-rail-keyboard-preview-1280-dark.png") })
  await page.keyboard.press("Escape")
  await expect(keyboardInsert).toHaveCount(0)
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  let releaseCommit!: () => void
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve })
  let delayed = false
  await page.route(`**${RAIL_ENDPOINT}`, async (route) => {
    if (route.request().method() === "PATCH" && !delayed) {
      delayed = true
      await commitGate
    }
    await route.continue()
  })
  const pendingResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === RAIL_ENDPOINT,
  )
  try {
    const keyboardSource = page.getByTestId(tid.serverIcon(first))
    await keyboardSource.focus()
    await page.keyboard.press("Space")
    await page.keyboard.press("ArrowDown")
    await expect(page.locator(`[data-testid^="${tid.serverRailInsert("")}"]`).first()).toBeVisible()
    await page.keyboard.press("Enter")
    await expect.poll(() => railRequests.length).toBe(9)

    const existingFolder = page.locator(`[data-testid^="${tid.serverRailFolder("")}"]`).first()
    await existingFolder.click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: "Move…" })).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "Create group" })).toHaveCount(0)
    await page.getByRole("menuitem", { name: "Ungroup" }).click()
    await page.waitForTimeout(250)
    expect(railRequests).toHaveLength(9)
  } finally {
    releaseCommit()
  }
  expect((await pendingResponse).status()).toBe(200)
  await page.unroute(`**${RAIL_ENDPOINT}`)
  await page.screenshot({ path: testInfo.outputPath("server-rail-keyboard-1280.png") })
})

test("short server rail keeps Add adjacent and desktop geometry stable", async ({ asUser }) => {
  const stamp = Date.now()
  const serverId = await seedServer("carol", `Rail short ${stamp}`)
  const { page } = await asUser("carol")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/c/channels/${serverId}`)
  await expect(page.getByTestId(tid.serverIcon(serverId))).toBeVisible({ timeout: 30_000 })

  const mobile = await railGeometry(page, serverId)
  expect(mobile.rootScrollTop).toBe(0)
  expect(mobile.railScrollHeight).toBeLessThanOrEqual(mobile.railClientHeight)
  expect(mobile.add.top - mobile.target.bottom).toBeGreaterThanOrEqual(0)
  expect(mobile.add.top - mobile.target.bottom).toBeLessThanOrEqual(16)
  expect(mobile.targetOwnsCenter).toBe(true)

  await page.setViewportSize({ width: 1280, height: 844 })
  const desktop = await railGeometry(page, serverId)
  expect(desktop.rootScrollTop).toBe(0)
  expect(desktop.target).toEqual(mobile.target)
  expect(desktop.add).toEqual(mobile.add)
  expect(desktop.targetOwnsCenter).toBe(true)

  let railPatchCount = 0
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === RAIL_ENDPOINT) {
      railPatchCount += 1
    }
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("banner").getByRole("button", { name: "Back" }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  const onlyServer = page.getByTestId(tid.serverIcon(serverId))
  await expect(onlyServer).toBeVisible()
  await onlyServer.evaluate((element) => {
    Reflect.set(window, "__railOnlyServerClicks", 0)
    element.addEventListener("click", () => {
      Reflect.set(
        window,
        "__railOnlyServerClicks",
        Number(Reflect.get(window, "__railOnlyServerClicks")) + 1,
      )
    })
  })

  const endLongPress = await startStationaryTouch(page, onlyServer)
  await page.waitForTimeout(700)
  await expect(onlyServer).not.toHaveAttribute("data-dragging", "true")
  await expect(page.locator("[data-rail-floating-preview]")).toHaveCount(0)
  await endLongPress()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__railOnlyServerClicks")))
    .toBe(1)
  expect(new URL(page.url()).pathname).toBe(`/c/channels/${serverId}`)
  expect(railPatchCount).toBe(0)
})
