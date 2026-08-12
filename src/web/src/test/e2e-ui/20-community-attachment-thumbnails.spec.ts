import { test, expect } from "./_fixtures/community-fixture"
import { readFileSync } from "node:fs"
import { tid } from "./_fixtures/testids"
import { composerEditable, createServer } from "./_fixtures/actions"

const PNG_FIXTURE = readFileSync("public/icon-192.png")

test("image thumbnails defer original loading and survive original errors", async ({ asUser }) => {
  test.setTimeout(120_000)
  const { page } = await asUser("alice")
  const browserErrors: string[] = []
  page.on("pageerror", (error) => browserErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  await page.goto("/c")
  await page.waitForURL(/\/c/, { timeout: 20_000, waitUntil: "commit" })
  await createServer(page, `Thumbnail E2E ${Date.now()}`)
  const channelId = new URL(page.url()).pathname.split("/").at(-1)!
  const observedGetPaths: string[] = []
  let messagePostCount = 0
  page.on("request", (request) => {
    if (request.method() === "GET") observedGetPaths.push(new URL(request.url()).pathname)
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
    ) messagePostCount++
  })

  const uploadResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return response.request().method() === "POST"
      && pathname === `/api/community/channels/${channelId}/attachments`
  })
  const messageResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return response.request().method() === "POST"
      && pathname === `/api/community/channels/${channelId}/messages`
  })

  const editable = composerEditable(page)
  await editable.click()
  await editable.pressSequentially("thumbnail network gate")
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: PNG_FIXTURE,
  })
  await expect.poll(() => editable.evaluate((element) => document.activeElement === element)).toBe(true)
  await page.keyboard.press("Enter")

  const uploadResponse = await uploadResponsePromise
  expect(uploadResponse.ok()).toBe(true)
  const uploaded = await uploadResponse.json() as { id: string; hasThumbnail?: boolean }
  // This is server-authoritative proof that the browser multipart contained a
  // valid JPEG thumbnail and that both objects were persisted.
  expect(uploaded.hasThumbnail).toBe(true)

  const originalPath = `/api/community/channels/${channelId}/attachments/${uploaded.id}`
  const thumbnailPath = `${originalPath}/thumbnail`
  const messageResponse = await messageResponsePromise
  expect(messageResponse.status()).toBe(201)
  expect((messageResponse.request().postDataJSON() as { attachments?: string[] }).attachments).toEqual([uploaded.id])
  expect(messagePostCount).toBe(1)
  const sent = await messageResponse.json() as { message: { id: string } }
  const listImage = page.getByTestId(tid.messageImage(sent.message.id, 0))
  await expect(listImage).toHaveAttribute("src", thumbnailPath)
  await expect.poll(() => observedGetPaths.filter((path) => path === thumbnailPath).length).toBeGreaterThan(0)
  expect(observedGetPaths.filter((path) => path === originalPath)).toHaveLength(0)

  let releaseOriginal!: () => void
  const originalGate = new Promise<void>((resolve) => { releaseOriginal = resolve })
  await page.route(`**${originalPath}`, async (route) => {
    if (
      route.request().method() === "GET"
      && new URL(route.request().url()).pathname === originalPath
    ) {
      await originalGate
    }
    await route.continue()
  })

  const listImageButton = page.getByRole("button", { name: "pixel.png" })
  // Message action controls lazy-activate on pointer entry. Let that stable
  // render settle before the click, matching a real pointer's hover→press.
  await listImageButton.hover()
  await listImageButton.click()
  await page.waitForTimeout(500)
  if (await page.getByTestId(tid.imageLightbox).count() === 0 && browserErrors.length > 0) {
    throw new Error(`lightbox render errors: ${browserErrors.join(" | ")}`)
  }
  await expect(page.getByTestId(tid.imageLightbox)).toBeVisible()
  await expect(page.getByTestId(tid.imageLightboxThumbnail)).toHaveAttribute("src", thumbnailPath)
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveClass(/invisible/)
  await expect.poll(() => observedGetPaths.filter((path) => path === originalPath).length).toBe(1)

  releaseOriginal()
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveAttribute("src", originalPath)
  await expect(page.getByTestId(tid.imageLightboxOriginal)).not.toHaveClass(/invisible/)
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(tid.imageLightbox)).toHaveCount(0)

  const errorUploadResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/attachments`,
  )
  const errorMessageResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`,
  )

  await editable.click()
  await editable.pressSequentially("original error gate")
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: PNG_FIXTURE,
  })
  await expect.poll(() => editable.evaluate((element) => document.activeElement === element)).toBe(true)
  await page.keyboard.press("Enter")

  const errorUploaded = await (await errorUploadResponsePromise).json() as {
    id: string
    hasThumbnail?: boolean
  }
  expect(errorUploaded.hasThumbnail).toBe(true)
  const errorMessageResponse = await errorMessageResponsePromise
  expect(errorMessageResponse.status()).toBe(201)
  const errorSent = await errorMessageResponse.json() as { message: { id: string } }
  const errorOriginalPath = `/api/community/channels/${channelId}/attachments/${errorUploaded.id}`
  const errorThumbnailPath = `${errorOriginalPath}/thumbnail`
  const originalRequests: string[] = []
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === errorOriginalPath) {
      originalRequests.push(request.url())
    }
  })
  const errorListImage = page.getByTestId(tid.messageImage(errorSent.message.id, 0))
  await expect(errorListImage).toHaveAttribute("src", errorThumbnailPath)
  expect(originalRequests).toHaveLength(0)
  await page.route(`**${errorOriginalPath}`, async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === errorOriginalPath) {
      await route.fulfill({ status: 500, contentType: "text/plain", body: "forced original failure" })
      return
    }
    await route.continue()
  })

  const errorListImageButton = page.getByRole("button", { name: "broken.png" })
  await errorListImageButton.hover()
  await errorListImageButton.click()
  await expect.poll(() => originalRequests.length).toBe(1)
  await expect(page.getByTestId(tid.imageLightboxThumbnail)).toHaveAttribute("src", errorThumbnailPath)
  await expect(page.getByTestId(tid.imageLightboxThumbnail)).toBeVisible()
  await expect(page.getByTestId(tid.imageLightboxOriginal)).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(originalRequests).toHaveLength(1)
  await expect(errorListImage).toHaveAttribute("src", errorThumbnailPath)
})
