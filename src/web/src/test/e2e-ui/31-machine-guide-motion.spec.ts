import { test, expect } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"

test("first-signup mobile starts onboarding once and retains it on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/sign-in")
  await page.getByRole("textbox", { name: "Email" }).fill(
    `direct-onboarding-mobile-${process.pid}-${Date.now()}@example.com`,
  )
  await page.getByRole("checkbox", { name: "I agree to the Terms of Service" }).check()
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForURL("**/c/me/machines", { waitUntil: "commit" })

  await expect.poll(async () => {
    const cookies = await page.context().cookies()
    return cookies.some((cookie) => cookie.name === "is_new_signup")
  }).toBe(false)

  const onboarding = page.getByTestId(tid.onboardingHarnessDialog)
  await expect(onboarding).toBeVisible()
  await expect(onboarding.getByRole("heading", { name: "Which harness do you already use?" })).toBeVisible()
  await page.getByTestId(tid.onboardingHarnessOption("grok")).click()
  await onboarding.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(page.getByTestId(tid.onboardingMachineDialog)).toBeVisible()

  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page).toHaveURL(/\/c\/me\/machines$/)
  await expect(page.getByTestId(tid.onboardingMachineDialog)).toBeVisible()
  await expect(onboarding).toHaveCount(0)
})

test("first-signup desktop opens onboarding before the empty Machines guide", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/sign-in")
  await page.getByRole("textbox", { name: "Email" }).fill(
    `direct-onboarding-desktop-${process.pid}-${Date.now()}@example.com`,
  )
  await page.getByRole("checkbox", { name: "I agree to the Terms of Service" }).check()
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForURL("**/c/me/machines", { waitUntil: "commit" })

  const onboarding = page.getByTestId(tid.onboardingHarnessDialog)
  await expect(onboarding).toBeVisible()
  await expect(
    onboarding.getByRole("heading", { name: "Which harness do you already use?" }),
  ).toBeVisible()
  await expect(onboarding.getByLabel("Step 1 of 3")).toBeVisible()
  await expect(page.getByTestId(tid.machineFirstSignupGuide)).toHaveCount(0)

  const grok = page.getByTestId(tid.onboardingHarnessOption("grok"))
  await expect(grok).toBeVisible()
  await expect(grok).toContainText("Grok Build")
  await expect(grok.locator('[data-provider-logo="grok"]')).toBeVisible()
  await grok.click()
  await onboarding.getByRole("button", { name: "Continue", exact: true }).click()

  const machineStep = page.getByTestId(tid.onboardingMachineDialog)
  await expect(machineStep).toBeVisible()
  await expect(machineStep.getByRole("heading", { name: /Connect your Grok Build machine/ }))
    .toBeVisible()
  await expect(machineStep.locator('[data-provider-logo="grok"]')).toBeVisible()
})
