import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Browser, BrowserContext, Page, TestFixture, TestInfo } from "@playwright/test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { test as caseTest, type CaseActors } from "./e2e-ui/_fixtures/case-fixture"
import { cleanupGeometryServers, seedGeometryRoutes } from "./e2e-ui/_fixtures/community-loading-geometry"
import { seedChannel, seedDm, seedForumThread, seedMessage, seedServer, seedThread } from "./e2e-ui/_fixtures/seed"
import * as legacySeed from "./e2e-ui/_fixtures/seed"

type CaseFactory = (roles: readonly ("alice" | "bob" | "carol")[]) => Promise<CaseActors>
type Registration = {
  caseActors: TestFixture<CaseFactory, { browser: Browser; caseCleanupGuard: void }>
  caseCleanupGuard: [TestFixture<void, Record<string, never>>, { auto: true }]
}

const fixture = vi.hoisted(() => ({
  directory: `/tmp/alook-case-fixture-unit-${process.pid}`,
  registration: undefined as Registration | undefined,
  login: vi.fn(),
}))

vi.mock("./e2e-ui/_fixtures/community-fixture", () => ({
  test: { extend: (registration: Registration) => {
    fixture.registration = registration
    return { expect: {} }
  } },
  expect: {},
  sessionCookie: (key: string) => `fixture-user=${key}`,
  userId: (key: string) => `user-${key}`,
}))

vi.mock("./e2e-ui/_setup/auth", () => ({ loginAndSaveState: fixture.login }))
vi.mock("./e2e-ui/_setup/paths", () => ({
  AUTH_DIR: fixture.directory,
  SERVICE_STATE_PATH: `${fixture.directory}/service-state.json`,
  MANIFEST_PATH: `${fixture.directory}/manifest.json`,
  WEB_URL: "http://fixture.test",
}))
vi.mock("./e2e-ui/_fixtures/seed-retry", async (importOriginal) => ({
  ...await importOriginal<typeof import("./e2e-ui/_fixtures/seed-retry")>(),
  retrySeedRequest: (request: () => Promise<Response>) => request(),
}))

vi.mock("./e2e-ui/_fixtures/seed", async (importOriginal) => ({
  ...await importOriginal<typeof import("./e2e-ui/_fixtures/seed")>(),
  seedServer: vi.fn(),
  seedChannel: vi.fn(),
  seedDm: vi.fn(),
  seedForumThread: vi.fn(),
  seedMessage: vi.fn(),
  seedThread: vi.fn(),
}))

describe("geometry fixture backend resource isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(seedChannel).mockResolvedValue("channel")
    vi.mocked(seedDm).mockResolvedValue("dm")
    vi.mocked(seedForumThread).mockResolvedValue("forum-post")
    vi.mocked(seedMessage).mockResolvedValue("message")
    vi.mocked(seedThread).mockResolvedValue("thread")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("retires only this fixture's twenty servers after the journey", async () => {
    const owned: string[] = []
    let nextId = 0
    vi.mocked(seedServer).mockImplementation(async () => `owned-${++nextId}`)
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", request)

    const routes = await seedGeometryRoutes(owned, legacySeed, (key) => `user-${key}`)
    await cleanupGeometryServers(owned, legacySeed)

    expect(routes).toHaveLength(9)
    expect(owned).toEqual(Array.from({ length: 20 }, (_, index) => `owned-${index + 1}`))
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(
      owned.map((id) => `/api/community/servers/${id}`),
    )
    expect(request.mock.calls.every(([, options]) => options.method === "DELETE"
      && options.headers.Cookie === "fixture-user=dave")).toBe(true)
  })

  it("keeps successful IDs available for teardown when later seeding fails", async () => {
    const owned: string[] = []
    vi.mocked(seedServer)
      .mockResolvedValueOnce("owned-first")
      .mockResolvedValueOnce("owned-second")
      .mockRejectedValueOnce(new Error("seed failed"))
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", request)

    await expect(seedGeometryRoutes(owned, legacySeed, (key) => `user-${key}`)).rejects.toThrow("seed failed")
    await cleanupGeometryServers(owned, legacySeed)

    expect(owned).toEqual(["owned-first", "owned-second"])
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/community/servers/owned-first",
      "/api/community/servers/owned-second",
    ])
  })

  it("attempts every owned ID and reports cleanup errors without treating 404 as failure", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockRejectedValueOnce(new Error("connection failed"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", request)

    const error = await cleanupGeometryServers(["failed", "disconnected", "already-gone", "remaining"], legacySeed)
      .catch((failure: AggregateError) => failure)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/community/servers/failed",
      "/api/community/servers/disconnected",
      "/api/community/servers/already-gone",
      "/api/community/servers/remaining",
    ])
  })
})

describe("test-scoped case actors and cleanup", () => {
  const actors = new Map<string, { key: string; userId: string; name: string }>()
  const servers = new Map<string, { id: string; ownerId: string }>()
  const deniedDeletes = new Set<string>()
  let nextServer = 0
  let dmCursor = 0
  let dmCreated = false
  let baselineFault: "stale" | "truncated" | "error" | "malformed" | "profile" | undefined
  let loseServerResponse = false
  let closeError: Error | undefined
  const closed: Array<{ isClosed: () => boolean }> = []

  const info = (testId: string, workerIndex = 0): TestInfo => ({
    testId,
    workerIndex,
    parallelIndex: 0,
    project: { name: "chromium" },
    annotations: [],
    attach: vi.fn(async () => undefined),
  }) as unknown as TestInfo

  const browser = (): Browser => ({
    newContext: vi.fn(async () => {
      let isClosed = false
      const page = { isClosed: () => isClosed } as Page
      const context = {
        newPage: async () => page,
        close: vi.fn(async () => {
          isClosed = true
          if (closeError) throw closeError
        }),
      }
      closed.push(page)
      return context
    }),
  }) as unknown as Browser

  const run = (testInfo: TestInfo, use: (factory: CaseFactory) => Promise<void>, currentBrowser = browser()) => {
    expect(caseTest).toBeDefined()
    return fixture.registration!.caseActors({ browser: currentBrowser, caseCleanupGuard: undefined }, use, testInfo)
  }

  beforeEach(() => {
    vi.resetAllMocks()
    actors.clear()
    servers.clear()
    deniedDeletes.clear()
    closed.length = 0
    nextServer = 0
    dmCursor = 0
    dmCreated = false
    baselineFault = undefined
    loseServerResponse = false
    closeError = undefined
    rmSync(fixture.directory, { force: true, recursive: true })
    mkdirSync(fixture.directory, { recursive: true })
    writeFileSync(resolve(fixture.directory, "manifest.json"), JSON.stringify({ stamp: "case-fixture-run", users: {} }))
    writeFileSync(resolve(fixture.directory, "service-state.json"), JSON.stringify({ status: "healthy", services: [{ name: "web" }], restorePending: false }))
    fixture.login.mockImplementation(async (_browser, key: string, stamp: string, storageState: string) => {
      const token = `${key}-${stamp}`
      const value = { key, userId: token, name: `e2e-${token}` }
      actors.set(token, value)
      writeFileSync(storageState, JSON.stringify({ cookies: [{ name: "better-auth.session_token", value: token }] }))
      return { ...value, email: `${value.name}@alook.test`, storageState }
    })
    vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
      const path = new URL(input).pathname
      const cookie = (options?.headers as Record<string, string>).Cookie
      const actor = actors.get(cookie.split("=")[1])!
      if (options?.method === "DELETE") {
        const id = path.split("/").at(-1)!
        if (deniedDeletes.has(id)) return new Response("{}", { status: 500 })
        const found = servers.get(id)
        if (found && found.ownerId !== actor.userId) return new Response("{}", { status: 403 })
        servers.delete(id)
        return new Response(null, { status: found ? 204 : 404 })
      }
      if (options?.method === "POST") {
        if (path === "/api/community/servers") {
          const server = { id: `owned-${++nextServer}`, ownerId: actor.userId }
          servers.set(server.id, server)
          if (loseServerResponse) return new Response("invalid server JSON")
          return Response.json({ server })
        }
        if (path === "/api/community/channels") {
          dmCreated = true
          return Response.json({ conversation: { id: "case-dm" } })
        }
        if (path.endsWith("/friends/request")) return Response.json({ id: "case-friendship" })
        return Response.json({})
      }
      if (path.endsWith("/profile")) return Response.json({ id: actor.userId, name: actor.name, aboutMe: baselineFault === "profile" ? "old account profile" : "", avatarVersion: 0, bannerColor: null, statusEmoji: null, statusText: "" })
      if (path === "/api/community/servers") return Response.json({ servers: [...servers.values()].filter((server) => server.ownerId === actor.userId) })
      if (path.endsWith("/read-state")) return Response.json({ readStates: dmCreated ? [{ channelId: "case-dm", lastReadSeq: dmCursor }] : [] })
      if (path.endsWith("/attention")) {
        if (baselineFault === "error") return Response.json({ error: "Unavailable" }, { status: 503 })
        if (baselineFault === "malformed") return Response.json({ scopes: null, items: [] })
        return Response.json({ scopes: [], items: [], stale: baselineFault === "stale", truncated: baselineFault === "truncated" })
      }
      const field = path.endsWith("/dms") ? "conversations" : path.endsWith("/server-folders") ? "folders" : path.endsWith("/marks") ? "marked" : path.endsWith("/accepted") ? "friends" : path.endsWith("/pending") ? "pending" : "blocked"
      return Response.json({ [field]: [] })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(fixture.directory, { force: true, recursive: true })
  })

  it("uses one private actor across devices but new identities for the next case", async () => {
    const currentBrowser = browser()
    let first = ""
    await run(info("first"), async (create) => {
      const users = await create(["alice", "bob"])
      first = users.userId("alice")
      await users.asUser("alice")
      await users.asUser("alice")
      await users.asUser("bob")
      await users.seed.seedServer("alice", "owned")
      const requests = vi.mocked(fetch).mock.calls.length
      await expect(users.seed.seedChannel("alice", "previous-case-server", "foreign")).rejects.toThrow("Foreign case resource")
      await expect(users.seed.seedMessage("alice", "previous-case-channel", "foreign")).rejects.toThrow("Foreign case resource")
      await expect(users.seed.seedDm("alice", "previous-case-user")).rejects.toThrow("unknown fixture user")
      expect(vi.mocked(fetch).mock.calls).toHaveLength(requests)
      await expect(users.asUser("carol")).rejects.toThrow("Undeclared")
      await expect(users.seed.seedServer("carol", "foreign")).rejects.toThrow("Undeclared")
    }, currentBrowser)
    const states = vi.mocked(currentBrowser.newContext).mock.calls.map(([options]) => options?.storageState)
    expect(states[0]).toBe(states[1])
    expect(states[2]).not.toBe(states[0])
    expect(closed.every((page) => page.isClosed())).toBe(true)
    expect(servers.size).toBe(0)
    await run(info("second"), async (create) => {
      const users = await create(["alice"])
      expect(users.userId("alice")).not.toBe(first)
    })
  })

  it("keeps the original body failure while retiring successful partial seeds", async () => {
    const original = new Error("first assertion failed")
    await expect(run(info("partial"), async (create) => {
      const users = await create(["alice"])
      await users.asUser("alice")
      await users.seed.seedServer("alice", "first")
      await users.seed.seedServer("alice", "second")
      throw original
    })).rejects.toBe(original)
    expect(servers.size).toBe(0)
    expect(closed.every((page) => page.isClosed())).toBe(true)
  })

  it("retains body and cleanup errors, attempts all resources and blocks a restarted successor", async () => {
    const original = new Error("first assertion failed")
    closeError = new Error("context close failed")
    const failure = await run(info("dirty"), async (create) => {
      const users = await create(["alice"])
      await users.asUser("alice")
      const failed = await users.seed.seedServer("alice", "failed")
      await users.seed.seedServer("alice", "remaining")
      deniedDeletes.add(failed)
      throw original
    }).catch((error: AggregateError) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(original)
    expect(servers.size).toBe(1)
    const record = JSON.parse(readFileSync(resolve(fixture.directory, "case-cleanup-failure.json"), "utf8"))
    expect(record.unresolvedServers).toHaveLength(1)
    const restarted = info("successor", 1)
    await expect(fixture.registration!.caseCleanupGuard[0]({}, async () => { throw new Error("must not start successor") }, restarted)).rejects.toThrow("blocked")
    expect(restarted.annotations).toEqual([expect.objectContaining({ type: "fixture-blocked" })])
    expect(fixture.login).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["stale", "incomplete"],
    ["truncated", "incomplete"],
    ["error", "failed (503)"],
    ["malformed", "must be empty"],
    ["profile", "modified profile defaults"],
  ] as const)("rejects a %s fresh-account baseline", async (fault, message) => {
    baselineFault = fault
    await expect(run(info(fault), async (create) => { await create(["alice"]) })).rejects.toThrow(message)
  })

  it("rejects a reused unowned stack before creating an account", async () => {
    writeFileSync(resolve(fixture.directory, "service-state.json"), JSON.stringify({ status: "healthy", services: [] }))
    await expect(run(info("unowned"), async (create) => { await create(["alice"]) })).rejects.toThrow("not owned")
    expect(fixture.login).not.toHaveBeenCalled()
  })

  it("reconciles an owned server when creation succeeded but its response was lost", async () => {
    loseServerResponse = true
    await expect(run(info("lost-response"), async (create) => {
      const users = await create(["alice"])
      await users.seed.seedServer("alice", "lost")
    })).rejects.toBeInstanceOf(SyntaxError)
    expect(servers.size).toBe(0)
    expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(true)
  })

  it("rejects a nonzero cursor created by the DM handshake without rewriting the expectation", async () => {
    await run(info("dm-conflict"), async (create) => {
      const users = await create(["alice", "bob"])
      dmCursor = 1
      await expect(users.seed.seedDm("alice", users.userId("bob"))).rejects.toThrow("zero-cursor")
    })
  })

  it("records an unclosed login context before actor assignment and blocks its successor", async () => {
    const original = new Error("login page failed")
    const closing = new Error("login context close failed")
    const context = { close: vi.fn().mockRejectedValue(closing) } as unknown as BrowserContext
    fixture.login.mockImplementation(async (_browser, _key, _stamp, _state, owner) => {
      owner.created(context)
      throw original
    })
    const failed = await run(info("login-dirty"), async (create) => { await create(["alice"]) })
      .catch((error: AggregateError) => error)
    expect(failed).toBeInstanceOf(AggregateError)
    expect((failed as AggregateError).errors).toEqual([original, closing])
    expect(context.close).toHaveBeenCalledOnce()
    const record = JSON.parse(readFileSync(resolve(fixture.directory, "case-cleanup-failure.json"), "utf8"))
    expect(record.unresolvedServers).toEqual([])
    expect(record.unresolvedContexts).toEqual([{ role: "alice", kind: "login", ordinal: 0 }])
    const successor = info("login-successor", 1)
    await expect(fixture.registration!.caseCleanupGuard[0]({}, async () => { throw new Error("must not enter") }, successor)).rejects.toThrow("blocked")
    expect(fixture.login).toHaveBeenCalledOnce()
  })

  it("retires a recovered login context while keeping the original setup failure", async () => {
    const original = new Error("login failed after context creation")
    const context = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext
    fixture.login.mockImplementation(async (_browser, _key, _stamp, _state, owner) => {
      owner.created(context)
      throw original
    })
    const current = info("login-recovered")
    await expect(run(current, async (create) => { await create(["alice"]) })).rejects.toBe(original)
    expect(context.close).toHaveBeenCalledOnce()
    const cleanup = vi.mocked(current.attach).mock.calls.find(([name]) => name === "case-cleanup")![1]!
    const result = JSON.parse(cleanup.body!.toString())
    expect(result.outcomes.contexts).toEqual([{ role: "alice", kind: "login", ordinal: 0, closed: true }])
    await expect(fixture.registration!.caseCleanupGuard[0]({}, async () => undefined, info("clean-successor", 1))).resolves.toBeUndefined()
  })

  it("does not close a successfully retired login context again during teardown", async () => {
    const signIn = fixture.login.getMockImplementation()!
    const context = { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext
    fixture.login.mockImplementation(async (currentBrowser, key, stamp, state, owner) => {
      owner.created(context)
      const result = await signIn(currentBrowser, key, stamp, state)
      await context.close()
      owner.closed(context)
      return result
    })
    await run(info("login-closed"), async (create) => { await create(["alice"]) })
    expect(context.close).toHaveBeenCalledOnce()
  })

  it("closes an actor context when its page creation fails", async () => {
    const original = new Error("actor page failed")
    const context = {
      newPage: vi.fn().mockRejectedValue(original),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext
    const currentBrowser = { newContext: vi.fn().mockResolvedValue(context) } as unknown as Browser
    await expect(run(info("actor-page"), async (create) => {
      const users = await create(["alice"])
      await users.asUser("alice")
    }, currentBrowser)).rejects.toBe(original)
    expect(context.close).toHaveBeenCalledOnce()
  })
})

describe("real login helper context exit", () => {
  const login = async (...args: Parameters<typeof import("./e2e-ui/_setup/auth").loginAndSaveState>) => {
    const real = await vi.importActual<typeof import("./e2e-ui/_setup/auth")>("./e2e-ui/_setup/auth")
    return real.loginAndSaveState(...args)
  }

  const setup = () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForURL: vi.fn().mockResolvedValue(undefined),
      getByRole: vi.fn(() => ({
        waitFor: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
      })),
    }
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
      request: { get: vi.fn().mockResolvedValue({ ok: () => true, json: async () => ({ userId: "unit-login-user" }) }) },
      addCookies: vi.fn().mockResolvedValue(undefined),
      clearCookies: vi.fn().mockResolvedValue(undefined),
      storageState: vi.fn().mockResolvedValue(undefined),
    }
    const currentBrowser = { newContext: vi.fn().mockResolvedValue(context) } as unknown as Browser
    const actualContext = context as unknown as BrowserContext
    const owned = new Set<BrowserContext>()
    const owner = {
      created: vi.fn((value: BrowserContext) => { owned.add(value) }),
      closed: vi.fn((value: BrowserContext) => { owned.delete(value) }),
    }
    return { page, context, actualContext, currentBrowser, owned, owner }
  }

  it("registers before newPage and closes after a page creation failure", async () => {
    const s = setup()
    const original = new Error("newPage failed")
    s.context.newPage.mockImplementation(async () => {
      expect(s.owned.has(s.actualContext)).toBe(true)
      throw original
    })
    await expect(login(s.currentBrowser, "alice", "unit", "unit-state.json", s.owner)).rejects.toBe(original)
    expect(s.context.close).toHaveBeenCalledOnce()
    expect(s.owner.closed).toHaveBeenCalledWith(s.actualContext)
    expect(s.owned.size).toBe(0)
  })

  it("keeps page and close errors in order without retiring the unresolved context", async () => {
    const s = setup()
    const original = new Error("newPage failed")
    const closing = new Error("close failed")
    s.context.newPage.mockRejectedValue(original)
    s.context.close.mockRejectedValue(closing)
    const failed = await login(s.currentBrowser, "alice", "unit", "unit-state.json", s.owner)
      .catch((error: AggregateError) => error)
    expect(failed).toBeInstanceOf(AggregateError)
    expect((failed as AggregateError).errors).toEqual([original, closing])
    expect(s.context.close).toHaveBeenCalledOnce()
    expect(s.owner.closed).not.toHaveBeenCalled()
    expect(s.owned.has(s.actualContext)).toBe(true)
  })

  it("retains the original sign-in failure together with a failed close", async () => {
    const s = setup()
    const original = new Error("sign-in URL failed")
    const closing = new Error("close failed after sign-in")
    s.page.waitForURL.mockRejectedValue(original)
    s.context.close.mockRejectedValue(closing)
    const failed = await login(s.currentBrowser, "alice", "unit", "unit-state.json", s.owner)
      .catch((error: AggregateError) => error)
    expect((failed as AggregateError).errors).toEqual([original, closing])
    expect(s.page.goto.mock.calls.map(([url]) => url)).toEqual(["http://fixture.test/c", "http://fixture.test/sign-in?redirect=/c"])
    expect(s.owner.closed).not.toHaveBeenCalled()
  })

  it("keeps registration until the close promise resolves", async () => {
    const s = setup()
    let release!: () => void
    const closing = new Promise<void>((resolveValue) => { release = resolveValue })
    s.context.close.mockReturnValue(closing)
    const result = login(s.currentBrowser, "alice", "unit", "unit-state.json", s.owner)
    await vi.waitFor(() => expect(s.context.close).toHaveBeenCalledOnce())
    expect(s.owned.has(s.actualContext)).toBe(true)
    expect(s.owner.closed).not.toHaveBeenCalled()
    release()
    await expect(result).resolves.toMatchObject({ key: "alice", userId: "unit-login-user", storageState: "unit-state.json" })
    expect(s.owned.size).toBe(0)
  })

  it("rejects a successful login when close fails and leaves its context owned", async () => {
    const s = setup()
    const closing = new Error("close failed after identity capture")
    s.context.close.mockRejectedValue(closing)
    await expect(login(s.currentBrowser, "alice", "unit", "unit-state.json", s.owner)).rejects.toBe(closing)
    expect(s.context.storageState).toHaveBeenCalledWith({ path: "unit-state.json" })
    expect(s.owner.closed).not.toHaveBeenCalled()
    expect(s.owned.has(s.actualContext)).toBe(true)
  })

  it("makes no registration when context creation fails", async () => {
    const s = setup()
    const original = new Error("newContext failed")
    vi.mocked(s.currentBrowser.newContext).mockRejectedValue(original)
    await expect(login(s.currentBrowser, "alice", "unit", "unit-state.json", s.owner)).rejects.toBe(original)
    expect(s.owner.created).not.toHaveBeenCalled()
    expect(s.owner.closed).not.toHaveBeenCalled()
    expect(s.context.close).not.toHaveBeenCalled()
  })

  it("preserves the legacy four-argument authentication and storage operations", async () => {
    const s = setup()
    const result = await login(s.currentBrowser, "alice", "unit", "unit-state.json")
    expect(result).toMatchObject({ key: "alice", userId: "unit-login-user", storageState: "unit-state.json" })
    expect(result.name).toBe(result.email.split("@")[0])
    expect(s.page.goto).toHaveBeenCalledWith("http://fixture.test/c", { waitUntil: "load" })
    expect(s.context.request.get).toHaveBeenCalledWith("http://fixture.test/api/ws/token")
    expect(s.context.addCookies).toHaveBeenCalledOnce()
    expect(s.context.clearCookies).toHaveBeenCalledWith({ name: /^(?:is_new_signup|is_sign_in)$/ })
    expect(s.context.storageState).toHaveBeenCalledWith({ path: "unit-state.json" })
    expect(s.context.close).toHaveBeenCalledOnce()
  })
})
