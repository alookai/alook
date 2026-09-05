import { test, expect } from "./_fixtures/community-fixture"
import { test as browserTest, expect as browserExpect } from "@playwright/test"

// Journey 1 — login & first screen. storageState is established in
// global-setup, so this journey re-verifies the redirect/auth contract with a
// FRESH context (no saved session) plus an authenticated landing.
test.describe.serial("auth & first screen", () => {
  test("unauthenticated /c deep-link redirects to /sign-in with redirect param", async ({ browser }) => {
    const context = await browser.newContext() // no storageState — anonymous
    const page = await context.newPage()
    await page.goto("/c/channels/does-not-matter/whatever")
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 , waitUntil: "commit" })
    expect(page.url()).toContain("redirect=")
    await context.close()
  })

  test("authenticated user reaches the community shell", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto("/c")
    // Not bounced to sign-in.
    await expect(page).not.toHaveURL(/\/sign-in/)
    await page.waitForURL(/\/c/, { timeout: 20_000 , waitUntil: "commit" })
  })
})

browserTest.describe("production OTP error placement", () => {
  browserTest("keeps an invalid OTP below the mobile control and clears it before retry", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })

    const attempts: string[] = []
    await page.route("**/api/auth/email-otp/send-verification-otp", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    }))
    await page.route("**/api/auth/sign-in/email-otp", async (route) => {
      const body = route.request().postDataJSON() as { otp: string }
      attempts.push(body.otp)
      if (attempts.length <= 2) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ code: "INVALID_OTP", message: "Invalid OTP" }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test", user: { id: "user_test" } }),
      })
    })
    await page.route("**/c/me", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<main>Signed in</main>",
    }))

    await page.goto("/sign-in")
    const sendCode = page.getByRole("button", { name: "Send Code" })
    browserTest.skip(!(await sendCode.isVisible()), "production Email OTP UI is not active")

    await page.getByRole("textbox", { name: "Email" }).fill("person@example.com")
    await sendCode.click()

    const otp = page.getByRole("textbox", { name: "Verification code" })
    await otp.fill("123456")
    const alert = page.getByRole("alert").filter({ hasText: "Invalid OTP" })
    await browserExpect(alert).toHaveCount(1)
    await browserExpect(otp).toHaveAttribute("aria-invalid", "true")
    await browserExpect(otp).toHaveAttribute("aria-describedby", "sign-in-otp-error")

    const slots = page.locator('[data-slot="input-otp-slot"]')
    const lastSlot = await slots.last().boundingBox()
    const alertBox = await alert.boundingBox()
    browserExpect(lastSlot).not.toBeNull()
    browserExpect(alertBox).not.toBeNull()
    browserExpect(alertBox!.y).toBeGreaterThanOrEqual(lastSlot!.y + lastSlot!.height)

    await otp.fill("7")
    await browserExpect(alert).toHaveCount(0)
    await browserExpect(otp).toHaveAttribute("aria-invalid", "false")

    await otp.fill("111111")
    await browserExpect(alert).toHaveCount(1)
    await page.getByRole("button", { name: "Use a different email" }).click()
    await browserExpect(alert).toHaveCount(0)
    await browserExpect(page.getByRole("textbox", { name: "Email" })).toBeVisible()
    await page.getByRole("button", { name: "Send Code" }).click()

    await otp.fill("654321")
    await page.waitForURL("**/c/me")
    browserExpect(attempts).toEqual(["123456", "111111", "654321"])
  })

  browserTest("keeps send failures and cooldown feedback inside the desktop email field", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })

    let sends = 0
    await page.route("**/api/auth/email-otp/send-verification-otp", async (route) => {
      sends += 1
      if (sends === 1) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ code: "SEND_FAILED", message: "Failed to send code" }),
        })
        return
      }
      await route.fulfill({
        status: 429,
        headers: { "Retry-After": "4" },
        contentType: "application/json",
        body: JSON.stringify({ code: "TOO_MANY_REQUESTS", message: "Too many requests" }),
      })
    })

    await page.goto("/sign-in")
    const sendCode = page.getByRole("button", { name: "Send Code" })
    browserTest.skip(!(await sendCode.isVisible()), "production Email OTP UI is not active")

    const email = page.getByRole("textbox", { name: "Email" })
    await email.fill("person@example.com")
    await sendCode.click()

    let alert = page.getByRole("alert").filter({ hasText: "Failed to send code" })
    await browserExpect(alert).toHaveCount(1)
    await browserExpect(email).toHaveAttribute("aria-describedby", "sign-in-email-error")
    const inputBox = await email.boundingBox()
    const sendBox = await sendCode.boundingBox()
    let alertBox = await alert.boundingBox()
    browserExpect(inputBox).not.toBeNull()
    browserExpect(sendBox).not.toBeNull()
    browserExpect(alertBox).not.toBeNull()
    browserExpect(alertBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height)
    browserExpect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(sendBox!.y)

    await email.fill("other@example.com")
    await browserExpect(alert).toHaveCount(0)
    await sendCode.click()

    alert = page.getByRole("alert").filter({
      hasText: /Too many requests\. Try again in \d+s\./,
    })
    await browserExpect(alert).toHaveCount(1)
    alertBox = await alert.boundingBox()
    browserExpect(alertBox).not.toBeNull()
    browserExpect(alertBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height)
    browserExpect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(sendBox!.y)
    await browserExpect(page.getByRole("button", { name: /Wait \d+s/ })).toBeDisabled()
    await browserExpect(page.getByRole("button", { name: "GitHub" })).toBeVisible()
    await browserExpect(page.getByRole("button", { name: "Google" })).toBeVisible()
  })
})
