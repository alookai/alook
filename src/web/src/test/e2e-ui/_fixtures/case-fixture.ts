import type { BrowserContext, BrowserContextOptions, Page, TestInfo } from "@playwright/test"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { loginAndSaveState } from "../_setup/auth"
import { AUTH_DIR, SERVICE_STATE_PATH, WEB_URL } from "../_setup/paths"
import { readLifecycleState } from "../_setup/service-lifecycle"
import { USER_KEYS, type SeededUser, type UserKey } from "../_setup/users"
import { test as base } from "./community-fixture"
import { manifest } from "./manifest"
import { createSeed, type CaseSeed } from "./seed"
import { retrySeedRequest } from "./seed-retry"

export type CaseActors = {
  asUser: (key: UserKey, options?: Omit<BrowserContextOptions, "storageState">) => Promise<{ context: BrowserContext; page: Page }>
  userId: (key: UserKey) => string
  userName: (key: UserKey) => string
  sessionCookie: (key: UserKey) => string
  seed: CaseSeed
  onCleanup: (operation: () => Promise<unknown>) => void
}

type CaseIdentity = {
  stamp: string
  testId: string
  file: string
  project: string
  workerIndex: number
  parallelIndex: number
}

type CleanupFailure = {
  identity: CaseIdentity
  unresolvedServers: Array<{ owner: UserKey; id: string }>
  unresolvedContexts: ContextOwner[]
  errorCount: number
}

type ContextOwner = { role: UserKey; kind: "login" | "actor"; ordinal: number }

const failurePath = resolve(AUTH_DIR, "case-cleanup-failure.json")

async function checkCleanupFailure(testInfo: TestInfo): Promise<void> {
  if (!existsSync(failurePath)) return
  const failure = JSON.parse(readFileSync(failurePath, "utf8")) as CleanupFailure
  testInfo.annotations.push({ type: "fixture-blocked", description: `Unresolved cleanup from ${failure.identity.testId}, worker ${failure.identity.workerIndex}` })
  await testInfo.attach("case-fixture-blocked", { body: JSON.stringify(failure), contentType: "application/json" })
  throw new Error(`Case fixture blocked by unresolved cleanup: ${failure.identity.testId}, worker ${failure.identity.workerIndex}`)
}

export const test = base.extend<{ caseActors: (roles: readonly UserKey[]) => Promise<CaseActors>; caseCleanupGuard: void }>({
  serviceGuard: async ({ caseCleanupGuard, serviceGuard }, provide) => {
    void caseCleanupGuard
    await provide(serviceGuard)
  },
  caseCleanupGuard: [async ({}, provide, testInfo) => {
    await checkCleanupFailure(testInfo)
    await provide()
  }, { auto: true }],
  caseActors: async ({ browser, caseCleanupGuard }, provide, testInfo) => {
    void caseCleanupGuard
    const users: Partial<Record<UserKey, SeededUser>> = {}
    const contexts = new Map<BrowserContext, ContextOwner>()
    const contextOutcomes: Array<ContextOwner & { closed: boolean }> = []
    let contextCount = 0
    const cleanup: Array<() => Promise<unknown>> = []
    const owned = new Map<string, UserKey>()
    const resources = new Set<string>()
    let allocated = false
    const identity: CaseIdentity = {
      stamp: manifest().stamp,
      testId: testInfo.testId,
      file: testInfo.file,
      project: testInfo.project.name,
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
    }
    const shardPath = resolve(AUTH_DIR, "../../../../e2e-shard-manifest/shard-manifest.json")
    const shard = existsSync(shardPath) ? readFileSync(shardPath, "utf8") : "local"
    const stamp = createHash("sha256").update(JSON.stringify(identity)).update(shard).digest("hex").slice(0, 24)
    const directory = resolve(AUTH_DIR, "cases", stamp)
    const user = (key: UserKey): SeededUser => {
      const value = users[key]
      if (!value) throw new Error(`Undeclared case actor: ${key}`)
      return value
    }
    const registerContext = (role: UserKey, kind: ContextOwner["kind"], context: BrowserContext) => {
      contexts.set(context, { role, kind, ordinal: contextCount++ })
    }
    const retireContext = (context: BrowserContext) => {
      const owner = contexts.get(context)
      if (owner) contextOutcomes.push({ ...owner, closed: true })
      contexts.delete(context)
    }
    const sessionCookie = (key: UserKey): string => {
      const state = JSON.parse(readFileSync(user(key).storageState, "utf8")) as { cookies: Array<{ name: string; value: string }> }
      return state.cookies.filter((cookie) => cookie.name.startsWith("better-auth")).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
    }
    const read = async (key: UserKey, path: string): Promise<Record<string, unknown>> => {
      const response = await retrySeedRequest(() => fetch(`${WEB_URL}${path}`, { headers: { Cookie: sessionCookie(key), Origin: WEB_URL } }))
      if (!response.ok) throw new Error(`Case baseline ${key} GET ${path} failed (${response.status})`)
      const body = await response.json() as Record<string, unknown>
      if (!body || typeof body !== "object" || body.stale === true || body.truncated === true) throw new Error(`Case baseline ${key} GET ${path} is incomplete`)
      return body
    }
    const assertEmpty = async (key: UserKey, path: string, field: string) => {
      const body = await read(key, path)
      if (!Array.isArray(body[field]) || body[field].length !== 0) throw new Error(`Case baseline ${key} ${field} must be empty`)
    }
    const seed = createSeed({
      sessionCookie,
      userId: (key) => user(key).userId,
      users: () => users,
      assertResource: (kind, id) => {
        if (kind === "user" && Object.values(users).some((value) => value?.userId === id)) return
        if (!resources.has(`${kind}:${id}`)) throw new Error(`Foreign case resource: ${kind} ${id}`)
      },
      onResourceCreated: (kind, id) => { resources.add(`${kind}:${id}`) },
      onServerCreated: (owner, id) => { owned.set(id, owner) },
      onDmCreated: async (first, second, id) => {
        for (const key of [first, second]) {
          const body = await read(key, "/api/community/users/me/read-state")
          if (!Array.isArray(body.readStates)) throw new Error(`Case DM baseline ${key} has no read-state array`)
          const row = body.readStates.find((value: { channelId: string }) => value.channelId === id) as { lastReadSeq?: number } | undefined
          if ((row?.lastReadSeq ?? 0) !== 0) throw new Error(`Case DM handshake violates the original zero-cursor premise for ${key}`)
        }
      },
    })
    let bodyError: unknown
    let bodyFailed = false
    try {
      await provide(async (roles) => {
        if (allocated) throw new Error("A test must allocate its case actors once and reuse them for all devices")
        allocated = true
        const state = readLifecycleState(SERVICE_STATE_PATH)
        if (state?.status !== "healthy" || state.services.length === 0) throw new Error("Case actors require this run's managed test database; the current stack is not owned")
        if (roles.length === 0 || new Set(roles).size !== roles.length || roles.some((key) => !USER_KEYS.includes(key))) throw new Error("Case actors require a nonempty unique role list")
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        for (const key of roles) {
          users[key] = await loginAndSaveState(browser, key, stamp, resolve(directory, `${key}.json`), {
            created: (context) => registerContext(key, "login", context),
            closed: retireContext,
          })
          const profile = await read(key, "/api/community/users/me/profile")
          if (profile.id !== user(key).userId || profile.name !== user(key).name) throw new Error(`Case baseline ${key} has a different profile identity`)
          if (profile.aboutMe !== "" || profile.avatarVersion !== 0 || profile.bannerColor !== null || profile.statusEmoji !== null || profile.statusText !== "") throw new Error(`Case baseline ${key} has modified profile defaults`)
          await Promise.all([
            assertEmpty(key, "/api/community/servers", "servers"),
            assertEmpty(key, "/api/community/users/me/server-folders", "folders"),
            assertEmpty(key, "/api/community/users/me/dms", "conversations"),
            assertEmpty(key, "/api/community/users/me/read-state", "readStates"),
            assertEmpty(key, "/api/community/users/me/marks", "marked"),
            assertEmpty(key, "/api/community/friends/accepted", "friends"),
            assertEmpty(key, "/api/community/friends/pending", "pending"),
            assertEmpty(key, "/api/community/friends/blocked", "blocked"),
            assertEmpty(key, "/api/community/users/me/attention", "scopes"),
            assertEmpty(key, "/api/community/users/me/attention", "items"),
          ])
        }
        await testInfo.attach("case-actor-ownership", { body: JSON.stringify({ identity, actors: roles.map((key) => ({ key, userId: user(key).userId })) }), contentType: "application/json" })
        return {
          asUser: async (key, options) => {
            const context = await browser.newContext({ ...options, storageState: user(key).storageState })
            registerContext(key, "actor", context)
            const page = await context.newPage()
            return { context, page }
          },
          userId: (key) => user(key).userId,
          userName: (key) => user(key).name,
          sessionCookie,
          seed,
          onCleanup: (operation) => { cleanup.push(operation) },
        }
      })
    } catch (error) {
      bodyError = error
      bodyFailed = true
    } finally {
      const errors: unknown[] = []
      const outcomes = { operations: [] as boolean[], contexts: contextOutcomes, servers: [] as Array<{ owner: UserKey; id: string; retired: boolean }> }
      for (const operation of cleanup.reverse()) {
        try { await operation(); outcomes.operations.push(true) } catch (error) { outcomes.operations.push(false); errors.push(error) }
      }
      for (const [context, owner] of contexts) {
        try { await context.close(); retireContext(context) } catch (error) { outcomes.contexts.push({ ...owner, closed: false }); errors.push(error) }
      }
      for (const key of Object.keys(users) as UserKey[]) {
        try {
          const listed = await read(key, "/api/community/servers")
          if (!Array.isArray(listed.servers)) throw new Error(`Case cleanup ${key} has no server list`)
          for (const server of listed.servers as Array<{ id: string; ownerId: string }>) {
            if (server.ownerId === user(key).userId) {
              owned.set(server.id, key)
              resources.add(`server:${server.id}`)
            }
          }
        } catch (error) { errors.push(error) }
      }
      for (const [id, owner] of owned) {
        try {
          await seed.retireSeedServers(owner, [id])
          owned.delete(id)
          outcomes.servers.push({ owner, id, retired: true })
        } catch (error) { outcomes.servers.push({ owner, id, retired: false }); errors.push(error) }
      }
      for (const key of Object.keys(users) as UserKey[]) {
        try { await assertEmpty(key, "/api/community/servers", "servers") } catch (error) { errors.push(error) }
      }
      try {
        await testInfo.attach("case-cleanup", { body: JSON.stringify({ identity, requestedContexts: contextCount, requestedOperations: cleanup.length, outcomes }), contentType: "application/json" })
      } catch (error) { errors.push(error) }
      const failure: CleanupFailure = { identity, unresolvedServers: [...owned].map(([id, owner]) => ({ owner, id })), unresolvedContexts: [...contexts.values()], errorCount: errors.length }
      if (errors.length > 0) {
        try {
          if (!existsSync(failurePath)) writeFileSync(failurePath, JSON.stringify(failure), { flag: "wx", mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") errors.push(error)
        }
        try { await testInfo.attach("case-cleanup-failure", { body: JSON.stringify(failure), contentType: "application/json" }) } catch (error) { errors.push(error) }
        throw new AggregateError(bodyFailed ? [bodyError, ...errors] : errors, "Case cleanup failed; successor fixtures are blocked")
      }
    }
    if (bodyFailed) throw bodyError
  },
})

export const expect = test.expect
