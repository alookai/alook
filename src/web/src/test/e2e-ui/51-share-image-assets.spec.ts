import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { createInvite, seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type SamplePoint = { x: number; y: number }

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
