import type { APIResponse, BrowserContext, BrowserContextOptions, Page, Response as PlaywrightResponse, TestInfo } from "@playwright/test"
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
  confirmSignedOut: (role: UserKey, evidence: SignedOutEvidence) => Promise<void>
  recordServerDeletion: (role: UserKey, serverId: string, evidence: ServerDeletionEvidence) => Promise<void>
}

export type SignedOutEvidence = { context: BrowserContext; page: Page; protectedResponse: APIResponse }
export type ServerDeletionEvidence = { page: Page; response: PlaywrightResponse }
export type OwnedCaseResource<T> = { readonly value: T; close: () => Promise<void> }
export type CaseResources = {
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>
  closeContext: (context: BrowserContext) => Promise<void>
  own: <T>(value: T, dispose: (value: T) => Promise<void>) => OwnedCaseResource<T>
}
type CaseExitOwner = {
  allocate: (roles: readonly UserKey[]) => Promise<CaseActors>
  resources: CaseResources
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
  unresolvedOperations: number
  pendingSessionRetirement: boolean
  errorCount: number
}

type ContextOwner = { role: UserKey | null; kind: "login" | "actor" | "anonymous"; ordinal: number }
type ServerDeletionProof = { request: string; status: 204; contextOrdinal: number; sessionFingerprint: string }
type OwnedServer = { owner: UserKey; deletion?: ServerDeletionProof }

const failurePath = resolve(AUTH_DIR, "case-cleanup-failure.json")

async function checkCleanupFailure(testInfo: TestInfo): Promise<void> {
  if (!existsSync(failurePath)) return
  const failure = JSON.parse(readFileSync(failurePath, "utf8")) as CleanupFailure
  testInfo.annotations.push({ type: "fixture-blocked", description: `Unresolved cleanup from ${failure.identity.testId}, worker ${failure.identity.workerIndex}` })
  await testInfo.attach("case-fixture-blocked", { body: JSON.stringify(failure), contentType: "application/json" })
  throw new Error(`Case fixture blocked by unresolved cleanup: ${failure.identity.testId}, worker ${failure.identity.workerIndex}`)
}

export const test = base.extend<{ caseActors: CaseExitOwner["allocate"]; caseResources: CaseResources; caseExitOwner: CaseExitOwner; caseCleanupGuard: void }>({
  serviceGuard: async ({ caseCleanupGuard, serviceGuard }, provide) => {
    void caseCleanupGuard
    await provide(serviceGuard)
  },
  caseCleanupGuard: [async ({ }, provide, testInfo) => {
    await checkCleanupFailure(testInfo)
    await provide()
  }, { auto: true }],
  caseActors: async ({ caseExitOwner }, provide) => { await provide(caseExitOwner.allocate) },
  caseResources: async ({ caseExitOwner }, provide) => { await provide(caseExitOwner.resources) },
  caseExitOwner: async ({ browser, caseCleanupGuard }, provide, testInfo) => {
    void caseCleanupGuard
    const users: Partial<Record<UserKey, SeededUser>> = {}
    const contexts = new Map<BrowserContext, ContextOwner>()
    const contextOutcomes: Array<ContextOwner & { closed: boolean }> = []
    let contextCount = 0
    const operations = new Set<OwnedCaseResource<unknown>>()
    let operationCount = 0
    const operationOutcomes: boolean[] = []
    const closingContexts = new Map<BrowserContext, Promise<void>>()
    const creatingContexts = new Set<Promise<BrowserContext>>()
    const closedContexts = new WeakSet<BrowserContext>()
    let exiting = false
    let pendingSessionRetirement = false
    const retiredSessions = new Map<UserKey, { fingerprint: string }>()
    const originalSessions = new Map<UserKey, string>()
    const businessRoles = new Set<UserKey>()
    const owned = new Map<string, OwnedServer>()
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
    const registerContext = (role: UserKey | null, kind: ContextOwner["kind"], context: BrowserContext) => {
      contexts.set(context, { role, kind, ordinal: contextCount++ })
    }
    const retireContext = (context: BrowserContext) => {
      const owner = contexts.get(context)
      if (owner) contextOutcomes.push({ ...owner, closed: true })
      contexts.delete(context)
      closedContexts.add(context)
    }
    const closeContext = async (context: BrowserContext): Promise<void> => {
      if (closedContexts.has(context)) return
      if (!contexts.has(context)) throw new Error("Context belongs to a different case owner")
      const pending = closingContexts.get(context)
      if (pending) return pending
      const closing = (async () => { await context.close(); retireContext(context) })()
      closingContexts.set(context, closing)
      try { await closing } finally { closingContexts.delete(context) }
    }
    const newContext = async (options: BrowserContextOptions | undefined, role: UserKey | null): Promise<BrowserContext> => {
      if (exiting) throw new Error("Case owner is exiting")
      const creation = (async () => {
        const context = await browser.newContext(options)
        registerContext(role, role === null ? "anonymous" : "actor", context)
        if (exiting) {
          await closeContext(context)
          throw new Error("Context creation completed after its case owner started exiting")
        }
        return context
      })()
      creatingContexts.add(creation)
      try { return await creation } finally { creatingContexts.delete(creation) }
    }
    const own = <T>(value: T, dispose: (value: T) => Promise<void>): OwnedCaseResource<T> => {
      if (exiting) throw new Error("Case owner is exiting")
      let closed = false
      let pending: Promise<void> | undefined
      const resource: OwnedCaseResource<T> = {
        value,
        close: async () => {
          if (closed) return
          if (pending) return pending
          pending = (async () => {
            await dispose(value)
            closed = true
            operations.delete(resource as OwnedCaseResource<unknown>)
            operationOutcomes.push(true)
          })()
          try { await pending } finally { pending = undefined }
        },
      }
      operations.add(resource as OwnedCaseResource<unknown>)
      operationCount += 1
      return resource
    }
    const caseResources: CaseResources = { newContext: (options) => newContext(options, null), closeContext, own }
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
    const originalSeed = createSeed({
      sessionCookie,
      userId: (key) => user(key).userId,
      users: () => users,
      assertResource: (kind, id) => {
        if (kind === "user" && Object.values(users).some((value) => value?.userId === id)) return
        if (!resources.has(`${kind}:${id}`)) throw new Error(`Foreign case resource: ${kind} ${id}`)
      },
      onResourceCreated: (kind, id) => { resources.add(`${kind}:${id}`) },
      onServerCreated: (owner, id) => { owned.set(id, { owner }) },
      onDmCreated: async (first, second, id) => {
        for (const key of [first, second]) {
          const body = await read(key, "/api/community/users/me/read-state")
          if (!Array.isArray(body.readStates)) throw new Error(`Case DM baseline ${key} has no read-state array`)
          const row = body.readStates.find((value: { channelId: string }) => value.channelId === id) as { lastReadSeq?: number } | undefined
          if ((row?.lastReadSeq ?? 0) !== 0) throw new Error(`Case DM handshake violates the original zero-cursor premise for ${key}`)
        }
      },
    })
    const seed = Object.fromEntries(Object.entries(originalSeed).map(([name, operation]) => [name, (...args: unknown[]) => {
      if (typeof args[0] === "string" && USER_KEYS.includes(args[0] as UserKey)) businessRoles.add(args[0] as UserKey)
      return (operation as (...values: unknown[]) => unknown)(...args)
    }])) as CaseSeed
    const recordServerDeletion = async (role: UserKey, serverId: string, evidence: ServerDeletionEvidence): Promise<void> => {
      user(role)
      const registration = owned.get(serverId)
      const contextOwner = contexts.get(evidence.page.context())
      if (exiting || !registration || registration.owner !== role || registration.deletion || contextOwner?.role !== role || contextOwner.kind !== "actor") throw new Error("Server deletion proof does not belong to this case actor and resource")
      const request = evidence.response.request()
      const target = `${WEB_URL}/api/community/servers/${serverId}`
      if (request.frame().page() !== evidence.page || request.method() !== "DELETE" || request.url() !== target || evidence.response.url() !== target || evidence.response.status() !== 204) throw new Error("Original server deletion request is not a matching successful DELETE")
      const headers = await request.allHeaders()
      const originalCookie = originalSessions.get(role)
      const sessionTokens = originalCookie?.split(";").map((value) => value.trim()).filter((value) => value.slice(0, value.indexOf("=")).endsWith(".session_token")) ?? []
      const requestCookies = headers.cookie?.split(";").map((value) => value.trim()) ?? []
      if (sessionTokens.length === 0 || !sessionTokens.every((token) => requestCookies.includes(token))) throw new Error("Original server deletion session proof is incomplete")
      const completion = await evidence.response.finished()
      if (completion !== null) throw completion
      if (exiting || owned.get(serverId) !== registration) throw new Error("Server deletion proof completed after its case owner started exiting")
      registration.deletion = { request: target, status: 204, contextOrdinal: contextOwner.ordinal, sessionFingerprint: createHash("sha256").update(sessionTokens.join(";")).digest("hex") }
    }
    const cleanupOwned = async (excluded: ReadonlySet<UserKey>): Promise<unknown[]> => {
      const errors: unknown[] = []
      const serverInventories = new Map<UserKey, Set<string>>()
      const creations = await Promise.allSettled([...creatingContexts])
      for (const result of creations) if (result.status === "rejected") errors.push(result.reason)
      for (const operation of [...operations].reverse()) {
        try { await operation.close() } catch (error) { operationOutcomes.push(false); errors.push(error) }
      }
      for (const [context, owner] of contexts) {
        try { await closeContext(context) } catch (error) { contextOutcomes.push({ ...owner, closed: false }); errors.push(error) }
      }
      for (const key of Object.keys(users) as UserKey[]) {
        if (excluded.has(key)) continue
        try {
          const listed = await read(key, "/api/community/servers")
          if (!Array.isArray(listed.servers) || listed.servers.some((value) => !value || typeof value.id !== "string" || value.id.length === 0 || typeof value.ownerId !== "string" || value.ownerId.length === 0)) throw new Error(`Case cleanup ${key} has no complete server list`)
          serverInventories.set(key, new Set((listed.servers as Array<{ id: string }>).map((server) => server.id)))
          for (const server of listed.servers as Array<{ id: string; ownerId: string }>) {
            if (server.ownerId === user(key).userId) {
              if (!owned.get(server.id)?.deletion) owned.set(server.id, { owner: key })
              resources.add(`server:${server.id}`)
            }
          }
        } catch (error) { errors.push(error) }
      }
      for (const [id, registration] of owned) {
        const { owner, deletion } = registration
        try {
          if (deletion) {
            const inventory = serverInventories.get(owner)
            if (!inventory || inventory.has(id)) throw new Error(`Product-deleted fixture server ${id} has no complete absence proof`)
          } else {
            await originalSeed.retireSeedServers(owner, [id])
          }
          owned.delete(id)
          serverOutcomes.push({ owner, id, retired: true, ...(deletion ? { deletion } : {}) })
        } catch (error) { serverOutcomes.push({ owner, id, retired: false }); errors.push(error) }
      }
      for (const key of Object.keys(users) as UserKey[]) {
        if (excluded.has(key)) continue
        try { await assertEmpty(key, "/api/community/servers", "servers") } catch (error) { errors.push(error) }
      }
      return errors
    }
    const serverOutcomes: Array<{ owner: UserKey; id: string; retired: boolean; deletion?: ServerDeletionProof }> = []
    const confirmSignedOut = async (role: UserKey, evidence: SignedOutEvidence): Promise<void> => {
      if (role !== "logout" || !testInfo.file.endsWith("10-eject-nav-auth.spec.ts")) throw new Error("Session retirement is restricted to the original logout journey")
      const actor = user(role)
      const cookie = originalSessions.get(role)
      const contextOwner = contexts.get(evidence.context)
      if (!cookie || contextOwner?.role !== role || contextOwner.kind !== "actor" || evidence.page.context() !== evidence.context) throw new Error("Sign-out evidence has a different case, role, context or original session")
      if (retiredSessions.has(role)) throw new Error("Original session retirement was already confirmed")
      const responseUrl = new URL(evidence.protectedResponse.url())
      const location = evidence.protectedResponse.headers().location
      const redirect = location ? new URL(location, WEB_URL) : undefined
      const pageUrl = new URL(evidence.page.url())
      if (responseUrl.origin !== WEB_URL || responseUrl.pathname !== "/c" || evidence.protectedResponse.status() !== 307 || redirect?.origin !== WEB_URL || redirect.pathname !== "/sign-in" || redirect.searchParams.get("redirect") !== "/c" || pageUrl.origin !== WEB_URL || pageUrl.pathname !== "/sign-in" || (await evidence.context.cookies()).some((value) => value.name.startsWith("better-auth"))) throw new Error("Original cookie and protected redirect sign-out proof is incomplete")
      if (businessRoles.has(role) || [...owned.values()].some((value) => value.owner === role)) throw new Error("Logout role has unresolved or unknown business resources")
      pendingSessionRetirement = true
      exiting = true
      const errors = await cleanupOwned(new Set([role]))
      if (errors.length || operations.size || contexts.size || owned.size) throw new AggregateError(errors, "Sign-out cannot retire a session with unresolved case resources")
      const response = await fetch(`${WEB_URL}/api/ws/token?refresh=1`, { headers: { Cookie: cookie, Origin: WEB_URL } })
      if (response.status !== 401 || response.headers.get("content-type") !== "text/plain;charset=UTF-8" || await response.text() !== "Unauthorized") throw new Error("Original session did not produce the authoritative normal empty-session response")
      const fingerprint = createHash("sha256").update(cookie).digest("hex")
      await testInfo.attach("case-session-retirement", { body: JSON.stringify({ identity, role, userId: actor.userId, fingerprint, request: "/api/ws/token?refresh=1", status: 401, normalEmptySession: true, unresolvedOperations: operations.size, unresolvedContexts: contexts.size, unresolvedServers: owned.size }), contentType: "application/json" })
      retiredSessions.set(role, { fingerprint })
      pendingSessionRetirement = false
    }
    let bodyError: unknown
    let bodyFailed = false
    try {
      const allocate: CaseExitOwner["allocate"] = async (roles) => {
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
          originalSessions.set(key, sessionCookie(key))
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
            const context = await newContext({ ...options, storageState: user(key).storageState }, key)
            const page = await context.newPage()
            return { context, page }
          },
          userId: (key) => user(key).userId,
          userName: (key) => user(key).name,
          sessionCookie,
          seed,
          onCleanup: (operation) => { own(operation, async (captured) => { await captured() }) },
          confirmSignedOut,
          recordServerDeletion,
        }
      }
      await provide({ allocate, resources: caseResources })
    } catch (error) {
      bodyError = error
      bodyFailed = true
    } finally {
      exiting = true
      const errors = await cleanupOwned(new Set(retiredSessions.keys()))
      if (pendingSessionRetirement) errors.push(new Error("Original session retirement remains unresolved"))
      const outcomes = { operations: operationOutcomes, contexts: contextOutcomes, servers: serverOutcomes }
      try {
        await testInfo.attach("case-cleanup", { body: JSON.stringify({ identity, requestedContexts: contextCount, requestedOperations: operationCount, outcomes }), contentType: "application/json" })
      } catch (error) { errors.push(error) }
      const failure: CleanupFailure = { identity, unresolvedServers: [...owned].map(([id, value]) => ({ owner: value.owner, id })), unresolvedContexts: [...contexts.values()], unresolvedOperations: operations.size, pendingSessionRetirement, errorCount: errors.length }
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
