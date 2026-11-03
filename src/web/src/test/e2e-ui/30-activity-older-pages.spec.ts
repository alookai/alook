import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase, settleSheet, attachPageScreenshot, type ActivityAnchorPage, activityAnchorSnapshot, settleActivityPosition, gateOlderActivityPages, seedActivityHistory, expectActivityPosition } from "./_fixtures/bot-profile-audit"

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
