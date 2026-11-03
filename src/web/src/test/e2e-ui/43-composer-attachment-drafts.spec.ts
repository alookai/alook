import { currentCommunityFixtureError } from "./_fixtures/business-contract"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, installInputCapability } from "./_fixtures/actions"
import { rootWorker } from "./_fixtures/public-static-qa"

import { tid } from "./_fixtures/testids"
import type { CaseActors } from "./_fixtures/case-fixture"

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

    const { page } = await asUser("alice")
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
