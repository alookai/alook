import {
  test as base,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from "@playwright/test"
import { createHash } from "crypto"
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
type AsUser = (
  key: UserKey,
  options?: Omit<BrowserContextOptions, "storageState">,
) => Promise<{ context: BrowserContext; page: Page }>

type CommunityDbProbeTimeline = {
  dropped: number
  events: unknown[]
  registryId: string
  runId: string
}

function lifecycleRunId(testInfo: TestInfo): string {
  const digest = createHash("sha256")
    .update(`${testInfo.testId}:${testInfo.retry}`)
    .digest("hex")
    .slice(0, 20)
  return `run-${testInfo.workerIndex}-${testInfo.retry}-${digest}`
}

async function enableCommunityDbLifecycleTrace(
  target: Pick<BrowserContext, "addInitScript"> | Pick<Page, "addInitScript">,
  runId: string,
): Promise<void> {
  await target.addInitScript((id) => {
    Reflect.set(globalThis, "__ALOOK_COMMUNITY_DB_TRACE_RUN_ID__", id)
    Reflect.set(globalThis, "__ALOOK_COMMUNITY_DB_TRACE_SEQUENCE__", 0)
    Reflect.set(globalThis, "__ALOOK_COMMUNITY_DB_TRACE_REGISTRY_SEQUENCE__", 0)
    Reflect.deleteProperty(globalThis, "__ALOOK_COMMUNITY_DB_TRACE_STORE__")
  }, runId)
}

async function attachCommunityDbLifecycleTrace(
  page: Page,
  testInfo: TestInfo,
  label: string,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return
  const timeline = await page.evaluate(() => {
    const probe = Reflect.get(globalThis, "__ALOOK_COMMUNITY_DB_PROBE__") as undefined | {
      timeline: () => CommunityDbProbeTimeline | null
    }
    return probe?.timeline() ?? null
  }).catch(() => null)
  await testInfo.attach(`community-db-lifecycle-${label}.json`, {
    body: JSON.stringify({ timeline }, null, 2),
    contentType: "application/json",
  })
}

function throwOrSkipFailure(
  decision: FailureDecision,
  skip: (condition: boolean, description: string) => void,
): void {
  if (decision.action === "report") throw new Error(decision.message)
  if (decision.action === "skip") skip(true, `${decision.message}; already reported by an earlier test`)
}

export const test = base.extend<{ asUser: AsUser; serviceGuard: void }>({
  page: async ({ page }, provide, testInfo) => {
    await enableCommunityDbLifecycleTrace(page, lifecycleRunId(testInfo))
    try {
      await provide(page)
    } finally {
      await attachCommunityDbLifecycleTrace(page, testInfo, "default")
    }
  },
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
  asUser: async ({ browser }, provide, testInfo) => {
    const opened: BrowserContext[] = []
    const pages: Page[] = []
    const runId = lifecycleRunId(testInfo)
    const factory: AsUser = async (key, options) => {
      const statePath = resolve(AUTH_DIR, `${key}.json`)
      const context = await browser.newContext({ ...options, storageState: statePath })
      opened.push(context)
      await enableCommunityDbLifecycleTrace(context, runId)
      const page = await context.newPage()
      pages.push(page)
      return { context, page }
    }
    try {
      await provide(factory)
    } finally {
      await Promise.all(pages.map((page, index) => (
        attachCommunityDbLifecycleTrace(page, testInfo, `as-user-${index + 1}`)
      )))
      await Promise.all(opened.map((context) => context.close()))
    }
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
