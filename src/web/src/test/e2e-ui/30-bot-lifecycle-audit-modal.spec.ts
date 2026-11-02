import { communityFixtureFetch } from "./_fixtures/business-contract"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase, attachPageScreenshot, expectActivityHeader, enrollBot, sendBotMessage, setBotMark, openBotProfile } from "./_fixtures/bot-profile-audit"

test("owner-only bot mark sticker, Stop lifecycle, owner swap, and URL-owned audit modal", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(180_000)

  const actors = await caseActors(["alice", "bob"])
  const { asUser } = actors
  const { seedChannel, seedJoinServer, seedServer } = actors.seed
  const { headersFor, jsonRequest, pairMachine, createBot, joinBotToServer } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const serverId = await seedServer("alice", `profile-preview-server-with-a-long-name-${suffix}`)
  const channelName = `bots-with-a-long-channel-name-${suffix}`
  const channelId = await seedChannel("alice", serverId, channelName)
  const staleServerId = await seedServer("alice", `stale-mark-server-${suffix}`)
  const staleChannelName = `former-private-work-${suffix}`
  const staleChannelId = await seedChannel("alice", staleServerId, staleChannelName)
  await seedJoinServer("alice", "bob", serverId)

  const { credential, machineId } = await pairMachine()
  const machine = connectMachine(credential, caseResources, { machineId, headers: headersFor("alice") })
  await machine.opened
  const botName = `Preview bot ${suffix} long-name`
  const botId = await createBot(machineId, botName)
  const runnerKey = await enrollBot(credential, botId)
  await joinBotToServer(runnerKey, botId, serverId)
  await joinBotToServer(runnerKey, botId, staleServerId)

  const { servers } = await jsonRequest<{
    servers: Array<{ id: string; name: string; discriminator: string }>
  }>("alice", "/api/community/servers")
  const server = servers.find((candidate) => candidate.id === serverId)
  const staleServer = servers.find((candidate) => candidate.id === staleServerId)
  expect(server).toBeTruthy()
  expect(staleServer).toBeTruthy()
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
  const removeStaleBot = await communityFixtureFetch(
    `${WEB_URL}/api/community/servers/${staleServerId}/members/${staleBotMember!.id}`,
    { method: "DELETE", headers: headersFor("alice") },
  )
  expect(removeStaleBot.status).toBe(204)

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
      const response = await communityFixtureFetch(
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
    const markedBody = sticker.locator("[data-community-message-body]").filter({ hasText: `Long marked task ${suffix}` })
    await expect(markedBody).toHaveCount(1)
    await expect(markedBody.locator('[data-streamdown="strong"]')).toHaveText(`Long marked task ${suffix}`)
    await expect(markedBody).toHaveText(`Long marked task ${suffix} ${"with enough detail to require a second line ".repeat(5)}`.trim())
    await expect(markedBody.locator("p")).toHaveCSS("-webkit-line-clamp", "none")
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
      const onMessage = (data: unknown) => {
        const frame = JSON.parse(String(data)) as { type: string }
        if (frame.type === "machine:heartbeat") return
        machine.socket.off("message", onMessage)
        resolveFrame(frame)
      }
      caseResources.own(onMessage, async captured => { machine.socket.off("message", captured) })
      machine.socket.on("message", onMessage)
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
    await sticker.getByTestId(tid.botAuditPreviewRow(liveEventId))
      .getByText("Open activity log 11", { exact: true }).click()
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
    const openActivity = sticker.getByTestId(tid.botAuditPreviewRow(liveEventId))
      .getByTitle("Open full audit log", { exact: true })
    await expect(openActivity.locator("time")).toHaveCount(1)
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
    const bobDirectMarks = await communityFixtureFetch(`${WEB_URL}/api/community/bots/${botId}/marks`, {
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
