import type { Browser, Page } from "@playwright/test"
import { WEB_URL } from "./paths"
import { emailFor, type SeededUser, type UserKey } from "./users"

async function signIn(page: Page, email: string): Promise<void> {
  const attempts = [`${WEB_URL}/c`, `${WEB_URL}/sign-in?redirect=/c`]
  let lastError: unknown

  for (const url of attempts) {
    await page.goto(url, { waitUntil: "load" })
    try {
      const emailInput = page.getByRole("textbox", { name: "Email" })
      await emailInput.waitFor({ state: "visible", timeout: 15_000 })
      await emailInput.fill(email)
      await page.getByRole("button", { name: "Sign in", exact: true }).click()
      await page.waitForURL((current) => !current.pathname.startsWith("/sign-in"), {
        timeout: 15_000,
        waitUntil: "commit",
      })
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

// Drives the real dev sign-in UI: navigating to /c first makes
// middleware redirect to /sign-in?redirect=/c, so post-login lands
// back in community (the default is /c/me otherwise). In dev the form
// is email-only — `handleDevSignIn` signs in with DEV_PASSWORD and
// auto-registers on first use. Captures storageState + the seeded userId.
export async function loginAndSaveState(
  browser: Browser,
  key: UserKey,
  stamp: string,
  storageStatePath: string,
): Promise<SeededUser> {
  const email = emailFor(key, stamp)
  // Dev sign-up derives the display name from the email local-part
  // (`handleDevSignIn`: `name: email.split("@")[0]`), so mirror that here.
  const name = email.split("@")[0]
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await signIn(page, email)

    // Resolve the seeded userId via the authenticated community profile API,
    // reusing the session cookie the login just established.
    const meRes = await context.request.get(`${WEB_URL}/api/ws/token`)
    if (!meRes.ok()) {
      throw new Error(`ws/token failed for ${key} (${meRes.status()})`)
    }
    const me = (await meRes.json()) as { userId: string }

    await context.clearCookies({ name: /^(?:is_new_signup|is_sign_in)$/ })
    await context.storageState({ path: storageStatePath })
    return { key, email, name, userId: me.userId, storageState: storageStatePath }
  } finally {
    await context.close()
  }
}
