import type { WebSocketRoute } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"
import { USER_WS_AUTH_CONSUMED_ATTRIBUTE, installUserWsAuthConsumedBarrier } from "./_fixtures/community-ws-reconnect"

test("an active onboarding form keeps focus priority during a reconnect", async ({ caseResources }) => {
  test.setTimeout(90_000)
  const context = await caseResources.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  let userWs: WebSocketRoute | null = null
  let blockUserWs = false
  await page.routeWebSocket((url) => url.pathname.endsWith("/user"), (ws) => {
    userWs = ws
    if (blockUserWs) {
      ws.close({ code: 1012, reason: "active onboarding reconnect e2e outage" })
      return
    }
    ws.connectToServer()
  })

  let caseJourneyFailure1: unknown
let caseJourneyFailure1Present = false
  try {
    await installUserWsAuthConsumedBarrier(page)
    await page.goto("/sign-in")
    await page.getByRole("button", { name: "Continue with email", exact: true }).click()
    await page.getByRole("textbox", { name: "Email" }).fill(
      `guide-reconnect-${process.pid}-${Date.now()}@example.com`,
    )
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page.waitForURL("**/c/me/machines", { waitUntil: "commit" })
    const onboarding = page.getByTestId(tid.onboardingHarnessDialog)
    await expect(onboarding).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute(
      USER_WS_AUTH_CONSUMED_ATTRIBUTE,
      "true",
      { timeout: 20_000 },
    )

    const onboardingAction = onboarding.getByRole("radio", { name: "Claude Code" })
    await onboardingAction.focus()
    blockUserWs = true
    expect(userWs).not.toBeNull()
    await userWs!.close({ code: 1012, reason: "active onboarding reconnect e2e outage" })

    await page.waitForTimeout(1_600)
    const failedStatus = page.getByTestId(tid.wsReconnectOverlay)
    if (await failedStatus.count()) {
      await expect(failedStatus).toHaveAttribute("data-ws-status", "failed")
      await expect(failedStatus).not.toHaveAttribute("aria-modal")
    }
    await expect(onboarding).toBeVisible()
    await expect(onboardingAction).toBeFocused()
    expect(await onboarding.evaluate((element) => element.closest("[inert]") !== null)).toBe(false)

    blockUserWs = false
    await expect(onboarding).toBeVisible()
  } catch (error) { caseJourneyFailure1 = error; caseJourneyFailure1Present = true; throw error } finally {
    try {

      blockUserWs = false
      await caseResources.closeContext(context)

    } catch (cleanupError) { if (caseJourneyFailure1Present) throw new AggregateError([caseJourneyFailure1, cleanupError], "Journey and resource exit both failed"); throw cleanupError }
  }
})
