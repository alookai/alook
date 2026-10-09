import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "./_fixtures/community-fixture"
import type { Locator, Page } from "@playwright/test"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { createInvite, seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type CaptureKind = "clipboard" | "download"
type SamplePoint = { x: number; y: number }
type MobileShareTestState = {
  calls: Array<{ command: string; attemptId: string; filename?: string }>
  finish: (index: number, destination: "clipboard" | "pictures") => void
}

const TWO_FRAME_GIF_BASE64 = "R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQIFAAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQIFAAAACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7"

async function solidPng(page: Page, color: string, width: number, height: number) {
  return page.evaluate(async ({ fill, targetWidth, targetHeight }) => {
    const canvas = document.createElement("canvas")
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext("2d")!
    context.fillStyle = fill
    context.fillRect(0, 0, targetWidth, targetHeight)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("PNG encode failed")),
      "image/png",
    ))
    return [...new Uint8Array(await blob.arrayBuffer())]
  }, { fill: color, targetWidth: width, targetHeight: height })
}

async function waitForLoadedImages(root: Locator): Promise<void> {
  await expect.poll(() => root.locator("img").evaluateAll((images: HTMLImageElement[]) => (
    images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)
  ))).toBe(true)
  await root.locator("img").evaluateAll((images: HTMLImageElement[]) => (
    Promise.all(images.map((image) => image.decode()))
  ))
}

async function reloadWithUnavailableImage(page: Page, route: string, image: Locator): Promise<void> {
  await gotoAfterUserWsAuth(page, route)
  await expect(image).toBeAttached()
  const source = await image.getAttribute("src")
  expect(source).toBeTruthy()
  expect(await page.evaluate((src) => {
    const url = new URL(src!, location.href).href
    return [...document.images].filter((candidate) => (
      (candidate.currentSrc || candidate.src) === url
      && candidate.complete
      && candidate.naturalWidth > 0
    )).length
  }, source)).toBe(0)
}

async function uploadAvatar(page: Page, color = "rgb(220, 35, 60)"): Promise<void> {
  const bytes = await solidPng(page, color, 48, 48)
  const status = await page.evaluate(async (png) => {
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "avatar.png")
    return (await fetch("/api/community/users/me/avatar", {
      method: "POST",
      body: form,
      credentials: "include",
    })).status
  }, bytes)
  expect(status).toBe(200)
}

async function seedMessage(
  page: Page,
  channelId: string,
  content: string,
  attachmentIds: string[] = [],
) {
  const result = await page.evaluate(async ({ targetId, body, attachments }) => {
    const response = await fetch(`/api/community/channels/${targetId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: body,
        attachments,
        nonce: `e2e:${crypto.randomUUID()}`,
      }),
    })
    const payload = await response.json() as { message: { id: string; createdAt: string } }
    return { status: response.status, ...payload.message }
  }, { targetId: channelId, body: content, attachments: attachmentIds })
  expect(result.status).toBe(201)
  return result
}

async function uploadAttachment(page: Page, channelId: string) {
  const bytes = await solidPng(page, "rgb(20, 105, 220)", 96, 64)
  const result = await page.evaluate(async ({ targetId, png }) => {
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "blue.png")
    const response = await fetch(`/api/community/channels/${targetId}/attachments`, {
      method: "POST",
      body: form,
      credentials: "include",
    })
    const payload = await response.json() as { id: string }
    return { status: response.status, id: payload.id }
  }, { targetId: channelId, png: bytes })
  expect(result.status).toBe(200)
  return result.id
}

async function uploadAnimatedAttachment(page: Page, channelId: string) {
  const result = await page.evaluate(async ({ targetId, base64 }) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const form = new FormData()
    form.append("file", new Blob([bytes], { type: "image/gif" }), "red-blue.gif")
    const response = await fetch(`/api/community/channels/${targetId}/attachments`, {
      method: "POST",
      body: form,
      credentials: "include",
    })
    const payload = await response.json() as { id: string }
    return { status: response.status, id: payload.id }
  }, { targetId: channelId, base64: TWO_FRAME_GIF_BASE64 })
  expect(result.status).toBe(200)
  return result.id
}

async function uploadServerIcon(page: Page, serverId: string): Promise<void> {
  const bytes = await solidPng(page, "rgb(25, 180, 80)", 64, 64)
  const status = await page.evaluate(async ({ targetId, png }) => {
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "icon.png")
    return (await fetch(`/api/community/servers/${targetId}/icon`, {
      method: "POST",
      body: form,
      credentials: "include",
    })).status
  }, { targetId: serverId, png: bytes })
  expect(status).toBe(200)
}

async function openShareDialog(page: Page, messageId: string): Promise<Locator> {
  const row = page.getByTestId(tid.message(messageId))
  await expect(row).toBeVisible()
  await row.hover()
  await page.getByTestId(tid.messageShare(messageId)).click()
  await page.getByRole("button", { name: "Share 1 selected messages as image" }).click()
  const dialog = page.getByRole("dialog", { name: "Share message" })
  await expect(dialog).toBeVisible()
  return dialog
}

async function waitForReady(dialog: Locator): Promise<Locator> {
  const card = dialog.locator("[data-share-card]")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByRole("button", { name: "Copy image" })).toBeEnabled()
  return card
}

async function installShareCapture(page: Page, rejectFirstClipboard = false): Promise<void> {
  await page.evaluate((rejectFirst) => {
    const captureWindow = window as typeof window & {
      __shareCaptures?: { clipboard: Blob[]; clipboardAttempts: number; download: Blob[] }
    }
    captureWindow.__shareCaptures = { clipboard: [], clipboardAttempts: 0, download: [] }
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL)
    URL.createObjectURL = ((value: Blob | MediaSource) => {
      if (value instanceof Blob && value.type === "image/png") {
        captureWindow.__shareCaptures!.download.push(value)
      }
      return nativeCreateObjectUrl(value)
    }) as typeof URL.createObjectURL
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          const captures = captureWindow.__shareCaptures!
          captures.clipboardAttempts += 1
          if (rejectFirst && captures.clipboardAttempts === 1) {
            throw new Error("clipboard denied by test")
          }
          captures.clipboard.push(await items[0]!.getType("image/png"))
        },
      },
    })
  }, rejectFirstClipboard)
}

async function captureCounts(page: Page) {
  return page.evaluate(() => {
    const captures = (window as typeof window & {
      __shareCaptures?: { clipboard: Blob[]; download: Blob[] }
    }).__shareCaptures
    return {
      clipboard: captures?.clipboard.length ?? 0,
      download: captures?.download.length ?? 0,
    }
  })
}

async function clipboardAttempts(page: Page) {
  return page.evaluate(() => (window as typeof window & {
    __shareCaptures?: { clipboardAttempts: number }
  }).__shareCaptures?.clipboardAttempts ?? 0)
}

async function installMobileShareNativeStub(page: Page): Promise<void> {
  await page.evaluate(() => {
    const completions: Array<(value: Record<string, unknown>) => void> = []
    const state: MobileShareTestState = {
      calls: [],
      finish(index, destination) {
        const call = this.calls[index]
        if (!call) throw new Error(`Missing mobile share call ${index}`)
        completions[index]?.({
          attemptId: call.attemptId,
          status: destination === "clipboard" ? "copied" : "saved",
          destination,
        })
      },
    }
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "iPhone",
    })
    Object.defineProperty(window, "__mobileShareTestState", {
      configurable: true,
      value: state,
    })
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke: (command: string, args: {
            payload: { attemptId: string; filename?: string }
          }) => new Promise((resolve) => {
            state.calls.push({
              command,
              attemptId: args.payload.attemptId,
              filename: args.payload.filename,
            })
            completions.push(resolve)
          }),
        },
      },
    })
  })
}

async function mobileShareCalls(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __mobileShareTestState: MobileShareTestState }
  ).__mobileShareTestState.calls)
}

async function finishMobileShareCall(
  page: Page,
  index: number,
  destination: "clipboard" | "pictures",
): Promise<void> {
  await page.evaluate(({ callIndex, resultDestination }) => {
    const state = (
      window as typeof window & { __mobileShareTestState: MobileShareTestState }
    ).__mobileShareTestState
    state.finish(callIndex, resultDestination)
  }, { callIndex: index, resultDestination: destination })
}

async function captureDigest(page: Page, kind: CaptureKind, index: number) {
  return page.evaluate(async ({ captureKind, captureIndex }) => {
    const blob = (window as typeof window & {
      __shareCaptures?: { clipboard: Blob[]; download: Blob[] }
    }).__shareCaptures?.[captureKind][captureIndex]
    if (!blob) throw new Error(`Missing ${captureKind} capture ${captureIndex}`)
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
  }, { captureKind: kind, captureIndex: index })
}

async function capturePixel(
  page: Page,
  kind: CaptureKind,
  index: number,
  point: SamplePoint,
) {
  return page.evaluate(async ({ captureKind, captureIndex, sample }) => {
    const blob = (window as typeof window & {
      __shareCaptures?: { clipboard: Blob[]; download: Blob[] }
    }).__shareCaptures?.[captureKind][captureIndex]
    if (!blob) throw new Error(`Missing ${captureKind} capture ${captureIndex}`)
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext("2d")!
    context.drawImage(bitmap, 0, 0)
    const pixel = [...context.getImageData(Math.round(sample.x), Math.round(sample.y), 1, 1).data]
    const result = { pixel, width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return result
  }, { captureKind: kind, captureIndex: index, sample: point })
}

async function comparePreviewToCapture(
  page: Page,
  card: Locator,
  captureIndex: number,
  regionSelector?: string,
) {
  const region = await card.evaluate((node, selector) => {
    const cardRect = node.getBoundingClientRect()
    const rect = selector ? node.querySelector(selector)!.getBoundingClientRect() : cardRect
    return {
      left: (rect.left - cardRect.left) / cardRect.width,
      top: (rect.top - cardRect.top) / cardRect.height,
      right: (rect.right - cardRect.left) / cardRect.width,
      bottom: (rect.bottom - cardRect.top) / cardRect.height,
    }
  }, regionSelector)
  const screenshot = await card.screenshot({ animations: "disabled" })
  return page.evaluate(async ({ previewBase64, index, region }) => {
    const captured = (window as typeof window & {
      __shareCaptures?: { clipboard: Blob[] }
    }).__shareCaptures?.clipboard[index]
    if (!captured) throw new Error(`Missing clipboard capture ${index}`)
    const binary = atob(previewBase64)
    const previewBytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) previewBytes[i] = binary.charCodeAt(i)
    const [preview, exported] = await Promise.all([
      createImageBitmap(new Blob([previewBytes], { type: "image/png" })),
      createImageBitmap(captured),
    ])
    const previewCanvas = document.createElement("canvas")
    previewCanvas.width = exported.width
    previewCanvas.height = exported.height
    const previewContext = previewCanvas.getContext("2d")!
    previewContext.drawImage(preview, 0, 0, exported.width, exported.height)
    const exportCanvas = document.createElement("canvas")
    exportCanvas.width = exported.width
    exportCanvas.height = exported.height
    const exportContext = exportCanvas.getContext("2d")!
    exportContext.drawImage(exported, 0, 0)
    const previewPixels = previewContext.getImageData(0, 0, exported.width, exported.height).data
    const exportPixels = exportContext.getImageData(0, 0, exported.width, exported.height).data
    let difference = 0
    let samples = 0
    for (let y = Math.ceil(region.top * exported.height); y < region.bottom * exported.height; y += 1) {
      for (let x = Math.ceil(region.left * exported.width); x < region.right * exported.width; x += 1) {
        const offset = (y * exported.width + x) * 4
        difference += Math.abs(previewPixels[offset]! - exportPixels[offset]!)
        difference += Math.abs(previewPixels[offset + 1]! - exportPixels[offset + 1]!)
        difference += Math.abs(previewPixels[offset + 2]! - exportPixels[offset + 2]!)
        samples += 3
      }
    }
    const result = {
      previewWidth: preview.width,
      previewHeight: preview.height,
      exportWidth: exported.width,
      exportHeight: exported.height,
      meanChannelDifference: difference / samples,
    }
    preview.close()
    exported.close()
    return result
  }, { previewBase64: screenshot.toString("base64"), index: captureIndex, region })
}

function sampleCenter(card: Locator, selector: string): Promise<SamplePoint> {
  return card.evaluate((cardNode, selector) => {
    const targetNode = cardNode.querySelector(selector)
    if (!targetNode) throw new Error(`Missing ${selector}`)
    const cardRect = cardNode.getBoundingClientRect()
    const targetRect = targetNode.getBoundingClientRect()
    return {
      x: (targetRect.left - cardRect.left + targetRect.width / 2) * 2,
      y: (targetRect.top - cardRect.top + targetRect.height / 2) * 2,
    }
  }, selector)
}

test("share image timestamp matches the live row and survives both exports", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share timestamp ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-timestamp")
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const seeded = await seedMessage(page, channelId, "Share timestamp parity")
  const expectedTimestamp = await page.evaluate((createdAt) => (
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      .format(new Date(createdAt))
  ), seeded.createdAt)
  await expect(page.getByTestId(tid.message(seeded.id))).toContainText(expectedTimestamp)
  await installShareCapture(page)

  const dialog = await openShareDialog(page, seeded.id)
  const card = await waitForReady(dialog)
  await expect(card.locator("[data-share-timestamp]")).toHaveText(expectedTimestamp)
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  const downloadStarted = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  await downloadStarted

  await expect.poll(() => captureCounts(page)).toEqual({ clipboard: 1, download: 1 })
  await expect(card.locator("[data-share-timestamp]")).toHaveText(expectedTimestamp)
})

test("mobile routing waits for native copy and save terminal receipts", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Mobile share receipt ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "mobile-share-receipt")
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const seeded = await seedMessage(page, channelId, "Native receipt controls success")
  await installMobileShareNativeStub(page)

  const dialog = await openShareDialog(page, seeded.id)
  await waitForReady(dialog)
  const copy = dialog.getByRole("button", { name: "Copy image" })
  const save = dialog.getByRole("button", { name: "Save image" })
  await expect(dialog.getByRole("button", { name: "Download" })).toHaveCount(0)

  await copy.click()
  await expect.poll(() => mobileShareCalls(page)).toHaveLength(1)
  await expect(copy).toBeDisabled()
  await expect(save).toBeDisabled()
  await expect(page.getByText("Image copied to clipboard", { exact: true })).toHaveCount(0)
  await finishMobileShareCall(page, 0, "clipboard")
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()

  await save.click()
  await expect.poll(() => mobileShareCalls(page)).toHaveLength(2)
  await expect(page.getByText("Saved to Pictures/Alook", { exact: true })).toHaveCount(0)
  await finishMobileShareCall(page, 1, "pictures")
  await expect(page.getByText("Saved to Pictures/Alook", { exact: true })).toBeVisible()
  expect(await mobileShareCalls(page)).toEqual([
    expect.objectContaining({ command: "mobile_share_image_copy" }),
    expect.objectContaining({
      command: "mobile_share_image_save",
      filename: expect.stringMatching(/^alook-message-.+\.png$/),
    }),
  ])
})

test("a loaded two-frame GIF is frozen to a displayed frame and reused by both exports", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Animated share ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "animated-share")
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const attachmentId = await uploadAnimatedAttachment(page, channelId)
  const seeded = await seedMessage(page, channelId, "The displayed animation frame stays immutable", [attachmentId])
  const row = page.getByTestId(tid.message(seeded.id))
  await waitForLoadedImages(row)
  const animatedSource = await row.getByTestId(tid.messageImage(seeded.id, 0)).evaluate((image: HTMLImageElement) => image.currentSrc || image.src)
  const assetRequests: string[] = []
  await page.route(animatedSource, async (route) => {
    assetRequests.push(route.request().url())
    await route.abort("failed")
  })
  await installShareCapture(page)

  const dialog = await openShareDialog(page, seeded.id)
  const card = await waitForReady(dialog)
  const image = card.getByTestId(tid.messageShareImage(seeded.id, 0))
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/)
  const before = await image.screenshot({ animations: "allow" })
  await page.waitForTimeout(500)
  const after = await image.screenshot({ animations: "allow" })
  expect(after.equals(before)).toBe(true)
  const point = await sampleCenter(card, `[data-testid="${tid.messageShareImage(seeded.id, 0)}"]`)

  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  const downloadStarted = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  await downloadStarted
  await expect.poll(() => captureCounts(page)).toEqual({ clipboard: 1, download: 1 })

  expect(await captureDigest(page, "clipboard", 0)).toBe(await captureDigest(page, "download", 0))
  const copied = await capturePixel(page, "clipboard", 0, point)
  const downloaded = await capturePixel(page, "download", 0, point)
  const isRed = copied.pixel[0]! > 200 && copied.pixel[1]! < 40 && copied.pixel[2]! < 40
  const isBlue = copied.pixel[0]! < 40 && copied.pixel[1]! < 40 && copied.pixel[2]! > 200
  expect(isRed || isBlue).toBe(true)
  expect(copied.pixel[3]).toBe(255)
  expect(downloaded.pixel).toEqual(copied.pixel)
  expect(assetRequests).toEqual([])
})

test("loaded avatar and content prepare and export without requesting or decoding source assets again", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share byte session ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-byte-session")
  const inviteToken = await createInvite("alice", serverId)
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  await uploadAvatar(page)
  await uploadServerIcon(page, serverId)
  const attachmentId = await uploadAttachment(page, channelId)
  const seeded = await seedMessage(
    page,
    channelId,
    `Loaded avatar, attachment, markdown, invite, and inline logo\n![Inline blue](/api/community/channels/${channelId}/attachments/${attachmentId})\n/c/invite/${inviteToken}`,
    [attachmentId],
  )
  const row = page.getByTestId(tid.message(seeded.id))
  await expect(row.getByTestId(tid.inviteCard(inviteToken))).toBeVisible()
  await waitForLoadedImages(row)
  const originals = await row.locator("img").elementHandles()
  const sourceUrls = await row.locator("img").evaluateAll((images: HTMLImageElement[]) => (
    [...new Set(images.map((image) => image.currentSrc || image.src))]
  ))
  const blockedAssetRequests: string[] = []
  for (const sourceUrl of sourceUrls) {
    await page.route(sourceUrl, async (requestRoute) => {
      blockedAssetRequests.push(requestRoute.request().url())
      await requestRoute.abort("failed")
    })
  }
  await page.evaluate((urls) => {
    const tracked = new Set(urls)
    const state = { imageDecodeSources: [] as string[], bitmapSourceDecodes: 0 }
    Object.defineProperty(window, "__shareSourceDecodes", { configurable: true, value: state })
    const nativeDecode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = function () {
      const url = this.currentSrc || this.src
      if (tracked.has(url)) state.imageDecodeSources.push(url)
      return nativeDecode.call(this)
    }
    const nativeBitmap = window.createImageBitmap.bind(window)
    window.createImageBitmap = ((source: ImageBitmapSource, ...args: unknown[]) => {
      if (source instanceof HTMLImageElement && tracked.has(source.currentSrc || source.src)) {
        state.bitmapSourceDecodes += 1
      }
      return Reflect.apply(nativeBitmap, window, [source, ...args])
    }) as typeof createImageBitmap
  }, sourceUrls)
  await installShareCapture(page)

  const dialog = await openShareDialog(page, seeded.id)
  const card = await waitForReady(dialog)
  const images = await card.locator("img").evaluateAll((nodes: HTMLImageElement[]) => (
    nodes.map((node) => node.currentSrc || node.src)
  ))
  expect(images.length).toBeGreaterThanOrEqual(4)
  expect(images.every((source) => source.startsWith("data:image/"))).toBe(true)
  await expect(card.locator('img[src="/alook.svg"]')).toHaveCount(0)
  await expect(card.getByTestId(tid.alookLogo)).toBeVisible()
  expect(blockedAssetRequests).toEqual([])

  const avatarPoint = await sampleCenter(card, "[data-share-identity-id]")
  const attachmentPoint = await sampleCenter(
    card,
    `[data-testid="${tid.messageShareImage(seeded.id, 0)}"]`,
  )
  const markdownPoint = await sampleCenter(card, 'img[alt="Inline blue"]')
  const invitePoint = await sampleCenter(
    card,
    `[data-testid="${tid.inviteCard(inviteToken)}"] img`,
  )
  const networkAfterReady: string[] = []
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (
      request.resourceType() === "font"
      || /avatar|attachments|\/icon|share-image/.test(pathname)
    ) networkAfterReady.push(pathname)
  })

  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  const downloadStarted = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  const download = await downloadStarted
  expect(download.suggestedFilename()).toMatch(/^alook-message-.+\.png$/)
  const exportPath = testInfo.outputPath("warm-source-share.png")
  await download.saveAs(exportPath)
  await testInfo.attach("warm-source-share", { path: exportPath, contentType: "image/png" })
  await expect.poll(() => captureCounts(page)).toEqual({ clipboard: 1, download: 1 })

  expect(networkAfterReady).toEqual([])
  expect(blockedAssetRequests).toEqual([])
  expect(await page.evaluate(() => (
    window as typeof window & {
      __shareSourceDecodes: { imageDecodeSources: string[]; bitmapSourceDecodes: number }
    }
  ).__shareSourceDecodes)).toEqual({ imageDecodeSources: [], bitmapSourceDecodes: 0 })
  expect(await captureDigest(page, "clipboard", 0)).toBe(await captureDigest(page, "download", 0))
  const avatar = await capturePixel(page, "clipboard", 0, avatarPoint)
  const attachment = await capturePixel(page, "clipboard", 0, attachmentPoint)
  const invite = await capturePixel(page, "clipboard", 0, invitePoint)
  const markdown = await capturePixel(page, "clipboard", 0, markdownPoint)
  expect(avatar.pixel[0]).toBeGreaterThan(180)
  expect(avatar.pixel[1]).toBeLessThan(80)
  expect(attachment.pixel[2]).toBeGreaterThan(180)
  expect(invite.pixel[1]).toBeGreaterThan(140)
  expect(markdown.pixel[2]).toBeGreaterThan(180)
  expect((await capturePixel(page, "download", 0, avatarPoint)).pixel).toEqual(avatar.pixel)
  expect((await capturePixel(page, "download", 0, attachmentPoint)).pixel).toEqual(attachment.pixel)
  expect((await capturePixel(page, "download", 0, invitePoint)).pixel).toEqual(invite.pixel)
  expect((await capturePixel(page, "download", 0, markdownPoint)).pixel).toEqual(markdown.pixel)
  const box = await card.boundingBox()
  expect(Math.abs(avatar.width - box!.width * 2)).toBeLessThanOrEqual(2)
  expect(Math.abs(avatar.height - box!.height * 2)).toBeLessThanOrEqual(2)
  await page.keyboard.press("Escape")
  for (const original of originals) {
    expect(await original.evaluate((image) => image.isConnected && (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true)
  }
  expect(blockedAssetRequests).toEqual([])

  const reopened = await openShareDialog(page, seeded.id)
  const frozenCard = await waitForReady(reopened)
  const frozenMarkup = await frozenCard.innerHTML()
  const liveAvatar = row.locator('[data-slot="avatar-image"]')
  const previousAvatarSrc = await liveAvatar.getAttribute("src")
  expect(previousAvatarSrc).toBeTruthy()
  await uploadAvatar(page, "rgb(30, 190, 100)")
  await expect(liveAvatar).not.toHaveAttribute("src", previousAvatarSrc!)
  expect(await frozenCard.innerHTML()).toBe(frozenMarkup)
})

test("loaded cross-origin pixels without CORS require the explicit fetch fallback", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Cross-origin share ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "cross-origin-share")
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const bytes = Buffer.from(await solidPng(page, "rgb(20, 105, 220)", 96, 64))
  let allowCors = false
  const requests: Array<{ mode: string | undefined; corsAllowed: boolean }> = []
  const origin = createServer((request, response) => {
    requests.push({ mode: request.headers["sec-fetch-mode"] as string | undefined, corsAllowed: allowCors })
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      ...(allowCors ? { "Access-Control-Allow-Origin": "*" } : {}),
    })
    response.end(bytes)
  })
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve))
  try {
    const sourceUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/protected.png`
    const message = await seedMessage(page, channelId, `![Protected cross-origin](${sourceUrl})`)
    const row = page.getByTestId(tid.message(message.id))
    const image = row.locator('img[alt="Protected cross-origin"]')
    await waitForLoadedImages(row)
    const original = await image.elementHandle()
    expect(original).not.toBeNull()
    const readability = await image.evaluate((source: HTMLImageElement) => {
      const canvas = document.createElement("canvas")
      canvas.width = source.naturalWidth
      canvas.height = source.naturalHeight
      canvas.getContext("2d")!.drawImage(source, 0, 0)
      try {
        canvas.toDataURL("image/png")
        return "readable"
      } catch (error) {
        return error instanceof DOMException ? error.name : String(error)
      }
    })
    expect(readability).toBe("SecurityError")
    const requestsBeforeShare = requests.length
    await installShareCapture(page)
    const dialog = await openShareDialog(page, message.id)
    await expect(dialog.getByText("Couldn't generate image — preparing images failed")).toBeVisible({ timeout: 15_000 })
    await expect(dialog.locator("[data-share-card]")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Copy image" })).toBeDisabled()
    expect(requests.slice(requestsBeforeShare)).toContainEqual({ mode: "cors", corsAllowed: false })
    expect(await original!.evaluate((source) => source.isConnected && (source as HTMLImageElement).complete)).toBe(true)

    allowCors = true
    await dialog.getByRole("button", { name: "Retry" }).click()
    const card = await waitForReady(dialog)
    expect(requests.slice(requestsBeforeShare)).toContainEqual({ mode: "cors", corsAllowed: true })
    await expect(card.locator('img[alt="Protected cross-origin"]')).toHaveAttribute("src", /^data:image\/png;base64,/)
    const point = await sampleCenter(card, 'img[alt="Protected cross-origin"]')
    await dialog.getByRole("button", { name: "Copy image" }).click()
    await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
    const copied = await capturePixel(page, "clipboard", 0, point)
    expect(copied.pixel[2]).toBeGreaterThan(180)
    expect(copied.pixel[0]).toBeLessThan(80)
    await page.keyboard.press("Escape")
    expect(await original!.evaluate((source) => source.isConnected && (source as HTMLImageElement).complete)).toBe(true)
  } finally {
    origin.closeAllConnections()
    await new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve()))
  }
})

test("cold preparation disables export until the held avatar bytes are ready", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Cold share ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "cold-share")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  await uploadAvatar(page)
  const seeded = await seedMessage(page, channelId, "Cold avatar is resolved before export")
  await expect(page.getByTestId(tid.message(seeded.id)).locator('[data-slot="avatar-image"]')).toBeVisible()

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let heldRequests = 0
  await page.route("**/api/community/users/*/avatar*", async (avatarRoute) => {
    if (avatarRoute.request().method() === "GET") {
      heldRequests += 1
      await gate
    }
    await avatarRoute.continue()
  })

  await reloadWithUnavailableImage(page, route, page.getByTestId(tid.message(seeded.id)).locator('[data-slot="avatar-image"]'))
  await installShareCapture(page)

  const dialog = await openShareDialog(page, seeded.id)
  await expect.poll(() => heldRequests).toBeGreaterThan(0)
  await expect(dialog.locator('[data-share-session-state="preparing"]')).toBeVisible()
  await expect(dialog.locator("[data-share-card]")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Copy image" })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "Download" })).toBeDisabled()

  release()
  const card = await waitForReady(dialog)
  await expect(card.locator('img[data-share-byte-backed="true"]')).toHaveAttribute("src", /^data:image\//)
  const requestsAtReady = heldRequests
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  expect(heldRequests).toBe(requestsAtReady)
  expect(await captureCounts(page)).toEqual({ clipboard: 1, download: 0 })
})

test("closing cold preparation suppresses output and reopening starts a fresh session", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share close ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-close")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  await uploadAvatar(page)
  const seeded = await seedMessage(page, channelId, "Close invalidates cold preparation")
  await expect(page.getByTestId(tid.message(seeded.id)).locator('[data-slot="avatar-image"]')).toBeVisible()

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let heldRequests = 0
  const avatarPattern = "**/api/community/users/*/avatar*"
  await page.route(avatarPattern, async (avatarRoute) => {
    if (avatarRoute.request().method() === "GET") {
      heldRequests += 1
      await gate
    }
    await avatarRoute.continue().catch(() => {})
  })

  await reloadWithUnavailableImage(page, route, page.getByTestId(tid.message(seeded.id)).locator('[data-slot="avatar-image"]'))
  await installShareCapture(page)

  let dialog = await openShareDialog(page, seeded.id)
  await expect.poll(() => heldRequests).toBeGreaterThan(0)
  await expect(dialog.locator('[data-share-session-state="preparing"]')).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()
  release()
  await page.unroute(avatarPattern)
  await expect.poll(() => captureCounts(page)).toEqual({ clipboard: 0, download: 0 })
  await expect(page.getByText("Image copied to clipboard", { exact: true })).toHaveCount(0)

  dialog = await openShareDialog(page, seeded.id)
  await waitForReady(dialog)
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  await expect.poll(() => captureCounts(page)).toEqual({ clipboard: 1, download: 0 })
})

test("loaded live avatar stays mounted through share selection and dialog close", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share avatar identity ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-avatar-identity")
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  await uploadAvatar(page)
  const message = await seedMessage(page, channelId, "Keep the loaded avatar https://example.test/selection")
  const row = page.getByTestId(tid.message(message.id))
  const avatar = row.locator('[data-slot="avatar-image"]')
  await expect(avatar).toHaveAttribute("data-avatar-photo-state", "ready")
  const original = await avatar.elementHandle()
  expect(original).not.toBeNull()
  await row.hover()
  expect(await original!.evaluate((image) => image.isConnected)).toBe(true)
  await page.getByTestId(tid.messageShare(message.id)).click()
  expect(await original!.evaluate((image) => image.isConnected)).toBe(true)
  const originalUrl = page.url()
  const pageCount = page.context().pages().length
  const link = row.getByRole("link", { name: "Link: https://example.test/selection" })
  await link.click()
  await expect(page.getByRole("button", { name: "Share 0 selected messages as image" })).toBeDisabled()
  await link.click()
  await expect(page.getByRole("button", { name: "Share 1 selected messages as image" })).toBeEnabled()
  await row.click({ button: "right" })
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.getByRole("button", { name: "Share 1 selected messages as image" }).click()
  const dialog = page.getByRole("dialog", { name: "Share message" })
  await waitForReady(dialog)
  expect(await original!.evaluate((image) => image.isConnected)).toBe(true)
  await page.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()
  expect(await original!.evaluate((image) => image.isConnected)).toBe(true)
  await expect(avatar).toHaveAttribute("data-avatar-photo-state", "ready")
  expect(page.url()).toBe(originalUrl)
  expect(page.context().pages()).toHaveLength(pageCount)
  await row.click({ button: "right" })
  await expect(page.getByRole("menu")).toBeVisible()
  await page.keyboard.press("Escape")
})

test("stalled avatar falls back and a single text message exports", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share avatar timeout ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-timeout")
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  await uploadAvatar(page)
  const message = await seedMessage(page, channelId, "Text survives an unavailable avatar")
  await expect(page.getByTestId(tid.message(message.id)).locator('[data-slot="avatar-image"]')).toBeVisible()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const pattern = "**/api/community/users/*/avatar*"
  await page.route(pattern, async (route) => {
    await blocked
    await route.abort("failed").catch(() => undefined)
  })
  try {
    await reloadWithUnavailableImage(page, `/c/channels/${serverId}/${channelId}`, page.getByTestId(tid.message(message.id)).locator('[data-slot="avatar-image"]'))
    await installShareCapture(page)
    const dialog = await openShareDialog(page, message.id)
    const card = await waitForReady(dialog)
    await expect(card.locator("[data-share-identity-fallback=beam]")).toBeVisible()
    await expect(card).toContainText("Text survives an unavailable avatar")
    await dialog.getByRole("button", { name: "Copy image" }).click()
    await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
    const downloaded = page.waitForEvent("download")
    await dialog.getByRole("button", { name: "Download" }).click()
    await downloaded
    await expect.poll(() => captureCounts(page)).toEqual({ clipboard: 1, download: 1 })
  } finally {
    release()
    await page.unroute(pattern)
  }
})

test("avatar failure is deterministic while content-image failure is atomic and retryable", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share failures ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-failures")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  await uploadAvatar(page)
  const avatarMessage = await seedMessage(page, channelId, "Avatar failure uses a seeded fallback")
  const attachmentId = await uploadAttachment(page, channelId)
  const contentMessage = await seedMessage(page, channelId, "Content failure aborts", [attachmentId])
  await expect(page.getByTestId(tid.message(avatarMessage.id)).locator('[data-slot="avatar-image"]')).toBeVisible()

  await page.route("**/api/community/users/*/avatar*", async (avatarRoute) => {
    if (avatarRoute.request().method() === "GET") await avatarRoute.abort("failed")
    else await avatarRoute.continue()
  })
  await reloadWithUnavailableImage(page, route, page.getByTestId(tid.message(avatarMessage.id)).locator('[data-slot="avatar-image"]'))
  let dialog = await openShareDialog(page, avatarMessage.id)
  let card = await waitForReady(dialog)
  const fallback = card.locator("[data-share-identity-fallback=beam]")
  await expect(fallback).toBeVisible()
  const firstFallback = await fallback.innerHTML()
  await page.keyboard.press("Escape")
  dialog = await openShareDialog(page, avatarMessage.id)
  card = await waitForReady(dialog)
  expect(await card.locator("[data-share-identity-fallback=beam]").innerHTML()).toBe(firstFallback)
  await page.keyboard.press("Escape")
  await page.unroute("**/api/community/users/*/avatar*")

  const rowImage = page.getByTestId(tid.messageImage(contentMessage.id, 0))
  await expect(rowImage).toBeVisible()
  const attachmentUrl = await rowImage.getAttribute("src")
  expect(attachmentUrl).toBeTruthy()
  const attachmentPath = new URL(attachmentUrl!, page.url()).pathname
  const attachmentPattern = `**${attachmentPath}*`
  await page.route(attachmentPattern, async (attachmentRoute) => attachmentRoute.abort("failed"))
  await reloadWithUnavailableImage(page, route, rowImage)
  dialog = await openShareDialog(page, contentMessage.id)
  await expect(dialog.getByText("Couldn't generate image — preparing images failed")).toBeVisible({ timeout: 15_000 })
  await expect(dialog.locator("[data-share-card]")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Copy image" })).toBeDisabled()

  await page.unroute(attachmentPattern)
  await dialog.getByRole("button", { name: "Retry" }).click()
  card = await waitForReady(dialog)
  await expect(card.getByTestId(tid.messageShareImage(contentMessage.id, 0))).toHaveAttribute("src", /^data:image\//)
})

test("clipboard failure releases retry and Download keeps first-winner ownership", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share retry ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-retry")
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const seeded = await seedMessage(page, channelId, "Retry and first-wins")
  await installShareCapture(page, true)
  const dialog = await openShareDialog(page, seeded.id)
  await waitForReady(dialog)

  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(page.getByText("Couldn't copy image — try Download instead", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  await expect.poll(() => clipboardAttempts(page)).toBe(2)
  expect(await captureCounts(page)).toEqual({ clipboard: 1, download: 0 })

  await expect(dialog.getByRole("button", { name: "Download", exact: true })).toBeEnabled()
  await expect(dialog.getByTestId(tid.messageShareCopy)).toBeEnabled()
  const downloadStarted = page.waitForEvent("download")
  await page.evaluate((copyTestId) => {
    const copy = document.querySelector<HTMLButtonElement>(`[data-testid="${copyTestId}"]`)!
    const ownerDialog = copy.closest('[role="dialog"]')!
    const download = [...ownerDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Download"))!
    download.click()
    copy.click()
  }, tid.messageShareCopy)
  await downloadStarted
  await expect.poll(() => captureCounts(page)).toEqual({ clipboard: 1, download: 1 })
})

test("light and dark desktop and narrow previews match their frozen full PNG", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share matrix ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-matrix")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  const attachmentId = await uploadAttachment(page, channelId)
  const seeded = await seedMessage(page, channelId, "Frozen theme, font, logo, geometry, and full-card pixels", [attachmentId])
  await installShareCapture(page)

  const observations: Array<{
    scheme: "light" | "dark"
    viewport: "desktop" | "narrow"
    width: number
    background: string
    difference: number
  }> = []
  let captureIndex = 0
  for (const scheme of ["light", "dark"] as const) {
    for (const viewport of ["desktop", "narrow"] as const) {
      await page.setViewportSize(viewport === "desktop"
        ? { width: 1280, height: 900 }
        : { width: 390, height: 844 })
      await page.evaluate((value) => {
        document.documentElement.classList.toggle("dark", value === "dark")
        document.documentElement.style.colorScheme = value
      }, scheme)
      const dialog = await openShareDialog(page, seeded.id)
      const card = await waitForReady(dialog)
      const style = await card.evaluate((node) => {
        const computed = getComputedStyle(node)
        const brand = node.querySelector<HTMLElement>("[data-share-brand]")!
        return {
          width: node.getBoundingClientRect().width,
          background: computed.backgroundColor,
          borderRadius: computed.borderRadius,
          brandFont: getComputedStyle(brand).fontFamily,
          animation: computed.animationName,
          transition: computed.transitionProperty,
        }
      })
      expect(style.borderRadius).not.toBe("0px")
      expect(style.brandFont).not.toContain("var(")
      expect(style.animation).toBe("none")
      expect(style.transition).toBe("none")
      await expect(card.getByTestId(tid.alookLogo)).toBeVisible()

      await dialog.getByRole("button", { name: "Copy image" }).click()
      await expect.poll(() => captureCounts(page)).toMatchObject({ clipboard: captureIndex + 1 })
      const comparison = await comparePreviewToCapture(page, card, captureIndex)
      expect(Math.abs(comparison.exportWidth - comparison.previewWidth * 2)).toBeLessThanOrEqual(2)
      expect(Math.abs(comparison.exportHeight - comparison.previewHeight * 2)).toBeLessThanOrEqual(2)
      expect(comparison.meanChannelDifference).toBeLessThan(28)
      const brandComparison = await comparePreviewToCapture(page, card, captureIndex, "[data-share-brand]")
      expect(brandComparison.meanChannelDifference).toBeLessThan(20)
      const point = await sampleCenter(card, `[data-testid="${tid.messageShareImage(seeded.id, 0)}"]`)
      expect((await capturePixel(page, "clipboard", captureIndex, point)).pixel[2]).toBeGreaterThan(180)
      const downloadStarted = page.waitForEvent("download")
      await dialog.getByRole("button", { name: "Download" }).click()
      await downloadStarted
      expect((await capturePixel(page, "download", captureIndex, point)).pixel[2]).toBeGreaterThan(180)
      expect(await captureDigest(page, "clipboard", captureIndex)).toBe(await captureDigest(page, "download", captureIndex))
      observations.push({
        scheme,
        viewport,
        width: style.width,
        background: style.background,
        difference: comparison.meanChannelDifference,
      })
      captureIndex += 1
      await page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
    }
  }

  const desktopWidth = observations.find((value) => value.viewport === "desktop")!.width
  const narrowWidth = observations.find((value) => value.viewport === "narrow")!.width
  expect(narrowWidth).toBeLessThan(desktopWidth)
  expect(observations.find((value) => value.scheme === "light")!.background)
    .not.toBe(observations.find((value) => value.scheme === "dark")!.background)
})
