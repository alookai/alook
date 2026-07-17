import { test, expect } from "./_fixtures/community-fixture"

// Journey 1 — login & first screen. storageState is established in
// global-setup, so this journey re-verifies the redirect/auth contract with a
// FRESH context (no saved session) plus an authenticated landing.
test.describe.serial("auth & first screen", () => {
  test("unauthenticated /c deep-link redirects to /sign-in with redirect param", async ({ browser }) => {
    const context = await browser.newContext() // no storageState — anonymous
    const page = await context.newPage()
    await page.goto("/c/channels/does-not-matter/whatever")
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 })
    expect(page.url()).toContain("redirect=")
    await context.close()
  })

  test("authenticated user reaches the community shell", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto("/c")
    // Not bounced to sign-in.
    await expect(page).not.toHaveURL(/\/sign-in/)
    await page.waitForURL(/\/c/, { timeout: 20_000 })
  })
})
