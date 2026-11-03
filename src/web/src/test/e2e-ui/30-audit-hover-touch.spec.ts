import { communityFixtureFetch } from "./_fixtures/business-contract"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import { connectMachine } from "./_fixtures/community-machine"
import { prepareCase, settleSheet, expectSheetThemeTokens, attachPageScreenshot } from "./_fixtures/bot-profile-audit"

test("full audit log reveals a truncated row by hover and touch", async ({ caseActors, caseResources }, testInfo) => {
  test.setTimeout(120_000)

  const actors = await caseActors(["alice"])
  const { asUser } = actors
  const { headersFor, pairMachine, createBot } = await prepareCase(actors, caseResources)

  const suffix = Date.now().toString(36)
  const longAuditTarget = `/Users/alice/workspace/${"deeply-nested-audit-target/".repeat(5)}result-${suffix}.md`
  const fullAuditText = `read · ${longAuditTarget}`
  const { credential, machineId } = await pairMachine()
  const machine = connectMachine(credential, caseResources, { machineId, headers: headersFor("alice") })
  await machine.opened
  const botId = await createBot(machineId, `Tooltip bot ${suffix}`)

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
      const response = await communityFixtureFetch(
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
