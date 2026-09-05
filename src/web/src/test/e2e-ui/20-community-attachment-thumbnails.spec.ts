import type { Locator, Page, TestInfo } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable, createServer } from "./_fixtures/actions"
import { solidPngFixture } from "../fixtures/media"

const LANDSCAPE_FIXTURE = solidPngFixture(800, 450, [91, 110, 225])
const PORTRAIT_FIXTURE = solidPngFixture(450, 800, [225, 91, 142])
const EXTREME_LANDSCAPE_FIXTURE = solidPngFixture(4000, 100, [91, 110, 225])
const EXTREME_PORTRAIT_FIXTURE = solidPngFixture(100, 4000, [225, 91, 142])

type Rect = { x: number; y: number; width: number; height: number }

async function boundingRect(locator: Locator): Promise<Rect> {
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  return rect!
}

function expectSameRect(actual: Rect, expected: Rect) {
  expect(actual.x).toBeCloseTo(expected.x, 1)
  expect(actual.y).toBeCloseTo(expected.y, 1)
  expect(actual.width).toBeCloseTo(expected.width, 1)
  expect(actual.height).toBeCloseTo(expected.height, 1)
}

function expectWithinPreviewViewport(rect: Rect, viewport: { width: number; height: number }) {
  expect(rect.width).toBeLessThanOrEqual(viewport.width * 0.9 + 0.5)
  expect(rect.height).toBeLessThanOrEqual(viewport.height * 0.85 + 0.5)
}

async function previewRects(page: Page) {
  const container = await boundingRect(page.getByTestId(tid.imageLightbox))
  const thumbnail = await boundingRect(page.getByTestId(tid.imageLightboxThumbnail))
  const original = await boundingRect(page.getByTestId(tid.imageLightboxOriginal))
  expectSameRect(thumbnail, container)
  expectSameRect(original, container)
  return { container, thumbnail, original }
}

async function waitForDialogEntrance(page: Page) {
  const lightbox = page.getByTestId(tid.imageLightbox)
  await expect(lightbox).toBeVisible()
  await lightbox.evaluate((element, ids) => {
    const dialog = element.closest<HTMLElement>("[data-slot='dialog-content']")
    if (!dialog) throw new Error("lightbox dialog content disappeared")
    return Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished))
      .then(() => new Promise<void>((resolveStable, rejectStable) => {
        let previous = ""
        let unchangedFrames = 0
        let observedFrames = 0
        const sample = () => {
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
          unchangedFrames = current === previous ? unchangedFrames + 1 : 0
          previous = current
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
      }))
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

test("image previews keep one frame through loading, decode, failure, retry, and mobile", async ({ asUser }, testInfo) => {
  test.setTimeout(180_000)
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
  let holdColdThumbnail = true
  let coldThumbnailRequests = 0
  const thumbnailPattern = "**/api/community/channels/**/attachments/**/thumbnail"
  await page.route(thumbnailPattern, async (route) => {
    if (holdColdThumbnail && route.request().method() === "GET") {
      coldThumbnailRequests++
      await coldThumbnailGate
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
  expect(observedGetPaths.filter((path) => path === landscape.originalPath)).toHaveLength(0)
  const landscapeListFrame = landscapeListImage.locator("xpath=ancestor::*[@data-remote-image-frame]")
  await expect(landscapeListFrame).toHaveAttribute("data-remote-image-state", "pending")
  const pendingListRect = await boundingRect(landscapeListFrame)
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await landscapeListFrame.locator("[data-remote-image-placeholder]").evaluate((element) => (
    getComputedStyle(element).animationName
  ))).toBe("none")
  await page.emulateMedia({ reducedMotion: "no-preference" })

  let releaseLandscape!: () => void
  const landscapeGate = new Promise<void>((resolve) => { releaseLandscape = resolve })
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
  await expect(page.getByTestId(tid.imageLightbox)).toBeHidden()
  expect(await page.getByTestId(tid.imageLightboxThumbnail).evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    naturalWidth: element.naturalWidth,
  }))).toEqual({ complete: false, naturalWidth: 0 })

  holdColdThumbnail = false
  releaseColdThumbnail()
  await expect(landscapeListFrame).toHaveAttribute("data-remote-image-state", "ready")
  expectSameRect(await boundingRect(landscapeListFrame), pendingListRect)
  await expect(page.getByTestId(tid.imageLightbox)).toBeVisible()
  const coldThumbnailReady = await page.getByTestId(tid.imageLightboxThumbnail).evaluate((element: HTMLImageElement) => ({
    complete: element.complete,
    naturalWidth: element.naturalWidth,
  }))
  expect(coldThumbnailReady.complete).toBe(true)
  expect(coldThumbnailReady.naturalWidth).toBeGreaterThan(0)
  await expect(page.getByTestId(tid.imageLightboxThumbnail)).toHaveClass(/opacity-100/)
  await attachScreenshot(testInfo, "desktop-landscape-first-visible", page)
  await page.unroute(thumbnailPattern)

  await waitForDialogEntrance(page)
  const desktopLandscapeLoading = await previewRects(page)
  expectWithinPreviewViewport(desktopLandscapeLoading.container, { width: 1280, height: 900 })
  await attachScreenshot(testInfo, "desktop-landscape-loading", page)

  await page.setViewportSize({ width: 700, height: 600 })
  const desktopLandscapeResized = await previewRects(page)
  expectWithinPreviewViewport(desktopLandscapeResized.container, { width: 700, height: 600 })
  expect(desktopLandscapeResized.container.width).toBeLessThan(desktopLandscapeLoading.container.width)
  await attachScreenshot(testInfo, "desktop-landscape-resized-loading", page)
  await page.setViewportSize({ width: 1280, height: 900 })
  const desktopLandscapeRestored = await previewRects(page)
  expectSameRect(desktopLandscapeRestored.container, desktopLandscapeLoading.container)

  releaseLandscape()
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-100/)
  const desktopLandscapeLoaded = await previewRects(page)
  expectSameRect(desktopLandscapeLoaded.container, desktopLandscapeRestored.container)
  await attachScreenshot(testInfo, "desktop-landscape-loaded", page)
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(tid.imageLightbox)).toHaveCount(0)
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
  const desktopPortraitLoading = await previewRects(page)
  await attachScreenshot(testInfo, "desktop-portrait-loading", page)
  releasePortraitFailure()
  await expect(page.getByTestId(tid.imageLightboxError)).toContainText("Failed to load original image")
  await expect(page.getByTestId(tid.imageLightboxThumbnail)).toBeVisible()
  await waitForDialogEntrance(page)
  const desktopPortraitFailed = {
    container: await boundingRect(page.getByTestId(tid.imageLightbox)),
    thumbnail: await boundingRect(page.getByTestId(tid.imageLightboxThumbnail)),
  }
  expectSameRect(desktopPortraitFailed.thumbnail, desktopPortraitFailed.container)
  expectSameRect(desktopPortraitFailed.container, desktopPortraitLoading.container)
  await attachScreenshot(testInfo, "desktop-portrait-failed", page)

  await page.getByTestId(tid.imageLightboxRetry).click()
  await expect.poll(() => portraitOriginalRequests.length).toBe(2)
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-100/)
  const desktopPortraitRetried = await previewRects(page)
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

  const { page: mobilePage } = await asUser("alice")
  await mobilePage.setViewportSize({ width: 390, height: 844 })
  await mobilePage.goto(channelUrl)
  await mobilePage.waitForURL(new RegExp(`/c/channels/[^/]+/${channelId}$`), { waitUntil: "commit" })
  await expect(mobilePage.getByTestId(tid.messageImage(landscape.messageId, 0))).toBeVisible()

  let releaseMobileLandscape!: () => void
  const mobileLandscapeGate = new Promise<void>((resolve) => { releaseMobileLandscape = resolve })
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
  const mobileLandscapeLoading = await previewRects(mobilePage)
  expectWithinPreviewViewport(mobileLandscapeLoading.container, { width: 390, height: 844 })
  await attachScreenshot(testInfo, "mobile-landscape-loading", mobilePage)
  releaseMobileLandscape()
  await expect(mobilePage.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-100/)
  const mobileLandscapeLoaded = await previewRects(mobilePage)
  expectSameRect(mobileLandscapeLoaded.container, mobileLandscapeLoading.container)
  await attachScreenshot(testInfo, "mobile-landscape-loaded", mobilePage)
  await mobilePage.keyboard.press("Escape")
  await mobilePage.unroute(`**${landscape.originalPath}`)

  let releaseMobilePortrait!: () => void
  const mobilePortraitGate = new Promise<void>((resolve) => { releaseMobilePortrait = resolve })
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
  const mobilePortraitLoading = await previewRects(mobilePage)
  expectWithinPreviewViewport(mobilePortraitLoading.container, { width: 390, height: 844 })
  await attachScreenshot(testInfo, "mobile-portrait-loading", mobilePage)

  await mobilePage.setViewportSize({ width: 844, height: 390 })
  const mobilePortraitLandscapeOrientation = await previewRects(mobilePage)
  expectWithinPreviewViewport(mobilePortraitLandscapeOrientation.container, { width: 844, height: 390 })
  expect(mobilePortraitLandscapeOrientation.container.height).toBeLessThan(mobilePortraitLoading.container.height)
  await attachScreenshot(testInfo, "mobile-portrait-landscape-orientation-loading", mobilePage)
  await mobilePage.setViewportSize({ width: 390, height: 844 })
  const mobilePortraitRestored = await previewRects(mobilePage)
  expectSameRect(mobilePortraitRestored.container, mobilePortraitLoading.container)

  releaseMobilePortrait()
  await expect(mobilePage.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/opacity-100/)
  const mobilePortraitLoaded = await previewRects(mobilePage)
  expectSameRect(mobilePortraitLoaded.container, mobilePortraitRestored.container)
  await attachScreenshot(testInfo, "mobile-portrait-loaded", mobilePage)
  await mobilePage.keyboard.press("Escape")
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
      mobileExtremeLandscapeFailed,
      mobileExtremePortraitFailed,
    }, null, 2)),
    contentType: "application/json",
  })
})
