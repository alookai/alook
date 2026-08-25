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
  const channelId = new URL(channelUrl).pathname.split("/").at(-1)!

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

  const editable = composerEditable(page)
  const pastePlainText = (text: string) => editable.evaluate((element, pastedText) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", pastedText)
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }))
  }, text)

  await editable.click()
  await pastePlainText("x".repeat(1_000))
  await expect(editable).toHaveText("x".repeat(1_000))
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.press("Backspace")

  const firstLongPaste = `# first paste\n\n${"a".repeat(1_001)}`
  const secondLongPaste = `second paste\n${"b".repeat(1_001)}`
  await pastePlainText(firstLongPaste)
  await pastePlainText(secondLongPaste)
  await expect(editable).toHaveText("")
  await expect(page.getByText("copy-1.md", { exact: true })).toBeVisible()
  await expect(page.getByText("copy-2.md", { exact: true })).toBeVisible()

  const longPasteResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return response.request().method() === "POST"
      && /^\/api\/community\/channels\/[^/]+\/messages$/.test(pathname)
  })
  await page.keyboard.press("Enter")
  const longPasteResponse = await longPasteResponsePromise
  expect(longPasteResponse.status()).toBe(201)
  const longPasteRequest = longPasteResponse.request().postDataJSON() as {
    content: string
    attachments?: string[]
  }
  expect(longPasteRequest.content).toBe("")
  expect(longPasteRequest.attachments).toHaveLength(2)
  const longPastePayload = await longPasteResponse.json() as { message: { id: string } }
  const longPasteMessage = page.getByTestId(tid.message(longPastePayload.message.id))
  await expect(longPasteMessage.getByText("copy-1.md", { exact: true })).toBeVisible()
  await expect(longPasteMessage.getByText("copy-2.md", { exact: true })).toBeVisible()
  await expect(page.getByTestId(tid.composerInput).locator("../..").getByText(/^copy-[12]\.md$/)).toHaveCount(0)

  let sends = 0
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === "POST" && /^\/api\/community\/channels\/[^/]+\/messages$/.test(pathname)) sends++
  })

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

  // Force this reload through the network-backed query path while preserving
  // the composer's localStorage draft. The app keeps this database open, so
  // clear the persister store in-place rather than using deleteDatabase.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("keyval-store")
    open.onerror = () => reject(open.error ?? new Error("failed to open query persister"))
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains("keyval")) {
        db.close()
        resolve()
        return
      }
      let tx: IDBTransaction
      try {
        tx = db.transaction("keyval", "readwrite")
        tx.objectStore("keyval").clear()
      } catch (error) {
        db.close()
        reject(error)
        return
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        const error = tx.error ?? new Error("failed to clear query persister")
        db.close()
        reject(error)
      }
      tx.onabort = () => {
        const error = tx.error ?? new Error("query persister clear aborted")
        db.close()
        reject(error)
      }
    }
  }))

  let releaseMessages!: () => void
  const messagesGate = new Promise<void>((resolve) => { releaseMessages = resolve })
  await page.route("**/api/community/channels/*/messages*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    await messagesGate
    await route.continue()
  })
  const messagesRequestPromise = page.waitForRequest((request) => {
    return request.method() === "GET"
      && new URL(request.url()).pathname === `/api/community/channels/${channelId}/messages`
  }, { timeout: 45_000 })
  await page.reload({ waitUntil: "commit" })
  await messagesRequestPromise
  releaseMessages()
  await expect(composerEditable(page)).toContainText(draft)
  await expect(page.getByTestId(tid.message(firstPayload.message.id))).toHaveCount(1)
  await expect(page.getByTestId(tid.message(imePayload.message.id))).toHaveCount(1)
  await page.unroute("**/api/community/channels/*/messages*")

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
    Object.defineProperty(window, "__messageStreamNonceCalls", {
      configurable: true,
      writable: true,
      value: 0,
    })
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: () => {
        ;(window as unknown as { __messageStreamNonceCalls: number }).__messageStreamNonceCalls++
        return "00000000-0000-4000-8000-000000000001"
      },
    })
  })
  let releasePendingSend!: () => void
  const pendingSendGate = new Promise<void>((resolve) => { releasePendingSend = resolve })
  let pendingSendIntercepted = false
  let pendingSendCompleted = false
  let pendingPostCount = 0
  await page.route("**/api/community/channels/*/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    pendingPostCount++
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
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __messageStreamNonceCalls: number }).__messageStreamNonceCalls,
  )).toBe(1)
  await expect.poll(() => pendingPostCount).toBe(1)

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
  await expect.poll(() => restored.evaluate((element) => document.activeElement === element)).toBe(true)
  await page.keyboard.press("Enter")
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __messageStreamNonceCalls: number }).__messageStreamNonceCalls,
  )).toBe(2)
  await expect.poll(() => pendingPostCount).toBe(1)
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
  const persisted = composerEditable(page)
  await expect(persisted).toContainText(rejectedDraft)

  await page.evaluate(() => {
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: () => "00000000-0000-4000-8000-000000000002",
    })
  })
  await page.locator('input[type="file"]').last().setInputFiles({
    name: "accepted.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("transfer me"),
  })
  await expect(page.getByText("accepted.txt", { exact: true })).toBeVisible()
  await expect.poll(() => persisted.evaluate((element) => document.activeElement === element)).toBe(true)
  const acceptedResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return response.request().method() === "POST"
      && /^\/api\/community\/channels\/[^/]+\/messages$/.test(pathname)
  })
  const acceptedUploadResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return response.request().method() === "POST"
      && /^\/api\/community\/channels\/[^/]+\/attachments$/.test(pathname)
  })
  await page.keyboard.press("Enter")
  const acceptedUploadResponse = await acceptedUploadResponsePromise
  expect(acceptedUploadResponse.ok()).toBe(true)
  const acceptedAttachment = await acceptedUploadResponse.json() as {
    id: string
    filename: string
    contentType: string
    size: number
  }
  expect(acceptedAttachment).toEqual(expect.objectContaining({
    filename: "accepted.txt",
    contentType: "text/plain",
    size: 11,
  }))
  const acceptedResponse = await acceptedResponsePromise
  expect(acceptedResponse.status()).toBe(201)
  const acceptedRequest = acceptedResponse.request().postDataJSON() as { attachments?: string[] }
  expect(acceptedRequest.attachments).toEqual([acceptedAttachment.id])
  const acceptedPayload = await acceptedResponse.json() as { message: { id: string } }
  const attachmentPath = new URL(acceptedResponse.url()).pathname.replace(
    /\/messages$/,
    `/attachments/${acceptedAttachment.id}`,
  )
  const persistedAttachment = await page.request.get(attachmentPath)
  expect(persistedAttachment.status()).toBe(200)
  expect(persistedAttachment.headers()["content-type"]).toContain("text/plain")
  expect((await persistedAttachment.body()).toString()).toBe("transfer me")
  await expectMessageVisible(page, rejectedDraft)
  const acceptedMessage = page.getByTestId(tid.message(acceptedPayload.message.id))
  await expect(acceptedMessage).toHaveCount(1)
  await expect(acceptedMessage.getByText("accepted.txt", { exact: true })).toBeVisible()
  await expect(persisted).toHaveText("")
  await expect(page.getByTestId(tid.composerInput).locator("../..").getByText("accepted.txt", { exact: true })).toHaveCount(0)
})
