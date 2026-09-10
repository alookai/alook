import { test, expect } from "./_fixtures/community-fixture"
import {
  test as browserTest,
  expect as browserExpect,
  type Locator,
  type Page,
} from "@playwright/test"

async function expectSameHorizontalCenter(first: Locator, second: Locator) {
  const [firstBox, secondBox] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
  ])
  browserExpect(firstBox).not.toBeNull()
  browserExpect(secondBox).not.toBeNull()
  browserExpect(Math.abs(
    firstBox!.x + firstBox!.width / 2 -
    (secondBox!.x + secondBox!.width / 2),
  )).toBeLessThanOrEqual(1)
}

async function expectSameWidth(first: Locator, second: Locator) {
  const [firstBox, secondBox] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
  ])
  browserExpect(firstBox).not.toBeNull()
  browserExpect(secondBox).not.toBeNull()
  browserExpect(Math.abs(firstBox!.width - secondBox!.width)).toBeLessThanOrEqual(1)
}

async function expectCenteredNativeOauthState(
  page: Page,
  {
    copy,
    role,
    cancel,
    retryDisabled,
  }: {
    copy: string
    role: "alert" | "status"
    cancel: boolean
    retryDisabled: boolean
  },
) {
  const status = page.getByRole(role).filter({ hasText: copy })
  const retry = page.getByRole("button", { name: "Try again" })
  const actions = retry.locator("..")
  const authPane = page.locator('[data-slot="card-content"] > div').first()
  await browserExpect(status).toHaveRole(role)
  await browserExpect(status).toHaveText(copy)
  await browserExpect(status).toHaveClass(/text-center/)
  await browserExpect(actions).toHaveClass(/justify-center/)
  await expectSameHorizontalCenter(status, authPane)
  await expectSameHorizontalCenter(actions, authPane)

  await browserExpect(retry).toHaveText("Try again")
  await browserExpect(retry).toHaveClass(/h-11/)
  await browserExpect(retry).toHaveClass(/sm:h-8/)
  await browserExpect(retry).toHaveClass(/text-primary/)
  await browserExpect(retry).not.toHaveClass(/border-border|bg-background|bg-primary|bg-secondary/)
  if (retryDisabled) await browserExpect(retry).toBeDisabled()
  else {
    await browserExpect(retry).toBeEnabled()
    await retry.focus()
    await browserExpect(retry).toBeFocused()
  }

  const cancelAction = page.getByRole("button", { name: "Cancel" })
  if (!cancel) {
    await browserExpect(cancelAction).toHaveCount(0)
    return
  }
  await browserExpect(cancelAction).toHaveText("Cancel")
  await browserExpect(cancelAction).toHaveClass(/h-11/)
  await browserExpect(cancelAction).toHaveClass(/sm:h-8/)
  await browserExpect(cancelAction).toHaveClass(/text-primary/)
  await browserExpect(cancelAction).not.toHaveClass(/border-border|bg-background|bg-primary|bg-secondary/)
  await cancelAction.focus()
  await browserExpect(cancelAction).toBeFocused()
}

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
  browserTest("centers an invalid OTP on mobile and desktop and clears it before retry", async ({ page }, testInfo) => {
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
    const otpField = page.locator('[data-slot="sign-in-otp-field"]')
    const otpGroup = page.locator('[data-slot="input-otp-group"]')
    const authPane = page.locator('[data-slot="card-content"] > div').first()
    const lastSlot = await slots.last().boundingBox()
    const alertBox = await alert.boundingBox()
    browserExpect(lastSlot).not.toBeNull()
    browserExpect(alertBox).not.toBeNull()
    browserExpect(alertBox!.y).toBeGreaterThanOrEqual(lastSlot!.y + lastSlot!.height)
    await expectSameHorizontalCenter(otpField, authPane)
    await expectSameHorizontalCenter(otpGroup, authPane)
    await expectSameHorizontalCenter(alert, otpGroup)
    await expectSameWidth(otpField, otpGroup)

    const mobileScreenshot = testInfo.outputPath("mobile-otp-centered.png")
    await page.screenshot({ path: mobileScreenshot })
    await testInfo.attach("mobile OTP centered", {
      path: mobileScreenshot,
      contentType: "image/png",
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await expectSameHorizontalCenter(otpField, authPane)
    await expectSameHorizontalCenter(otpGroup, authPane)
    await expectSameHorizontalCenter(alert, otpGroup)
    await expectSameWidth(otpField, otpGroup)

    const desktopScreenshot = testInfo.outputPath("desktop-otp-centered.png")
    await page.screenshot({ path: desktopScreenshot })
    await testInfo.attach("desktop OTP centered", {
      path: desktopScreenshot,
      contentType: "image/png",
    })

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

browserTest.describe("native OAuth status actions", () => {
  browserTest("centers responsive preparing, waiting, and error states with text-only actions", async ({ page }) => {
    const attempt = {
      attemptId: "attempt_1234567890123456",
      provider: "github" as const,
      redirectPath: "/c/me",
      expiresAt: Date.now() + 600_000,
      waiting: false,
    }
    const registration = {
      attemptId: attempt.attemptId,
      stateHash: "a".repeat(64),
      codeChallenge: "b".repeat(43),
      instanceKeyHash: "c".repeat(64),
      platform: "macos",
      provider: "github",
      redirectPath: "/c/me",
    }
    let snapshot: typeof attempt | null = null
    let failPrepare = false
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve })

    await page.exposeFunction("__testNativeOauthInvoke", async (command: string) => {
      if (command === "native_oauth_snapshot") return snapshot
      if (command === "native_oauth_pending_exchange") return null
      if (command === "native_oauth_prepare") {
        if (failPrepare) throw new Error("start failed")
        await prepareGate
        snapshot = attempt
        return registration
      }
      if (command === "native_oauth_open_start") {
        snapshot = { ...attempt, waiting: true }
        return null
      }
      if (command === "native_oauth_cancel") {
        snapshot = null
        return null
      }
      return null
    })
    await page.addInitScript(() => {
      const bridge = window as typeof window & {
        __testNativeOauthInvoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        __TAURI__: {
          core: {
            Channel: new () => { onmessage: () => void }
            invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
      }
      class Channel {
        onmessage = () => {}
      }
      bridge.__TAURI__ = {
        core: {
          Channel,
          invoke: (command, args) => command === "native_oauth_listen"
            ? Promise.resolve(1)
            : bridge.__testNativeOauthInvoke(command, args),
        },
      }
    })
    await page.route("**/api/auth/native/attempt", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ startUrl: "https://github.com/login/oauth/authorize" }),
    }))

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/sign-in")
    await browserExpect(page.getByRole("button", { name: "GitHub" })).toBeEnabled()
    await page.getByRole("button", { name: "GitHub" }).click()
    await expectCenteredNativeOauthState(page, {
      copy: "Opening sign-in in your browser…",
      role: "status",
      cancel: true,
      retryDisabled: true,
    })
    await browserExpect.poll(async () => (
      await page.getByRole("button", { name: "Cancel" }).boundingBox()
    )?.height ?? 0).toBeGreaterThanOrEqual(44)

    await page.setViewportSize({ width: 1280, height: 800 })
    await expectCenteredNativeOauthState(page, {
      copy: "Opening sign-in in your browser…",
      role: "status",
      cancel: true,
      retryDisabled: true,
    })

    releasePrepare()
    await expectCenteredNativeOauthState(page, {
      copy: "Finish signing in in your browser.",
      role: "status",
      cancel: true,
      retryDisabled: false,
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await expectCenteredNativeOauthState(page, {
      copy: "Finish signing in in your browser.",
      role: "status",
      cancel: true,
      retryDisabled: false,
    })
    await browserExpect.poll(async () => (
      await page.getByRole("button", { name: "Try again" }).boundingBox()
    )?.height ?? 0).toBeGreaterThanOrEqual(44)

    failPrepare = true
    await page.getByRole("button", { name: "Try again" }).click()
    await expectCenteredNativeOauthState(page, {
      copy: "Couldn't open sign-in. Try again.",
      role: "alert",
      cancel: false,
      retryDisabled: false,
    })
    await browserExpect.poll(async () => (
      await page.getByRole("button", { name: "Try again" }).boundingBox()
    )?.height ?? 0).toBeGreaterThanOrEqual(44)

    await page.setViewportSize({ width: 1280, height: 800 })
    await expectCenteredNativeOauthState(page, {
      copy: "Couldn't open sign-in. Try again.",
      role: "alert",
      cancel: false,
      retryDisabled: false,
    })
  })
})
