import { test as base, type BrowserContext, type Page } from "@playwright/test"
import { readFileSync } from "fs"
import { resolve } from "path"
import {
  AUTH_DIR,
  SERVICE_FAILURE_CLAIM_PATH,
  SERVICE_STATE_PATH,
} from "../_setup/paths"
import { claimServiceFailure, type FailureDecision } from "../_setup/service-lifecycle"
import { manifest } from "./manifest"
import type { UserKey } from "../_setup/users"

// Per-user authenticated context factory. A journey calls `asUser("bob")` to
// get Bob's own browser context + page (separate from Alice's) so multi-user
// realtime journeys can drive two or three sessions at once.
type AsUser = (key: UserKey) => Promise<{ context: BrowserContext; page: Page }>

function throwOrSkipFailure(
  decision: FailureDecision,
  skip: (condition: boolean, description: string) => void,
): void {
  if (decision.action === "report") throw new Error(decision.message)
  if (decision.action === "skip") skip(true, `${decision.message}; already reported by an earlier test`)
}

export const test = base.extend<{ asUser: AsUser; serviceGuard: void }>({
  serviceGuard: [async ({}, provide, testInfo) => {
    throwOrSkipFailure(
      claimServiceFailure(SERVICE_STATE_PATH, SERVICE_FAILURE_CLAIM_PATH),
      testInfo.skip.bind(testInfo),
    )
    let timer: ReturnType<typeof setInterval> | undefined
    const failure = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        const decision = claimServiceFailure(SERVICE_STATE_PATH, SERVICE_FAILURE_CLAIM_PATH)
        if (decision.action === "report") reject(new Error(decision.message))
      }, 100)
    })
    try {
      await Promise.race([provide(), failure])
    } finally {
      if (timer) clearInterval(timer)
    }
    throwOrSkipFailure(
      claimServiceFailure(SERVICE_STATE_PATH, SERVICE_FAILURE_CLAIM_PATH),
      testInfo.skip.bind(testInfo),
    )
  }, { auto: true }],
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
    await Promise.all(opened.map((context) => context.close()))
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
