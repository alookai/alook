import { createRequire } from "module"
import { resolve } from "path"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedJoinServer, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { MACHINE_WS_URL, REPO_ROOT, WEB_URL } from "./_setup/paths"

type UserKey = "alice" | "bob"
type Rect = { x: number; y: number; width: number; height: number }

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
      const current = [bounds.x, bounds.y, bounds.width, bounds.height, style.opacity, style.transform].join(":")
      stableFrames = current === previous ? stableFrames + 1 : 0
      previous = current
      if (stableFrames >= 3 || performance.now() >= deadline) resolveStable()
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
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

function headersFor(key: UserKey, extra?: Record<string, string>) {
  return {
    Cookie: sessionCookie(key),
    Origin: WEB_URL,
    ...extra,
  }
}

async function jsonRequest<T>(
  key: UserKey,
  path: string,
  init?: RequestInit,
): Promise<T> {
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

async function pairMachine(): Promise<{ credential: string; machineId: string }> {
  const pair = await jsonRequest<{ tokenId: string }>("alice", "/api/community/machines/pair", {
    method: "POST",
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
  return response.json() as Promise<{ credential: string; machineId: string }>
}

async function createBot(machineId: string, name: string): Promise<string> {
  const data = await jsonRequest<{ bot: { id: string } }>("alice", "/api/community/bots", {
    method: "POST",
    body: JSON.stringify({ name, machineId, runtime: "codex" }),
  })
  return data.bot.id
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
  once(event: "open", listener: () => void): void
  once(event: "error", listener: (error: Error) => void): void
  once(event: "message", listener: (data: unknown) => void): void
}

function connectMachine(credential: string) {
  const requireFromDaemon = createRequire(resolve(REPO_ROOT, "src/daemon/package.json"))
  const Ws = requireFromDaemon("ws") as {
    WebSocket: new (url: string, options: { headers: Record<string, string> }) => MachineSocket
  }
  const socket = new Ws.WebSocket(MACHINE_WS_URL.replace(/^http/, "ws"), {
    headers: { Authorization: `Bearer ${credential}` },
  })
  return {
    socket,
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

test("owner-only bot mark sticker, Stop lifecycle, owner swap, and URL-owned audit modal", async ({ asUser }, testInfo) => {
  test.setTimeout(180_000)
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

  const machine = connectMachine(credential)
  await machine.opened
  try {
    machine.socket.send(JSON.stringify({ type: "agent_activity", agentId: botId, state: "idle" }))
    for (let index = 0; index < 11; index += 1) {
      machine.socket.send(JSON.stringify({
        type: "bot_audit_event",
        agentId: botId,
        sessionId: `session-${suffix}`,
        launchId: `launch-${suffix}`,
        event: { kind: "tool_call", payload: { name: `Open activity log ${index}` } },
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
    const activityTab = sticker.getByRole("tab", { name: "Recent activity" })
    const marksTab = sticker.getByRole("tab", { name: /Marked messages/ })
    const auditRows = alice.page.locator(
      `[data-testid^="${tid.botAuditPreviewRow("")}"]`,
    )
    const activityScroller = sticker
      .getByRole("tabpanel", { name: "Recent activity log" })
      .locator(".bot-note-scrollbar")
    await expect(activityTab).toHaveAttribute("aria-selected", "true")
    await expect(auditRows).toHaveCount(10)
    await expect(alice.page.getByTestId(tid.botAuditPreviewEarlier)).toHaveText("…")
    await expect(activityScroller).toHaveCSS("overflow-y", "auto")
    await expect.poll(async () => activityScroller.evaluate((element) =>
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1))
      .toBe(true)
    expect((await auditRows.allTextContents()).some((text) =>
      /open activity log 0$/i.test(text))).toBe(false)
    machine.socket.send(JSON.stringify({
      type: "bot_audit_event",
      agentId: botId,
      sessionId: `session-${suffix}`,
      launchId: `launch-${suffix}`,
      event: { kind: "tool_call", payload: { name: "Open activity log 11" } },
    }))
    await expect.poll(async () =>
      (await auditRows.allTextContents()).join(" ").toLowerCase())
      .toContain("open activity log 11")
    await expect(auditRows).toHaveCount(10)
    expect((await auditRows.allTextContents()).some((text) =>
      /open activity log 1$/i.test(text))).toBe(false)
    await expect.poll(async () => activityScroller.evaluate((element) =>
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1))
      .toBe(true)
    await expect(sticker.getByRole("button", { name: /Load more activity/ }))
      .toBeVisible()
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
    await expect(sticker.locator("p").filter({ hasText: `Long marked task ${suffix}` }))
      .toHaveCSS("-webkit-line-clamp", "2")
    expect(ownerMarkRequests.length).toBeGreaterThan(0)
    machine.socket.send(JSON.stringify({ type: "agent_activity", agentId: botId, state: "running" }))
    const stop = alice.page.getByTestId(tid.botMarkStickerStop)
    await expect(stop).toBeVisible()
    await attachPageScreenshot(testInfo, "bot-work-sticker-marked-running-desktop", alice.page)
    await activityTab.click()
    await expect(activityTab).toHaveAttribute("aria-selected", "true")
    await expect(sticker.getByRole("button", { name: /Load more activity/ }))
      .toBeVisible()
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
    await expect(sticker.getByLabel("Loading recent activity")).toHaveCount(0)
    await expect(sticker.getByText("open activity log 11", { exact: true })).toBeVisible()
    await attachPageScreenshot(testInfo, "bot-mark-sticker-activity-mobile-dark", alice.page)
    await sticker.getByRole("tab", { name: "Marked messages" }).click()
    await expect(alice.page.locator(`[data-testid^="${tid.botMarkStickerRow("")}"]`))
      .toHaveCount(3)
    await attachPageScreenshot(testInfo, "bot-mark-sticker-marks-mobile-dark", alice.page)
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
    const openActivity = alice.page.getByRole("button", {
      name: "Load more activity in the full audit log",
    })
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
  } finally {
    machine.socket.close()
  }
})

test("CommunitySheet footers keep four consumers horizontal and intrinsic at 390/639/640", async ({ asUser }) => {
  test.setTimeout(180_000)
  const { machineId } = await pairMachine()
  const botName = `Footer bot ${Date.now().toString(36)}`
  await createBot(machineId, botName)
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, "/c/me/bots")

  await page.getByRole("button", { name: "Create a bot", exact: true }).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, "Create a bot", ["Cancel", "Create bot"], width)
  }
  await page.getByRole("dialog", { name: "Create a bot", exact: true })
    .getByRole("button", { name: "Close", exact: true }).click()

  await page.getByRole("button", { name: "Bot actions", exact: true }).first().click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  for (const width of [390, 639, 640] as const) {
    await expectFooterGeometry(page, `Edit ${botName}`, ["Cancel", "Save"], width)
  }
  await page.getByRole("dialog", { name: `Edit ${botName}`, exact: true })
    .getByRole("button", { name: "Close", exact: true }).click()

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
