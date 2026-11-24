import { currentCommunityFixtureError } from "./_fixtures/business-contract"
import type { Locator, Page, Request } from "@playwright/test"
import { type CaseActors, expect, test } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { composerEditable, createServer, expectMessageVisible, installInputCapability, sendMessage } from "./_fixtures/actions"
import { rootWorker } from "./_fixtures/public-static-qa"

type AttachmentDraftUrls = { created: string[]; revoked: string[]; files: { url: string; name: string; size: number; type: string }[] }

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press("Tab")
    if (await target.evaluate(element => document.activeElement === element)) return
  }
  await expect(target).toBeFocused()
}

async function openTouchCategoryMenu(page: Page, header: Locator) {
  await header.scrollIntoViewIfNeeded()
  const box = await header.boundingBox()
  if (!box) throw new Error("category title is outside the viewport")
  const session = await page.context().newCDPSession(page)
  let started = false
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 1, radiusY: 1, force: 1, id: 2 }],
    })
    started = true
    await expect(page.getByRole("menu")).toBeVisible()
  } finally {
    try {
      if (started) await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    } finally { await session.detach() }
  }
}

test("mobile category actions stay hidden while title menus and desktop keyboard actions work", async ({ caseActors }, testInfo) => {
  test.setTimeout(120_000)
  const actors = await caseActors(["alice", "bob"])
  const serverId = await actors.seed.seedServer("alice", `Category actions ${Date.now()}`)
  const categoryName = "CATEGORY ACTIONS"
  const categoryId = await actors.seed.seedCategory("alice", serverId, categoryName)
  const channelId = await actors.seed.seedChannel("alice", serverId, "category-actions", "text", categoryId)
  await actors.seed.seedJoinServer("alice", "bob", serverId)
  const settingsLabel = `Category settings for ${categoryName}`
  const createLabel = `Create channel in ${categoryName}`
  const mutations: string[] = []
  const observe = (request: Request) => {
    const path = new URL(request.url()).pathname
    if (request.method() !== "GET" && /\/(?:categories(?:\/[^/]+)?|channels(?:\/[^/]+)?|(?:category|channel)-order)$/.test(path)) mutations.push(`${request.method()} ${path}`)
  }
  const { page } = await actors.asUser("alice", { viewport: { width: 1280, height: 900 }, hasTouch: false, reducedMotion: "reduce" })
  page.on("request", observe)
  for (const width of [640, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.mouse.move(0, 0)
    await page.goto(`/c/channels/${serverId}/${channelId}`)
    const header = page.getByTestId(tid.categoryHeader(categoryId))
    await expect(header).toBeVisible()
    await expect(header).toHaveAttribute("aria-expanded", "true")
    const settings = header.getByRole("button", { name: settingsLabel, exact: true })
    const create = header.getByRole("button", { name: createLabel, exact: true })
    for (const button of [settings, create]) {
      await expect(button).toHaveCSS("display", "grid")
      await expect(button).toHaveCSS("opacity", "0")
    }
    await testInfo.attach(`category-actions-${width}-mouse-default.png`, { body: await page.screenshot(), contentType: "image/png" })
    await header.hover()
    for (const button of [settings, create]) await expect(button).toHaveCSS("opacity", "1")
    await page.mouse.move(0, 0)
    for (const button of [settings, create]) await expect(button).toHaveCSS("opacity", "0")
    for (const action of ["settings", "create"] as const) {
      await tabTo(page, header)
      await page.keyboard.press("Tab")
      if (action === "create") await page.keyboard.press("Tab")
      const button = action === "settings" ? settings : create
      await expect(button).toBeFocused()
      await expect(button).toHaveCSS("opacity", "1")
      await page.keyboard.press("Enter")
      const dialog = page.getByRole("dialog", { name: action === "settings" ? "Category settings" : `New channel in ${categoryName}`, exact: true })
      await expect(dialog).toBeVisible()
      await expect(header).toHaveAttribute("aria-expanded", "true")
      await expect(header).not.toHaveAttribute("data-dragging", "true")
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId(tid.channelRow(channelId))).toBeVisible()
    }
  }
  const { page: touch } = await actors.asUser("alice", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" })
  touch.on("request", observe)
  for (const width of [390, 639]) {
    await touch.setViewportSize({ width, height: 844 })
    await touch.goto(`/c/channels/${serverId}`)
    const header = touch.getByTestId(tid.categoryHeader(categoryId))
    const row = touch.getByTestId(tid.channelRow(channelId))
    await expect(header).toBeVisible()
    await expect(header).toHaveAttribute("aria-expanded", "true")
    const buttons = [settingsLabel, createLabel].map(name => header.getByRole("button", { name, exact: true, includeHidden: true }))
    for (const button of buttons) {
      await expect(button).toHaveCount(1)
      await expect(button).toHaveCSS("display", "none")
      expect(await button.boundingBox()).toBeNull()
    }
    for (const name of [settingsLabel, createLabel]) await expect(header.getByRole("button", { name, exact: true })).toHaveCount(0)
    await testInfo.attach(`category-actions-${width}-touch-default.png`, { body: await touch.screenshot(), contentType: "image/png" })
    await tabTo(touch, header)
    for (const button of buttons) await expect(button).toHaveCSS("display", "none")
    await touch.keyboard.press("Tab")
    await expect(row).toBeFocused()
    for (const action of ["settings", "create"] as const) {
      await openTouchCategoryMenu(touch, header)
      await touch.getByRole("menuitem", { name: action === "settings" ? "Category settings" : "Create channel", exact: true }).tap()
      const dialog = touch.getByRole("dialog", { name: action === "settings" ? "Category settings" : `New channel in ${categoryName}`, exact: true })
      await expect(dialog).toBeVisible()
      await expect(header).toHaveAttribute("aria-expanded", "true")
      await expect(header).not.toHaveAttribute("data-dragging", "true")
      await dialog.getByRole("button", { name: "Cancel", exact: true }).tap()
      await expect(dialog).toHaveCount(0)
      await expect(row).toBeVisible()
    }
    await header.tap()
    await expect(header).toHaveAttribute("aria-expanded", "false")
    await expect(row).toHaveCount(0)
    await header.tap()
    await expect(header).toHaveAttribute("aria-expanded", "true")
    await expect(row).toBeVisible()
  }
  const { page: member } = await actors.asUser("bob", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  member.on("request", observe)
  await member.goto(`/c/channels/${serverId}`)
  const memberHeader = member.getByTestId(tid.categoryHeader(categoryId))
  await expect(memberHeader).toBeVisible()
  for (const name of [settingsLabel, createLabel]) await expect(memberHeader.getByRole("button", { name, exact: true, includeHidden: true })).toHaveCount(0)
  expect(mutations).toEqual([])
  await testInfo.attach("category-actions-input.json", { body: JSON.stringify({ serverId, categoryId, channelId,
    contexts: [{ widths: [640, 1280], hasTouch: false, input: "mouse hover and native Tab/Enter" },
      { widths: [390, 639], hasTouch: true, isMobile: true, input: "stationary CDP touch hold, menu tap, native Tab and title tap" }],
    mutations }), contentType: "application/json" })
})

test("server → channel → message", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors

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
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "é" }))
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }))
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "é" }))
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
  const messageContinuations: Promise<void>[] = []
  const pendingMessageRequests = new Set<Request>()
  const settleMessageRequest = (request: Request) => { pendingMessageRequests.delete(request) }
  page.on("requestfinished", settleMessageRequest)
  page.on("requestfailed", settleMessageRequest)
  caseResources.own(releaseMessages, async (captured) => { captured(); await Promise.all(messageContinuations) })
  let heldMessageReads = 0
  await page.route("**/api/community/channels/*/messages*", route => {
    const request = route.request()
    const continuation = (async () => {
      if (request.method() === "GET") {
        pendingMessageRequests.add(request)
        heldMessageReads += 1
        await messagesGate
        if (!pendingMessageRequests.has(request)) return
      }
      try { await route.continue() } catch (error) {
        if (request.method() !== "GET" || pendingMessageRequests.has(request)) throw error
      }
    })()
    messageContinuations.push(continuation)
    return continuation
  })
  await page.reload({ waitUntil: "commit" })
  await expect.poll(() => heldMessageReads).toBeGreaterThan(0)
  await expect(composerEditable(page)).toHaveCount(0)
  await expect(page.getByTestId(tid.message(firstPayload.message.id))).toHaveCount(0)
  await expect(page.getByTestId(tid.message(imePayload.message.id))).toHaveCount(0)
  releaseMessages()
  await expect(composerEditable(page)).toContainText(draft)
  await expect(page.getByTestId(tid.message(firstPayload.message.id))).toHaveCount(1)
  await expect(page.getByTestId(tid.message(imePayload.message.id))).toHaveCount(1)
  await Promise.all(messageContinuations)
  await page.unroute("**/api/community/channels/*/messages*")
  page.off("requestfinished", settleMessageRequest)
  page.off("requestfailed", settleMessageRequest)

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
  let releasePendingSend!: () => void
  const pendingSendGate = new Promise<void>((resolve) => { releasePendingSend = resolve })
  caseResources.own(releasePendingSend, async (captured) => { captured() })
  let pendingSendIntercepted = false
  let pendingSendCompleted = false
  let pendingPostCount = 0
  const sendBodies: Array<{ content: string; nonce: string }> = []
  await page.route("**/api/community/channels/*/messages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    pendingPostCount++
    sendBodies.push(route.request().postDataJSON())
    pendingSendIntercepted = true
    await pendingSendGate
    await route.fulfill(currentCommunityFixtureError("forced staging rejection probe", 500))
    pendingSendCompleted = true
  })

  const pendingBody = `pending ${Date.now()}`
  await restored.pressSequentially(pendingBody)
  await page.keyboard.press("Enter")
  await expect(restored).toHaveText("")
  await expect.poll(() => pendingSendIntercepted).toBe(true)
  await expect.poll(() => pendingPostCount).toBe(1)
  expect(sendBodies[0]).toMatchObject({ content: pendingBody, nonce: expect.any(String) })
  expect(sendBodies[0]!.nonce).not.toBe("")

  const rejectedDraft = `rejected draft ${Date.now()}`
  await restored.pressSequentially(rejectedDraft)
  await page.evaluate(() => {
    const created: string[] = [], revoked: string[] = []
    const files: { url: string; name: string; size: number; type: string }[] = []
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    Object.defineProperty(window, "__attachmentDraftUrls", { configurable: true, value: { created, revoked, files } })
    URL.createObjectURL = (object) => {
      const url = create(object)
      created.push(url)
      if (object instanceof File) files.push({ url, name: object.name, size: object.size, type: object.type })
      return url
    }
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url) }
  })
  const previewBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  await page.getByTestId(tid.composerFileInput).setInputFiles({ name: "retry-preview.png", mimeType: "image/png", buffer: previewBytes })
  try {
    const previewCard = page.getByTestId(tid.composerInput).locator("../..").getByText("retry-preview.png", { exact: true }).locator("..")
    await expect(previewCard).toBeVisible()
    await expect(previewCard).not.toHaveAttribute("aria-busy", "true")
    await expect.poll(() => page.evaluate(() => {
      const { files, revoked } = (window as unknown as { __attachmentDraftUrls: AttachmentDraftUrls }).__attachmentDraftUrls
      return files.filter(file => file.name === "retry-preview.png" && !revoked.includes(file.url))
    })).toEqual([{ url: expect.stringMatching(/^blob:/), name: "retry-preview.png", type: "image/png", size: previewBytes.length }])
    const currentPreview = await page.evaluate(() => {
      const { files, revoked } = (window as unknown as { __attachmentDraftUrls: AttachmentDraftUrls }).__attachmentDraftUrls
      return files.find(file => file.name === "retry-preview.png" && !revoked.includes(file.url))!.url
    })
    await expect.poll(() => pendingPostCount).toBe(1)
    await expect(restored).toContainText(rejectedDraft)

    releasePendingSend()
    await expect.poll(() => pendingSendCompleted).toBe(true)
    const retry = page.getByRole("button", { name: "Message failed to send. Click to retry." })
    await expect(retry).toHaveCount(1)
    await expectMessageVisible(page, pendingBody)
    await page.unroute("**/api/community/channels/*/messages")
    const retryResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`)
    await retry.click()
    const retryResponse = await retryResponsePromise
    expect(retryResponse.status()).toBe(201)
    const retryBody = retryResponse.request().postDataJSON() as { content: string; nonce: string }
    expect(retryBody).toMatchObject({ content: pendingBody, nonce: sendBodies[0]!.nonce })
    expect(sends).toBe(3)
    const retryPayload = await retryResponse.json() as { message: { id: string } }
    await expect(page.getByTestId(tid.message(retryPayload.message.id))).toHaveCount(1)
    await expectMessageVisible(page, pendingBody)
    await expect(page.getByRole("button", { name: "Message failed to send. Click to retry." })).toHaveCount(0)
    await expect(restored).toContainText(rejectedDraft)
    await expect(page.getByText("retry-preview.png", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => {
      const { files, revoked } = (window as unknown as { __attachmentDraftUrls: AttachmentDraftUrls }).__attachmentDraftUrls
      return files.filter(file => file.name === "retry-preview.png" && !revoked.includes(file.url)).map(file => file.url)
    })).toEqual([currentPreview])
    expect(await page.evaluate((url) => (window as unknown as { __attachmentDraftUrls: { revoked: string[] } }).__attachmentDraftUrls.revoked.includes(url), currentPreview)).toBe(false)
    expect(await page.evaluate(async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), currentPreview)).toEqual(Array.from(previewBytes))
    const previewUploadResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/community/channels/${channelId}/attachments`)
    const previewMessageResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`)
    await restored.click()
    await expect.poll(() => restored.evaluate((element) => document.activeElement === element)).toBe(true)
    await page.keyboard.press("Enter")
    const previewUpload = await previewUploadResponsePromise
    expect(previewUpload.ok()).toBe(true)
    const previewAttachment = await previewUpload.json() as { id: string; filename: string; contentType: string; size: number }
    expect(previewAttachment).toMatchObject({ filename: "retry-preview.png", contentType: "image/png", size: previewBytes.length })
    const previewMessage = await previewMessageResponsePromise
    expect(previewMessage.status()).toBe(201)
    expect(previewMessage.request().postDataJSON()).toMatchObject({ content: rejectedDraft, attachments: [previewAttachment.id] })
    const downloadedPreview = await page.request.get(`/api/community/channels/${channelId}/attachments/${previewAttachment.id}`)
    expect(downloadedPreview.status()).toBe(200)
    expect(await downloadedPreview.body()).toEqual(previewBytes)
    await expect(restored).toHaveText("")
    await expect(previewCard).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => {
      const { files, revoked } = (window as unknown as { __attachmentDraftUrls: AttachmentDraftUrls }).__attachmentDraftUrls
      const owned = files.filter(file => file.name === "retry-preview.png")
      return owned.length > 0 && owned.every(file => revoked.filter(url => url === file.url).length === 1)
    })).toBe(true)
  } finally {
    const lifecycle = await page.evaluate(() => ({
      ...(window as unknown as { __attachmentDraftUrls: AttachmentDraftUrls }).__attachmentDraftUrls,
      at: performance.now(),
      clock: "performance.now in the current page",
    })).catch(error => ({ captureError: String(error) }))
    await testInfo.attach("attachment-draft-urls.json", { body: JSON.stringify(lifecycle), contentType: "application/json" })
  }
  const attachmentDraft = `${rejectedDraft} next attachment`
  await restored.pressSequentially(attachmentDraft)
  await page.goto("/c/me", { waitUntil: "commit" })
  await page.goto(channelUrl, { waitUntil: "commit" })
  const persisted = composerEditable(page)
  await expect(persisted).toContainText(attachmentDraft)

  await page.getByTestId(tid.composerFileInput).setInputFiles({
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
  const acceptedRequest = acceptedResponse.request().postDataJSON() as { attachments?: string[]; nonce: string }
  expect(acceptedRequest.attachments).toEqual([acceptedAttachment.id])
  expect(acceptedRequest.nonce).not.toBe(sendBodies[0]!.nonce)
  const acceptedPayload = await acceptedResponse.json() as { message: { id: string } }
  const attachmentPath = new URL(acceptedResponse.url()).pathname.replace(
    /\/messages$/,
    `/attachments/${acceptedAttachment.id}`,
  )
  const persistedAttachment = await page.request.get(attachmentPath)
  expect(persistedAttachment.status()).toBe(200)
  expect(persistedAttachment.headers()["content-type"]).toContain("text/plain")
  expect((await persistedAttachment.body()).toString()).toBe("transfer me")
  await expectMessageVisible(page, attachmentDraft)
  const acceptedMessage = page.getByTestId(tid.message(acceptedPayload.message.id))
  await expect(acceptedMessage).toHaveCount(1)
  await expect(acceptedMessage.getByText("accepted.txt", { exact: true })).toBeVisible()
  await expect(persisted).toHaveText("")
  await expect(page.getByTestId(tid.composerInput).locator("../..").getByText("accepted.txt", { exact: true })).toHaveCount(0)
})

test.describe("composer attachment drafts", () => {
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  )

  async function menuTargetState(target: Locator) {
    return target.evaluate(element => {
      const doc = element.ownerDocument
      const identify = (node: Element | null) => node ? { tag: node.tagName, id: node.id, testId: node.getAttribute("data-testid"), slot: node.getAttribute("data-slot") } : null
      const rectangle = (node: Element) => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height } }
      const bounds = element.getBoundingClientRect()
      const hit = doc.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return {
        at: performance.now(),
        clock: "performance.now in the current page",
        target: identify(element),
        bounds: rectangle(element),
        focused: identify(doc.activeElement),
        centerHit: identify(hit),
        targetOwnsCenterHit: !!hit && element.contains(hit),
        tooltips: Array.from(doc.querySelectorAll('[data-slot="tooltip-content"]'), popup => {
          const style = doc.defaultView!.getComputedStyle(popup)
          const parent = popup.parentElement
          return {
            identity: identify(popup),
            open: popup.hasAttribute("data-open"),
            closed: popup.hasAttribute("data-closed"),
            ending: popup.hasAttribute("data-ending-style"),
            state: popup.getAttribute("data-state"),
            hidden: popup.hasAttribute("hidden"),
            inert: popup.hasAttribute("inert"),
            hiddenAncestor: !!popup.closest("[hidden]"),
            inertAncestor: !!popup.closest("[inert]"),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            bounds: rectangle(popup),
            parent: parent ? { identity: identify(parent), hidden: parent.hidden, inert: parent.inert, ownsCenterHit: !!hit && parent.contains(hit) } : null,
          }
        }),
      }
    })
  }

  async function revealSidebar(page: Page) {
    const sidebar = page.locator('[data-slot="community-sidebar-panel-content"]')
    if (await sidebar.getAttribute("inert") !== null) {
      const back = page.getByRole("banner").getByRole("button", { name: "Back", exact: true })
      await expect(back).toBeVisible()
      await back.click()
      await expect(sidebar).not.toHaveAttribute("inert")
    }
  }

  async function navigateChannel(page: Page, serverId: string, channelId: string) {
    const route = `/c/channels/${serverId}/${channelId}`
    const row = page.getByTestId(tid.channelRow(channelId))
    await revealSidebar(page)
    if (!await row.isVisible()) await page.getByTestId(tid.serverIcon(serverId)).click()
    await expect(row).toBeVisible()
    await row.click()
    await page.waitForURL((url) => url.pathname === route)
    await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
  }

  async function navigateDm(page: Page, dmId: string) {
    await revealSidebar(page)
    await page.getByTestId(tid.homeButton).click()
    const row = page.getByTestId(tid.dmRow(dmId))
    await expect(row).toBeVisible()
    await row.click()
    await page.waitForURL((url) => url.pathname === `/c/me/${dmId}`)
    await expect(composerEditable(page)).toBeVisible({ timeout: 20_000 })
  }

  function composerAttachments(page: Page) {
    return page.getByTestId(tid.composerInput).locator("../..")
  }

  async function selectFromFocusedComposer(page: Page, pointer: "mouse" | "touch", file: { name: string; mimeType: string; buffer: Buffer }) {
    const editable = composerEditable(page)
    await expect(editable).toBeFocused()
    const caret = await editable.evaluate(element => {
      const text = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
      const selection = element.ownerDocument.getSelection()
      if (!text?.textContent || !selection) throw new Error("A focused nonempty draft is required")
      const offset = Math.floor(text.textContent.length / 2)
      selection.setBaseAndExtent(text, offset, text, offset)
      return { text: text.textContent, anchor: offset, focus: offset, collapsed: true, inside: true }
    })
    expect(caret.anchor).toBeGreaterThan(0)
    expect(caret.anchor).toBeLessThan(caret.text.length)
    const readCaret = () => editable.evaluate(element => {
      const selection = element.ownerDocument.getSelection()
      return {
        text: selection?.anchorNode?.textContent ?? null,
        anchor: selection?.anchorOffset ?? null,
        focus: selection?.focusOffset ?? null,
        collapsed: selection?.isCollapsed ?? false,
        inside: !!selection?.anchorNode && element.contains(selection.anchorNode) && !!selection.focusNode && element.contains(selection.focusNode),
      }
    })
    let chooserCount = 0
    const onChooser = () => { chooserCount++ }
    page.on("filechooser", onChooser)
    try {
      const attach = page.getByTestId(tid.composerAttach)
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        pointer === "touch" ? attach.tap() : attach.click(),
      ])
      expect(chooserCount).toBe(1)
      expect(chooser.isMultiple()).toBe(true)
      await expect(editable).toBeFocused()
      expect(await readCaret()).toEqual(caret)
      await chooser.setFiles(file)
      await expect(editable).toBeFocused()
      expect(await readCaret()).toEqual(caret)
      expect(chooserCount).toBe(1)
    } finally {
      page.off("filechooser", onChooser)
    }
  }

  test.describe("same-tab Community attachment drafts", () => {
    async function prepareCase1(actors: CaseActors) {
      const { userId } = actors
      const { seedChannel, seedDm, seedMessage, seedServer, seedThread } = actors.seed
      const serverId: string = await seedServer("alice", `attachment-drafts-${Date.now()}`)
      const channelAId: string = await seedChannel("alice", serverId, "attachment-draft-a")
      const channelBId: string = await seedChannel("alice", serverId, "attachment-draft-b")
      const openerId: string = await seedMessage("alice", channelAId, "attachment draft thread opener")
      const threadId: string = await seedThread("alice", openerId, "attachment-draft-thread")
      const dmId: string = await seedDm("alice", userId("bob"))
      return { serverId, channelAId, channelBId, openerId, threadId, dmId }
    }

    test("desktop isolates external file events and accepts input while real image workers prepare attachments", async ({ caseActors }, testInfo) => {
      test.setTimeout(120_000)
      const actors = await caseActors(["alice", "bob"])
      const { serverId, channelAId, channelBId } = await prepareCase1(actors)
      const otherServerId = await actors.seed.seedServer("alice", `file-event-sort-${Date.now()}`)
      const { page } = await actors.asUser("alice")
      await installInputCapability(page, true)
      await page.goto(`/c/channels/${serverId}/${channelAId}`, { waitUntil: "commit" })
      await expect(composerEditable(page)).toBeVisible()
      await rootWorker(page)
      const composer = composerAttachments(page)
      const transfer = await page.evaluateHandle(() => {
        const data = new DataTransfer()
        data.items.add(new File(["dropped document"], "dropped.txt", { type: "text/plain" }))
        return data
      })
      const menuStates: Array<{ stage: string; state: Awaited<ReturnType<typeof menuTargetState>> }> = []
      let activeMenuTarget: Locator | null = null
      const recordMenuState = async (stage: string, target: Locator) => { menuStates.push({ stage, state: await menuTargetState(target) }) }
      try {
        for (const target of [page.getByTestId(tid.serverIcon(serverId)), page.getByTestId(tid.channelRow(channelAId))]) {
          activeMenuTarget = target
          await recordMenuState("before-editor-focus", target)
          await composerEditable(page).click()
          await expect(composerEditable(page)).toBeFocused()
          await recordMenuState("editor-focused", target)
          await page.keyboard.press("Escape")
          await recordMenuState("after-escape", target)
          await target.click({ button: "right", trial: true, timeout: 10_000 })
          await recordMenuState("native-ready-before-files", target)
          await target.dispatchEvent("dragenter", { dataTransfer: transfer })
          await target.dispatchEvent("dragover", { dataTransfer: transfer })
          await expect(composer.getByText("Drop files here", { exact: true })).toHaveCount(0)
          await target.click({ button: "right" })
          if (await target.getAttribute("data-testid") === tid.serverIcon(serverId)) await expect(page.getByTestId(tid.serverSettingsOpen)).toBeVisible()
          else await expect(page.getByRole("menuitem", { name: "Edit channel", exact: true })).toBeVisible()
          await recordMenuState("menu-open-after-files", target)
          await page.keyboard.press("Escape")
          await target.dispatchEvent("dragleave", { dataTransfer: transfer })
        }
        await page.getByTestId(tid.channelRow(channelAId)).dispatchEvent("drop", { dataTransfer: transfer })
        await expect(composer.getByText("dropped.txt", { exact: true })).toHaveCount(0)
        await composer.dispatchEvent("dragenter", { dataTransfer: transfer })
        await expect(composer.getByText("Drop files here", { exact: true })).toBeVisible()
        await composer.dispatchEvent("drop", { dataTransfer: transfer })
        await expect(composer.getByText("Drop files here", { exact: true })).toHaveCount(0)
        await expect(composer.getByText("dropped.txt", { exact: true })).toBeVisible()
      } finally {
        const finalTargetState = activeMenuTarget ? await menuTargetState(activeMenuTarget).catch(error => ({ captureError: String(error) })) : { captureError: "No menu target selected" }
        await testInfo.attach("external-file-menu-input.json", { body: JSON.stringify({ observations: menuStates, finalTargetState, boundary: "Read-only DOM focus/style/center-hit evidence; native trial and actual secondary-click/menu assertions are the gates" }), contentType: "application/json" })
        await transfer.dispose()
      }

      await composerEditable(page).focus()
      await composerEditable(page).evaluate(element => {
        const data = new DataTransfer()
        data.items.add(new File(["pasted document"], "pasted.txt", { type: "text/plain" }))
        data.setData("text/html", `<p>${"discarded HTML ".repeat(30_000)}</p>`)
        data.setData("text/plain", "discarded clipboard text")
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
      })
      await expect(composer.getByText("pasted.txt", { exact: true })).toBeVisible()
      await expect(composerEditable(page)).toHaveText("")
      const workers: string[] = []
      page.on("worker", worker => workers.push(worker.url()))
      const workerScriptResponses: { path: string; status: number; contentType: string | null; fromServiceWorker: boolean }[] = []
      const recordWorkerScriptResponse = (response: import("@playwright/test").Response) => {
        const path = new URL(response.url()).pathname
        if (path.startsWith("/_next/static/chunks/") && path.endsWith(".js")) workerScriptResponses.push({ path, status: response.status(), contentType: response.headers()["content-type"] ?? null, fromServiceWorker: response.fromServiceWorker() })
      }
      page.on("response", recordWorkerScriptResponse)
      const serviceWorkerController = await page.evaluate(() => ({ script: navigator.serviceWorker.controller!.scriptURL, state: navigator.serviceWorker.controller!.state }))
      const imageData = await page.evaluateHandle(async () => {
        const canvas = document.createElement("canvas")
        canvas.width = 6000
        canvas.height = 4000
        const context = canvas.getContext("2d")!
        const pixels = context.createImageData(canvas.width, canvas.height)
        let seed = 98251
        for (let index = 0; index < pixels.data.length; index += 4) {
          seed = (seed * 1664525 + 1013904223) >>> 0
          pixels.data[index] = seed & 255
          pixels.data[index + 1] = seed >>> 8 & 255
          pixels.data[index + 2] = seed >>> 16 & 255
          pixels.data[index + 3] = 255
        }
        context.putImageData(pixels, 0, 0)
        const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/jpeg", 0.94))
        canvas.width = 0
        canvas.height = 0
        const data = new DataTransfer()
        for (let index = 0; index < 10; index++) data.items.add(new File([blob], `large-${index}.jpg`, { type: "image/jpeg" }))
        return data
      })
      for (const name of ["dropped.txt", "pasted.txt"]) await composer.getByText(name, { exact: true }).locator("..").getByRole("button", { name: "Remove file" }).click()
      await composerEditable(page).focus()
      const workerResults = await page.evaluateHandle(() => {
        const results: { width: number; height: number; size: number; type: string }[] = []
        const messages: { worker: number; kind: string; keys: string[]; unsupported: boolean; error: string | null; blob: { constructor: string; tag: string; mainRealmBlob: boolean; bytes: number | null; type: string | null } | null }[] = []
        const failures: { worker: number; event: string; message: string; filename: string; line: number; column: number }[] = []
        const instances: { worker: number; url: string; type: string }[] = []
        const capabilities = { Worker: typeof Worker, createImageBitmap: typeof createImageBitmap, OffscreenCanvas: typeof OffscreenCanvas }
        let nextWorker = 0
        const NativeWorker = window.Worker
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options)
            const worker = ++nextWorker
            instances.push({ worker, url: String(url), type: options?.type ?? "classic" })
            this.addEventListener("error", event => {
              failures.push({ worker, event: event.type, message: event.message, filename: event.filename, line: event.lineno, column: event.colno })
            })
            this.addEventListener("messageerror", event => {
              failures.push({ worker, event: event.type, message: "Worker message deserialization failed", filename: "", line: 0, column: 0 })
            })
            this.addEventListener("message", ({ data }) => {
              const object = data && typeof data === "object" ? data : null
              const blob = object?.result?.blob
              messages.push({
                worker,
                kind: object && "result" in object ? "result" : object && "error" in object ? "error" : object?.unsupported === true ? "unsupported" : "unknown",
                keys: object ? Object.keys(object) : [],
                unsupported: object?.unsupported === true,
                error: typeof object?.error === "string" ? object.error : null,
                blob: blob == null ? null : { constructor: blob.constructor?.name ?? "unknown", tag: Object.prototype.toString.call(blob), mainRealmBlob: blob instanceof Blob, bytes: typeof blob.size === "number" ? blob.size : null, type: typeof blob.type === "string" ? blob.type : null },
              })
              if (data?.result?.blob instanceof Blob) results.push({ width: data.result.width, height: data.result.height, size: data.result.blob.size, type: data.result.blob.type })
            })
          }
        }
        return { results, messages, failures, instances, capabilities }
      })
      const inputProbe = await composerEditable(page).evaluateHandle((element, inputId) => {
        const host = element.closest(`[data-testid="${inputId}"]`)?.parentElement?.parentElement
        const busy = () => !!host?.querySelector('[aria-busy="true"]')
        const started = performance.now()
        const keys: { at: number; eventToHandlerMs: number; trusted: boolean; preparing: boolean }[] = []
        const inputs: { at: number; keyToInputMs: number | null; eventToHandlerMs: number; nextFrameMs: number | null; trusted: boolean; preparing: boolean }[] = []
        const timerGaps: number[] = []
        const longTasks: { at: number; durationMs: number }[] = []
        let lastKey: number | null = null
        let lastTimer = started
        const keydown = (event: Event) => {
          const at = performance.now()
          lastKey = at
          keys.push({ at: at - started, eventToHandlerMs: Math.max(0, at - event.timeStamp), trusted: event.isTrusted, preparing: busy() })
        }
        const input = (event: Event) => {
          const at = performance.now()
          const sample = { at: at - started, keyToInputMs: lastKey === null ? null : at - lastKey, eventToHandlerMs: Math.max(0, at - event.timeStamp), nextFrameMs: null as number | null, trusted: event.isTrusted, preparing: busy() }
          inputs.push(sample)
          requestAnimationFrame(() => { sample.nextFrameMs = performance.now() - at })
        }
        element.addEventListener("keydown", keydown)
        element.addEventListener("input", input)
        const timer = setInterval(() => { const now = performance.now(); timerGaps.push(now - lastTimer); lastTimer = now }, 10)
        const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask")
        const observer = longTasksSupported ? new PerformanceObserver(list => {
          for (const entry of list.getEntries()) longTasks.push({ at: entry.startTime - started, durationMs: entry.duration })
        }) : null
        observer?.observe({ type: "longtask" })
        return {
          snapshot: () => ({ startedAt: started, clock: "performance.now in the current page", elapsedMs: performance.now() - started, keys, inputs, timerGaps, longTasksSupported, longTasks }),
          stop: () => { element.removeEventListener("keydown", keydown); element.removeEventListener("input", input); clearInterval(timer); observer?.disconnect() },
        }
      }, tid.composerInput)
      let admission: { constructor: string; files: { name: string; bytes: number }[]; consumed: boolean; focused: boolean } | undefined
      let acceptedFiles: string[] = []
      let survivingFiles: string[] = []
      try {
        admission = await composerEditable(page).evaluate((element, clipboardData) => {
          const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true })
          const files = Array.from(event.clipboardData?.files ?? [], file => ({ name: file.name, bytes: file.size }))
          element.dispatchEvent(event)
          return { constructor: event.constructor.name, files, consumed: event.defaultPrevented, focused: document.activeElement === element }
        }, imageData)
        expect(admission.constructor).toBe("ClipboardEvent")
        expect(admission.files).toHaveLength(10)
        expect(admission.consumed).toBe(true)
        expect(admission.focused).toBe(true)
        await expect(composer.getByRole("status").first()).toBeVisible()
        await expect(composer.getByRole("button", { name: "Remove file" })).toHaveCount(10)
        acceptedFiles = await composer.locator('[aria-label="Remove file"]').evaluateAll(buttons => buttons.map(button => button.parentElement!.querySelector("span")!.textContent!))
        expect(acceptedFiles).toEqual(admission.files.map(file => file.name))
        await composer.getByText("large-9.jpg", { exact: true }).locator("..").getByRole("button", { name: "Remove file" }).click()
        await expect(composer.getByRole("button", { name: "Remove file" })).toHaveCount(9)
        await composerEditable(page).pressSequentially("typing while image files prepare", { delay: 5 })
        await expect(composerEditable(page)).toHaveText("typing while image files prepare")
        await expect.poll(() => inputProbe.evaluate(probe => probe.snapshot().inputs.some(input => input.trusted && input.preparing))).toBe(true)
        await expect(composer.getByRole("status")).toHaveCount(0, { timeout: 30_000 })
        await expect(composer.getByText("large-9.jpg", { exact: true })).toHaveCount(0)
        await expect(composer.getByRole("button", { name: "Remove file" })).toHaveCount(9)
        survivingFiles = await composer.locator('[aria-label="Remove file"]').evaluateAll(buttons => buttons.map(button => button.parentElement!.querySelector("span")!.textContent!))
        expect(survivingFiles).toEqual(acceptedFiles.slice(0, 9))
        expect(workers.length).toBeGreaterThan(0)
        const prepared = await workerResults.evaluate(probe => probe.results)
        expect(prepared.length).toBeGreaterThan(0)
        expect(prepared).toHaveLength(survivingFiles.length)
        for (const result of prepared) {
          expect(result).toMatchObject({ width: 6000, height: 4000, type: "image/jpeg" })
          expect(result.size).toBeLessThanOrEqual(256 * 1024)
        }
      } finally {
        page.off("response", recordWorkerScriptResponse)
        const input = await inputProbe.evaluate(probe => { probe.stop(); return probe.snapshot() })
        const workerObservation = await workerResults.jsonValue()
        await testInfo.attach("image-preparation-input.json", { body: JSON.stringify({ admission, acceptedFiles, survivingFiles, workers, prepared: workerObservation.results, workerObservation, serviceWorkerController, workerScriptResponses, input, fixture: { width: 6000, height: 4000, files: 10 }, removedBeforePreparation: "large-9.jpg", timingBoundary: "Trusted page event delivery and next-frame opportunities; not compositor timestamps or a statistical performance gate" }), contentType: "application/json" })
        await imageData.dispose()
        await workerResults.dispose()
        await inputProbe.dispose()
      }
      while (await composer.getByRole("button", { name: "Remove file" }).count()) await composer.getByRole("button", { name: "Remove file" }).first().click()

      const nativeSource = (id: string, server: boolean) => page.getByTestId(server ? tid.serverIcon(id) : tid.channelRow(id)).locator("xpath=ancestor-or-self::*[@draggable='true'][1]")
      const orderPair = async (first: ReturnType<typeof nativeSource>, second: ReturnType<typeof nativeSource>) => {
        const firstBox = await first.boundingBox(), secondBox = await second.boundingBox()
        if (!firstBox || !secondBox) throw new Error("Native sorting source or target is not visible")
        return firstBox.y > secondBox.y ? [first, second] as const : [second, first] as const
      }
      const [railSource, railTarget] = await orderPair(nativeSource(serverId, true), nativeSource(otherServerId, true))
      const railAccepted = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/community/users/me/server-rail")
      await railSource.dragTo(railTarget, { targetPosition: { x: 22, y: 4 } })
      const railResponse = await railAccepted
      expect(railResponse.status()).toBe(200)
      expect(railResponse.request().postDataJSON()).toMatchObject({ commands: [{ kind: "reorder-top-level" }] })
      const [channelSource, channelTarget] = await orderPair(nativeSource(channelAId, false), nativeSource(channelBId, false))
      const channelAccepted = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/community/servers/${serverId}/channels/reorder`)
      await channelSource.dragTo(channelTarget, { targetPosition: { x: 22, y: 4 } })
      const channelResponse = await channelAccepted
      expect(channelResponse.status()).toBe(200)
      expect(channelResponse.request().postDataJSON()).toMatchObject({ channelIds: expect.arrayContaining([channelAId, channelBId]) })
      await expect(page).toHaveURL(url => url.pathname === `/c/channels/${serverId}/${channelAId}`)
      await navigateChannel(page, serverId, channelBId)
      await navigateChannel(page, serverId, channelAId)
      await expect(composer.getByRole("button", { name: "Remove file" })).toHaveCount(0)
      await expect(composerEditable(page)).toHaveText("typing while image files prepare")
    })

    test("desktop restores scoped real image/file drafts, rebuilds URLs, and removal never revives", async ({ caseActors }) => {
      test.setTimeout(120_000)

      const actors = await caseActors(["alice", "bob"])
      const { asUser } = actors
      const { serverId, channelAId, channelBId, openerId, threadId, dmId } = await prepareCase1(actors)

      const { page } = await asUser("alice")
      const channelA = `/c/channels/${serverId}/${channelAId}`
      await page.goto(channelA, { waitUntil: "commit" })
      const initialComposer = composerEditable(page)
      await expect(async () => {
        expect(await initialComposer.count()).toBe(1)
        expect(await initialComposer.isVisible()).toBe(true)
      }).toPass({ timeout: 20_000 })
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
      await selectFromFocusedComposer(page, "mouse", {
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
      const threadPanel = page.getByTestId(tid.threadSplitPanel)
      await expect(composerEditable(page, threadPanel)).toBeVisible()
      await expect(composerEditable(page, threadPanel)).toHaveText("")
      await expect(threadPanel.getByRole("button", { name: "Remove file" })).toHaveCount(0)
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

    test("desktop restored generic file survives upload failure, retries once, and never revives", async ({ caseActors }) => {
      test.setTimeout(120_000)

      const actors = await caseActors(["alice", "bob"])
      const { asUser } = actors
      const { serverId, channelAId, channelBId } = await prepareCase1(actors)

      const { page } = await asUser("alice")
      const channelA = `/c/channels/${serverId}/${channelAId}`
      await page.goto(channelA, { waitUntil: "commit" })
      const initialComposer = composerEditable(page)
      await expect(async () => {
        expect(await initialComposer.count()).toBe(1)
        expect(await initialComposer.isVisible()).toBe(true)
      }).toPass({ timeout: 20_000 })
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
          await route.fulfill(currentCommunityFixtureError("forced upload failure", 500))
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

    test("mobile restores scoped attachments, sends explicitly once, and reload restores text only", async ({ caseActors }) => {
      test.setTimeout(120_000)

      const actors = await caseActors(["alice", "bob"])
      const { asUser } = actors
      const { serverId, channelAId, channelBId } = await prepareCase1(actors)

      const { page } = await asUser("alice", { hasTouch: true })
      await installInputCapability(page, false)
      await page.setViewportSize({ width: 390, height: 844 })
      const channelA = `/c/channels/${serverId}/${channelAId}`
      await page.goto(channelA, { waitUntil: "commit" })
      const initialComposer = composerEditable(page)
      await expect(async () => {
        expect(await initialComposer.count()).toBe(1)
        expect(await initialComposer.isVisible()).toBe(true)
      }).toPass({ timeout: 20_000 })
      const body = `mobile restored image ${Date.now()}`
      await composerEditable(page).fill(body)
      await selectFromFocusedComposer(page, "touch", {
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
      await send.click()
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
})
