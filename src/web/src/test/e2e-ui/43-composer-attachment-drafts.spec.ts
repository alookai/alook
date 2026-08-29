import type { Page } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { composerEditable } from "./_fixtures/actions"
import { seedChannel, seedDm, seedMessage, seedServer, seedThread } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

async function navigateChannel(page: Page, serverId: string, channelId: string) {
  const route = `/c/channels/${serverId}/${channelId}`
  const row = page.getByTestId(tid.channelRow(channelId))
  if (!await row.isVisible()) {
    const serverCrumb = page.getByTestId(tid.channelHeaderServer(serverId))
    if (await serverCrumb.isVisible()) await serverCrumb.evaluate((element) => (element as HTMLElement).click())
    else await page.getByTestId(tid.serverIcon(serverId)).evaluate((element) => (element as HTMLElement).click())
  }
  await expect(row).toBeVisible()
  await row.evaluate((element) => (element as HTMLElement).click())
  await page.waitForURL((url) => url.pathname === route)
  await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
}

async function navigateDm(page: Page, dmId: string) {
  await page.getByTestId(tid.homeButton).evaluate((element) => (element as HTMLElement).click())
  const row = page.getByTestId(tid.dmRow(dmId))
  await expect(row).toBeVisible()
  await row.evaluate((element) => (element as HTMLElement).click())
  await page.waitForURL((url) => url.pathname === `/c/me/${dmId}`)
  await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
}

function composerAttachments(page: Page) {
  return page.getByTestId(tid.composerInput).locator("../..")
}

test.describe.serial("same-tab Community attachment drafts", () => {
  let serverId: string
  let channelAId: string
  let channelBId: string
  let openerId: string
  let threadId: string
  let dmId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `attachment-drafts-${Date.now()}`)
    channelAId = await seedChannel("alice", serverId, "attachment-draft-a")
    channelBId = await seedChannel("alice", serverId, "attachment-draft-b")
    openerId = await seedMessage("alice", channelAId, "attachment draft thread opener")
    threadId = await seedThread("alice", openerId, "attachment-draft-thread")
    dmId = await seedDm("alice", userId("bob"))
  })

  test("desktop restores scoped real image/file drafts, rebuilds URLs, and removal never revives", async ({ asUser }) => {
    test.setTimeout(120_000)
    const { page } = await asUser("alice")
    const channelA = `/c/channels/${serverId}/${channelAId}`
    await page.goto(channelA, { waitUntil: "commit" })
    await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
    await page.evaluate(() => {
      const created: string[] = []
      const revoked: string[] = []
      const create = URL.createObjectURL.bind(URL)
      const revoke = URL.revokeObjectURL.bind(URL)
      Object.defineProperty(window, "__attachmentDraftUrls", {
        configurable: true,
        value: { created, revoked },
      })
      URL.createObjectURL = (object) => {
        const url = create(object)
        created.push(url)
        return url
      }
      URL.revokeObjectURL = (url) => {
        revoked.push(url)
        revoke(url)
      }
    })
    let attachmentPosts = 0
    let messagePosts = 0
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "POST" && /\/attachments$/.test(path)) attachmentPosts++
      if (request.method() === "POST" && /\/messages$/.test(path)) messagePosts++
    })

    const channelAText = `image draft ${Date.now()}`
    await composerEditable(page).fill(channelAText)
    await page.getByTestId(tid.composerFileInput).setInputFiles({
      name: "scope-image.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    })
    await expect(composerAttachments(page).getByText("scope-image.png", { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __attachmentDraftUrls: { created: string[] } }).__attachmentDraftUrls.created.length,
    )).toBeGreaterThanOrEqual(1)
    const initialUrlEvidence = await page.evaluate(() =>
      (window as unknown as { __attachmentDraftUrls: { created: string[]; revoked: string[] } }).__attachmentDraftUrls,
    )
    const initialPreviewUrl = initialUrlEvidence.created.at(-1)!

    await navigateChannel(page, serverId, channelBId)
    expect(await page.evaluate(() => "__attachmentDraftUrls" in window)).toBe(true)
    await expect(composerAttachments(page).getByText("scope-image.png", { exact: true })).toHaveCount(0)
    const channelBText = `file draft ${Date.now()}`
    await composerEditable(page).fill(channelBText)
    await page.getByTestId(tid.composerFileInput).setInputFiles({
      name: "scope-file.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("generic draft bytes"),
    })
    await expect(composerAttachments(page).getByText("scope-file.txt", { exact: true })).toBeVisible()

    await navigateChannel(page, serverId, channelAId)
    await expect(composerAttachments(page).getByText("scope-image.png", { exact: true })).toBeVisible()
    await page.getByTestId(tid.threadIndicator(openerId)).click()
    await page.waitForURL((url) => url.pathname === `/c/channels/${serverId}/${threadId}`)
    await expect(composerEditable(page)).toBeVisible()
    await expect(composerEditable(page)).toHaveText("")
    await expect(page.getByRole("button", { name: "Remove file" })).toHaveCount(0)
    await navigateDm(page, dmId)
    await expect(composerEditable(page)).toHaveText("")
    await expect(page.getByRole("button", { name: "Remove file" })).toHaveCount(0)

    await navigateChannel(page, serverId, channelAId)
    await expect(composerEditable(page)).toContainText(channelAText)
    await expect(composerAttachments(page).getByText("scope-image.png", { exact: true })).toBeVisible()
    const urlEvidence = await page.evaluate(() =>
      (window as unknown as { __attachmentDraftUrls: { created: string[]; revoked: string[] } }).__attachmentDraftUrls,
    )
    expect(urlEvidence.created.length).toBeGreaterThan(initialUrlEvidence.created.length)
    expect(urlEvidence.created.at(-1)).not.toBe(initialPreviewUrl)
    expect(urlEvidence.revoked).toContain(initialPreviewUrl)
    await page.getByRole("button", { name: "Remove file" }).click()

    await navigateChannel(page, serverId, channelBId)
    await expect(composerEditable(page)).toContainText(channelBText)
    await expect(composerAttachments(page).getByText("scope-file.txt", { exact: true })).toBeVisible()
    await navigateChannel(page, serverId, channelAId)
    await expect(composerEditable(page)).toContainText(channelAText)
    await expect(composerAttachments(page).getByText("scope-image.png", { exact: true })).toHaveCount(0)
    expect(attachmentPosts).toBe(0)
    expect(messagePosts).toBe(0)
  })

  test("desktop restored generic file survives upload failure, retries once, and never revives", async ({ asUser }) => {
    test.setTimeout(120_000)
    const { page } = await asUser("alice")
    const channelA = `/c/channels/${serverId}/${channelAId}`
    await page.goto(channelA, { waitUntil: "commit" })
    await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
    const body = `retry restored file ${Date.now()}`
    await composerEditable(page).fill(body)
    await page.getByTestId(tid.composerFileInput).setInputFiles({
      name: "retry-restored.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retry restored bytes"),
    })
    await expect(composerAttachments(page).getByText("retry-restored.txt", { exact: true })).toBeVisible()
    await navigateChannel(page, serverId, channelBId)
    await navigateChannel(page, serverId, channelAId)
    await expect(composerEditable(page)).toContainText(body)
    await expect(composerAttachments(page).getByText("retry-restored.txt", { exact: true })).toBeVisible()

    let uploadAttempts = 0
    let messagePosts = 0
    await page.route(`**/api/community/channels/${channelAId}/attachments`, async (route) => {
      if (route.request().method() !== "POST") return route.continue()
      uploadAttempts++
      if (uploadAttempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "forced upload failure" }),
        })
        return
      }
      await route.continue()
    })
    page.on("request", (request) => {
      if (
        request.method() === "POST"
        && new URL(request.url()).pathname === `/api/community/channels/${channelAId}/messages`
      ) messagePosts++
    })
    await composerEditable(page).press("Enter")
    await expect(page.getByText("Message failed to send. Click to retry.", { exact: true })).toBeVisible()
    await expect(composerEditable(page)).toHaveText("")
    await expect(composerAttachments(page).getByText("retry-restored.txt", { exact: true })).toHaveCount(0)
    expect(uploadAttempts).toBe(1)
    expect(messagePosts).toBe(0)

    const committed = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/community/channels/${channelAId}/messages`,
    )
    await page.getByText("Message failed to send. Click to retry.", { exact: true }).click()
    expect((await committed).status()).toBe(201)
    await expect.poll(() => uploadAttempts).toBe(2)
    await expect.poll(() => messagePosts).toBe(1)
    await expect(page.getByText("Message failed to send. Click to retry.", { exact: true })).toHaveCount(0)

    await navigateChannel(page, serverId, channelBId)
    await navigateChannel(page, serverId, channelAId)
    await expect(composerEditable(page)).toHaveText("")
    await expect(composerAttachments(page).getByText("retry-restored.txt", { exact: true })).toHaveCount(0)
  })

  test("mobile restores scoped attachments, sends explicitly once, and reload restores text only", async ({ asUser }) => {
    test.setTimeout(120_000)
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 390, height: 844 })
    const channelA = `/c/channels/${serverId}/${channelAId}`
    await page.goto(channelA, { waitUntil: "commit" })
    await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
    const body = `mobile restored image ${Date.now()}`
    await composerEditable(page).fill(body)
    await page.getByTestId(tid.composerFileInput).setInputFiles({
      name: "mobile-image.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    })
    await expect(composerAttachments(page).getByText("mobile-image.png", { exact: true })).toBeVisible()
    await navigateChannel(page, serverId, channelBId)
    await page.getByTestId(tid.composerFileInput).setInputFiles({
      name: "mobile-file.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("mobile generic bytes"),
    })
    await expect(composerAttachments(page).getByText("mobile-file.txt", { exact: true })).toBeVisible()
    await navigateChannel(page, serverId, channelAId)
    await expect(composerEditable(page)).toContainText(body)
    await expect(composerAttachments(page).getByText("mobile-image.png", { exact: true })).toBeVisible()

    let uploads = 0
    let messages = 0
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "POST" && path.endsWith("/attachments")) uploads++
      if (request.method() === "POST" && path.endsWith("/messages")) messages++
    })
    const send = page.getByTestId(tid.composerSend)
    await expect(send).toBeEnabled()
    const committed = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/community/channels/${channelAId}/messages`,
    )
    await send.evaluate((button) => (button as HTMLButtonElement).click())
    expect((await committed).status()).toBe(201)
    await expect.poll(() => uploads).toBe(1)
    await expect.poll(() => messages).toBe(1)
    await expect(composerEditable(page)).toHaveText("")

    await navigateChannel(page, serverId, channelBId)
    const reloadText = `mobile reload text ${Date.now()}`
    await composerEditable(page).fill(reloadText)
    await expect(composerAttachments(page).getByText("mobile-file.txt", { exact: true })).toBeVisible()
    const beforeReloadUploads = uploads
    const beforeReloadMessages = messages
    await page.reload({ waitUntil: "commit" })
    await expect(composerEditable(page)).toContainText(reloadText)
    await expect(composerAttachments(page).getByText("mobile-file.txt", { exact: true })).toHaveCount(0)
    expect(uploads).toBe(beforeReloadUploads)
    expect(messages).toBe(beforeReloadMessages)
  })
})
