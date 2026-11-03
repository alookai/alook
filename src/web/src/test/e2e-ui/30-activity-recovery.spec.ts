import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase, settleSheet, attachPageScreenshot, type ActivityAnchorPage, activityAnchorSnapshot, gateOlderActivityPages, seedActivityHistory, observeActivityFrames, publishActivityReset, expectActivityPosition, visibleActivityAnchor } from "./_fixtures/bot-profile-audit"

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
