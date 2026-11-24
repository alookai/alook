import { communityFixtureFetch, currentCommunityFixtureError } from "./_fixtures/business-contract"
import { type CaseActors, type CaseResources, expect, test } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { REPO_ROOT, WEB_URL } from "./_setup/paths"
import { connectMachine } from "./_fixtures/community-machine"
import { type ActivityAnchorPage, activityAnchorSnapshot, attachPageScreenshot, enrollBot, expectActivityHeader, expectActivityPosition, gateOlderActivityPages, observeActivityFrames, openBotProfile, prepareCase, publishActivityReset, seedActivityHistory, sendBotMessage, setBotMark, settleActivityPosition, settleSheet, visibleActivityAnchor } from "./_fixtures/bot-profile-audit"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_BOT_ACTOR_HEADER, COMMUNITY_CONTRACT_HEADER, type CommunityWsEvent, WS_EVENTS, admitCommunityBrowserEventBatch, decodeCommunityBrowserEvent, isCommunityBrowserEventBatchCandidate } from "@alook/shared"
import { spawnSync } from "node:child_process"
import type { Page } from "@playwright/test"

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
      .getByRole("tabpanel", { name: "Recent thoughts", exact: true })
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
    await expect(alice.page.getByTestId(tid.profileBotBadge)).toContainText("Codex CLI")
    await expect(alice.page.getByTestId(tid.profileBotBadge).locator('[data-provider-logo="codex"]')).toBeVisible()
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

test.describe("bot activity older pages", () => {
  for (const scenario of ["same-day", "cross-day"] as const) {
  for (const width of [1280, 390] as const) {
  test(`Activity ${scenario} older pages preserve real event positions at ${width}`, async ({ caseActors, caseResources }, testInfo) => {
        test.setTimeout(120_000)
        const actors = await caseActors(["alice"])
        const { pairMachine, createBot, jsonRequest, headersFor } = await prepareCase(actors, caseResources)
        const { credential, machineId } = await pairMachine()
        const machine = connectMachine(credential, caseResources, { machineId, headers: headersFor("alice") })
        await machine.opened
        const suffix = Date.now().toString(36)
        const botId = await createBot(machineId, `Anchor ${scenario} ${width} ${suffix}`)
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
          await expect.poll(() => scroller.evaluate(element => Boolean(element.querySelector("[data-activity-event-id]"))
            && element.scrollHeight > element.clientHeight
            && element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
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
})

test.describe("bot activity recovery", () => {
  for (const width of [1280, 390] as const) {
  test(`Activity recovery, live reading and reopen preserve event ownership at ${width}`, async ({ caseActors, caseResources }, testInfo) => {
      test.setTimeout(120_000)
      const actors = await caseActors(["alice"])
      const { pairMachine, createBot, jsonRequest, headersFor } = await prepareCase(actors, caseResources)
      const suffix = Date.now().toString(36)
      const { credential, machineId } = await pairMachine()
      const machine = connectMachine(credential, caseResources, { machineId, headers: headersFor("alice") })
      await machine.opened
      const botId = await createBot(machineId, `Recovery ${width} ${suffix}`)
      let gate: Awaited<ReturnType<typeof gateOlderActivityPages>> | undefined
      let journeyFailure: unknown
      let journeyFailurePresent = false
      const steps: Array<Record<string, unknown>> = []
      try {
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
        await expect.poll(() => scroller.evaluate(element => Boolean(element.querySelector("[data-activity-event-id]"))
          && element.scrollHeight > element.clientHeight
          && element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
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
})

test.describe("bot memberships", () => {
  type Bot = { id: string; name: string; runnerKey: string }
  type MembershipEvent = Extract<CommunityWsEvent, { type: typeof WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE | typeof WS_EVENTS.MEMBER_LEAVE }>

  async function prepareMembershipCase(actors: CaseActors, resources: CaseResources) {
    const headers = (role: "alice" | "bob" = "alice") => ({ Cookie: actors.sessionCookie(role), Origin: WEB_URL, "Content-Type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) })
    const call = (path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) => fetch(`${WEB_URL}${path}`, {method, headers:{...headers(),...extra}, ...(body === undefined ? {} : {body:JSON.stringify(body)})})
    const pair = await call("/api/community/machines/pair", "POST")
    expect(pair.status).toBe(200)
    const { tokenId } = await pair.json() as { tokenId: string }
    const activation = await fetch(`${WEB_URL}/api/community/daemon/activate`, {method:"POST",headers:{Authorization:`Bearer ${tokenId}`,Origin:WEB_URL,"Content-Type":"application/json"},body:JSON.stringify({hostname:`membership-qa-${Date.now()}`,platform:"darwin",arch:"arm64",runtimeReport:[{id:"codex-cli",status:"healthy"}]})})
    expect(activation.status).toBe(200)
    const {machineId,credential} = await activation.json() as {machineId:string;credential:string}
    resources.own(machineId, async id => {expect([204,404]).toContain((await call(`/api/community/machines/${id}`,"DELETE")).status)})
    const machine = connectMachine(credential,resources,{machineId,headers:headers()})
    await machine.opened
    const bots: Bot[] = []
    for (const name of ["Research companion", "Release assistant"]) {
      const response = await call("/api/community/bots","POST",{name,machineId,runtime:"codex-cli"})
      expect(response.status).toBe(201)
      const {bot} = await response.json() as {bot:{id:string;name:string}}
      resources.own(bot.id,async id => {expect([204,404]).toContain((await call(`/api/community/bots/${id}`,"DELETE")).status)})
      const enroll = await call("/api/community/daemon/enroll-agent","POST",{agentId:bot.id},{Authorization:`Bearer ${credential}`})
      expect(enroll.status).toBe(200)
      const {runnerKey} = await enroll.json() as {runnerKey:string}
      bots.push({...bot,runnerKey})
    }
    const [first,second] = bots as [Bot,Bot]
    const servers: Array<{id:string;handle:string;publicId:string;privateId:string;privateRef:string;hiddenId:string;threadId:string;messageId:string}> = []
    for (const name of ["Membership studio", "Release planning with a deliberately long server name"]) {
      const id = await actors.seed.seedServer("alice",name)
      const token = await actors.seed.createInvite("alice",id)
      let handle = ""
      for (const bot of bots) {
        const joined = await call(`/api/community/invites/${token}/join`,"POST",{},{Authorization:`Bearer ${bot.runnerKey}`})
        expect(joined.status).toBe(200)
        const {server} = await joined.json() as {server:{name:string;discriminator:string}}
        handle=`${server.name}#${server.discriminator}`
      }
      const publicId = await actors.seed.seedChannel("alice",id,"announcements","text")
      await actors.seed.seedChannel("alice",id,"ideas-and-feedback","forum")
      const categoryId = await actors.seed.seedCategory("alice",id,"Do not show this category",{private:true})
      const privateId = await actors.seed.seedChannel("alice",id,"private-working-notes","text",categoryId)
      const hiddenId = await actors.seed.seedChannel("alice",id,"hidden-from-bots","text",categoryId)
      for (const bot of bots) expect((await call(`/api/community/channels/${privateId}/members`,"POST",{userId:bot.id})).status).toBe(201)
      const messageId = await actors.seed.seedMessage("alice",privateId,"Preserved history before bot exit")
      const threadId = await actors.seed.seedThread("alice",messageId,"Child participation")
      for (const bot of bots) expect((await call(`/api/community/channels/${threadId}/participants`,"POST",{userId:bot.id})).status).toBe(201)
      servers.push({id,handle,publicId,privateId,privateRef:`/${handle}/private-working-notes`,hiddenId,threadId,messageId})
    }
    return {headers,call,bots,first,second,servers,machine}
  }

  async function openMemberships(page: Page, bot: Bot) {
    const card = page.locator('[data-slot="card"]').filter({has:page.getByText(bot.name,{exact:true})})
    await expect(card).toHaveCount(1)
    const trigger = card.getByRole("button",{name:"Bot actions",exact:true})
    await trigger.click()
    await page.getByTestId(tid.botMembershipsMenu(bot.id)).click()
    await expect(page.getByTestId(tid.botMembershipsSheet)).toBeVisible()
    const description = page.getByTestId(tid.botMembershipsSheet).locator('[data-slot="sheet-description"]')
    await expect(description).toContainText(bot.name)
    const avatar = description.locator("svg")
    await expect(avatar).toHaveCount(1)
    expect(await avatar.innerHTML()).toBe(await card.locator("svg").first().innerHTML())
    expect((await avatar.boundingBox())!.width).toBe(24)
    expect((await avatar.boundingBox())!.height).toBe(24)
    await expect(page.getByRole("menu",{includeHidden:true})).toHaveCount(0)
    return trigger
  }

  function observeMembershipEvents(page: Page) {
    const events: MembershipEvent[] = []
    page.on("websocket", socket => socket.on("framereceived", async ({payload}) => {
      const text = String(payload)
      if (!text.startsWith("{")) return
      const frame: unknown = JSON.parse(text)
      const admitted = isCommunityBrowserEventBatchCandidate(frame)
        ? await admitCommunityBrowserEventBatch(frame)
        : decodeCommunityBrowserEvent(frame)
      if (!admitted.ok) return
      for (const item of "events" in admitted ? admitted.events : [admitted.event]) {
        if (item.type === WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE || item.type === WS_EVENTS.MEMBER_LEAVE) events.push(item)
      }
    }))
    return events
  }

  function membershipRows(serverId: string, botIds: string[]) {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    const sql = `SELECT m.user_id AS userId, m.channel_id AS channelId, m.relation FROM community_channel_member m JOIN community_channel c ON c.id=m.channel_id WHERE c.server_id=${quote(serverId)} AND m.user_id IN (${botIds.map(quote).join(",")}) ORDER BY m.user_id,m.channel_id,m.relation`
    const result = spawnSync("pnpm", ["exec","wrangler","d1","execute","alook-app","--local","--json","--command",sql],{cwd:`${REPO_ROOT}/src/web`,encoding:"utf8",maxBuffer:4*1024*1024})
    expect(result.status).toBe(0)
    return (JSON.parse(result.stdout) as Array<{results:Array<{userId:string;channelId:string;relation:string}>}>)[0]!.results
  }

  test("owned bot exits preserve other identities, child participation boundaries and history", async ({caseActors,caseResources},testInfo) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice","bob"])
    const fixture = await prepareMembershipCase(actors,caseResources)
    const {first,second,servers,call,headers} = fixture
    const [studio,release] = servers
    const actorHeader = {[COMMUNITY_BOT_ACTOR_HEADER]:first.id}
    const list = await call("/api/community/servers/channels","GET",undefined,actorHeader)
    expect(list.status).toBe(200)
    const body = await list.json() as {servers:Array<{id:string;handle:string}>;groups:Array<{channels:Array<{ref:string;name:string}>}>}
    expect(body.servers.map(s=>s.id).sort()).toEqual(servers.map(s=>s.id).sort())
    const channels = body.groups.flatMap(g=>g.channels)
    expect(channels.some(c=>c.ref===studio.privateRef)).toBe(true)
    expect(channels.some(c=>c.name==="hidden-from-bots")).toBe(false)
    expect(channels.some(c=>c.name==="Child participation")).toBe(false)
    expect((await fetch(`${WEB_URL}/api/community/servers/channels`,{headers:{...headers("bob"),...actorHeader}})).status).toBe(404)
    expect((await call("/api/community/servers/channels","GET",undefined,{...actorHeader,Authorization:`Bearer ${first.runnerKey}`})).status).toBe(403)
    expect((await call("/api/community/users/me/notifications","GET",undefined,actorHeader)).status).toBe(403)
    const publicLeave = `/api/community/channels/resolve/members/self?ref=${encodeURIComponent(`/${studio.handle}/announcements`)}`
    expect((await call(publicLeave,"DELETE",undefined,actorHeader)).status).toBe(400)
    expect((await call(`/api/community/channels/${studio.privateId}/members/${second.id}`,"DELETE",undefined,actorHeader)).status).toBe(403)
    const before = membershipRows(studio.id,[first.id,second.id])
    expect(before.filter(r=>r.userId===first.id).map(r=>r.relation).sort()).toEqual(["access","notify"])
    const {page} = await actors.asUser("alice",{viewport:{width:1280,height:900},reducedMotion:"reduce"})
    const events = observeMembershipEvents(page)
    await gotoAfterUserWsAuth(page,"/c/me/bots")
    const trigger = await openMemberships(page,first)
    const sheet = page.getByTestId(tid.botMembershipsSheet)
    await expect(sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))).toBeVisible()
    await expect(sheet.getByText("Do not show this category",{exact:true})).toHaveCount(0)
    await expect(sheet.getByText("hidden-from-bots",{exact:true})).toHaveCount(0)
    await expect(sheet.getByTestId(tid.botMembershipsLeave(`/${studio.handle}/announcements`))).toBeEnabled()
    await page.getByTestId(tid.botMembershipsLeave(studio.privateRef)).click()
    await expect(page.getByRole("alertdialog")).toContainText(first.name)
    await expect(page.getByRole("alertdialog")).toContainText("Membership-studio")
    await page.getByRole("button",{name:"Cancel",exact:true}).click()
    expect(membershipRows(studio.id,[first.id,second.id])).toEqual(before)
    let fail = true
    let requests = 0
    let releaseResponse!: () => void
    const gate = new Promise<void>(r=>releaseResponse=r)
    caseResources.own(releaseResponse,async r=>r())
    let captured!: () => void
    const saved = new Promise<void>(r=>captured=r)
    const leavePath = `/api/community/channels/resolve/members/self?ref=${encodeURIComponent(studio.privateRef)}`
    await page.route(`**${leavePath}`,async route=>{
      requests++
      expect(route.request().headers()[COMMUNITY_BOT_ACTOR_HEADER.toLowerCase()]).toBe(first.id)
      expect(route.request().headers().authorization).toBeUndefined()
      if(fail){await route.fulfill(currentCommunityFixtureError("QA temporary failure",503));return}
      const response = await route.fetch()
      expect(response.status()).toBe(204)
      captured()
      await gate
      await route.fulfill({response})
    })
    await page.getByTestId(tid.botMembershipsLeave(studio.privateRef)).click()
    const confirm = page.getByTestId(tid.botMembershipsConfirm)
    await confirm.click()
    await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText("QA temporary failure")
    expect(membershipRows(studio.id,[first.id,second.id])).toEqual(before)
    fail=false
    await confirm.click()
    await saved
    await expect(confirm).toBeDisabled()
    await expect(page.getByRole("button",{name:"Cancel",exact:true})).toBeDisabled()
    await confirm.dispatchEvent("click")
    expect(requests).toBe(2)
    releaseResponse()
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await expect(sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))).toHaveCount(0)
    const after = membershipRows(studio.id,[first.id,second.id])
    expect(after).toEqual(before.filter(r=>r.userId===second.id))
    await testInfo.attach("received-community-events",{body:JSON.stringify(events),contentType:"application/json"})
    await expect.poll(()=>events.some(e=>e.type===WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE&&e.userId===first.id&&e.channelId===studio.privateId&&e.relation==="access"&&e.present===false)).toBe(true)
    expect((await call(leavePath,"DELETE",undefined,actorHeader)).status).toBe(403)
    expect((await call(`/api/community/bots/${first.id}/active`,"PATCH",{active:false})).status).toBe(200)
    expect((await call("/api/community/servers/channels","GET",undefined,actorHeader)).status).toBe(200)
    expect((await call("/api/community/channels/resolve/messages","POST",{channel:`/${release.handle}/announcements`,content:{text:"must not send"}},actorHeader)).status).toBe(403)
    await page.getByTestId(tid.botMembershipsLeave(`/${release.handle}/announcements`)).click()
    await expect(page.getByRole("alertdialog")).toContainText("public")
    await expect(confirm).toHaveText("Leave server")
    const left = page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/api/community/servers/resolve/leave")
    await confirm.click()
    expect((await left).status()).toBe(204)
    await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toHaveCount(0)
    expect(membershipRows(release.id,[first.id,second.id]).map(r=>r.userId)).toEqual([second.id,second.id])
    await expect.poll(()=>events.some(e=>e.type===WS_EVENTS.MEMBER_LEAVE&&e.userId===first.id&&e.serverId===release.id)).toBe(true)
    const roster = await call(`/api/community/servers/${release.id}/members`)
    expect(roster.status).toBe(200)
    const members = (await roster.json() as {members:Array<{userId:string}>}).members.map(m=>m.userId)
    expect(members).toContain(actors.userId("alice"))
    expect(members).toContain(second.id)
    expect(members).not.toContain(first.id)
    const history = await call(`/api/community/channels/${release.privateId}/messages`)
    expect(history.status).toBe(200)
    expect((await history.json() as {messages:Array<{id:string}>}).messages.some(m=>m.id===release.messageId)).toBe(true)
    await page.getByTestId(tid.botMembershipsLeave(studio.id)).click()
    await confirm.click()
    await expect(sheet.getByText(`${first.name} hasn't joined any servers.`,{exact:true})).toBeVisible()
    const emptyMemberships = await call("/api/community/servers/channels","GET",undefined,actorHeader)
    expect(emptyMemberships.status).toBe(200)
    expect(await emptyMemberships.json()).toMatchObject({servers:[],groups:[]})
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await openMemberships(page,second)
    for(const server of servers) await expect(page.getByTestId(tid.botMembershipsServer(server.id))).toBeVisible()
    await testInfo.attach("membership-api-d1-ws",{body:JSON.stringify({before,after,events,protectedIdentities:[actors.userId("alice"),second.id],historyPreserved:release.messageId}),contentType:"application/json"})
  })

  test("membership loading and late responses stay bound to the selected bot on desktop and mobile", async ({caseActors,caseResources},testInfo) => {
    test.setTimeout(180_000)
    const actors = await caseActors(["alice"])
    const {first,second,servers,call} = await prepareMembershipCase(actors,caseResources)
    const [studio,release] = servers
    expect((await call(`/api/community/servers/resolve/leave?server=${encodeURIComponent(release.handle)}`,"POST",undefined,{[COMMUNITY_BOT_ACTOR_HEADER]:second.id})).status).toBe(204)
    const {page} = await actors.asUser("alice",{viewport:{width:1440,height:1000},reducedMotion:"reduce"})
    await gotoAfterUserWsAuth(page,"/c/me/bots")
    const style="nextjs-portal, .tsqd-open-btn-container { visibility:hidden !important; }"
    const botCard = page.locator('[data-slot="card"]').filter({has:page.getByText(first.name,{exact:true})})
    await expect(botCard).toHaveCount(1)
    await botCard.getByRole("button",{name:"Bot actions",exact:true}).click()
    await expect(page.getByRole("menuitem",{name:"Restart",exact:true})).toBeVisible()
    await expect(page.getByRole("menuitem",{name:"Reset",exact:true})).toHaveCount(0)
    await page.screenshot({path:testInfo.outputPath("bot-restart-menu.png"),style})
    await page.getByRole("menuitem",{name:"Restart",exact:true}).click()
    await expect(page.getByRole("alertdialog").getByRole("heading",{name:"Restart this bot?",exact:true})).toBeVisible()
    await expect(page.getByRole("menu",{includeHidden:true})).toHaveCount(0)
    await page.screenshot({path:testInfo.outputPath("bot-restart-confirm.png"),style})
    await page.getByRole("alertdialog").getByRole("button",{name:"Cancel",exact:true}).click()
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    let releaseFailure!: () => void
    const failureGate = new Promise<void>(r=>releaseFailure=r)
    caseResources.own(releaseFailure,async r=>r())
    let fail = true
    let hold = false
    let releaseRead!: () => void
    let captureRead!: () => void
    let finishRead!: () => void
    const gate = new Promise<void>(r=>releaseRead=r)
    const captured = new Promise<void>(r=>captureRead=r)
    const delivered = new Promise<void>(r=>finishRead=r)
    caseResources.own(releaseRead,async r=>r())
    await page.route("**/api/community/servers/channels",async route=>{
      if(route.request().headers()[COMMUNITY_BOT_ACTOR_HEADER.toLowerCase()]!==first.id){await route.continue();return}
      if(fail){await failureGate;await route.fulfill(currentCommunityFixtureError("QA loading unavailable",503));return}
      if(!hold){await route.continue();return}
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      captureRead()
      await gate
      await route.fulfill({response}).catch(()=>undefined)
      finishRead()
    })
    const sheet = page.getByTestId(tid.botMembershipsSheet)
    await openMemberships(page,first)
    await expect(sheet.getByLabel("Loading servers and channels")).toBeVisible()
    await page.screenshot({path:testInfo.outputPath("memberships-loading.png"),style})
    releaseFailure()
    await expect(sheet.getByRole("alert")).toContainText("Could not load servers and channels.")
    fail=false
    await sheet.getByRole("button",{name:"Retry",exact:true}).click()
    await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    hold=true
    await openMemberships(page,first)
    await captured
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    await openMemberships(page,second)
    await expect(sheet.getByTestId(tid.botMembershipsServer(studio.id))).toBeVisible()
    await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toHaveCount(0)
    releaseRead()
    await delivered
    await expect(sheet).toContainText(second.name)
    await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toHaveCount(0)
    hold=false
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    await openMemberships(page,first)
    await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toBeVisible()
    await page.screenshot({path:testInfo.outputPath("memberships-desktop-light.png"),style})
    await page.keyboard.press("Escape")
    await page.getByTestId(tid.userSettingsOpen).click()
    await page.getByTestId(tid.settingsTab("appearance")).click()
    await page.getByRole("button",{name:"Dark",exact:true}).click()
    await expect(page.getByRole("button",{name:"Dark",exact:true})).toHaveAttribute("aria-pressed","true")
    await page.getByTestId(tid.settingsClose).click()
    await openMemberships(page,first)
    await expect(sheet.getByTestId(tid.botMembershipsServer(release.id))).toBeVisible()
    await page.screenshot({path:testInfo.outputPath("memberships-desktop-dark.png"),style})
    await page.keyboard.press("Escape")
    await page.getByTestId(tid.userSettingsOpen).click()
    await page.getByTestId(tid.settingsTab("appearance")).click()
    await page.getByRole("button",{name:"Light",exact:true}).click()
    await page.getByTestId(tid.settingsClose).click()
    await page.setViewportSize({width:390,height:844})
    await openMemberships(page,first)
    await expect(sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))).toBeVisible()
    const box = (await sheet.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x+box.width).toBeLessThanOrEqual(390)
    expect((await sheet.getByTestId(tid.botMembershipsLeave(studio.privateRef)).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const actions = sheet.getByTestId(/^bot-memberships-leave-/)
    expect(await actions.count()).toBeGreaterThan(2)
    const privateRow = sheet.getByTestId(tid.botMembershipsChannel(studio.privateRef))
    const lock = privateRow.getByLabel("Private channel",{exact:true})
    await expect(lock).toBeVisible()
    const icons = privateRow.locator("svg")
    expect((await lock.boundingBox())!.x).toBeLessThan((await icons.nth(1).boundingBox())!.x)
    await expect(sheet.getByTestId(tid.botMembershipsChannel(`/${studio.handle}/announcements`)).getByLabel("Private channel",{exact:true})).toHaveCount(0)
    for (const action of await actions.all()) {
      const bounds = (await action.boundingBox())!
      expect(bounds.height).toBeGreaterThanOrEqual(44)
      expect(bounds.width).toBeGreaterThanOrEqual(44)
      await expect(action).toHaveAccessibleName(/Leave/)
      expect((await action.innerText()).trim()).toBe("")
    }
    await page.screenshot({path:testInfo.outputPath("memberships-mobile.png"),style})
    await sheet.getByTestId(tid.botMembershipsLeave(studio.privateRef)).click()
    const confirmation = page.getByRole("alertdialog")
    await expect(confirmation).toContainText("Membership-studio")
    expect((await page.getByTestId(tid.botMembershipsConfirm).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect((await confirmation.getByRole("button",{name:"Cancel",exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({path:testInfo.outputPath("memberships-mobile-confirm.png"),style})
    await confirmation.getByRole("button",{name:"Cancel",exact:true}).click()
    await sheet.getByTestId(tid.botMembershipsLeave(`/${studio.handle}/announcements`)).click()
    await expect(confirmation).toContainText("public")
    await expect(confirmation).toContainText("Membership-studio")
    await expect(page.getByTestId(tid.botMembershipsConfirm)).toHaveText("Leave server")
    await page.screenshot({path:testInfo.outputPath("memberships-mobile-public-confirm.png"),style})
    await confirmation.getByRole("button",{name:"Cancel",exact:true}).click()
    await expect(sheet.getByTestId(tid.botMembershipsServer(studio.id))).toBeVisible()
    await page.keyboard.press("Escape")
    expect((await call(`/api/community/bots/${first.id}`,"DELETE")).status).toBe(204)
    expect((await call("/api/community/servers/channels","GET",undefined,{[COMMUNITY_BOT_ACTOR_HEADER]:first.id})).status).toBe(404)
  })
})
