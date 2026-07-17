import { chromium } from "@playwright/test"
import { WEB_URL } from "./paths"
import { emailFor, type SeededUser, type UserKey } from "./users"

// Drives the real dev sign-in UI: navigating to /c first makes
// middleware redirect to /sign-in?redirect=/c, so post-login lands
// back in community (default is /workspaces?auto otherwise). In dev the form
// is email-only — `handleDevSignIn` signs in with DEV_PASSWORD and
// auto-registers on first use. Captures storageState + the seeded userId.
export async function loginAndSaveState(
  key: UserKey,
  stamp: string,
  storageStatePath: string,
): Promise<SeededUser> {
  const email = emailFor(key, stamp)
  // Dev sign-up derives the display name from the email local-part
  // (`handleDevSignIn`: `name: email.split("@")[0]`), so mirror that here.
  const name = email.split("@")[0]
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(`${WEB_URL}/c`)
    await page.waitForURL(/\/sign-in/, { timeout: 30_000 })

    await page.getByRole("textbox", { name: "Email" }).fill(email)
    await page.getByRole("button", { name: "Sign in", exact: true }).click()

    // Land somewhere authenticated — community shell or the default workspace.
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
      timeout: 30_000,
    })

    // Resolve the seeded userId via the authenticated community profile API,
    // reusing the session cookie the login just established.
    const meRes = await context.request.get(`${WEB_URL}/api/ws/token`)
    if (!meRes.ok()) {
      throw new Error(`ws/token failed for ${key} (${meRes.status()})`)
    }
    const me = (await meRes.json()) as { userId: string }

    await context.storageState({ path: storageStatePath })
    return { key, email, name, userId: me.userId, storageState: storageStatePath }
  } finally {
    await browser.close()
  }
}
