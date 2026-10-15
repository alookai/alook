import { createRequire } from "module"
import { resolve } from "path"
import type { Locator, Page, Route, TestInfo, WebSocket as BrowserSocket } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"

import { tid } from "./_fixtures/testids"
import { MACHINE_WS_URL, REPO_ROOT, WEB_URL } from "./_setup/paths"
import type { CaseActors, CaseResources, OwnedCaseResource } from "./_fixtures/case-fixture"

async function prepareCase(actors: CaseActors, caseResources: CaseResources) {
  const { sessionCookie } = actors
  const createdBotIds = new Map<string, OwnedCaseResource<string>>()
  const createdMachineIds = new Map<string, OwnedCaseResource<string>>()
  async function cleanupCreatedResources(): Promise<void> {
    const errors: unknown[] = []
    for (const resource of [...createdBotIds.values(), ...createdMachineIds.values()]) {
      try {
        await resource.close()
      }
      catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Bot preview resource cleanup failed")
  }
  function headersFor(key: UserKey, extra?: Record<string, string>) {
    return {
      Cookie: sessionCookie(key),
      Origin: WEB_URL,
      ...extra,
    }
  }
  async function jsonRequest<T>(key: UserKey, path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${WEB_URL}${path}`, {
      ...init,
      headers: headersFor(key, {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      }),
    })
    expect(response.status, `${init?.method ?? "GET"} ${path}`).toBeLessThan(300)
    return response.json() as Promise<T>
  }
  async function pairMachine(): Promise<{
    credential: string
    machineId: string
  }> {
    const pair = await jsonRequest<{
      tokenId: string
    }>("alice", "/api/community/machines/pair", {
      method: "POST",
    })
    const activationProof: { response?: Response; machineId?: string } = {}
    const pairingToken = caseResources.own(pair.tokenId, async () => {
      if (!activationProof.response?.ok || !activationProof.machineId) throw new Error("Pairing token consumption is UNKNOWN; this case must stop")
    })
    const response = await fetch(`${WEB_URL}/api/community/daemon/activate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pair.tokenId}`,
        "Content-Type": "application/json",
        Origin: WEB_URL,
      },
      body: JSON.stringify({
        hostname: `profile-preview-e2e-${Date.now()}`,
        platform: "darwin",
        arch: "arm64",
        runtimeReport: [{ id: "codex", status: "healthy" }],
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as {
      credential: string
      machineId: string
    }
    createdMachineIds.set(data.machineId, caseResources.own(data.machineId, async (machineId) => {
      const response = await fetch(`${WEB_URL}/api/community/machines/${machineId}`, { method: "DELETE", headers: headersFor("alice") })
      expect(response.status, `delete test machine ${machineId}`).toBe(204)
      createdMachineIds.delete(machineId)
    }))
    activationProof.response = response
    activationProof.machineId = data.machineId
    await pairingToken.close()
    return data
  }
  async function createBot(machineId: string, name: string): Promise<string> {
    const data = await jsonRequest<{
      bot: {
        id: string
      }
    }>("alice", "/api/community/bots", {
      method: "POST",
      body: JSON.stringify({ name, machineId, runtime: "codex" }),
    })
    createdBotIds.set(data.bot.id, caseResources.own(data.bot.id, async (botId) => {
      const response = await fetch(`${WEB_URL}/api/community/bots/${botId}`, { method: "DELETE", headers: headersFor("alice") })
      expect(response.status, `delete test bot ${botId}`).toBe(204)
      createdBotIds.delete(botId)
    }))
    return data.bot.id
  }
  actors.onCleanup(cleanupCreatedResources)
  return { createdBotIds, createdMachineIds, cleanupCreatedResources, headersFor, jsonRequest, pairMachine, createBot }
}

type UserKey = "alice" | "bob"
type Rect = { x: number; y: number; width: number; height: number }
type PreviewFrameSample = {
  phase: "start" | "mutation" | "frame"
  rootOverflowX: number
  rootOverflowY: number
  scrollX: number
  scrollY: number
  ready: string | null
  visibility: string | null
  pointerEvents: string | null
  rect: Rect | null
  viewportWidth: number
  viewportHeight: number
}

async function rect(locator: Locator): Promise<Rect> {
  const value = await locator.boundingBox()
  expect(value).not.toBeNull()
  return value!
}

async function settleSheet(sheet: Locator): Promise<void> {
  await expect(sheet).toBeVisible()
  await sheet.evaluate((element) => new Promise<void>((resolveStable) => {
    const deadline = performance.now() + 1_000
    let previous = ""
    let stableFrames = 0
    const sample = () => {
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const current = [
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        style.opacity,
        style.transform,
        style.backgroundColor,
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ].join(":")
      stableFrames = current === previous ? stableFrames + 1 : 0
      previous = current
      if (stableFrames >= 3 || performance.now() >= deadline) resolveStable()
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
}

async function expectSheetThemeTokens(sheet: Locator): Promise<void> {
  const colors = await sheet.evaluate((element) => {
    const probe = document.createElement("div")
    probe.style.cssText = [
      "position:fixed",
      "visibility:hidden",
      "background-color:var(--background)",
      "border:1px solid var(--border)",
    ].join(";")
    document.body.appendChild(probe)

    const sheetStyle = getComputedStyle(element)
    const probeStyle = getComputedStyle(probe)
    const header = element.querySelector<HTMLElement>("[data-slot='sheet-header']")
    const body = element.querySelector<HTMLElement>("[data-slot='sheet-body']")
    if (!header || !body) throw new Error("missing sheet surface")
    const result = {
      expectedBackground: probeStyle.backgroundColor,
      expectedBorder: probeStyle.borderLeftColor,
      sheetBackground: sheetStyle.backgroundColor,
      sheetBorder: sheetStyle.borderLeftColor,
      headerBackground: getComputedStyle(header).backgroundColor,
      headerBorder: getComputedStyle(header).borderBottomColor,
      bodyBackground: getComputedStyle(body).backgroundColor,
    }
    probe.remove()
    return result
  })

  expect(colors).toMatchObject({
    sheetBackground: colors.expectedBackground,
    sheetBorder: colors.expectedBorder,
    headerBackground: "rgba(0, 0, 0, 0)",
    headerBorder: colors.expectedBorder,
    bodyBackground: colors.expectedBackground,
  })
}

async function attachPageScreenshot(testInfo: TestInfo, name: string, page: Page): Promise<void> {
  await testInfo.attach(`${name}.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
}

async function expectActivityHeader(
  page: Page,
  testInfo: TestInfo,
  width: 390 | 1280,
): Promise<void> {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  const sheet = page.getByTestId(tid.botActivityModal)
  await settleSheet(sheet)
  const header = sheet.locator("[data-slot='sheet-header']")
  const avatar = header.locator("[data-slot='sheet-header-leading']")
  const title = header.locator("[data-slot='sheet-title']")
  const description = header.locator("[data-slot='sheet-description']")
  const close = sheet.getByRole("button", { name: "Close", exact: true })
  const [avatarRect, titleRect, descriptionRect, closeRect] = await Promise.all([
    rect(avatar), rect(title), rect(description), rect(close),
  ])

  expect(avatarRect.width).toBeCloseTo(32, 0)
  expect(avatarRect.height).toBeCloseTo(32, 0)
  expect(titleRect.x).toBeGreaterThanOrEqual(avatarRect.x + avatarRect.width + 11.5)
  expect(descriptionRect.x).toBeCloseTo(titleRect.x, 0)
  expect(titleRect.x + titleRect.width).toBeLessThanOrEqual(closeRect.x + 0.5)
  const styles = await title.evaluate((element) => {
    const titleStyle = getComputedStyle(element)
    const descriptionNode = element.parentElement?.querySelector<HTMLElement>("[data-slot='sheet-description']")
    if (!descriptionNode) throw new Error("missing Activity Log description")
    const descriptionStyle = getComputedStyle(descriptionNode)
    return {
      titleFontSize: titleStyle.fontSize,
      titleFontWeight: titleStyle.fontWeight,
      titleLineHeight: titleStyle.lineHeight,
      descriptionFontSize: descriptionStyle.fontSize,
      descriptionLineHeight: descriptionStyle.lineHeight,
    }
  })
  expect(styles).toMatchObject({
    titleFontSize: "18px",
    titleFontWeight: "600",
    descriptionFontSize: "14px",
  })
  expect(Number.parseFloat(styles.titleLineHeight)).toBeGreaterThan(Number.parseFloat(styles.titleFontSize))
  expect(Number.parseFloat(styles.descriptionLineHeight)).toBeGreaterThan(Number.parseFloat(styles.descriptionFontSize))
  await attachPageScreenshot(testInfo, `activity-log-header-${width}`, page)
}

async function expectFooterGeometry(
  page: Page,
  title: string,
  actionNames: string[],
  width: 390 | 639 | 640,
): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  const sheet = page.getByRole("dialog", { name: title, exact: true })
  await settleSheet(sheet)
  const footer = sheet.locator("[data-slot='sheet-footer']")
  const actions = actionNames.map((name) => footer.getByRole("button", { name, exact: true }))
  const footerRect = await rect(footer)
  const actionRects = await Promise.all(actions.map(rect))
  const style = await footer.evaluate((element) => {
    const value = getComputedStyle(element)
    return {
      display: value.display,
      flexDirection: value.flexDirection,
      justifyContent: value.justifyContent,
      alignItems: value.alignItems,
    }
  })
  expect(style).toEqual({
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  })
  for (const actionRect of actionRects) {
    expect(actionRect.width).toBeLessThan(footerRect.width * 0.75)
    if (width < 640) expect(actionRect.height).toBeGreaterThanOrEqual(44)
  }
  for (let index = 1; index < actionRects.length; index++) {
    expect(actionRects[index]!.x).toBeGreaterThan(actionRects[index - 1]!.x)
    expect(actionRects[index]!.y).toBeCloseTo(actionRects[0]!.y, 0)
  }
  const finalAction = actionRects.at(-1)!
  expect(footerRect.x + footerRect.width - (finalAction.x + finalAction.width))
    .toBe(width < 640 ? 16 : 24)
}

async function enrollBot(credential: string, botId: string): Promise<string> {
  const response = await fetch(`${WEB_URL}/api/community/daemon/enroll-agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ agentId: botId }),
  })
  expect(response.status).toBe(200)
  const data = await response.json() as { runnerKey: string }
  return data.runnerKey
}

async function sendBotMessage(
  runnerKey: string,
  channel: string,
  text: string,
  seenUpToSeq = 0,
): Promise<{ seq: number }> {
  const response = await fetch(`${WEB_URL}/api/community/channels/resolve/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runnerKey}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({
      channel,
      content: { text },
      attachments: [],
      seenUpToSeq,
      nonce: `profile-preview:${crypto.randomUUID()}`,
    }),
  })
  expect(response.status).toBe(200)
  const data = await response.json() as { state: string; message: { seq: string } }
  expect(data.state).toBe("sent")
  const seq = Number(data.message.seq.replace(/^#/, ""))
  expect(Number.isInteger(seq) && seq > 0).toBe(true)
  return { seq }
}

async function setBotMark(
  runnerKey: string,
  channel: string,
  seq: number,
): Promise<void> {
  const response = await fetch(`${WEB_URL}/api/community/messages/resolve/properties`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${runnerKey}`,
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({
      channel,
      seq,
      property: { type: "mark", value: true },
    }),
  })
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toMatchObject({ type: "mark", value: true })
}

type MachineSocket = {
  send: (data: string) => void
  close: () => void
  readonly readyState: number
  once(event: "close", listener: () => void): void
  once(event: "open", listener: () => void): void
  once(event: "error", listener: (error: Error) => void): void
  once(event: "message", listener: (data: unknown) => void): void
  on(event: "message", listener: (data: unknown) => void): void
  off(event: "message", listener: (data: unknown) => void): void
}

function connectMachine(credential: string, caseResources: CaseResources) {
  const requireFromDaemon = createRequire(resolve(REPO_ROOT, "src/daemon/package.json"))
  const Ws = requireFromDaemon("ws") as {
    WebSocket: new (url: string, options: { headers: Record<string, string> }) => MachineSocket
  }
  const socket = new Ws.WebSocket(MACHINE_WS_URL.replace(/^http/, "ws"), {
    headers: { Authorization: `Bearer ${credential}` },
  })
  const ownedSocket = caseResources.own(socket, async (captured) => {
    await new Promise<void>((resolve) => {
      if (captured.readyState === 3) { resolve(); return }
      captured.once("close", resolve)
      captured.close()
    })
  })
  return {
    socket,
    close: () => ownedSocket.close(),
    opened: new Promise<void>((resolveOpen, reject) => {
      socket.once("open", () => resolveOpen())
      socket.once("error", reject)
    }),
  }
}

async function openBotProfile(page: Page, botName: string): Promise<void> {
  await page.getByRole("button", { name: botName, exact: true }).click()
  await expect(page.getByTestId(tid.profileCard)).toBeVisible()
}

async function installPreviewFrameProbe(page: Page): Promise<void> {
  await page.evaluate((dockTestId) => {
    type ProbeState = {
      active: boolean
      observer: MutationObserver
      samples: PreviewFrameSample[]
    }
    const target = window as typeof window & { __previewFrameProbe?: ProbeState }
    const samples: PreviewFrameSample[] = []
    const sample = (phase: PreviewFrameSample["phase"]) => {
      if (samples.length >= 500) return
      const root = document.documentElement
      const dock = document.querySelector<HTMLElement>(`[data-testid="${dockTestId}"]`)
      const style = dock ? getComputedStyle(dock) : null
      const bounds = dock?.getBoundingClientRect()
      samples.push({
        phase,
        rootOverflowX: root.scrollWidth - root.clientWidth,
        rootOverflowY: root.scrollHeight - root.clientHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        ready: dock?.getAttribute("data-measurement-ready") ?? null,
        visibility: style?.visibility ?? null,
        pointerEvents: style?.pointerEvents ?? null,
        rect: bounds
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          : null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
    }
    const observer = new MutationObserver(() => sample("mutation"))
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-measurement-ready", "style"],
      childList: true,
      subtree: true,
    })
    target.__previewFrameProbe = { active: true, observer, samples }
    sample("start")
    const frame = () => {
      const state = target.__previewFrameProbe
      if (!state?.active) return
      sample("frame")
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, tid.botAuditPreviewDock)
}

async function finishPreviewFrameProbe(page: Page): Promise<PreviewFrameSample[]> {
  return page.evaluate(async () => {
    await new Promise<void>((resolveFrames) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(
        () => resolveFrames(),
      )))
    })
    const target = window as typeof window & {
      __previewFrameProbe?: {
        active: boolean
        observer: MutationObserver
        samples: PreviewFrameSample[]
      }
    }
    const state = target.__previewFrameProbe
    if (!state) throw new Error("preview frame probe was not installed")
    state.active = false
    state.observer.disconnect()
    return state.samples
  })
}

function expectPreviewFrames(samples: PreviewFrameSample[], label: string): void {
  expect(samples.length, `${label}: captured frames`).toBeGreaterThan(1)
  const baseline = samples[0]!
  expect(baseline.rootOverflowX, `${label}: baseline root X overflow`).toBe(0)
  expect(baseline.rootOverflowY, `${label}: baseline root Y overflow`).toBe(0)
  const visible = samples.filter((sample) => sample.ready === "true"
    && sample.visibility === "visible"
    && sample.rect)
  expect(visible.length, `${label}: visible positioned frames`).toBeGreaterThan(0)

  for (const [index, sample] of samples.entries()) {
    expect(sample.rootOverflowX, `${label}: frame ${index} root X overflow`).toBe(0)
    expect(sample.rootOverflowY, `${label}: frame ${index} root Y overflow`).toBe(0)
    expect(sample.scrollX, `${label}: frame ${index} root scrollX`).toBe(baseline.scrollX)
    expect(sample.scrollY, `${label}: frame ${index} root scrollY`).toBe(baseline.scrollY)
    if (sample.ready === "false") {
      expect(sample.visibility, `${label}: frame ${index} hidden measurement`).toBe("hidden")
      expect(sample.pointerEvents, `${label}: frame ${index} inert measurement`).toBe("none")
    }
    if (sample.ready !== "true" || sample.visibility !== "visible" || !sample.rect) continue
    expect(sample.rect.x, `${label}: frame ${index} left boundary`).toBeGreaterThanOrEqual(7.5)
    expect(sample.rect.y, `${label}: frame ${index} top boundary`).toBeGreaterThanOrEqual(7.5)
    expect(
      sample.rect.x + sample.rect.width,
      `${label}: frame ${index} right boundary`,
    ).toBeLessThanOrEqual(sample.viewportWidth - 7.5)
    expect(
      sample.rect.y + sample.rect.height,
      `${label}: frame ${index} bottom boundary`,
    ).toBeLessThanOrEqual(sample.viewportHeight - 7.5)
  }
}

async function probeOwnedBotProfile(
  page: Page,
  author: Locator,
  label: string,
): Promise<PreviewFrameSample[]> {
  await expect(author).toBeVisible({ timeout: 20_000 })
  await installPreviewFrameProbe(page)
  await author.click()
  const dock = page.getByTestId(tid.botAuditPreviewDock)
  await expect(dock).toHaveAttribute("data-measurement-ready", "true")
  await expect(dock).toBeVisible()
  const samples = await finishPreviewFrameProbe(page)
  expectPreviewFrames(samples, label)
  return samples
}

test("full audit log reveals a truncated row by hover and touch", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { headersFor, pairMachine, createBot } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const longAuditTarget = `/Users/alice/workspace/${"deeply-nested-audit-target/".repeat(5)}result-${suffix}.md`
  const fullAuditText = `read · ${longAuditTarget}`
  const { credential, machineId } = await pairMachine()
  const botId = await createBot(machineId, `Tooltip bot ${suffix}`)
  const machine = connectMachine(credential, caseResources)
  await machine.opened

  let caseJourneyFailure1: unknown
let caseJourneyFailure1Present = false
  try {
    machine.socket.send(JSON.stringify({
      type: "bot_audit_event",
      agentId: botId,
      sessionId: `session-${suffix}`,
      launchId: `launch-${suffix}`,
      event: { kind: "tool_call", payload: { name: "Read", target: longAuditTarget } },
    }))

    await expect.poll(async () => {
      const response = await fetch(
        `${WEB_URL}/api/community/bots/${botId}/audit-log?limit=10`,
        { headers: headersFor("alice") },
      )
      if (!response.ok) return false
      const { events } = (await response.json()) as {
        events: Array<{ payload?: { target?: string } | null }>
      }
      return events.some((event) => event.payload?.target === longAuditTarget)
    }).toBe(true)

    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoAfterUserWsAuth(page, `/c/me/bots?audit=${botId}`)
    const sheet = page.getByTestId(tid.botActivityModal)
    await settleSheet(sheet)
    const trigger = sheet.locator("[data-activity-tooltip-trigger]").filter({ hasText: "read" })
    await expect(trigger).toHaveCount(1)
    await expect.poll(() => trigger.locator("span").first().evaluate((element) => (
      element.scrollWidth > element.clientWidth
    ))).toBe(true)

    await trigger.hover()
    const tooltip = page.getByRole("tooltip")
    await expect(tooltip).toHaveText(fullAuditText)
    await expect(tooltip).toHaveCSS("opacity", "1")
    await attachPageScreenshot(testInfo, "bot-activity-log-tooltip-desktop", page)
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    await settleSheet(sheet)
    await expectSheetThemeTokens(sheet)
    await expect(tooltip).toHaveCSS("opacity", "1")
    await attachPageScreenshot(testInfo, "bot-activity-log-tooltip-desktop-dark", page)
    await page.mouse.move(0, 0)
    await expect(tooltip).toBeHidden()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await settleSheet(sheet)
    await trigger.click()
    const detailDialog = page.getByRole("dialog", { name: "Activity details" })
    await expect(detailDialog.getByTestId(tid.botActivityDetail)).toHaveText(fullAuditText)
    await attachPageScreenshot(testInfo, "bot-activity-log-detail-mobile", page)
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    await expect(detailDialog.getByTestId(tid.botActivityDetail)).toHaveText(fullAuditText)
    await attachPageScreenshot(testInfo, "bot-activity-log-detail-mobile-dark", page)
    await detailDialog.getByRole("button", { name: "Close" }).click()
    await expect(detailDialog).toBeHidden()
    await expect(trigger).toBeFocused()
  } catch (error) { caseJourneyFailure1 = error; caseJourneyFailure1Present = true; throw error } finally {
    try {

      await machine.close()

    } catch (cleanupError) { if (caseJourneyFailure1Present) throw new AggregateError([caseJourneyFailure1, cleanupError], "Journey and resource exit both failed"); throw cleanupError }
  }
})

test("owned bot profile preview stays root-bounded from its first visible frame", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice", "bob"])
  const { asUser } = actors
  const { seedChannel, seedForumThread, seedJoinServer, seedServer } = actors.seed
  const { jsonRequest, pairMachine, createBot } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `preview-overflow-${suffix}`)
  const channelName = `regular-${suffix}`
  const forumName = `forum-${suffix}`
  const channelId = await seedChannel("alice", serverId, channelName)
  const forumId = await seedChannel("alice", serverId, forumName, "forum")
  const forumThreadId = await seedForumThread(
    "alice",
    forumId,
    `Right column ${suffix}`,
    `Forum opener ${suffix}`,
  )
  await seedJoinServer("alice", "bob", serverId)

  const { credential, machineId } = await pairMachine()
  const botName = `Overflow bot ${suffix}`
  const botId = await createBot(machineId, botName)
  await jsonRequest("alice", `/api/community/servers/${serverId}/bots`, {
    method: "POST",
    body: JSON.stringify({ botId }),
  })
  const runnerKey = await enrollBot(credential, botId)
  const { servers } = await jsonRequest<{
    servers: Array<{ id: string; name: string; discriminator: string }>
  }>("alice", "/api/community/servers")
  const server = servers.find((candidate) => candidate.id === serverId)
  expect(server).toBeTruthy()
  const channelRef = `/${server!.name}#${server!.discriminator}/${channelName}`
  const forumRef = `/${server!.name}#${server!.discriminator}/${forumName}`
  const forumEnvelope = await jsonRequest<{
    threads: Array<{ id: string; parentMessageId: string | null }>
    included: { parentMessages: Array<{ id: string; seq: number }> }
  }>(
    "alice",
    `/api/community/channels/${forumId}/threads?order=createdAt&limit=50&include=parentMessage`,
  )
  const forumThread = forumEnvelope.threads.find((thread) => thread.id === forumThreadId)
  const forumOpener = forumEnvelope.included.parentMessages.find(
    (message) => message.id === forumThread?.parentMessageId,
  )
  expect(forumOpener?.seq).toBeGreaterThan(0)
  await sendBotMessage(runnerKey, channelRef, `Regular overflow probe ${suffix}`)
  await sendBotMessage(
    runnerKey,
    `${forumRef}/#${forumOpener!.seq}`,
    `Forum overflow probe ${suffix}`,
  )

  const regularRoute = `/c/channels/${serverId}/${channelId}`
  const alice = await asUser("alice")
  await alice.page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(alice.page, regularRoute)
  const regularFrames = await probeOwnedBotProfile(
    alice.page,
    alice.page.getByRole("button", { name: botName, exact: true }),
    "regular channel",
  )
  await testInfo.attach("owned-agent-preview-regular-frames.json", {
    body: Buffer.from(JSON.stringify(regularFrames, null, 2)),
    contentType: "application/json",
  })
  await attachPageScreenshot(testInfo, "owned-agent-preview-regular", alice.page)

  await gotoAfterUserWsAuth(alice.page, `/c/channels/${serverId}/${forumThreadId}`)
  const split = alice.page.getByTestId(tid.threadSplit)
  await expect(split).toHaveAttribute("data-layout", "split", { timeout: 20_000 })
  const threadPanel = alice.page.getByTestId(tid.threadSplitPanel)
  const forumFrames = await probeOwnedBotProfile(
    alice.page,
    threadPanel.getByRole("button", { name: botName, exact: true }),
    "forum split right column",
  )
  await testInfo.attach("owned-agent-preview-forum-split-frames.json", {
    body: Buffer.from(JSON.stringify(forumFrames, null, 2)),
    contentType: "application/json",
  })
  await attachPageScreenshot(testInfo, "owned-agent-preview-forum-split", alice.page)

  await alice.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(alice.page, regularRoute)
  await openBotProfile(alice.page, botName)
  await expect(alice.page.getByRole("dialog", { name: `${botName} profile` })).toBeVisible()
  await expect(alice.page.getByTestId(tid.botMarkSticker)).toBeVisible()
  await expect(alice.page.getByTestId(tid.botAuditPreviewDock)).toHaveCount(0)
  await attachPageScreenshot(testInfo, "owned-agent-preview-mobile-390", alice.page)

  const bob = await asUser("bob")
  await bob.page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(bob.page, regularRoute)
  await openBotProfile(bob.page, botName)
  await expect(bob.page.getByTestId(tid.profileOwnerLink)).toBeVisible()
  await expect(bob.page.getByTestId(tid.botMarkSticker)).toHaveCount(0)
  await expect(bob.page.getByTestId(tid.botAuditPreviewDock)).toHaveCount(0)
  await attachPageScreenshot(testInfo, "owned-agent-preview-non-owner", bob.page)
})

test("owner-only bot mark sticker, Stop lifecycle, owner swap, and URL-owned audit modal", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(180_000)

  const actors = await caseActors(["alice", "bob"])
  const { asUser } = actors
  const { seedChannel, seedJoinServer, seedServer } = actors.seed
  const { headersFor, jsonRequest, pairMachine, createBot } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `profile-preview-server-with-a-long-name-${suffix}`)
  const channelName = `bots-with-a-long-channel-name-${suffix}`
  const channelId = await seedChannel("alice", serverId, channelName)
  const staleServerId = await seedServer("alice", `stale-mark-server-${suffix}`)
  const staleChannelName = `former-private-work-${suffix}`
  const staleChannelId = await seedChannel("alice", staleServerId, staleChannelName)
  await seedJoinServer("alice", "bob", serverId)

  const { credential, machineId } = await pairMachine()
  const botName = `Preview bot ${suffix} long-name`
  const botId = await createBot(machineId, botName)
  await jsonRequest("alice", `/api/community/servers/${serverId}/bots`, {
    method: "POST",
    body: JSON.stringify({ botId }),
  })
  await jsonRequest("alice", `/api/community/servers/${staleServerId}/bots`, {
    method: "POST",
    body: JSON.stringify({ botId }),
  })

  const { servers } = await jsonRequest<{
    servers: Array<{ id: string; name: string; discriminator: string }>
  }>("alice", "/api/community/servers")
  const server = servers.find((candidate) => candidate.id === serverId)
  const staleServer = servers.find((candidate) => candidate.id === staleServerId)
  expect(server).toBeTruthy()
  expect(staleServer).toBeTruthy()
  const runnerKey = await enrollBot(credential, botId)
  const channelRef = `/${server!.name}#${server!.discriminator}/${channelName}`
  let latestSeq = 0
  for (const index of [1, 2, 3]) {
    const created = await jsonRequest<{ message: { seq: number } }>(
      "alice",
      `/api/community/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content: `Marked task ${index} ${suffix}` }),
      },
    )
    latestSeq = created.message.seq
    await setBotMark(runnerKey, channelRef, latestSeq)
  }
  const longBotMessage = await sendBotMessage(
    runnerKey,
    channelRef,
    `**Long marked task ${suffix}** ${"with enough detail to require a second line ".repeat(5)}`,
    latestSeq,
  )
  await setBotMark(runnerKey, channelRef, longBotMessage.seq)

  const staleMessage = await jsonRequest<{ message: { seq: number } }>(
    "alice",
    `/api/community/channels/${staleChannelId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ content: `Persisted stale mark ${suffix}` }),
    },
  )
  const staleChannelRef = `/${staleServer!.name}#${staleServer!.discriminator}/${staleChannelName}`
  await setBotMark(runnerKey, staleChannelRef, staleMessage.message.seq)
  const staleMembers = await jsonRequest<{
    members: Array<{ id: string; userId: string }>
  }>("alice", `/api/community/servers/${staleServerId}/members`)
  const staleBotMember = staleMembers.members.find((member) => member.userId === botId)
  expect(staleBotMember).toBeTruthy()
  const removeStaleBot = await fetch(
    `${WEB_URL}/api/community/servers/${staleServerId}/members/${staleBotMember!.id}`,
    { method: "DELETE", headers: headersFor("alice") },
  )
  expect(removeStaleBot.status).toBe(204)

  const machine = connectMachine(credential, caseResources)
  await machine.opened
  let caseJourneyFailure2: unknown
let caseJourneyFailure2Present = false
  try {
    machine.socket.send(JSON.stringify({ type: "agent_activity", agentId: botId, state: "idle" }))
    for (let index = 0; index < 11; index += 1) {
      machine.socket.send(JSON.stringify({
        type: "bot_audit_event",
        eventId: `bae_${suffix}_${String(index).padStart(2, "0")}`,
        agentId: botId,
        sessionId: `session-${suffix}`,
        launchId: `launch-${suffix}`,
        event: { kind: "text", payload: { text: `Open activity log ${index}`, truncated: false, chars: `Open activity log ${index}`.length } },
      }))
    }

    await expect.poll(async () => {
      const response = await fetch(
        `${WEB_URL}/api/community/bots/${botId}/audit-log?limit=10`,
        { headers: headersFor("alice") },
      )
      if (!response.ok) return 0
      return ((await response.json()) as { events: unknown[] }).events.length
    }).toBe(10)

    const authoritativeMarks = await jsonRequest<{
      marked: Array<{
        id: string
        server: string
        channel: string
        m: { authorName: string; content: string; createdAt: string }
      }>
    }>("alice", `/api/community/bots/${botId}/marks`)
    expect(authoritativeMarks.marked).toHaveLength(4)
    expect(authoritativeMarks.marked.some((mark) => mark.m.authorName === botName)).toBe(true)
    expect(authoritativeMarks.marked).toContainEqual(expect.objectContaining({
      server: staleServer!.name,
      channel: staleChannelName,
      m: expect.objectContaining({ content: `Persisted stale mark ${suffix}` }),
    }))

    const route = `/c/channels/${serverId}/${channelId}`
    const alice = await asUser("alice")
    const ownerMarkRequests: string[] = []
    alice.page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/community/bots/${botId}/marks`) {
        ownerMarkRequests.push(request.url())
      }
    })
    await gotoAfterUserWsAuth(alice.page, route)
    await openBotProfile(alice.page, botName)

    const sticker = alice.page.getByTestId(tid.botMarkSticker)
    await expect(sticker).toBeVisible()
    await expect(sticker).toHaveAttribute("aria-label", "Bot log")
    const activityTab = sticker.getByRole("tab", { name: "Thoughts" })
    const marksTab = sticker.getByRole("tab", { name: /Marked messages/ })
    const auditRows = alice.page.locator(
      `[data-testid^="${tid.botAuditPreviewRow("")}"]`,
    )
    const activityScroller = sticker
      .getByRole("tabpanel", { name: "Recent thoughts" })
      .getByTestId(tid.botAuditPreviewScroll)
    await expect(activityTab).toHaveAttribute("aria-selected", "true")
    await expect(auditRows).toHaveCount(10)
    await expect(activityScroller).toHaveCSS("overflow-y", "auto")
    await expect.poll(async () => activityScroller.evaluate((element) =>
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1))
      .toBe(true)
    expect((await auditRows.allTextContents()).some((text) =>
      /open activity log 0$/i.test(text))).toBe(false)
    const liveEventId = `bae_${suffix}_11`
    let liveEventAcknowledged = false
    const onAuditAck = (data: unknown) => {
      const frame = JSON.parse(String(data)) as { type?: string; eventId?: string }
      if (frame.type === "bot_audit_event_ack" && frame.eventId === liveEventId) {
        liveEventAcknowledged = true
      }
    }
    machine.socket.on("message", onAuditAck)
    try {
      machine.socket.send(JSON.stringify({
        type: "bot_audit_event",
        eventId: liveEventId,
        agentId: botId,
        sessionId: `session-${suffix}`,
        launchId: `launch-${suffix}`,
        event: { kind: "text", payload: { text: "Open activity log 11", truncated: false, chars: "Open activity log 11".length } },
      }))
      await expect.poll(() => liveEventAcknowledged, {
        message: `machine receives bot_audit_event_ack for ${liveEventId}`,
        timeout: 30_000,
      }).toBe(true)
    } finally {
      machine.socket.off("message", onAuditAck)
    }
    await expect.poll(async () =>
      (await auditRows.allTextContents()).join(" ").toLowerCase())
      .toContain("open activity log 11")
    await expect(auditRows).toHaveCount(10)
    expect((await auditRows.allTextContents()).some((text) =>
      /open activity log 1$/i.test(text))).toBe(false)
    await expect.poll(async () => activityScroller.evaluate((element) =>
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1))
      .toBe(true)
    await expect(sticker.getByRole("button", { name: /Load more activity/ })).toHaveCount(0)
    await marksTab.click()
    await expect(marksTab).toHaveAttribute("aria-selected", "true")
    await expect(alice.page.locator(`[data-testid^="${tid.botMarkStickerRow("")}"]`))
      .toHaveCount(3)
    await expect(alice.page.getByTestId(tid.botMarkStickerOverflow)).toBeVisible()
    await expect(sticker.getByTitle(`${server!.name} · #${channelName}`).first()).toBeVisible()
    await expect(sticker).toContainText(botName)
    await expect(sticker).toContainText(`Long marked task ${suffix}`)
    await expect(sticker).not.toContainText("**Long marked task")
    await expect(sticker.locator("time")).toHaveCount(3)
    const markedMessageBody = sticker.locator("p").filter({ hasText: `Long marked task ${suffix}` })
    await expect(markedMessageBody).toHaveText(`Long marked task ${suffix} ${"with enough detail to require a second line ".repeat(5).trim()}`)
    await expect(markedMessageBody.locator('[data-streamdown="strong"]')).toHaveText(`Long marked task ${suffix}`)
    await expect(markedMessageBody).toHaveCSS("-webkit-line-clamp", "none")
    expect(ownerMarkRequests.length).toBeGreaterThan(0)
    machine.socket.send(JSON.stringify({ type: "agent_activity", agentId: botId, state: "running" }))
    const stop = alice.page.getByTestId(tid.botMarkStickerStop)
    await expect(stop).toBeVisible()
    await attachPageScreenshot(testInfo, "bot-work-sticker-marked-running-desktop", alice.page)
    await activityTab.click()
    await expect(activityTab).toHaveAttribute("aria-selected", "true")
    await expect(sticker.getByRole("button", { name: /Load more activity/ })).toHaveCount(0)
    await expect(stop).toBeVisible()
    await attachPageScreenshot(testInfo, "bot-work-sticker-activity-running-desktop", alice.page)
    await marksTab.click()
    const interruptFrame = new Promise<unknown>((resolveFrame) => {
      machine.socket.once("message", (data) => resolveFrame(JSON.parse(String(data))))
    })
    await stop.click()
    await expect(stop).toContainText("Stopping…")
    await expect(stop).toBeDisabled()
    await expect(interruptFrame).resolves.toEqual({ type: "agent:interrupt", agentId: botId })
    machine.socket.send(JSON.stringify({ type: "agent_activity", agentId: botId, state: "idle" }))
    await expect.poll(async () => {
      const profile = await jsonRequest<{ statusText: string | null }>(
        "alice",
        `/api/community/users/${botId}/profile`,
      )
      return profile.statusText
    }).toBe("Idle")
    await gotoAfterUserWsAuth(alice.page, route)
    await openBotProfile(alice.page, botName)
    await expect(alice.page.getByTestId(tid.botMarkStickerStop))
      .toHaveCount(0)
    await expect(sticker).toBeVisible()

    await alice.page.setViewportSize({ width: 375, height: 812 })
    await alice.page.emulateMedia({ colorScheme: "dark" })
    await expect(alice.page.locator("html")).toHaveClass(/dark/)
    await expect(sticker).toBeVisible()
    const mobileStickerGeometry = await sticker.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      right: element.getBoundingClientRect().right,
    }))
    expect(mobileStickerGeometry.scrollWidth).toBeLessThanOrEqual(mobileStickerGeometry.clientWidth)
    expect(mobileStickerGeometry.right).toBeLessThanOrEqual(375)
    await expect(sticker.getByLabel("Loading thoughts")).toHaveCount(0)
    await expect(sticker.getByText("Open activity log 11", { exact: true })).toBeVisible()
    await attachPageScreenshot(testInfo, "bot-mark-sticker-activity-mobile-dark", alice.page)
    await sticker.getByRole("tab", { name: "Marked messages" }).click()
    await expect(alice.page.locator(`[data-testid^="${tid.botMarkStickerRow("")}"]`))
      .toHaveCount(3)
    await attachPageScreenshot(testInfo, "bot-mark-sticker-marks-mobile-dark", alice.page)
    await sticker.getByRole("tab", { name: "Thoughts" }).click()
    await sticker.getByText("Open activity log 11", { exact: true }).click()
    await expect(alice.page).toHaveURL(new RegExp(`/c/me/bots\\?audit=${botId}`))
    await gotoAfterUserWsAuth(alice.page, route)
    await openBotProfile(alice.page, botName)
    const footer = sticker.locator("footer")
    await expect(footer.locator("time")).toHaveCount(0)
    const ownerLink = alice.page.getByTestId(tid.profileOwnerLink)
    await expect(alice.page.getByTestId(tid.profileBotBadge)).toContainText("Bot")
    await expect(ownerLink).toBeVisible()
    const ownerLinkBox = await ownerLink.boundingBox()
    expect(ownerLinkBox?.height).toBeGreaterThanOrEqual(44)
    const ownerHandle = await ownerLink.textContent()
    await ownerLink.click()
    await expect(alice.page.getByTestId(tid.profileCard)).toHaveCount(1)
    await expect(alice.page.getByTestId(tid.profileOwnerLink)).toHaveCount(0)
    await expect(alice.page.getByTestId(tid.profileCard))
      .toContainText(ownerHandle!.trim().replace(/^@/, ""))

    await alice.page.mouse.click(4, 4)
    await expect(alice.page.getByTestId(tid.profileCard)).toHaveCount(0)
    await alice.page.setViewportSize({ width: 1280, height: 900 })
    await alice.page.emulateMedia({ colorScheme: "light" })
    await openBotProfile(alice.page, botName)
    await expect(alice.page.getByTestId(tid.botAuditPreviewDock)).toHaveAttribute(
      "data-placement",
      /^(right|left|top|bottom)$/,
    )
    const openActivity = auditRows.filter({ hasText: "Open activity log 11" }).getByTitle("Open full audit log")
    await openActivity.focus()
    await expect(openActivity).toBeFocused()
    await openActivity.press("Enter")
    await expect(alice.page).toHaveURL(new RegExp(`/c/me/bots\\?audit=${botId}$`))
    await expect(alice.page.getByTestId(tid.botActivityModal)).toBeVisible()
    await expectActivityHeader(alice.page, testInfo, 1280)
    await expectActivityHeader(alice.page, testInfo, 390)
    await alice.page.setViewportSize({ width: 1280, height: 900 })
    await alice.page.reload()
    await expect(alice.page.getByTestId(tid.botActivityModal)).toBeVisible()
    await alice.page.goBack({ waitUntil: "commit" })
    await expect(alice.page).toHaveURL(new RegExp(`${route}$`))
    await alice.page.goForward({ waitUntil: "commit" })
    await expect(alice.page.getByTestId(tid.botActivityModal)).toBeVisible()

    await alice.page.goto(`/c/me/bots?machineId=${machineId}&audit=${botId}`)
    await expect(alice.page.getByTestId(tid.botActivityModal)).toBeVisible()
    await alice.page.getByRole("button", { name: "Close", exact: true }).click()
    await expect(alice.page).toHaveURL(`/c/me/bots?machineId=${machineId}`)

    const bob = await asUser("bob")
    const bobDirectMarks = await fetch(`${WEB_URL}/api/community/bots/${botId}/marks`, {
      headers: headersFor("bob"),
    })
    expect(bobDirectMarks.status).toBe(404)
    const bobMarkRequests: string[] = []
    bob.page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/community/bots/${botId}/marks`) {
        bobMarkRequests.push(request.url())
      }
    })
    await gotoAfterUserWsAuth(bob.page, route)
    await openBotProfile(bob.page, botName)
    await expect(bob.page.getByTestId(tid.profileOwnerLink)).toBeVisible()
    await expect(bob.page.getByTestId(tid.botMarkSticker)).toHaveCount(0)
    expect(bobMarkRequests).toEqual([])
    await bob.page.getByTestId(tid.profileOwnerLink).click()
    await expect(bob.page.getByTestId(tid.profileCard)).toHaveCount(1)
    await expect(bob.page.getByTestId(tid.profileOwnerLink)).toHaveCount(0)

    await bob.page.goto(`/c/me/bots?audit=${botId}`)
    await expect(bob.page.getByTestId(tid.botActivityModal)).toHaveCount(0)
    await expect.poll(() => new URL(bob.page.url()).searchParams.has("audit")).toBe(false)
    expect(bobMarkRequests).toEqual([])
  } catch (error) { caseJourneyFailure2 = error; caseJourneyFailure2Present = true; throw error } finally {
    try {

      await machine.close()

    } catch (cleanupError) { if (caseJourneyFailure2Present) throw new AggregateError([caseJourneyFailure2, cleanupError], "Journey and resource exit both failed"); throw cleanupError }
  }
})

test("CommunitySheet footers keep four consumers horizontal and intrinsic at 390/639/640", async ({ caseActors, caseResources }) => {
  test.setTimeout(180_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { seedChannel, seedServer } = actors.seed
  const { cleanupCreatedResources, jsonRequest, pairMachine, createBot } = await prepareCase(actors, caseResources)

  const { machineId } = await pairMachine()
  const botName = `Footer bot ${Date.now().toString(36)}`
  await createBot(machineId, botName)
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, "/c/me/bots")

  const capacity = await jsonRequest<{ ownedCount: number; limit: number }>("alice", "/api/community/bots")
  expect(capacity.ownedCount).toBeLessThan(capacity.limit)
  const create = page.getByRole("button", { name: "Create a bot", exact: true })
  await expect(create).toBeEnabled()
  await create.click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, "Create a bot", ["Cancel", "Create bot"], width)
  }
  await page.getByRole("dialog", { name: "Create a bot", exact: true })
    .getByRole("button", { name: "Close", exact: true }).click()

  await page.locator('[data-slot="card"]')
    .filter({ has: page.getByText(botName, { exact: true }) })
    .getByRole("button", { name: "Bot actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, `Edit ${botName}`, ["Cancel", "Save"], width)
  }
  await page.getByRole("dialog", { name: `Edit ${botName}`, exact: true })
    .getByRole("button", { name: "Close", exact: true }).click()

  await cleanupCreatedResources()
  await gotoAfterUserWsAuth(page, "/c/me/machines")
  await page.getByTestId(tid.machinePairOpen).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, "Connect a machine", ["Done"], width)
  }
  await page.getByRole("dialog", { name: "Connect a machine", exact: true })
    .getByRole("button", { name: "Done", exact: true }).click()

  const serverId = await seedServer("alice", `footer-${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, `footer-${Date.now()}`)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const fileName = `footer-oracle-${Date.now()}.md`
  const uploadResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/attachments`
  ))
  const messageResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/community/channels/${channelId}/messages`
  ))
  const editable = composerEditable(page)
  await editable.click()
  await editable.pressSequentially("Attachment footer oracle")
  await page.getByTestId(tid.composerFileInput).setInputFiles({
    name: fileName,
    mimeType: "text/markdown",
    buffer: Buffer.from("# Footer oracle"),
  })
  await page.keyboard.press("Enter")
  expect((await uploadResponse).ok()).toBe(true)
  expect((await messageResponse).status()).toBe(201)
  await page.getByTestId(tid.attachmentCard(fileName)).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, fileName, ["Download"], width)
  }
})

type ActivityAnchorPage = {
  events: Array<{ id: string; createdAt: string }>
  nextCursor: { beforeCreatedAt: string; beforeId: string } | null
}

async function activityAnchorSnapshot(scroller: Locator) {
  return scroller.evaluate(element => {
    const root = element.getBoundingClientRect()
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowAnchor: getComputedStyle(element).overflowAnchor,
      events: [...element.querySelectorAll<HTMLElement>("[data-activity-event-id]")].flatMap(wrapper => {
        const body = wrapper.firstElementChild
        if (!(body instanceof HTMLElement)) return []
        const rect = body.getBoundingClientRect()
        return [{ id: wrapper.dataset.activityEventId!, top: rect.top - root.top, bottom: rect.bottom - root.top, height: rect.height }]
      }),
    }
  })
}

async function settleActivityPosition(scroller: Locator, target: number) {
  return scroller.evaluate(async (element, target) => {
    const samples: Array<{ scrollTop: number; scrollHeight: number; clientHeight: number; events: Array<{ id: string; top: number; bottom: number }> }> = []
    let previous = ""
    let stableFrames = 0
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()))
      if (!element.isConnected) return { settled: false, samples }
      const root = element.getBoundingClientRect()
      const sample = {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        events: [...element.querySelectorAll<HTMLElement>("[data-activity-event-id]")].flatMap(wrapper => {
          const body = wrapper.firstElementChild
          if (!(body instanceof HTMLElement)) return []
          const rect = body.getBoundingClientRect()
          return [{ id: wrapper.dataset.activityEventId!, top: rect.top - root.top, bottom: rect.bottom - root.top }]
        }),
      }
      samples.push(sample)
      const signature = JSON.stringify(sample)
      stableFrames = Math.abs(sample.scrollTop - target) <= 1 && sample.events.length > 0 && signature === previous ? stableFrames + 1 : 0
      if (stableFrames === 2) return { settled: true, samples }
      previous = signature
    }
    return { settled: false, samples }
  }, target)
}

async function gateOlderActivityPages(page: Page, botId: string, caseResources: CaseResources) {
  const entries: Array<{ url: string; release: (status?: 503) => void }> = []
  const running = new Set<Promise<void>>()
  let closing = false
  const matches = (url: URL) => url.pathname === `/api/community/bots/${botId}/audit-log`
  const handler = (route: Route) => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has("beforeId")) return route.continue()
    if (closing) return route.abort("failed")
    let release!: (status?: 503) => void
    const ready = new Promise<503 | undefined>(resolveGate => { release = resolveGate })
    const operation = (async () => {
      const status = await ready
      if (page.isClosed()) return
      if (closing) await route.abort("failed")
      else if (status) await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "Injected Activity older-page failure" }) })
      else await route.continue()
    })()
    entries.push({ url: url.toString(), release })
    running.add(operation)
    return operation.finally(() => running.delete(operation))
  }
  const owned = caseResources.own(entries, async () => {
    closing = true
    for (const entry of entries) entry.release()
    await Promise.all(running)
    if (!page.isClosed()) await page.unroute(matches, handler)
  })
  await page.route(matches, handler)
  return { entries, close: () => owned.close() }
}

type ActivityJsonRequest = Awaited<ReturnType<typeof prepareCase>>["jsonRequest"]

async function seedActivityHistory({ machine, botId, suffix, scenario, caseResources, jsonRequest, testInfo }: {
  machine: ReturnType<typeof connectMachine>
  botId: string
  suffix: string
  scenario: "same-day" | "cross-day"
  caseResources: CaseResources
  jsonRequest: ActivityJsonRequest
  testInfo: TestInfo
}) {
  const now = new Date()
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 5, 12)
  const history = Array.from({ length: 200 }, (_, index) => ({
    id: `bae_anchor_${suffix}_${String(index).padStart(3, "0")}`,
    createdAt: new Date(start + (scenario === "cross-day" ? Math.floor(index / 60) * 86_400_000 + index % 60 * 1_000 : index * 1_000)).toISOString(),
  }))
  const acknowledged = new Set<string>()
  const acknowledgements: Array<{ type: string; eventId: string }> = []
  const expectedIds = new Set(history.map(event => event.id))
  const onMessage = (raw: unknown) => {
    const frame = JSON.parse(String(raw)) as { type?: string; eventId?: string }
    if (frame.type === "bot_audit_event_ack" && frame.eventId && expectedIds.has(frame.eventId)) {
      acknowledged.add(frame.eventId)
      acknowledgements.push({ type: frame.type, eventId: frame.eventId })
    }
  }
  const listener = caseResources.own(onMessage, async captured => { machine.socket.off("message", captured) })
  machine.socket.on("message", onMessage)
  for (const event of history) machine.socket.send(JSON.stringify({
    type: "bot_audit_event",
    eventId: event.id,
    occurredAt: event.createdAt,
    agentId: botId,
    sessionId: `anchor-session-${suffix}`,
    launchId: `anchor-launch-${suffix}`,
    event: { kind: "session_reset", payload: { trigger: "idle_timeout" } },
  }))
  await expect.poll(() => acknowledged.size, { timeout: 30_000 }).toBe(history.length)
  await listener.close()
  const headPath = `/api/community/bots/${botId}/audit-log?limit=50`
  const head = await jsonRequest<ActivityAnchorPage>("alice", headPath)
  await testInfo.attach("activity-history-backend", {
    body: JSON.stringify({ botId, scenario, history, acknowledgements, headPath, head }),
    contentType: "application/json",
  })
  expect(head.events.map(event => ({ id: event.id, createdAt: event.createdAt }))).toEqual(history.slice(-50).reverse())
  expect(head.nextCursor).toEqual({ beforeCreatedAt: history[150].createdAt, beforeId: history[150].id })
  return history
}

function observeActivityFrames(page: Page, caseResources: CaseResources) {
  const frames: Array<{ id: string; botId: string; createdAt: string }> = []
  const onSocket = (socket: BrowserSocket) => {
    const onFrame = ({ payload }: { payload: string | Buffer }) => {
      let frame: { type?: string; id?: string; botId?: string; createdAt?: string }
      try { frame = JSON.parse(String(payload)) } catch { return }
      if (frame.type === "community:bot.audit_event" && frame.id && frame.botId && frame.createdAt) {
        frames.push({ id: frame.id, botId: frame.botId, createdAt: frame.createdAt })
      }
    }
    socket.on("framereceived", onFrame)
    caseResources.own(socket, async captured => { captured.off("framereceived", onFrame) })
  }
  page.on("websocket", onSocket)
  caseResources.own(onSocket, async captured => { page.off("websocket", captured) })
  return frames
}

async function publishActivityReset({ machine, botId, suffix, id, createdAt, frames, caseResources, jsonRequest, testInfo }: {
  machine: ReturnType<typeof connectMachine>
  botId: string
  suffix: string
  id: string
  createdAt: string
  frames: ReturnType<typeof observeActivityFrames>
  caseResources: CaseResources
  jsonRequest: ActivityJsonRequest
  testInfo: TestInfo
}) {
  let acknowledged = false
  const onMessage = (raw: unknown) => {
    const frame = JSON.parse(String(raw)) as { type?: string; eventId?: string }
    if (frame.type === "bot_audit_event_ack" && frame.eventId === id) acknowledged = true
  }
  const listener = caseResources.own(onMessage, async captured => { machine.socket.off("message", captured) })
  machine.socket.on("message", onMessage)
  machine.socket.send(JSON.stringify({
    type: "bot_audit_event", eventId: id, occurredAt: createdAt, agentId: botId,
    sessionId: `anchor-session-${suffix}`, launchId: `anchor-launch-${suffix}`,
    event: { kind: "session_reset", payload: { trigger: "idle_timeout" } },
  }))
  await expect.poll(() => acknowledged).toBe(true)
  await listener.close()
  await expect.poll(() => frames.some(frame => frame.id === id && frame.botId === botId && frame.createdAt === createdAt)).toBe(true)
  const cursor = new URLSearchParams({ limit: "50", beforeCreatedAt: new Date(Date.parse(createdAt) + 1).toISOString(), beforeId: id })
  const path = `/api/community/bots/${botId}/audit-log?${cursor}`
  const persisted = await jsonRequest<ActivityAnchorPage>("alice", path)
  await testInfo.attach(`activity-live-${id}`, {
    body: JSON.stringify({ id, botId, createdAt, acknowledged, received: frames.filter(frame => frame.id === id), path, persisted }),
    contentType: "application/json",
  })
  expect(persisted.events[0]).toMatchObject({ id, createdAt })
}

async function expectActivityPosition(scroller: Locator, anchor: { id: string; top: number }) {
  await expect.poll(async () => {
    const snapshot = await activityAnchorSnapshot(scroller)
    const kept = snapshot.events.find(event => event.id === anchor.id)
    return kept ? Math.abs(kept.top - anchor.top) : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(1)
}

async function visibleActivityAnchor(scroller: Locator) {
  const snapshot = await activityAnchorSnapshot(scroller)
  const anchor = snapshot.events.find(event => event.top >= 32 && event.bottom <= snapshot.clientHeight)
  expect(anchor).toBeDefined()
  return anchor!
}

for (const scenario of ["same-day", "cross-day"] as const) {
  for (const width of [1280, 390] as const) {
    test(`Activity ${scenario} older pages preserve real event positions at ${width}`, async ({ caseActors, caseResources }, testInfo) => {
      test.setTimeout(120_000)
      const actors = await caseActors(["alice"])
      const { pairMachine, createBot, jsonRequest } = await prepareCase(actors, caseResources)
      const { credential, machineId } = await pairMachine()
      const suffix = Date.now().toString(36)
      const botId = await createBot(machineId, `Anchor ${scenario} ${width} ${suffix}`)
      const machine = connectMachine(credential, caseResources)
      await machine.opened
      let gate: Awaited<ReturnType<typeof gateOlderActivityPages>> | undefined
      let journeyFailure: unknown
      let journeyFailurePresent = false
      const positioning: Array<{ page: number; target: number; deltaY: number; olderRequests: string[] } & Awaited<ReturnType<typeof settleActivityPosition>>> = []
      try {
        const history = await seedActivityHistory({ machine, botId, suffix, scenario, caseResources, jsonRequest, testInfo })
        const { page } = await actors.asUser("alice", { viewport: { width, height: 900 }, colorScheme: width === 390 ? "dark" : "light" })
        gate = await gateOlderActivityPages(page, botId, caseResources)
        await gotoAfterUserWsAuth(page, `/c/me/bots?audit=${botId}`)
        const sheet = page.getByTestId(tid.botActivityModal)
        await settleSheet(sheet)
        const scroller = sheet.getByRole("region", { name: "Activity log", exact: true })
        await expect(scroller).toHaveCount(1)
        await expect.poll(() => scroller.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
        for (const [index, target] of [0, 80].entries()) {
          await scroller.hover()
          await page.mouse.wheel(0, -1_000_000)
          const zeroPosition = await settleActivityPosition(scroller, 0)
          positioning.push({ page: index + 1, target: 0, deltaY: -1_000_000, olderRequests: gate.entries.map(entry => entry.url), ...zeroPosition })
          expect(zeroPosition.settled, "physical zero and rendered geometry settle before choosing the reading position").toBe(true)
          if (target > 0) {
            await page.mouse.wheel(0, target)
            const nearTopPosition = await settleActivityPosition(scroller, target)
            positioning.push({ page: index + 1, target, deltaY: target, olderRequests: gate.entries.map(entry => entry.url), ...nearTopPosition })
            expect(nearTopPosition.settled, "physical near-top target and rendered geometry settle without another wheel").toBe(true)
          }
          await expect.poll(async () => Math.abs(await scroller.evaluate(element => element.scrollTop) - target)).toBeLessThanOrEqual(1)
          await expect.poll(() => gate!.entries.length).toBe(index + 1)
          const pending = gate.entries[index]
          const cursor = history[150 - index * 50]
          const url = new URL(pending.url)
          expect(url.searchParams.get("limit")).toBe("50")
          expect(url.searchParams.get("beforeId")).toBe(cursor.id)
          expect(url.searchParams.get("beforeCreatedAt")).toBe(cursor.createdAt)
          const before = await activityAnchorSnapshot(scroller)
          expect(Math.abs(before.scrollTop - target), "physical target at retained snapshot").toBeLessThanOrEqual(1)
          expect(before.overflowAnchor).toBe("none")
          const anchor = before.events.find(event => event.top >= 32 && event.bottom <= before.clientHeight)
          expect(anchor).toBeDefined()
          await attachPageScreenshot(testInfo, `activity-anchor-${scenario}-${width}-before-page-${index + 1}`, page)
          const atRelease = await activityAnchorSnapshot(scroller)
          expect(Math.abs(atRelease.scrollTop - target), "physical target at response release").toBeLessThanOrEqual(1)
          const releaseAnchor = atRelease.events.find(event => event.id === anchor!.id)
          expect(releaseAnchor).toBeDefined()
          expect(Math.abs(releaseAnchor!.top - anchor!.top), "named event at response release").toBeLessThanOrEqual(1)
          const [response] = await Promise.all([
            page.waitForResponse(value => value.url() === pending.url && value.request().method() === "GET"),
            Promise.resolve().then(() => pending.release()),
          ])
          expect(response.status()).toBe(200)
          const body = await response.json() as ActivityAnchorPage
          expect(body.events.map(event => ({ id: event.id, createdAt: event.createdAt })))
            .toEqual(history.slice(100 - index * 50, 150 - index * 50).reverse())
          expect(body.nextCursor).not.toBeNull()
          await expect.poll(() => scroller.evaluate(element => element.scrollHeight)).toBeGreaterThan(before.scrollHeight + 300)
          try {
            await expect.poll(async () => {
              const after = await activityAnchorSnapshot(scroller)
              const kept = after.events.find(event => event.id === anchor!.id)
              return kept ? Math.abs(kept.top - anchor!.top) : Number.POSITIVE_INFINITY
            }).toBeLessThanOrEqual(1)
            await scroller.evaluate(() => new Promise<void>(resolveFrame => {
              requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())))
            }))
            await expectActivityPosition(scroller, anchor!)
            expect(gate.entries).toHaveLength(index + 1)
          } finally {
            await testInfo.attach(`activity-anchor-${scenario}-${width}-page-${index + 1}`, {
              body: JSON.stringify({ scenario, width, target, anchor, request: pending.url, returnedIds: body.events.map(event => event.id), before, atRelease, after: await activityAnchorSnapshot(scroller), olderRequestCount: gate.entries.length }),
              contentType: "application/json",
            })
            await attachPageScreenshot(testInfo, `activity-anchor-${scenario}-${width}-page-${index + 1}`, page)
          }
        }
      } catch (error) { journeyFailure = error; journeyFailurePresent = true; throw error } finally {
        const exitErrors: unknown[] = []
        try { await gate?.close() } catch (error) { exitErrors.push(error) }
        try { await machine.close() } catch (error) { exitErrors.push(error) }
        try {
          await testInfo.attach(`activity-anchor-${scenario}-${width}-positioning`, {
            body: JSON.stringify({ responseReleaseTargets: [0, 80], requestStartPosition: "not asserted; the gate can hold a request during the zero-position step", positioning }),
            contentType: "application/json",
          })
        } catch (error) { exitErrors.push(error) }
        if (exitErrors.length) throw new AggregateError(journeyFailurePresent ? [journeyFailure, ...exitErrors] : exitErrors, "Activity journey, cleanup or evidence retention failed")
      }
    })
  }
}

for (const width of [1280, 390] as const) {
  test(`Activity recovery, live reading and reopen preserve event ownership at ${width}`, async ({ caseActors, caseResources }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice"])
    const { pairMachine, createBot, jsonRequest } = await prepareCase(actors, caseResources)
    const suffix = Date.now().toString(36)
    const { credential, machineId } = await pairMachine()
    const botId = await createBot(machineId, `Recovery ${width} ${suffix}`)
    const machine = connectMachine(credential, caseResources)
    let gate: Awaited<ReturnType<typeof gateOlderActivityPages>> | undefined
    let journeyFailure: unknown
    let journeyFailurePresent = false
    const steps: Array<Record<string, unknown>> = []
    try {
      await machine.opened
      const history = await seedActivityHistory({ machine, botId, suffix, scenario: "same-day", caseResources, jsonRequest, testInfo })
      const { page } = await actors.asUser("alice", { viewport: { width, height: 900 }, colorScheme: width === 390 ? "dark" : "light" })
      const frames = observeActivityFrames(page, caseResources)
      gate = await gateOlderActivityPages(page, botId, caseResources)
      await gotoAfterUserWsAuth(page, `/c/me/bots?audit=${botId}`)
      const sheet = page.getByTestId(tid.botActivityModal)
      await settleSheet(sheet)
      const scroller = sheet.getByRole("region", { name: "Activity log", exact: true })
      await expect(scroller).toHaveCSS("overflow-anchor", "none")
      const record = async (phase: string) => {
        steps.push({ phase, snapshot: await activityAnchorSnapshot(scroller), olderRequests: gate!.entries.map(entry => entry.url) })
        await attachPageScreenshot(testInfo, `activity-recovery-${width}-${phase}`, page)
      }
      await expect.poll(() => scroller.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
      await scroller.hover()
      await page.mouse.wheel(0, -1_000_000)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
      await expect.poll(() => gate!.entries.length).toBe(1)
      const anchor = await visibleActivityAnchor(scroller)
      const cursor = history[150]
      await record("before-error")
      for (const index of [0, 1]) {
        await expect.poll(() => gate!.entries.length).toBe(index + 1)
        const pending = gate.entries[index]
        const url = new URL(pending.url)
        expect(url.searchParams.get("beforeId")).toBe(cursor.id)
        expect(url.searchParams.get("beforeCreatedAt")).toBe(cursor.createdAt)
        const atRelease = await activityAnchorSnapshot(scroller)
        steps.push({ phase: `before-error-release-${index + 1}`, snapshot: atRelease })
        expect(atRelease.scrollTop, "physical target before injected error").toBe(0)
        const releaseAnchor = atRelease.events.find(event => event.id === anchor.id)
        expect(releaseAnchor).toBeDefined()
        expect(Math.abs(releaseAnchor!.top - anchor.top)).toBeLessThanOrEqual(1)
        const [response] = await Promise.all([
          page.waitForResponse(value => value.url() === pending.url),
          Promise.resolve().then(() => pending.release(503)),
        ])
        expect(response.status()).toBe(503)
        steps.push({ phase: `injected-error-${index + 1}`, url: pending.url, status: response.status() })
      }
      const retry = sheet.getByRole("button", { name: "Retry older", exact: true })
      await expect(retry).toBeEnabled()
      await expectActivityPosition(scroller, anchor)
      await scroller.evaluate(() => new Promise<void>(resolveFrame => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())))
      }))
      expect(gate.entries).toHaveLength(2)
      await record("failed-and-stopped")
      await retry.click()
      await expect.poll(() => gate!.entries.length).toBe(3)
      expect(gate.entries[2].url).toBe(gate.entries[0].url)
      const beforeRecovery = await activityAnchorSnapshot(scroller)
      steps.push({ phase: "before-recovery-release", snapshot: beforeRecovery })
      expect(beforeRecovery.scrollTop, "physical target before recovery").toBe(0)
      const recoveryAnchor = beforeRecovery.events.find(event => event.id === anchor.id)
      expect(recoveryAnchor).toBeDefined()
      expect(Math.abs(recoveryAnchor!.top - anchor.top)).toBeLessThanOrEqual(1)
      const [recovered] = await Promise.all([
        page.waitForResponse(value => value.url() === gate!.entries[2].url && value.status() === 200),
        Promise.resolve().then(() => gate!.entries[2].release()),
      ])
      const recoveredBody = await recovered.json() as ActivityAnchorPage
      expect(recoveredBody.events.map(event => ({ id: event.id, createdAt: event.createdAt }))).toEqual(history.slice(100, 150).reverse())
      expect(recoveredBody.nextCursor).toEqual({ beforeCreatedAt: history[100].createdAt, beforeId: history[100].id })
      steps.push({ phase: "recovery-response", status: recovered.status(), body: recoveredBody })
      await expect.poll(() => scroller.evaluate(element => element.scrollHeight)).toBeGreaterThan(beforeRecovery.scrollHeight + 300)
      await expect(retry).toHaveCount(0)
      await expectActivityPosition(scroller, anchor)
      expect(gate.entries).toHaveLength(3)
      await record("recovered")
      const publish = (label: string, createdAt: string) => publishActivityReset({
        machine, botId, suffix, id: `bae_${label}_${suffix}`, createdAt, frames, caseResources, jsonRequest, testInfo,
      })
      const liveId = `bae_history_${suffix}`
      const liveTime = Date.parse(history[199].createdAt) + 86_400_000
      await publish("history", new Date(liveTime).toISOString())
      await expectActivityPosition(scroller, anchor)
      await expect(scroller.locator(`[data-activity-event-id="${liveId}"]`)).toHaveCount(0)
      await record("live-while-reading")
      await publish("late", new Date(Date.parse(history[140].createdAt) + 500).toISOString())
      await expectActivityPosition(scroller, anchor)
      await record("late-interleave")
      await page.setViewportSize({ width, height: 760 })
      await expectActivityPosition(scroller, anchor)
      await record("resized")
      const beforeTakeover = await scroller.evaluate(element => element.scrollTop)
      await scroller.hover()
      await page.mouse.wheel(0, 150)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeTakeover + 100)
      const readerAnchor = await visibleActivityAnchor(scroller)
      expect(readerAnchor.id).not.toBe(anchor.id)
      await publish("reader", new Date(liveTime + 1_000).toISOString())
      await expectActivityPosition(scroller, readerAnchor)
      await record("reader-takeover")
      await scroller.hover()
      await page.mouse.wheel(0, 1_000_000)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
      const tailId = `bae_tail_${suffix}`
      await publish("tail", new Date().toISOString())
      await expect(scroller.locator(`[data-activity-event-id="${tailId}"]`)).toBeVisible()
      await expect.poll(() => scroller.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
      await expect(scroller.locator("[data-activity-date]").filter({ hasText: /^Today$/ }).last()).toBeVisible()
      await record("tail-follow")
      await gate.close()
      steps.push({ phase: "older-control-retired-before-navigation", requests: gate.entries.map(entry => entry.url) })
      await sheet.getByRole("button", { name: "Close", exact: true }).click()
      await expect(sheet).toHaveCount(0)
      await expect(page).toHaveURL("/c/me/bots")
      await gotoAfterUserWsAuth(page, `/c/me/bots?audit=${botId}`)
      await settleSheet(sheet)
      await expect(scroller.locator(`[data-activity-event-id="${tailId}"]`)).toBeVisible()
      await expect.poll(() => scroller.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
      await record("reopened")
      const otherBotId = await createBot(machineId, `Other ${width} ${suffix}`)
      await gotoAfterUserWsAuth(page, `/c/me/bots?audit=${otherBotId}`)
      await settleSheet(sheet)
      const otherId = `bae_other_${suffix}`
      await publishActivityReset({ machine, botId: otherBotId, suffix, id: otherId, createdAt: new Date().toISOString(), frames, caseResources, jsonRequest, testInfo })
      await expect(scroller.locator(`[data-activity-event-id="${otherId}"]`)).toBeVisible()
      await expect(scroller.locator(`[data-activity-event-id="${tailId}"]`)).toHaveCount(0)
      await record("other-bot")
      gate = await gateOlderActivityPages(page, botId, caseResources)
      steps.push({ phase: "pending-control-installed-before-return" })
      await gotoAfterUserWsAuth(page, `/c/me/bots?audit=${botId}`)
      await settleSheet(sheet)
      await expect(scroller.locator(`[data-activity-event-id="${tailId}"]`)).toBeVisible()
      const requestsBeforeWheel = gate.entries.length
      await scroller.hover()
      await page.mouse.wheel(0, -1_000_000)
      await expect.poll(() => gate!.entries.length).toBe(1)
      const pendingUrl = gate.entries[0].url
      const pendingSearch = new URL(pendingUrl).searchParams
      const pendingCursor = history.find(event => event.id === pendingSearch.get("beforeId"))
      expect(pendingCursor).toBeDefined()
      expect(pendingSearch.get("beforeCreatedAt")).toBe(pendingCursor!.createdAt)
      expect(pendingSearch.get("limit")).toBe("50")
      await expect(sheet).toBeVisible()
      steps.push({ phase: "owned-pending-route-ready", requestsBeforeWheel, url: pendingUrl, cursor: pendingCursor, snapshot: await activityAnchorSnapshot(scroller) })
      const failed = page.waitForEvent("requestfailed", { predicate: request => request.url() === pendingUrl })
      await gate.close()
      const aborted = await failed
      expect(aborted.failure()?.errorText).toBeTruthy()
      steps.push({ phase: "owned-pending-route-exit", url: aborted.url(), failure: aborted.failure() })
      await sheet.getByRole("button", { name: "Close", exact: true }).click()
      await expect(sheet).toHaveCount(0)
      await attachPageScreenshot(testInfo, `activity-recovery-${width}-closed`, page)
    } catch (error) { journeyFailure = error; journeyFailurePresent = true; throw error } finally {
      await testInfo.attach(`activity-recovery-${width}-steps`, { body: JSON.stringify({ width, botId, steps }), contentType: "application/json" })
      try {
        await gate?.close()
        await machine.close()
      } catch (cleanupError) { if (journeyFailurePresent) throw new AggregateError([journeyFailure, cleanupError], "Journey and resource exit both failed"); throw cleanupError }
    }
  })
}
