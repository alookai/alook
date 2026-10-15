import type { Locator, Page, TestInfo } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable, createServer } from "./_fixtures/actions"
import { solidPngFixture } from "../fixtures/media"

const LANDSCAPE_FIXTURE = solidPngFixture(800, 450, [91, 110, 225])
const PORTRAIT_FIXTURE = solidPngFixture(450, 800, [225, 91, 142])
const EXTREME_LANDSCAPE_FIXTURE = solidPngFixture(4000, 100, [91, 110, 225])
const EXTREME_PORTRAIT_FIXTURE = solidPngFixture(100, 4000, [225, 91, 142])

type Rect = { x: number; y: number; width: number; height: number }

type NativeImageContextMenuProbe = {
  defaultPrevented: boolean | null
  targetSrc: string | null
  targetTagName: string | null
  targetTestId: string | null
}

async function boundingRect(locator: Locator): Promise<Rect> {
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  return rect!
}

async function expectNativeImageContextMenu(
  page: Page,
  target: Locator,
  expected: { src: string; testId: string },
) {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __imageContextMenuProbe?: NativeImageContextMenuProbe
    }
    state.__imageContextMenuProbe = {
      defaultPrevented: null,
      targetSrc: null,
      targetTagName: null,
      targetTestId: null,
    }
    document.addEventListener("contextmenu", (event) => {
      const eventTarget = event.target instanceof Element ? event.target : null
      const imageTarget = eventTarget instanceof HTMLImageElement ? eventTarget : null
      if (state.__imageContextMenuProbe) {
        state.__imageContextMenuProbe.targetSrc = imageTarget?.getAttribute("src") ?? null
        state.__imageContextMenuProbe.targetTagName = eventTarget?.tagName ?? null
        state.__imageContextMenuProbe.targetTestId = eventTarget?.getAttribute("data-testid") ?? null
      }
      setTimeout(() => {
        if (state.__imageContextMenuProbe) {
          state.__imageContextMenuProbe.defaultPrevented = event.defaultPrevented
        }
      })
    }, { capture: true, once: true })
  })

  await target.click({ button: "right" })
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __imageContextMenuProbe?: NativeImageContextMenuProbe }
  ).__imageContextMenuProbe)).toEqual({
    defaultPrevented: false,
    targetSrc: expected.src,
    targetTagName: "IMG",
    targetTestId: expected.testId,
  })
}

function expectSameRect(actual: Rect, expected: Rect) {
  expect(actual.x).toBeCloseTo(expected.x, 1)
  expect(actual.y).toBeCloseTo(expected.y, 1)
  expect(actual.width).toBeCloseTo(expected.width, 1)
  expect(actual.height).toBeCloseTo(expected.height, 1)
}

function expectWithinRect(rect: Rect, outer: Rect) {
  expect(rect.width).toBeGreaterThan(0)
  expect(rect.height).toBeGreaterThan(0)
  expect(rect.x).toBeGreaterThanOrEqual(outer.x - 0.5)
  expect(rect.y).toBeGreaterThanOrEqual(outer.y - 0.5)
  expect(rect.x + rect.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5)
  expect(rect.y + rect.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5)
}

async function previewLayout(page: Page) {
  await waitForDialogEntrance(page)
  const container = await boundingRect(page.getByTestId(tid.imageLightbox))
  const controls = await boundingRect(page.getByRole("toolbar", { name: "Image controls" }))
  const dialog = await boundingRect(page.locator("[data-slot='dialog-content']").filter({ has: page.getByTestId(tid.imageLightbox) }))
  const { viewport, inset } = await page.evaluate(() => {
    const probe = document.createElement("div")
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
    document.body.appendChild(probe)
    const style = getComputedStyle(probe)
    const gutter = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    const inset = {
      top: Math.max(gutter, Number.parseFloat(style.paddingTop)),
      right: Math.max(gutter, Number.parseFloat(style.paddingRight)),
      bottom: Math.max(gutter, Number.parseFloat(style.paddingBottom)),
      left: Math.max(gutter, Number.parseFloat(style.paddingLeft)),
    }
    probe.remove()
    const visible = window.visualViewport
    return {
      viewport: { x: visible?.offsetLeft ?? 0, y: visible?.offsetTop ?? 0, width: visible?.width ?? innerWidth, height: visible?.height ?? innerHeight },
      inset,
    }
  })
  expectSameRect(dialog, {
    x: viewport.x + inset.left,
    y: viewport.y + inset.top,
    width: viewport.width - inset.left - inset.right,
    height: viewport.height - inset.top - inset.bottom,
  })
  for (const rect of [dialog, controls, container]) expectWithinRect(rect, viewport)
  expect(controls.y).toBeCloseTo(dialog.y, 1)
  expect(controls.y + controls.height).toBeLessThan(container.y)
  expect(container.x).toBeCloseTo(dialog.x, 1)
  expect(container.width).toBeCloseTo(dialog.width, 1)
  expect(container.y + container.height).toBeCloseTo(dialog.y + dialog.height, 1)
  const surfaces = await page.getByTestId(tid.imageLightbox).evaluate((element) => {
    const result = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      result.push({ background: style.backgroundColor, overflowX: style.overflowX, overflowY: style.overflowY })
      if (node.getAttribute("data-slot") === "dialog-content") break
    }
    return result
  })
  for (const surface of surfaces) {
    expect(surface.background).toBe("rgba(0, 0, 0, 0)")
    expect(surface.overflowX).toBe("visible")
    expect(surface.overflowY).toBe("visible")
  }
  return { container, controls, dialog, viewport }
}

async function previewImageGeometry(locator: Locator) {
  const geometry = await locator.evaluate((element: HTMLImageElement) => {
    const rect = element.getBoundingClientRect()
    const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    const style = getComputedStyle(element)
    const transform = new DOMMatrixReadOnly(style.transform)
    const ratio = Math.min(rect.width / element.naturalWidth, rect.height / element.naturalHeight)
    const width = element.naturalWidth * ratio
    const height = element.naturalHeight * ratio
    return {
      box,
      painted: element.naturalWidth > 0 && element.naturalHeight > 0 ? {
        x: rect.x + (rect.width - width) / 2,
        y: rect.y + (rect.height - height) / 2,
        width,
        height,
      } : null,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      translation: { x: transform.m41, y: transform.m42 },
      scale: transform.a,
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      state: element.getAttribute("data-remote-image-state"),
    }
  })
  expect(geometry.objectFit).toBe("contain")
  expect(geometry.objectPosition).toBe("50% 50%")
  if (geometry.state === "ready") expect(geometry.painted).not.toBeNull()
  return geometry
}

function expectFittedImage(painted: Rect | null, container: Rect, dimensions: { width: number; height: number }) {
  if (!painted) return
  const ratio = Math.min(1, container.width / dimensions.width, container.height / dimensions.height)
  const width = dimensions.width * ratio
  const height = dimensions.height * ratio
  expectSameRect(painted, {
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    width,
    height,
  })
  expectWithinRect(painted, container)
  expect(painted.width / painted.height).toBeCloseTo(dimensions.width / dimensions.height, 2)
}

async function previewRects(page: Page, dimensions: { width: number; height: number }) {
  const layout = await previewLayout(page)
  const thumbnail = await previewImageGeometry(page.getByTestId(tid.imageLightboxThumbnail))
  const original = await previewImageGeometry(page.getByTestId(tid.imageLightboxOriginal))
  expectSameRect(thumbnail.box, original.box)
  for (const layer of [thumbnail, original]) {
    expectWithinRect(layer.box, layout.container)
    expectFittedImage(layer.painted, layout.container, dimensions)
  }
  if (original.painted) {
    expect(original.naturalWidth).toBe(dimensions.width)
    expect(original.naturalHeight).toBe(dimensions.height)
  }
  return { ...layout, thumbnail: thumbnail.box, original: original.box, thumbnailPainted: thumbnail.painted, originalPainted: original.painted }
}

async function expectZoomedImage(page: Page, dimensions: { width: number; height: number }) {
  const layout = await previewLayout(page)
  const scale = Number(await page.getByTestId(tid.imageLightbox).getAttribute("data-zoom-scale"))
  const { painted, translation, scale: renderedScale } = await previewImageGeometry(page.getByTestId(tid.imageLightboxOriginal))
  expect(painted).not.toBeNull()
  expect(renderedScale).toBeCloseTo(scale, 4)
  const fit = Math.min(1, layout.container.width / dimensions.width, layout.container.height / dimensions.height)
  const width = dimensions.width * fit * scale
  const height = dimensions.height * fit * scale
  expectSameRect(painted!, {
    x: layout.container.x + layout.container.width / 2 + translation.x - width / 2,
    y: layout.container.y + layout.container.height / 2 + translation.y - height / 2,
    width,
    height,
  })
  return { ...layout, painted: painted!, scale, translation }
}

async function expectToolbarAboveImage(page: Page, painted: Rect) {
  for (const name of ["Zoom out", "Fit image", "Zoom in", "Close image preview"]) {
    const button = page.getByRole("button", { name, exact: true })
    const rect = await boundingRect(button)
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    expect(point.x).toBeGreaterThan(painted.x)
    expect(point.x).toBeLessThan(painted.x + painted.width)
    expect(point.y).toBeGreaterThan(painted.y)
    expect(point.y).toBeLessThan(painted.y + painted.height)
    expect(await button.evaluate((element, target) => element.contains(document.elementFromPoint(target.x, target.y)), point)).toBe(true)
  }
}

async function previewNodes(page: Page) {
  return Promise.all([tid.imageLightbox, tid.imageLightboxThumbnail, tid.imageLightboxOriginal].map(async (id) => {
    const locator = page.getByTestId(id)
    const node = await locator.elementHandle()
    expect(node).not.toBeNull()
    return { id, node, src: await locator.getAttribute("src") }
  }))
}

async function expectSamePreviewNodes(page: Page, nodes: Awaited<ReturnType<typeof previewNodes>>) {
  for (const { id, node, src } of nodes) {
    const locator = page.getByTestId(id)
    expect(await locator.evaluate((element, captured) => element === captured, node)).toBe(true)
    expect(await locator.getAttribute("src")).toBe(src)
  }
}

async function waitForDialogEntrance(page: Page) {
  const lightbox = page.getByTestId(tid.imageLightbox)
  await expect(lightbox).toBeVisible()
  await lightbox.evaluate((element, ids) => {
    const dialog = element.closest<HTMLElement>("[data-slot='dialog-content']")
    if (!dialog) throw new Error("lightbox dialog content disappeared")
    return new Promise<void>((resolveStable, rejectStable) => {
      let previous = ""
      let unchangedFrames = 0
      let observedFrames = 0
      const sample = () => {
        if (!dialog.isConnected) {
          rejectStable(new Error("lightbox dialog content disappeared"))
          return
        }
        const container = document.querySelector<HTMLElement>(`[data-testid="${ids.container}"]`)
        if (!container) {
          rejectStable(new Error("lightbox container disappeared"))
          return
        }
        // The failed-original state intentionally unmounts the original
        // image. Sample whichever image layers currently exist; each test
        // phase separately asserts its required layer before measuring.
        const nodes = [
          container,
          document.querySelector<HTMLElement>(`[data-testid="${ids.thumbnail}"]`),
          document.querySelector<HTMLElement>(`[data-testid="${ids.original}"]`),
        ].filter((node): node is HTMLElement => node !== null)
        const current = nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return [rect.x, rect.y, rect.width, rect.height].join(":")
        }).join("|")
        const animating = dialog.getAnimations({ subtree: true }).some((animation) => (
          Number.isFinite(animation.effect?.getComputedTiming().endTime)
          && (animation.pending || animation.playState === "running" || animation.playState === "paused")
        ))
        unchangedFrames = !animating && current === previous ? unchangedFrames + 1 : 0
        previous = animating ? "" : current
        observedFrames += 1
        if (unchangedFrames >= 1) {
          resolveStable()
          return
        }
        if (observedFrames >= 120) {
          rejectStable(new Error("lightbox geometry did not stabilize within 120 animation frames"))
          return
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
  }, {
    container: tid.imageLightbox,
    thumbnail: tid.imageLightboxThumbnail,
    original: tid.imageLightboxOriginal,
  })
}

async function attachScreenshot(testInfo: TestInfo, name: string, page: Page) {
  await testInfo.attach(`${name}.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
}

async function uploadImage(args: {
  page: Page
  channelId: string
  message: string
  name: string
  buffer: Buffer
  mimeType?: string
}) {
  const { page, channelId, message, name, buffer, mimeType = "image/png" } = args
  const uploadResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/attachments`
  ))
  const messageResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  const editable = composerEditable(page)
  await editable.click()
  await editable.pressSequentially(message)
  await page.getByTestId(tid.composerFileInput).setInputFiles({
    name,
    mimeType,
    buffer,
  })
  await expect.poll(() => editable.evaluate((element) => document.activeElement === element)).toBe(true)
  await page.keyboard.press("Enter")

  const uploadResponse = await uploadResponsePromise
  expect(uploadResponse.ok()).toBe(true)
  const uploaded = await uploadResponse.json() as { id: string; hasThumbnail?: boolean }
  expect(uploaded.hasThumbnail).toBe(true)
  const messageResponse = await messageResponsePromise
  expect(messageResponse.status()).toBe(201)
  expect((messageResponse.request().postDataJSON() as { attachments?: string[] }).attachments).toEqual([uploaded.id])
  const sent = await messageResponse.json() as { message: { id: string } }
  const originalPath = `/api/community/channels/${channelId}/attachments/${uploaded.id}`

  return {
    messageId: sent.message.id,
    originalPath,
    thumbnailPath: `${originalPath}/thumbnail`,
  }
}

test("image previews keep one frame through loading, decode, failure, retry, and mobile", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(180_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors

  const { page } = await asUser("alice")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/c")
  await page.waitForURL(/\/c/, { timeout: 20_000, waitUntil: "commit" })
  await createServer(page, `Thumbnail E2E ${Date.now()}`)
  const channelUrl = page.url()
  const channelId = new URL(channelUrl).pathname.split("/").at(-1)!
  const observedGetPaths: string[] = []
  let messagePostCount = 0
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === "GET") observedGetPaths.push(pathname)
    if (request.method() === "POST" && pathname === `/api/community/channels/${channelId}/messages`) {
      messagePostCount++
    }
  })

  let releaseColdThumbnail!: () => void
  const coldThumbnailGate = new Promise<void>((resolve) => { releaseColdThumbnail = resolve })
  caseResources.own(releaseColdThumbnail, async (captured) => { captured() })
  let holdColdThumbnail = true
  let coldThumbnailRequests = 0
  let coldThumbnailPath: string | null = null
  const thumbnailPattern = "**/api/community/channels/**/attachments/**/thumbnail"
  await page.route(thumbnailPattern, async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (
      holdColdThumbnail
      && route.request().method() === "GET"
      && pathname.startsWith(`/api/community/channels/${channelId}/attachments/`)
      && (coldThumbnailPath === null || pathname === coldThumbnailPath)
    ) {
      coldThumbnailPath = pathname
      coldThumbnailRequests++
      const response = route.fetch()
      await coldThumbnailGate
      await route.fulfill({ response: await response })
      return
    }
    await route.continue()
  })

  const landscape = await uploadImage({
    page,
    channelId,
    message: "landscape preview network gate",
    name: "landscape.webp",
    buffer: LANDSCAPE_FIXTURE,
  })
  const landscapeListImage = page.getByTestId(tid.messageImage(landscape.messageId, 0))
  await expect(landscapeListImage).toHaveAttribute("src", landscape.thumbnailPath)
  await expect.poll(() => observedGetPaths.filter((path) => path === landscape.thumbnailPath).length).toBeGreaterThan(0)
  await expect.poll(() => coldThumbnailPath).toBe(landscape.thumbnailPath)
  expect(observedGetPaths.filter((path) => path === landscape.originalPath)).toHaveLength(0)
  const landscapeListFrame = landscapeListImage.locator("xpath=ancestor::*[@data-remote-image-frame]")
  await expect(landscapeListFrame).toHaveAttribute("data-remote-image-state", "pending")
  const pendingListRect = await boundingRect(landscapeListFrame)
  expect(pendingListRect.height).toBeCloseTo(240, 0)
  expect(pendingListRect.width / pendingListRect.height).toBeCloseTo(800 / 450, 2)
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await landscapeListFrame.locator("[data-remote-image-placeholder]").evaluate((element) => (
    getComputedStyle(element).animationName
  ))).toBe("none")
  await page.emulateMedia({ reducedMotion: "no-preference" })

  let releaseLandscape!: () => void
  const landscapeGate = new Promise<void>((resolve) => { releaseLandscape = resolve })
  caseResources.own(releaseLandscape, async (captured) => { captured() })
  await page.route(`**${landscape.originalPath}`, async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === landscape.originalPath) {
      await landscapeGate
    }
    await route.continue()
  })
  const landscapeButton = page.getByRole("button", { name: "landscape.webp" })
  await landscapeButton.hover()
  await landscapeButton.click()
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-0/)
  await expect.poll(() => observedGetPaths.filter((path) => path === landscape.originalPath).length).toBe(1)
  await expect.poll(() => coldThumbnailRequests).toBeGreaterThan(0)
  await expect(page.getByTestId(tid.imageLightbox)).toBeVisible()
  await expect(page.getByTestId(tid.imageLightboxLoading)).toBeVisible()
  await expect(page.getByTestId(tid.imageLightboxThumbnail)).toHaveAttribute("src", landscape.thumbnailPath)
  await waitForDialogEntrance(page)
  const coldPendingRect = await previewRects(page, { width: 800, height: 450 })
  expect(await page.getByTestId(tid.imageLightboxThumbnail).evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    naturalWidth: element.naturalWidth,
  }))).toEqual({ complete: false, naturalWidth: 0 })

  holdColdThumbnail = false
  releaseColdThumbnail()
  await expect(landscapeListFrame).toHaveAttribute("data-remote-image-state", "ready")
  expectSameRect(await boundingRect(landscapeListFrame), pendingListRect)
  await expect(page.getByTestId(tid.imageLightbox)).toBeVisible()
  expectSameRect(await previewRects(page, { width: 800, height: 450 }).then((rects) => rects.container), coldPendingRect.container)
  await expect(page.getByTestId(tid.imageLightboxThumbnail)).toHaveClass(/opacity-100/)
  const coldThumbnailReady = await page.getByTestId(tid.imageLightboxThumbnail).evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    naturalWidth: element.naturalWidth,
  }))
  expect(coldThumbnailReady.complete).toBe(true)
  expect(coldThumbnailReady.naturalWidth).toBeGreaterThan(0)
  await attachScreenshot(testInfo, "desktop-landscape-first-visible", page)
  await page.unroute(thumbnailPattern)

  const desktopLandscapeLoading = await previewRects(page, { width: 800, height: 450 })
  const desktopNodes = await previewNodes(page)
  caseResources.own(desktopNodes, async (captured) => { await Promise.all(captured.map(({ node }) => node?.dispose())) })
  const desktopImageGets = observedGetPaths.filter((path) => path === landscape.originalPath || path === landscape.thumbnailPath)
  await attachScreenshot(testInfo, "desktop-landscape-loading", page)

  await page.setViewportSize({ width: 700, height: 600 })
  const desktopLandscapeResized = await previewRects(page, { width: 800, height: 450 })
  expect(desktopLandscapeResized.container.width).toBeLessThan(desktopLandscapeLoading.container.width)
  await attachScreenshot(testInfo, "desktop-landscape-resized-loading", page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const desktopLandscapeRestored = await previewRects(page, { width: 800, height: 450 })
  expectSameRect(desktopLandscapeRestored.container, desktopLandscapeLoading.container)

  releaseLandscape()
  const landscapeOriginal = page.getByTestId(tid.imageLightboxOriginal)
  await expect(landscapeOriginal).toHaveClass(/pointer-events-auto opacity-100/)
  await expectNativeImageContextMenu(page, landscapeOriginal, {
    src: landscape.originalPath,
    testId: tid.imageLightboxOriginal,
  })
  const desktopLandscapeLoaded = await previewRects(page, { width: 800, height: 450 })
  expectSameRect(desktopLandscapeLoaded.container, desktopLandscapeRestored.container)
  await expectSamePreviewNodes(page, desktopNodes)
  expect(observedGetPaths.filter((path) => path === landscape.originalPath || path === landscape.thumbnailPath)).toEqual(desktopImageGets)
  await attachScreenshot(testInfo, "desktop-landscape-loaded", page)
  const desktopZoomFrame = page.getByTestId(tid.imageLightbox)
  await desktopZoomFrame.hover()
  await page.mouse.wheel(0, -350)
  await expect.poll(async () => Number(await desktopZoomFrame.getAttribute("data-zoom-scale"))).toBeGreaterThan(1)
  expectSameRect(await boundingRect(desktopZoomFrame), desktopLandscapeLoaded.container)
  const desktopZoomRect = await boundingRect(landscapeOriginal)
  expect(desktopZoomRect.width).toBeGreaterThan(desktopLandscapeLoaded.original.width)
  const beforeDrag = await landscapeOriginal.evaluate((element) => element.style.transform)
  const desktopCenter = {
    x: desktopLandscapeLoaded.container.x + desktopLandscapeLoaded.container.width / 2,
    y: desktopLandscapeLoaded.container.y + desktopLandscapeLoaded.container.height / 2,
  }
  await page.mouse.move(desktopCenter.x, desktopCenter.y)
  await page.mouse.down()
  await page.mouse.move(desktopCenter.x + 70, desktopCenter.y + 40, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => landscapeOriginal.evaluate((element) => element.style.transform)).not.toBe(beforeDrag)
  await expectZoomedImage(page, { width: 800, height: 450 })
  await attachScreenshot(testInfo, "desktop-original-zoomed", page)
  await page.getByRole("button", { name: "Fit image", exact: true }).click()
  await expect(desktopZoomFrame).toHaveAttribute("data-zoom-scale", "1")
  await page.getByRole("button", { name: "Zoom out", exact: true }).click()
  const shrunken = await expectZoomedImage(page, { width: 800, height: 450 })
  expect(shrunken.scale).toBeCloseTo(2 / 3, 4)
  await page.mouse.move(desktopCenter.x, desktopCenter.y)
  await page.mouse.down()
  const outsidePoint = { x: desktopLandscapeLoaded.container.x / 2, y: desktopCenter.y }
  await page.mouse.move(outsidePoint.x, outsidePoint.y, { steps: 5 })
  await page.mouse.up()
  const freelyPanned = await expectZoomedImage(page, { width: 800, height: 450 })
  expect(freelyPanned.translation.x).toBeCloseTo(outsidePoint.x - desktopCenter.x, 1)
  expect(outsidePoint.x).toBeLessThan(freelyPanned.container.x)
  expect(outsidePoint.x).toBeGreaterThan(freelyPanned.painted.x)
  expect(outsidePoint.x).toBeLessThan(freelyPanned.painted.x + freelyPanned.painted.width)
  expect(await landscapeOriginal.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, outsidePoint)).toBe(true)
  await attachScreenshot(testInfo, "desktop-whole-image-outside-region", page)
  await page.getByRole("button", { name: "Fit image", exact: true }).click()
  for (let step = 0; step < 6; step++) await page.getByRole("button", { name: "Zoom in", exact: true }).click()
  const beyondEight = await expectZoomedImage(page, { width: 800, height: 450 })
  expect(beyondEight.scale).toBeGreaterThan(8)
  await expectToolbarAboveImage(page, beyondEight.painted)
  await attachScreenshot(testInfo, "desktop-toolbar-above-enlarged-image", page)
  await page.getByRole("button", { name: "Zoom out", exact: true }).click()
  expect(Number(await desktopZoomFrame.getAttribute("data-zoom-scale"))).toBeCloseTo(beyondEight.scale / 1.5, 4)
  await page.getByRole("button", { name: "Fit image", exact: true }).click()
  await previewRects(page, { width: 800, height: 450 })
  await desktopZoomFrame.dblclick()
  await expect(desktopZoomFrame).toHaveAttribute("data-zoom-scale", "2")
  await desktopZoomFrame.dblclick()
  await expect(desktopZoomFrame).toHaveAttribute("data-zoom-scale", "1")
  await desktopZoomFrame.focus()
  await desktopZoomFrame.press("Equal")
  await expect(desktopZoomFrame).toHaveAttribute("data-zoom-scale", "1.5")
  await desktopZoomFrame.press("Equal")
  await expect(desktopZoomFrame).toHaveAttribute("data-zoom-scale", "2.25")
  const beforeKeyboardPan = await landscapeOriginal.evaluate((element) => element.style.transform)
  await desktopZoomFrame.press("ArrowRight")
  await expect.poll(() => landscapeOriginal.evaluate((element) => element.style.transform)).not.toBe(beforeKeyboardPan)
  await expectZoomedImage(page, { width: 800, height: 450 })
  await desktopZoomFrame.press("0")
  await expect(desktopZoomFrame).toHaveAttribute("data-zoom-scale", "1")
  for (let step = 0; step < 6; step++) await desktopZoomFrame.press("Equal")
  await expectToolbarAboveImage(page, (await expectZoomedImage(page, { width: 800, height: 450 })).painted)
  await page.getByRole("button", { name: "Close image preview", exact: true }).click()
  await expect(desktopZoomFrame).toHaveCount(0)
  await landscapeButton.click()
  await expect(desktopZoomFrame).toHaveAttribute("data-zoom-scale", "1")
  await expect(landscapeOriginal).toHaveClass(/opacity-100/)
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(tid.imageLightbox)).toHaveCount(0)
  await landscapeButton.click()
  await expect(landscapeOriginal).toHaveClass(/opacity-100/)
  await waitForDialogEntrance(page)
  await page.mouse.click(1, 1)
  await expect(desktopZoomFrame).toHaveCount(0)
  await page.unroute(`**${landscape.originalPath}`)

  const portrait = await uploadImage({
    page,
    channelId,
    message: "portrait preview error gate",
    name: "portrait.webp",
    buffer: PORTRAIT_FIXTURE,
  })
  const portraitListImage = page.getByTestId(tid.messageImage(portrait.messageId, 0))
  await expect(portraitListImage).toHaveAttribute("src", portrait.thumbnailPath)
  const portraitOriginalRequests: string[] = []
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === portrait.originalPath) {
      portraitOriginalRequests.push(request.url())
    }
  })
  let releasePortraitFailure!: () => void
  const portraitFailureGate = new Promise<void>((resolve) => { releasePortraitFailure = resolve })
  caseResources.own(releasePortraitFailure, async (captured) => { captured() })
  await page.route(`**${portrait.originalPath}`, async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== portrait.originalPath) {
      await route.continue()
      return
    }
    if (portraitOriginalRequests.length === 1) {
      await portraitFailureGate
      await route.fulfill({ status: 500, contentType: "text/plain", body: "forced original failure" })
      return
    }
    await route.continue()
  })

  const portraitButton = page.getByRole("button", { name: "portrait.webp" })
  await portraitButton.hover()
  await portraitButton.click()
  await expect.poll(() => portraitOriginalRequests.length).toBe(1)
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-0/)
  await waitForDialogEntrance(page)
  const desktopPortraitLoading = await previewRects(page, { width: 450, height: 800 })
  await attachScreenshot(testInfo, "desktop-portrait-loading", page)
  releasePortraitFailure()
  await expect(page.getByTestId(tid.imageLightboxError)).toContainText("Failed to load original image")
  const portraitThumbnail = page.getByTestId(tid.imageLightboxThumbnail)
  await expect(portraitThumbnail).toBeVisible()
  await expect(portraitThumbnail).toHaveClass(/pointer-events-auto/)
  await expectNativeImageContextMenu(page, portraitThumbnail, {
    src: portrait.thumbnailPath,
    testId: tid.imageLightboxThumbnail,
  })
  await waitForDialogEntrance(page)
  const desktopPortraitFailed = {
    container: await boundingRect(page.getByTestId(tid.imageLightbox)),
    thumbnail: await boundingRect(page.getByTestId(tid.imageLightboxThumbnail)),
  }
  expectSameRect(desktopPortraitFailed.thumbnail, desktopPortraitLoading.thumbnail)
  const failedThumbnailGeometry = await previewImageGeometry(portraitThumbnail)
  expectFittedImage(failedThumbnailGeometry.painted, desktopPortraitFailed.container, { width: 450, height: 800 })
  expectSameRect(desktopPortraitFailed.container, desktopPortraitLoading.container)
  await attachScreenshot(testInfo, "desktop-portrait-failed", page)

  await page.getByTestId(tid.imageLightboxRetry).click()
  await expect.poll(() => portraitOriginalRequests.length).toBe(2)
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-100/)
  const desktopPortraitRetried = await previewRects(page, { width: 450, height: 800 })
  expectSameRect(desktopPortraitRetried.container, desktopPortraitFailed.container)
  await attachScreenshot(testInfo, "desktop-portrait-retried", page)
  expect(messagePostCount).toBe(2)
  await page.keyboard.press("Escape")
  await page.unroute(`**${portrait.originalPath}`)

  const extremeLandscape = await uploadImage({
    page,
    channelId,
    message: "extreme landscape error controls",
    name: "extreme-landscape.png",
    buffer: EXTREME_LANDSCAPE_FIXTURE,
    mimeType: "image/png",
  })
  const extremePortrait = await uploadImage({
    page,
    channelId,
    message: "extreme portrait error controls",
    name: "extreme-portrait.png",
    buffer: EXTREME_PORTRAIT_FIXTURE,
    mimeType: "image/png",
  })
  expect(messagePostCount).toBe(4)

  const { page: mobilePage } = await asUser("alice", { hasTouch: true })
  const mobilePortraitGetPaths: string[] = []
  mobilePage.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === "GET" && (pathname === portrait.originalPath || pathname === portrait.thumbnailPath)) {
      mobilePortraitGetPaths.push(pathname)
    }
  })
  await mobilePage.setViewportSize({ width: 390, height: 844 })
  await mobilePage.goto(channelUrl)
  await mobilePage.waitForURL(new RegExp(`/c/channels/[^/]+/${channelId}$`), { waitUntil: "commit" })
  await expect(mobilePage.getByTestId(tid.messageImage(landscape.messageId, 0)))
    .toBeVisible({ timeout: 30_000 })
  const mobilePortraitListFrame = mobilePage.getByTestId(tid.messageImage(portrait.messageId, 0))
    .locator("xpath=ancestor::*[@data-remote-image-frame]")
  const mobilePortraitListRect = await boundingRect(mobilePortraitListFrame)
  expect(mobilePortraitListRect.height).toBeCloseTo(200, 0)
  expect(mobilePortraitListRect.width / mobilePortraitListRect.height).toBeCloseTo(450 / 800, 2)

  let releaseMobileLandscape!: () => void
  const mobileLandscapeGate = new Promise<void>((resolve) => { releaseMobileLandscape = resolve })
  caseResources.own(releaseMobileLandscape, async (captured) => { captured() })
  let mobileLandscapeRequests = 0
  await mobilePage.route(`**${landscape.originalPath}`, async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === landscape.originalPath) {
      mobileLandscapeRequests++
      await mobileLandscapeGate
    }
    await route.continue()
  })
  await mobilePage.getByRole("button", { name: "landscape.webp" }).click()
  await expect.poll(() => mobileLandscapeRequests).toBe(1)
  await expect(mobilePage.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-0/)
  await waitForDialogEntrance(mobilePage)
  const mobileLandscapeLoading = await previewRects(mobilePage, { width: 800, height: 450 })
  await attachScreenshot(testInfo, "mobile-landscape-loading", mobilePage)
  releaseMobileLandscape()
  await expect(mobilePage.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-100/)
  const mobileLandscapeLoaded = await previewRects(mobilePage, { width: 800, height: 450 })
  expectSameRect(mobileLandscapeLoaded.container, mobileLandscapeLoading.container)
  await attachScreenshot(testInfo, "mobile-landscape-loaded", mobilePage)
  await mobilePage.keyboard.press("Escape")
  await mobilePage.unroute(`**${landscape.originalPath}`)

  let releaseMobilePortrait!: () => void
  const mobilePortraitGate = new Promise<void>((resolve) => { releaseMobilePortrait = resolve })
  caseResources.own(releaseMobilePortrait, async (captured) => { captured() })
  let mobilePortraitRequests = 0
  await mobilePage.route(`**${portrait.originalPath}`, async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === portrait.originalPath) {
      mobilePortraitRequests++
      await mobilePortraitGate
    }
    await route.continue()
  })
  await mobilePage.getByRole("button", { name: "portrait.webp" }).click()
  await expect.poll(() => mobilePortraitRequests).toBe(1)
  await expect(mobilePage.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-0/)
  await waitForDialogEntrance(mobilePage)
  const mobilePortraitLoading = await previewRects(mobilePage, { width: 450, height: 800 })
  await expect(mobilePage.getByTestId(tid.imageLightboxThumbnail)).toHaveClass(/opacity-100/)
  const mobileNodes = await previewNodes(mobilePage)
  caseResources.own(mobileNodes, async (captured) => { await Promise.all(captured.map(({ node }) => node?.dispose())) })
  const pendingMobileGets = [...mobilePortraitGetPaths]
  await attachScreenshot(testInfo, "mobile-portrait-loading", mobilePage)

  await mobilePage.setViewportSize({ width: 844, height: 390 })
  const mobilePortraitLandscapeOrientation = await previewRects(mobilePage, { width: 450, height: 800 })
  expect(mobilePortraitLandscapeOrientation.container.height).toBeLessThan(mobilePortraitLoading.container.height)
  const rotatedControls = await boundingRect(mobilePage.getByRole("toolbar", { name: "Image controls" }))
  expect(rotatedControls.y + rotatedControls.height).toBeLessThan(mobilePortraitLandscapeOrientation.container.y)
  await attachScreenshot(testInfo, "mobile-portrait-landscape-orientation-loading", mobilePage)
  await mobilePage.setViewportSize({ width: 390, height: 844 })
  const mobilePortraitRestored = await previewRects(mobilePage, { width: 450, height: 800 })
  expectSameRect(mobilePortraitRestored.container, mobilePortraitLoading.container)
  await expectSamePreviewNodes(mobilePage, mobileNodes)
  expect(mobilePortraitGetPaths).toEqual(pendingMobileGets)

  releaseMobilePortrait()
  await expect(mobilePage.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-100/)
  const mobilePortraitLoaded = await previewRects(mobilePage, { width: 450, height: 800 })
  expectSameRect(mobilePortraitLoaded.container, mobilePortraitRestored.container)
  const loadedMobileGets = [...mobilePortraitGetPaths]
  await mobilePage.setViewportSize({ width: 390, height: 700 })
  const mobilePortraitLoadedHeight = await previewRects(mobilePage, { width: 450, height: 800 })
  expect(mobilePortraitLoadedHeight.container.height).toBeLessThan(mobilePortraitLoaded.container.height)
  await expectSamePreviewNodes(mobilePage, mobileNodes)
  expect(mobilePortraitGetPaths).toEqual(loadedMobileGets)
  await mobilePage.setViewportSize({ width: 390, height: 844 })
  expectSameRect((await previewRects(mobilePage, { width: 450, height: 800 })).container, mobilePortraitLoaded.container)
  await attachScreenshot(testInfo, "mobile-portrait-loaded", mobilePage)
  const mobileZoomFrame = mobilePage.getByTestId(tid.imageLightbox)
  const mobileOriginal = mobilePage.getByTestId(tid.imageLightboxOriginal)
  const centerX = mobilePortraitLoaded.container.x + mobilePortraitLoaded.container.width / 2
  const centerY = mobilePortraitLoaded.container.y + mobilePortraitLoaded.container.height / 2
  const touchSession = await mobilePage.context().newCDPSession(mobilePage)
  try {
    const points = (gap: number) => [
      { id: 1, x: centerX - gap, y: centerY, radiusX: 1, radiusY: 1, force: 1 },
      { id: 2, x: centerX + gap, y: centerY, radiusX: 1, radiusY: 1, force: 1 },
    ]
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(40) })
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(80) })
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect.poll(async () => Number(await mobileZoomFrame.getAttribute("data-zoom-scale"))).toBeCloseTo(2, 1)
    expect(await mobilePage.evaluate(() => window.visualViewport?.scale)).toBe(1)
    const beforePan = await mobileOriginal.evaluate((element) => element.style.transform)
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: centerX, y: centerY, radiusX: 1, radiusY: 1, force: 1 }] })
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: centerX + 40, y: centerY + 30, radiusX: 1, radiusY: 1, force: 1 }] })
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect.poll(() => mobileOriginal.evaluate((element) => element.style.transform)).not.toBe(beforePan)
  } finally {
    await touchSession.detach()
  }
  expectSameRect(await boundingRect(mobileZoomFrame), mobilePortraitLoaded.container)
  const mobilePortraitZoomed = await expectZoomedImage(mobilePage, { width: 450, height: 800 })
  await expectToolbarAboveImage(mobilePage, mobilePortraitZoomed.painted)
  await mobilePage.setViewportSize({ width: 390, height: 644 })
  const mobilePortraitZoomedHeight = await expectZoomedImage(mobilePage, { width: 450, height: 800 })
  expect(mobilePortraitZoomedHeight.scale).toBeCloseTo(2, 1)
  expect(mobilePortraitZoomedHeight.translation).toEqual(mobilePortraitZoomed.translation)
  await mobilePage.setViewportSize({ width: 844, height: 390 })
  const mobilePortraitZoomedRotated = await expectZoomedImage(mobilePage, { width: 450, height: 800 })
  expect(mobilePortraitZoomedRotated.scale).toBeCloseTo(2, 1)
  expect(mobilePortraitZoomedRotated.translation).toEqual(mobilePortraitZoomed.translation)
  await mobilePage.setViewportSize({ width: 390, height: 844 })
  const mobilePortraitZoomedRestored = await expectZoomedImage(mobilePage, { width: 450, height: 800 })
  expect(mobilePortraitZoomedRestored.scale).toBeCloseTo(2, 1)
  expect(mobilePortraitZoomedRestored.translation).toEqual(mobilePortraitZoomed.translation)
  await expectToolbarAboveImage(mobilePage, mobilePortraitZoomedRestored.painted)
  expectSameRect(mobilePortraitZoomedRestored.container, mobilePortraitLoaded.container)
  await expectSamePreviewNodes(mobilePage, mobileNodes)
  await expect(mobileOriginal).toHaveClass(/opacity-100/)
  expect(mobilePortraitGetPaths).toEqual(loadedMobileGets)
  await attachScreenshot(testInfo, "mobile-original-pinched", mobilePage)
  for (const name of ["Zoom out", "Fit image", "Zoom in", "Close image preview"]) {
    const control = await boundingRect(mobilePage.getByRole("button", { name, exact: true }))
    expect(control.width).toBeGreaterThanOrEqual(44)
    expect(control.height).toBeGreaterThanOrEqual(44)
    expect(control.y).toBeGreaterThanOrEqual(0)
    expect(control.x).toBeGreaterThanOrEqual(0)
    expect(control.x + control.width).toBeLessThanOrEqual(390)
  }
  await mobilePage.getByRole("button", { name: "Fit image", exact: true }).click()
  await expect(mobileZoomFrame).toHaveAttribute("data-zoom-scale", "1")
  expectSameRect(await boundingRect(mobileOriginal), mobilePortraitLoaded.original)
  await mobilePage.getByRole("button", { name: "Close image preview", exact: true }).click()
  await expect(mobilePage.getByTestId(tid.imageLightbox)).toHaveCount(0)

  async function assertExtremeFailure(args: {
    attachment: typeof extremeLandscape
    buttonName: string
    screenshotName: string
  }) {
    const { attachment, buttonName, screenshotName } = args
    let requests = 0
    await mobilePage.route(`**${attachment.originalPath}`, async (route) => {
      if (route.request().method() === "GET" && new URL(route.request().url()).pathname === attachment.originalPath) {
        requests++
        await route.fulfill({ status: 500, contentType: "text/plain", body: "forced extreme failure" })
        return
      }
      await route.continue()
    })

    await mobilePage.getByRole("button", { name: buttonName }).click()
    await expect.poll(() => requests).toBe(1)
    await expect(mobilePage.getByTestId(tid.imageLightboxError)).toBeVisible()
    const frame = await boundingRect(mobilePage.getByTestId(tid.imageLightbox))
    const error = await boundingRect(mobilePage.getByTestId(tid.imageLightboxError))
    const retry = await boundingRect(mobilePage.getByTestId(tid.imageLightboxRetry))
    expect(retry.width).toBeGreaterThanOrEqual(44)
    expect(retry.height).toBeGreaterThanOrEqual(44)
    expect(error.x).toBeGreaterThanOrEqual(0)
    expect(error.y).toBeGreaterThanOrEqual(0)
    expect(error.x + error.width).toBeLessThanOrEqual(390)
    expect(error.y + error.height).toBeLessThanOrEqual(844)
    await attachScreenshot(testInfo, screenshotName, mobilePage)
    await mobilePage.keyboard.press("Escape")
    await mobilePage.unroute(`**${attachment.originalPath}`)
    return { frame, error, retry }
  }

  const mobileExtremeLandscapeFailed = await assertExtremeFailure({
    attachment: extremeLandscape,
    buttonName: "extreme-landscape.png",
    screenshotName: "mobile-extreme-landscape-failed",
  })
  const mobileExtremePortraitFailed = await assertExtremeFailure({
    attachment: extremePortrait,
    buttonName: "extreme-portrait.png",
    screenshotName: "mobile-extreme-portrait-failed",
  })

  await testInfo.attach("image-preview-rects.json", {
    body: Buffer.from(JSON.stringify({
      desktopLandscapeLoading,
      desktopLandscapeResized,
      desktopLandscapeRestored,
      desktopLandscapeLoaded,
      desktopPortraitLoading,
      desktopPortraitFailed,
      desktopPortraitRetried,
      mobileLandscapeLoading,
      mobileLandscapeLoaded,
      mobilePortraitLoading,
      mobilePortraitLandscapeOrientation,
      mobilePortraitRestored,
      mobilePortraitLoaded,
      mobilePortraitLoadedHeight,
      mobilePortraitZoomedHeight,
      mobilePortraitZoomedRotated,
      mobilePortraitZoomedRestored,
      mobileExtremeLandscapeFailed,
      mobileExtremePortraitFailed,
    }, null, 2)),
    contentType: "application/json",
  })
})
