import { test, expect } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type SamplePoint = { x: number; y: number }

test("downloaded share image keeps the rendered avatar and message image", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `Share assets ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "share-assets")
  const { page } = await asUser("alice")
  const route = `/c/channels/${serverId}/${channelId}`
  await gotoAfterUserWsAuth(page, route)

  const seeded = await page.evaluate(async (targetId) => {
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
        content: "Both rendered images must survive export",
        attachments: [attachment.id],
        nonce: `e2e:${crypto.randomUUID()}`,
      }),
    })
    const message = await messageResponse.json() as { message: { id: string } }
    return {
      avatarStatus: avatarResponse.status,
      attachmentStatus: attachmentResponse.status,
      messageStatus: messageResponse.status,
      messageId: message.message.id,
    }
  }, channelId)

  expect(seeded).toMatchObject({ avatarStatus: 200, attachmentStatus: 200, messageStatus: 201 })
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
  await expect(avatar).toBeVisible()
  await expect(attachment).toBeVisible()
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
  await expect.poll(() => attachment.evaluate((image: HTMLImageElement) => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)

  const points = await card.evaluate((cardNode, imageTestId) => {
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
    }
  }, attachmentId)

  await page.evaluate(() => {
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL)
    ;(window as typeof window & { __shareImageBlob?: Blob }).__shareImageBlob = undefined
    URL.createObjectURL = ((value: Blob | MediaSource) => {
      if (value instanceof Blob && value.type === "image/png") {
        ;(window as typeof window & { __shareImageBlob?: Blob }).__shareImageBlob = value
      }
      return nativeCreateObjectUrl(value)
    }) as typeof URL.createObjectURL
  })

  const downloadStarted = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  const download = await downloadStarted
  expect(download.suggestedFilename()).toMatch(/^alook-message-.*\.png$/)

  const pixels = await page.evaluate(async ({ avatarPoint, attachmentPoint }) => {
    const blob = (window as typeof window & { __shareImageBlob?: Blob }).__shareImageBlob
    if (!blob) throw new Error("Share image blob was not captured")
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
      width: bitmap.width,
      height: bitmap.height,
    }
  }, { avatarPoint: points.avatar, attachmentPoint: points.attachment })

  expect(pixels.width).toBeGreaterThan(0)
  expect(pixels.height).toBeGreaterThan(0)
  expect(pixels.avatar[0]).toBeGreaterThan(180)
  expect(pixels.avatar[1]).toBeLessThan(80)
  expect(pixels.avatar[2]).toBeLessThan(100)
  expect(pixels.attachment[0]).toBeLessThan(80)
  expect(pixels.attachment[1]).toBeGreaterThan(70)
  expect(pixels.attachment[2]).toBeGreaterThan(180)
})
