import { communityFixtureFetch, currentCommunityFixtureError } from "./business-contract"
import type { Locator, Page, Route, TestInfo, WebSocket as BrowserSocket } from "@playwright/test"
import { expect } from "./case-fixture"
import { tid } from "./testids"
import { WEB_URL } from "../_setup/paths"
import { connectMachine } from "./community-machine"
import type { CaseActors, CaseResources, OwnedCaseResource } from "./case-fixture"

export async function prepareCase(actors: CaseActors, caseResources: CaseResources) {
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
    const response = await communityFixtureFetch(`${WEB_URL}${path}`, {
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
      const response = await communityFixtureFetch(`${WEB_URL}/api/community/machines/${machineId}`, { method: "DELETE", headers: headersFor("alice") })
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
      const response = await communityFixtureFetch(`${WEB_URL}/api/community/bots/${botId}`, { method: "DELETE", headers: headersFor("alice") })
      expect(response.status, `delete test bot ${botId}`).toBe(204)
      createdBotIds.delete(botId)
    }))
    return data.bot.id
  }
  async function joinBotToServer(runnerKey: string, botId: string, serverId: string): Promise<void> {
    const token = await actors.seed.createInvite("alice", serverId)
    const joined = await jsonRequest<{ serverId: string; member: { userId: string } }>(
      "alice",
      `/api/community/invites/${token}/join`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${runnerKey}` },
        body: "{}",
      },
    )
    expect(joined.serverId).toBe(serverId)
    expect(joined.member.userId).toBe(botId)
  }
  actors.onCleanup(cleanupCreatedResources)
  return { createdBotIds, createdMachineIds, cleanupCreatedResources, headersFor, jsonRequest, pairMachine, createBot, joinBotToServer }
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

export async function settleSheet(sheet: Locator): Promise<void> {
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

export async function expectSheetThemeTokens(sheet: Locator): Promise<void> {
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

export async function attachPageScreenshot(testInfo: TestInfo, name: string, page: Page): Promise<void> {
  await testInfo.attach(`${name}.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
}

export async function expectActivityHeader(
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
  // Technostalgia sheet/dialog titles: 22px/750, 20px on phones.
  expect(styles).toMatchObject({
    titleFontSize: width === 390 ? "20px" : "22px",
    titleFontWeight: "750",
    descriptionFontSize: "14px",
  })
  expect(Number.parseFloat(styles.titleLineHeight)).toBeGreaterThan(Number.parseFloat(styles.titleFontSize))
  expect(Number.parseFloat(styles.descriptionLineHeight)).toBeGreaterThan(Number.parseFloat(styles.descriptionFontSize))
  await attachPageScreenshot(testInfo, `activity-log-header-${width}`, page)
}

export async function expectFooterGeometry(
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

export async function enrollBot(credential: string, botId: string): Promise<string> {
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

export async function sendBotMessage(
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

export async function setBotMark(
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

export async function openBotProfile(page: Page, botName: string): Promise<void> {
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

export async function probeOwnedBotProfile(
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

export type ActivityAnchorPage = {
  events: Array<{ id: string; createdAt: string }>
  nextCursor: { beforeCreatedAt: string; beforeId: string } | null
}

export async function activityAnchorSnapshot(scroller: Locator) {
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

export async function settleActivityPosition(scroller: Locator, target: number) {
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

export async function gateOlderActivityPages(page: Page, botId: string, caseResources: CaseResources) {
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
      else if (status) await route.fulfill(currentCommunityFixtureError("Injected Activity older-page failure", status))
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

export async function seedActivityHistory({ machine, botId, suffix, scenario, caseResources, jsonRequest, testInfo }: {
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

export function observeActivityFrames(page: Page, caseResources: CaseResources) {
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

export async function publishActivityReset({ machine, botId, suffix, id, createdAt, frames, caseResources, jsonRequest, testInfo }: {
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

export async function expectActivityPosition(scroller: Locator, anchor: { id: string; top: number }) {
  await expect.poll(async () => {
    const snapshot = await activityAnchorSnapshot(scroller)
    const kept = snapshot.events.find(event => event.id === anchor.id)
    return kept ? Math.abs(kept.top - anchor.top) : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(1)
}

export async function visibleActivityAnchor(scroller: Locator) {
  const snapshot = await activityAnchorSnapshot(scroller)
  const anchor = snapshot.events.find(event => event.top >= 32 && event.bottom <= snapshot.clientHeight)
  expect(anchor).toBeDefined()
  return anchor!
}
