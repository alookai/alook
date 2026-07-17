import { test as base, type BrowserContext, type Page } from "@playwright/test"
import { readFileSync } from "fs"
import { resolve } from "path"
import { AUTH_DIR } from "../_setup/paths"
import { manifest } from "./manifest"
import type { UserKey } from "../_setup/users"

// Per-user authenticated context factory. A journey calls `asUser("bob")` to
// get Bob's own browser context + page (separate from Alice's) so multi-user
// realtime journeys can drive two or three sessions at once.
type AsUser = (key: UserKey) => Promise<{ context: BrowserContext; page: Page }>

export const test = base.extend<{ asUser: AsUser }>({
  asUser: async ({ browser }, provide) => {
    const opened: BrowserContext[] = []
    const factory: AsUser = async (key) => {
      const statePath = resolve(AUTH_DIR, `${key}.json`)
      const context = await browser.newContext({ storageState: statePath })
      opened.push(context)
      const page = await context.newPage()
      return { context, page }
    }
    await provide(factory)
    for (const c of opened) await c.close()
  },
})

export const expect = test.expect

export function userId(key: UserKey): string {
  return manifest().users[key].userId
}

export function userName(key: UserKey): string {
  return manifest().users[key].name
}

// Extract the better-auth session cookie string ("name=value") from a saved
// storageState, for API-driven precondition seeding via test-utils helpers.
export function sessionCookie(key: UserKey): string {
  const statePath = resolve(AUTH_DIR, `${key}.json`)
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    cookies: Array<{ name: string; value: string }>
  }
  return state.cookies
    .filter((c) => c.name.startsWith("better-auth"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ")
}
