import { test, expect } from "./_fixtures/community-fixture"
import type { Locator, Page, Route } from "@playwright/test"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { createInvite, seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type SamplePoint = { x: number; y: number }
type CaptureKind = "clipboard" | "download"

async function uploadPhoto(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const canvas = document.createElement("canvas")
    canvas.width = 48
    canvas.height = 48
    const context = canvas.getContext("2d")!
    context.fillStyle = "rgb(220, 35, 60)"
    context.fillRect(0, 0, canvas.width, canvas.height)
    const avatar = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("PNG encode failed")),
      "image/png",
    ))
    const avatarForm = new FormData()
    avatarForm.append("file", avatar, "avatar.png")
    const avatarResponse = await fetch("/api/community/users/me/avatar", {
      method: "POST",
      body: avatarForm,
      credentials: "include",
    })
    return avatarResponse.status
  })
  expect(status).toBe(200)
}

async function seedPhotoMessage(page: Page, channelId: string, content: string) {
  await uploadPhoto(page)
  const seeded = await page.evaluate(async ({ targetId, body }) => {
    const messageResponse = await fetch(`/api/community/channels/${targetId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: body,
        attachments: [],
        nonce: `e2e:${crypto.randomUUID()}`,
      }),
    })
    const message = await messageResponse.json() as { message: { id: string } }
    return {
      messageStatus: messageResponse.status,
      messageId: message.message.id,
    }
  }, { targetId: channelId, body: content })

  expect(seeded).toMatchObject({ messageStatus: 201 })
  return seeded.messageId
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

async function installShareCapture(page: Page, rejectFirstClipboard = false): Promise<void> {
  await page.evaluate((rejectFirst) => {
    const captureWindow = window as typeof window & {
      __shareCaptures?: {
        clipboard: Blob[]
        clipboardAttempts: number
        download: Blob[]
      }
    }
    captureWindow.__shareCaptures = {
      clipboard: [],
      clipboardAttempts: 0,
      download: [],
    }
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

async function shareCaptureCounts(page: Page) {
  return page.evaluate(() => {
    const captures = (window as typeof window & {
      __shareCaptures?: {
        clipboard: Blob[]
        clipboardAttempts: number
        download: Blob[]
      }
    }).__shareCaptures
    return {
      clipboard: captures?.clipboard.length ?? 0,
      clipboardAttempts: captures?.clipboardAttempts ?? 0,
      download: captures?.download.length ?? 0,
    }
  })
}

async function avatarSamplePoint(card: Locator): Promise<SamplePoint> {
  return card.evaluate((cardNode) => {
    const avatar = cardNode.querySelector('[data-avatar-kind="photo"]')!
    const cardRect = cardNode.getBoundingClientRect()
    const avatarRect = avatar.getBoundingClientRect()
    return {
      x: (avatarRect.left - cardRect.left + avatarRect.width / 2) * 2,
      y: (avatarRect.top - cardRect.top + avatarRect.height / 2) * 2,
    }
  })
}

async function capturedPixel(
  page: Page,
  kind: CaptureKind,
  index: number,
  point: SamplePoint,
) {
  return page.evaluate(async ({ captureKind, captureIndex, sample }) => {
    const captures = (window as typeof window & {
      __shareCaptures?: { clipboard: Blob[]; download: Blob[] }
    }).__shareCaptures
    const blob = captures?.[captureKind][captureIndex]
    if (!blob) throw new Error(`Missing ${captureKind} capture ${captureIndex}`)
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext("2d")!
    context.drawImage(bitmap, 0, 0)
    const pixel = [...context.getImageData(
      Math.round(sample.x),
      Math.round(sample.y),
      1,
      1,
    ).data]
    const dimensions = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return { pixel, ...dimensions }
  }, { captureKind: kind, captureIndex: index, sample: point })
}

async function waitForRowPhoto(page: Page, messageId: string): Promise<Locator> {
  const image = page.getByTestId(tid.message(messageId)).locator(
    '[data-avatar-kind="photo"] [data-slot="avatar-image"]',
  )
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => (
    node.complete && node.naturalWidth > 0
  ))).toBe(true)
  return image
}

function isRedPhoto(pixel: number[]): boolean {
  return pixel[0]! > 180 && pixel[1]! < 80 && pixel[2]! < 100 && pixel[3] === 255
}

async function holdNextAvatarRequest(page: Page) {
  let shouldHold = false
  let heldRoute: Route | undefined
  let resolveHeld!: () => void
  const held = new Promise<void>((resolve) => { resolveHeld = resolve })
  let getCount = 0
  await page.route("**/api/community/users/*/avatar*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    getCount += 1
    if (!shouldHold || heldRoute) {
      await route.continue()
      return
    }
    heldRoute = route
    resolveHeld()
  })
  return {
    arm: () => { shouldHold = true },
    disarm: () => { shouldHold = false },
    getCount: () => getCount,
    wait: async () => {
      await held
      return heldRoute!
    },
  }
}

test("consecutive share-image exports reuse rendered avatar, attachment, and invite icon pixels", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share assets ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-assets")
  const inviteToken = await createInvite("alice", serverId)
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)

  const seeded = await page.evaluate(async ({ targetId, targetServerId, token }) => {
    async function solidPng(color: string, width: number, height: number): Promise<Blob> {
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext("2d")!
      context.fillStyle = color
      context.fillRect(0, 0, width, height)
      return new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("PNG encode failed")),
        "image/png",
      ))
    }

    const avatarForm = new FormData()
    avatarForm.append("file", await solidPng("rgb(220, 35, 60)", 48, 48), "avatar.png")
    const avatarResponse = await fetch("/api/community/users/me/avatar", {
      method: "POST",
      body: avatarForm,
      credentials: "include",
    })

    const iconForm = new FormData()
    iconForm.append("file", await solidPng("rgb(25, 180, 80)", 64, 64), "server-icon.png")
    const iconResponse = await fetch(`/api/community/servers/${targetServerId}/icon`, {
      method: "POST",
      body: iconForm,
      credentials: "include",
    })

    const attachmentForm = new FormData()
    attachmentForm.append(
      "file",
      await solidPng("rgb(20, 105, 220)", 96, 64),
      "blue-message.png",
    )
    const attachmentResponse = await fetch(`/api/community/channels/${targetId}/attachments`, {
      method: "POST",
      body: attachmentForm,
      credentials: "include",
    })
    const attachment = await attachmentResponse.json() as { id: string }

    const messageResponse = await fetch(`/api/community/channels/${targetId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `All rendered images must survive export\n/c/invite/${token}`,
        attachments: [attachment.id],
        nonce: `e2e:${crypto.randomUUID()}`,
      }),
    })
    const message = await messageResponse.json() as { message: { id: string } }
    return {
      avatarStatus: avatarResponse.status,
      iconStatus: iconResponse.status,
      attachmentStatus: attachmentResponse.status,
      messageStatus: messageResponse.status,
      messageId: message.message.id,
    }
  }, { targetId: channelId, targetServerId: serverId, token: inviteToken })

  expect(seeded).toMatchObject({
    avatarStatus: 200,
    iconStatus: 200,
    attachmentStatus: 200,
    messageStatus: 201,
  })
  await gotoAfterUserWsAuth(page, route)
  const row = page.getByTestId(tid.message(seeded.messageId))
  await expect(row).toBeVisible()
  await row.hover()
  await page.getByTestId(tid.messageShare(seeded.messageId)).click()
  await page.getByRole("button", { name: "Share 1 selected messages as image" }).click()

  const dialog = page.getByRole("dialog", { name: "Share message" })
  const card = dialog.locator("[data-share-card]")
  const avatar = card.locator('[data-slot="avatar-image"]')
  const attachmentId = tid.messageShareImage(seeded.messageId, 0)
  const attachment = card.getByTestId(attachmentId)
  const inviteIcon = card.getByTestId(tid.inviteCard(inviteToken)).locator("img")
  await expect(avatar).toBeVisible()
  await expect(attachment).toBeVisible()
  await expect(inviteIcon).toBeVisible()
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
  await expect.poll(() => attachment.evaluate((image: HTMLImageElement) => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
  await expect.poll(() => inviteIcon.evaluate((image: HTMLImageElement) => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)

  const points = await card.evaluate((cardNode, { imageTestId, inviteTestId }) => {
    const cardRect = cardNode.getBoundingClientRect()
    const sample = (image: Element): SamplePoint => {
      const rect = image.getBoundingClientRect()
      return {
        x: (rect.left - cardRect.left + rect.width / 2) * 2,
        y: (rect.top - cardRect.top + rect.height / 2) * 2,
      }
    }
    return {
      avatar: sample(cardNode.querySelector('[data-slot="avatar-image"]')!),
      attachment: sample(cardNode.querySelector(`[data-testid="${imageTestId}"]`)!),
      inviteIcon: sample(cardNode.querySelector(`[data-testid="${inviteTestId}"] img`)!),
    }
  }, { imageTestId: attachmentId, inviteTestId: tid.inviteCard(inviteToken) })

  await page.evaluate(() => {
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL)
    ;(window as typeof window & { __shareImageBlobs?: Blob[] }).__shareImageBlobs = []
    URL.createObjectURL = ((value: Blob | MediaSource) => {
      if (value instanceof Blob && value.type === "image/png") {
        ;(window as typeof window & { __shareImageBlobs?: Blob[] }).__shareImageBlobs!.push(value)
      }
      return nativeCreateObjectUrl(value)
    }) as typeof URL.createObjectURL
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          const blob = await items[0]!.getType("image/png")
          ;(window as typeof window & { __shareImageBlobs?: Blob[] }).__shareImageBlobs!.push(blob)
        },
      },
    })
  })

  const dynamicImagePaths = [
    "/avatar",
    "/attachments/",
    "/icon",
  ]
  const imageRequestsDuringCapture: string[] = []
  let captureStarted = false
  page.on("request", (request) => {
    if (!captureStarted || request.method() !== "GET") return
    const pathname = new URL(request.url()).pathname
    if (dynamicImagePaths.some((suffix) => pathname.includes(suffix))) {
      imageRequestsDuringCapture.push(pathname)
    }
  })

  captureStarted = true
  const downloadStarted = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  const download = await downloadStarted
  expect(download.suggestedFilename()).toMatch(/^alook-message-.*\.png$/)
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()

  const exports = await page.evaluate(async ({ avatarPoint, attachmentPoint, inviteIconPoint }) => {
    const blobs = (window as typeof window & { __shareImageBlobs?: Blob[] }).__shareImageBlobs
    if (!blobs || blobs.length !== 2) throw new Error("Share image blobs were not captured")
    return Promise.all(blobs.map(async (blob) => {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement("canvas")
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext("2d")!
      context.drawImage(bitmap, 0, 0)
      const read = ({ x, y }: SamplePoint) => [
        ...context.getImageData(Math.round(x), Math.round(y), 1, 1).data,
      ]
      return {
        avatar: read(avatarPoint),
        attachment: read(attachmentPoint),
        inviteIcon: read(inviteIconPoint),
        width: bitmap.width,
        height: bitmap.height,
      }
    }))
  }, {
    avatarPoint: points.avatar,
    attachmentPoint: points.attachment,
    inviteIconPoint: points.inviteIcon,
  })

  expect(imageRequestsDuringCapture).toEqual([])
  expect(exports).toHaveLength(2)
  for (const pixels of exports) {
    expect(pixels.width).toBeGreaterThan(0)
    expect(pixels.height).toBeGreaterThan(0)
    expect(pixels.avatar[0]).toBeGreaterThan(180)
    expect(pixels.avatar[1]).toBeLessThan(80)
    expect(pixels.avatar[2]).toBeLessThan(100)
    expect(pixels.attachment[0]).toBeLessThan(80)
    expect(pixels.attachment[1]).toBeGreaterThan(70)
    expect(pixels.attachment[2]).toBeGreaterThan(180)
    expect(pixels.inviteIcon[0]).toBeLessThan(80)
    expect(pixels.inviteIcon[1]).toBeGreaterThan(140)
    expect(pixels.inviteIcon[2]).toBeLessThan(120)
  }
})

test("a warm share avatar is a distinct node with the same cached versioned source", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Warm share avatar ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "warm-share-avatar")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  const messageId = await seedPhotoMessage(page, channelId, "Warm avatar cache evidence")
  await gotoAfterUserWsAuth(page, route)

  const rowImage = await waitForRowPhoto(page, messageId)
  await rowImage.evaluate((image) => {
    ;(window as typeof window & { __warmRowAvatar?: Element }).__warmRowAvatar = image
    performance.clearResourceTimings()
  })
  await installShareCapture(page)
  const dialog = await openShareDialog(page, messageId)
  const card = dialog.locator("[data-share-card]")
  const shareImage = card.locator('[data-avatar-photo-state="ready"]')
  await expect(shareImage).toBeVisible()
  const point = await avatarSamplePoint(card)

  const identity = await shareImage.evaluate((image: HTMLImageElement) => {
    const row = (window as typeof window & { __warmRowAvatar?: HTMLImageElement }).__warmRowAvatar
    return {
      distinct: row !== image,
      rowSrc: row?.currentSrc,
      shareSrc: image.currentSrc,
    }
  })
  expect(identity.distinct).toBe(true)
  expect(identity.rowSrc).toBe(identity.shareSrc)
  expect(identity.shareSrc).toMatch(/\/api\/community\/users\/[^/]+\/avatar\?v=\d+$/)

  const downloadStarted = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  await downloadStarted
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()

  expect(await shareCaptureCounts(page)).toEqual({
    clipboard: 1,
    clipboardAttempts: 1,
    download: 1,
  })
  expect(isRedPhoto((await capturedPixel(page, "download", 0, point)).pixel)).toBe(true)
  expect(isRedPhoto((await capturedPixel(page, "clipboard", 0, point)).pixel)).toBe(true)
  const transfers = await page.evaluate((src) => performance
    .getEntriesByName(src)
    .filter((entry): entry is PerformanceResourceTiming => entry.entryType === "resource")
    .map((entry) => entry.transferSize), identity.shareSrc!)
  expect(transfers.every((size) => size === 0)).toBe(true)
})

test("an immediate cold Copy waits for the real photo and owns the whole generation", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Cold share avatar ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "cold-share-avatar")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  const messageId = await seedPhotoMessage(page, channelId, "Cold avatar should win before deadline")
  const avatarRequests = await holdNextAvatarRequest(page)
  await gotoAfterUserWsAuth(page, route)
  await waitForRowPhoto(page, messageId)
  const baselineRequests = avatarRequests.getCount()
  avatarRequests.arm()
  await installShareCapture(page)
  await uploadPhoto(page)
  const held = await avatarRequests.wait()

  const dialog = await openShareDialog(page, messageId)
  const card = dialog.locator("[data-share-card]")
  await expect(card.locator('[data-avatar-photo-state="pending"]')).toBeVisible()
  const pendingPlaceholder = card.locator('[data-avatar-photo-placeholder="pending"]')
  await expect(pendingPlaceholder).toBeVisible()
  await expect(pendingPlaceholder).toHaveClass(/animate-pulse/)
  await expect(card.locator('[data-avatar-kind="photo"] [data-slot="avatar-fallback"]')).toHaveCount(0)
  await expect(card.locator('[data-avatar-kind="photo"] svg')).toHaveCount(0)
  const point = await avatarSamplePoint(card)
  await page.evaluate((copyTestId) => {
    const copy = document.querySelector<HTMLButtonElement>(`[data-testid="${copyTestId}"]`)!
    const dialog = copy.closest('[role="dialog"]')!
    const download = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Download"))!
    copy.click()
    copy.disabled = false
    copy.click()
    download.disabled = false
    download.click()
  }, tid.messageShareCopy)
  avatarRequests.disarm()
  await held.continue()

  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  expect(await shareCaptureCounts(page)).toEqual({
    clipboard: 1,
    clipboardAttempts: 1,
    download: 0,
  })
  expect(avatarRequests.getCount()).toBe(baselineRequests + 1)
  expect(isRedPhoto((await capturedPixel(page, "clipboard", 0, point)).pixel)).toBe(true)
})

for (const scenario of [
  { name: "an avatar error", action: "copy", outcome: "abort" },
  { name: "an avatar timeout", action: "download", outcome: "timeout" },
] as const) {
  test(`${scenario.name} exports neutral placeholder pixels and a remount retries the photo`, async ({ asUser }) => {
    test.setTimeout(120_000)
    const serverId = await seedServer("alice", `Fallback share avatar ${Date.now()}`)
    const channelId = await seedChannel("alice", serverId, `fallback-${scenario.outcome}`)
    const { page } = await asUser("alice")
    const route = `/c/channels/${serverId}/${channelId}`
    await gotoAfterUserWsAuth(page, route)
    const messageId = await seedPhotoMessage(page, channelId, `Fallback for ${scenario.outcome}`)
    const avatarRequests = await holdNextAvatarRequest(page)
    await gotoAfterUserWsAuth(page, route)
    await waitForRowPhoto(page, messageId)
    const baselineRequests = avatarRequests.getCount()
    avatarRequests.arm()
    await installShareCapture(page)
    await uploadPhoto(page)
    const held = await avatarRequests.wait()

    let dialog = await openShareDialog(page, messageId)
    const card = dialog.locator("[data-share-card]")
    await expect(card.locator('[data-avatar-photo-state="pending"]')).toBeVisible()
    const pendingPlaceholder = card.locator('[data-avatar-photo-placeholder="pending"]')
    await expect(pendingPlaceholder).toBeVisible()
    await expect(pendingPlaceholder).toHaveClass(/animate-pulse/)
    await expect(card.locator('[data-avatar-kind="photo"] [data-slot="avatar-fallback"]')).toHaveCount(0)
    await expect(card.locator('[data-avatar-kind="photo"] svg')).toHaveCount(0)
    const fallbackPoint = await avatarSamplePoint(card)
    const firstDownload = scenario.action === "download" ? page.waitForEvent("download") : null
    await dialog.getByRole("button", {
      name: scenario.action === "copy" ? "Copy image" : "Download",
    }).click()
    if (scenario.outcome === "abort") await held.abort("failed")
    if (firstDownload) await firstDownload
    if (scenario.action === "copy") {
      await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible({ timeout: 10_000 })
    } else {
      await expect(dialog.getByRole("button", { name: "Download" })).toBeEnabled({ timeout: 10_000 })
      avatarRequests.disarm()
      await held.abort("failed").catch(() => {})
    }
    const failedPlaceholder = card.locator('[data-avatar-photo-placeholder="failed"]')
    await expect(failedPlaceholder).toBeVisible()
    await expect(failedPlaceholder).not.toHaveClass(/animate-pulse/)

    const firstKind: CaptureKind = scenario.action === "copy" ? "clipboard" : "download"
    const fallback = await capturedPixel(page, firstKind, 0, fallbackPoint)
    expect(fallback.width).toBeGreaterThan(0)
    expect(fallback.height).toBeGreaterThan(0)
    expect(fallback.pixel[3]).toBe(255)
    expect(isRedPhoto(fallback.pixel)).toBe(false)
    expect(avatarRequests.getCount()).toBe(baselineRequests + 1)

    avatarRequests.disarm()
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
    dialog = await openShareDialog(page, messageId)
    await expect(dialog.locator('[data-avatar-photo-state="ready"]')).toBeVisible()
    const retryPoint = await avatarSamplePoint(dialog.locator("[data-share-card]"))
    await dialog.getByRole("button", { name: "Copy image" }).click()
    await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
    const retryIndex = scenario.action === "copy" ? 1 : 0
    expect(isRedPhoto((await capturedPixel(page, "clipboard", retryIndex, retryPoint)).pixel)).toBe(true)
  })
}

test("clipboard failure releases retry and Download keeps first-wins ownership", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share retry ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-retry")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  const messageId = await seedPhotoMessage(page, channelId, "Retry and first-wins")
  await gotoAfterUserWsAuth(page, route)
  await waitForRowPhoto(page, messageId)
  await installShareCapture(page, true)
  const dialog = await openShareDialog(page, messageId)
  await expect(dialog.locator('[data-avatar-photo-state="ready"]')).toBeVisible()

  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(page.getByText("Couldn't copy image — try Download instead", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  await expect.poll(() => shareCaptureCounts(page)).toEqual({
    clipboard: 1,
    clipboardAttempts: 2,
    download: 0,
  })
  await expect(dialog.getByRole("button", { name: "Copy image" })).toBeVisible({ timeout: 5_000 })

  const downloadStarted = page.waitForEvent("download")
  await page.evaluate((copyTestId) => {
    const copy = document.querySelector<HTMLButtonElement>(`[data-testid="${copyTestId}"]`)!
    const dialog = copy.closest('[role="dialog"]')!
    const download = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Download"))!
    download.click()
    download.disabled = false
    download.click()
    copy.disabled = false
    copy.click()
  }, tid.messageShareCopy)
  await downloadStarted
  await expect.poll(() => shareCaptureCounts(page)).toEqual({
    clipboard: 1,
    clipboardAttempts: 2,
    download: 1,
  })
})

test("closing a cold export suppresses its writer and reopening starts fresh", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share close ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-close")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)
  const messageId = await seedPhotoMessage(page, channelId, "Close invalidates cold export")
  const avatarRequests = await holdNextAvatarRequest(page)
  await gotoAfterUserWsAuth(page, route)
  await waitForRowPhoto(page, messageId)
  avatarRequests.arm()
  await installShareCapture(page)
  await uploadPhoto(page)
  const held = await avatarRequests.wait()

  let dialog = await openShareDialog(page, messageId)
  await expect(dialog.locator('[data-avatar-photo-state="pending"]')).toBeVisible()
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copy image" })).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()
  avatarRequests.disarm()
  await held.continue().catch(() => {})
  await expect.poll(() => shareCaptureCounts(page)).toEqual({
    clipboard: 0,
    clipboardAttempts: 0,
    download: 0,
  })
  await expect(page.getByText("Image copied to clipboard", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Couldn't copy image — try Download instead", { exact: true })).toHaveCount(0)

  dialog = await openShareDialog(page, messageId)
  await expect(dialog.locator('[data-avatar-photo-state="ready"]')).toBeVisible()
  await dialog.getByRole("button", { name: "Copy image" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  await expect.poll(() => shareCaptureCounts(page)).toEqual({
    clipboard: 1,
    clipboardAttempts: 1,
    download: 0,
  })
})
