import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable, createServer, sendMessage, expectMessageVisible } from "./_fixtures/actions"

test("server → channel → message", async ({ asUser }) => {
  test.setTimeout(120_000)
  const { page } = await asUser("alice")
  await page.goto("/c")
  await page.waitForURL(/\/c/, { timeout: 20_000, waitUntil: "commit" })
  await createServer(page, `E2E Server ${Date.now()}`)
  const channelUrl = page.url()
  expect(channelUrl).toMatch(/\/c\/channels\/[^/]+\/[^/]+/)

  const firstBody = `hello world ${Date.now()}`
  const firstResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return response.request().method() === "POST"
      && /^\/api\/community\/channels\/[^/]+\/messages$/.test(pathname)
  })
  await sendMessage(page, firstBody)
  const firstResponse = await firstResponsePromise
  expect(firstResponse.status()).toBe(201)
  const firstPayload = await firstResponse.json() as { message: { id: string; seq: number } }
  expect(firstPayload.message.seq).toBeGreaterThan(0)
  await expectMessageVisible(page, firstBody)
  await expect(page.getByTestId(tid.message(firstPayload.message.id))).toHaveCount(1)
  await expect(page.getByTestId(tid.composerInput)).toHaveText("")

  let sends = 0
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === "POST" && /^\/api\/community\/channels\/[^/]+\/messages$/.test(pathname)) sends++
  })

  const editable = composerEditable(page)
  const imeBody = `ime probe ${Date.now()}`
  await editable.click()
  await editable.pressSequentially(imeBody)
  await editable.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "候" }))
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }))
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "候" }))
  })
  await expect(editable).toContainText(imeBody)
  await expect.poll(() => sends).toBe(0)
  const imeResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return response.request().method() === "POST"
      && /^\/api\/community\/channels\/[^/]+\/messages$/.test(pathname)
  })
  await page.keyboard.press("Enter")
  const imeResponse = await imeResponsePromise
  expect(imeResponse.status()).toBe(201)
  const imePayload = await imeResponse.json() as { message: { id: string; seq: number } }
  expect(imePayload.message.seq).toBeGreaterThan(firstPayload.message.seq)
  await expectMessageVisible(page, imeBody)
  await expect(page.getByTestId(tid.message(imePayload.message.id))).toHaveCount(1)
  await expect.poll(() => sends).toBe(1)

  const draft = `draft probe ${Date.now()}`
  await editable.click()
  await editable.pressSequentially(draft)
  await expect(editable).toContainText(draft)
  await page.goto("/c/me", { waitUntil: "commit" })
  await page.goto(channelUrl, { waitUntil: "commit" })
  await expect(composerEditable(page)).toContainText(draft)
  await expect(page.getByTestId(tid.message(firstPayload.message.id))).toHaveCount(1)
  await expect(page.getByTestId(tid.message(imePayload.message.id))).toHaveCount(1)

  let releaseMessages!: () => void
  const messagesGate = new Promise<void>((resolve) => { releaseMessages = resolve })
  let intercepted = false
  await page.route("**/api/community/channels/*/bootstrap*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    intercepted = true
    await messagesGate
    await route.continue()
  })
  await page.reload({ waitUntil: "commit" })
  await expect.poll(() => intercepted).toBe(true)
  releaseMessages()
  await expect(composerEditable(page)).toContainText(draft)
  await expect(page.getByTestId(tid.message(firstPayload.message.id))).toHaveCount(1)
  await expect(page.getByTestId(tid.message(imePayload.message.id))).toHaveCount(1)
  await page.unroute("**/api/community/channels/*/bootstrap*")

  const restored = composerEditable(page)
  await restored.click()
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Enter")
  await expect(restored).toHaveText("")
  await restored.pressSequentially("line one")
  await page.keyboard.press("Shift+Enter")
  await restored.pressSequentially("line two")
  await expect(restored).toContainText("line one")
  await expect(restored).toContainText("line two")

  await restored.click()
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.press("Backspace")
  await page.evaluate(() => {
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: () => "00000000-0000-4000-8000-000000000001",
    })
  })
  let releasePendingSend!: () => void
  const pendingSendGate = new Promise<void>((resolve) => { releasePendingSend = resolve })
  let pendingSendIntercepted = false
  let pendingSendCompleted = false
  await page.route("**/api/community/channels/*/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    pendingSendIntercepted = true
    await pendingSendGate
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "forced staging rejection probe" }),
    })
    pendingSendCompleted = true
  })

  await restored.pressSequentially(`pending ${Date.now()}`)
  await page.keyboard.press("Enter")
  await expect(restored).toHaveText("")
  await expect.poll(() => pendingSendIntercepted).toBe(true)

  const rejectedDraft = `rejected draft ${Date.now()}`
  await restored.pressSequentially(rejectedDraft)
  await page.evaluate(() => {
    const revokedUrls: string[] = []
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL)
    Object.defineProperty(window, "__messageStreamRevokedUrls", {
      configurable: true,
      value: revokedUrls,
    })
    URL.revokeObjectURL = (url) => {
      revokedUrls.push(url)
      revokeObjectUrl(url)
    }
  })
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "rejected.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("keep me"),
  })
  await expect(page.getByText("rejected.txt", { exact: true })).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(restored).toContainText(rejectedDraft)
  await expect(page.getByText("rejected.txt", { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __messageStreamRevokedUrls: string[] }).__messageStreamRevokedUrls.length,
  )).toBe(1)

  releasePendingSend()
  await expect.poll(() => pendingSendCompleted).toBe(true)
  await page.unroute("**/api/community/channels/*/messages")
  await page.goto("/c/me", { waitUntil: "commit" })
  await page.goto(channelUrl, { waitUntil: "commit" })
  await expect(composerEditable(page)).toContainText(rejectedDraft)
})
