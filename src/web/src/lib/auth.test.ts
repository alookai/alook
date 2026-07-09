import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("better-auth", () => ({
  betterAuth: vi.fn((opts: unknown) => ({ __options: opts })),
}))

vi.mock("better-auth/plugins", () => ({
  emailOTP: vi.fn((cfg: unknown) => ({ __plugin: "emailOTP", cfg })),
  deviceAuthorization: vi.fn((cfg: unknown) => ({ __plugin: "deviceAuthorization", cfg })),
  bearer: vi.fn(() => ({ __plugin: "bearer" })),
}))

// `probeAvailableDiscriminator` (called from the `user.create.before` hook)
// does a real `getUserByNameAndDiscriminator` SELECT against `getDb(env.DB)`
// — stub `getDb` to return a minimal drizzle-chain fake instead of `{}` so
// hook tests don't need a real `Database`. Each `.select(...).from(...)
// .where(...).limit(1)` call resolves to the next queued response (FIFO);
// defaults to "no collision" (empty rows) so every existing hook test keeps
// getting `computeDiscriminator(id)` verbatim on the first attempt, same as
// before this hook started probing the DB.
let selectResponses: unknown[][] = []
function queueSelectResponse(rows: unknown[]) {
  selectResponses.push(rows)
}
function makeFakeDb() {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => selectResponses.shift() ?? [],
  }
  return { select: () => chain }
}
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => makeFakeDb()) }));

vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    DEV_EMAIL_WORKER_URL: "http://localhost:0",
  }
})

vi.mock("./email-templates", () => ({
  getOtpSubject: () => "subject",
  renderOtpEmail: () => "<html></html>",
}))

// Mock `checkRateLimit` so tests can assert what auth passes to the
// unified rate-limit helper without spinning up the DO.
const mockCheckRateLimit = vi.fn(async () => ({ allowed: true }))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...(a as [])),
}))

function makeEnvBase() {
  return {}
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...makeEnvBase(),
    DB: {},
    EMAIL_BUCKET: {},
    WS_DO_WORKER: {},
    EMAIL_WORKER: { fetch: vi.fn(async () => new Response("ok", { status: 200 })) },
    NEXT_INC_CACHE_R2_BUCKET: {},
    NEXT_TAG_CACHE_D1: {},
    NEXT_CACHE_DO_QUEUE: {},
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "gh-s",
    GOOGLE_CLIENT_ID: "gg",
    GOOGLE_CLIENT_SECRET: "gg-s",
    BETTER_AUTH_SECRET: "secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    ...overrides,
  }
}

type AuthOptions = {
  user?: {
    additionalFields?: Record<
      string,
      { type: string; required?: boolean; input?: boolean; returned?: boolean }
    >
  }
  rateLimit: {
    enabled: boolean
  }
  plugins?: Array<{
    __plugin?: string
    cfg?: {
      sendVerificationOTP?: (args: { email: string; otp: string; type: string }) => Promise<void>
    }
  }>
  session?: {
    cookieCache?: {
      enabled?: boolean
      maxAge?: number
    }
  }
  databaseHooks?: {
    user?: {
      create?: {
        before?: (user: {
          name?: string
          email?: string
          [k: string]: unknown
        }) => Promise<{ data: { name?: string; email?: string; [k: string]: unknown } }>
        after?: (user: unknown, ctx: unknown) => Promise<void>
      }
    }
  }
}

async function loadCreateAuth() {
  vi.resetModules()
  const mod = await import("./auth")
  return mod.createAuth
}

// Fetches the OTP-plugin `sendVerificationOTP` callback for a given env
// so tests can drive rate-limit + email-send behavior directly.
function getSendOtp(opts: AuthOptions) {
  const otp = opts.plugins?.find((p) => p?.__plugin === "emailOTP")
  const fn = otp?.cfg?.sendVerificationOTP
  if (!fn) throw new Error("emailOTP plugin not present")
  return fn
}

describe("createAuth rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockReset().mockResolvedValue({ allowed: true })
  })

  it("turns off better-auth's built-in rate limiter — we run our own inside sendVerificationOTP", async () => {
    const createAuth = await loadCreateAuth()
    const optsProd = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    expect(optsProd.rateLimit.enabled).toBe(false)

    const optsDev = (createAuth(makeEnv({ NODE_ENV: "development" }) as never) as { __options: AuthOptions }).__options
    expect(optsDev.rateLimit.enabled).toBe(false)
  })

  it("calls checkRateLimit('auth:otpSend', email) with the default 5/60s policy", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production" })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    await getSendOtp(opts)({ email: "a@b.com", otp: "1234", type: "sign-in" })
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      env,
      "auth:otpSend",
      "a@b.com",
      { windowMs: 60_000, max: 5 },
    )
  })

  it("honours AUTH_OTP_RATE_LIMIT_MAX / _WINDOW_SEC overrides", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({
      NODE_ENV: "production",
      AUTH_OTP_RATE_LIMIT_MAX: "3",
      AUTH_OTP_RATE_LIMIT_WINDOW_SEC: "120",
    })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    await getSendOtp(opts)({ email: "a@b.com", otp: "1234", type: "sign-in" })
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      env,
      "auth:otpSend",
      "a@b.com",
      { windowMs: 120_000, max: 3 },
    )
  })

  it("falls back to defaults when env overrides are non-numeric or zero", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({
      NODE_ENV: "production",
      AUTH_OTP_RATE_LIMIT_MAX: "not-a-number",
      AUTH_OTP_RATE_LIMIT_WINDOW_SEC: "0",
    })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    await getSendOtp(opts)({ email: "a@b.com", otp: "1234", type: "sign-in" })
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      env,
      "auth:otpSend",
      "a@b.com",
      { windowMs: 60_000, max: 5 },
    )
  })

  it("throws before sending when the rate limiter blocks", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSec: 42 })
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production" })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    const sendOtp = getSendOtp(opts)
    await expect(
      sendOtp({ email: "a@b.com", otp: "1234", type: "sign-in" }),
    ).rejects.toThrow(/retry in 42s/)
    expect(env.EMAIL_WORKER.fetch).not.toHaveBeenCalled()
  })
})

describe("createAuth session cookie cache", () => {
  beforeEach(() => vi.clearAllMocks())

  // The signed session-data cookie lets `auth.api.getSession()` validate without
  // a D1 round-trip. Without it, the first request after a fresh OTP sign-up
  // can 401 because the just-written `user` row hasn't replicated yet.
  it("enables the signed session-data cookie with a positive maxAge", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    expect(opts.session?.cookieCache?.enabled).toBe(true)
    expect(opts.session?.cookieCache?.maxAge).toBeGreaterThan(0)
  })

  it("enables cookieCache in development too so local sign-up doesn't 401", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "development" }) as never) as { __options: AuthOptions }).__options
    expect(opts.session?.cookieCache?.enabled).toBe(true)
  })
})

describe("createAuth user fields", () => {
  beforeEach(() => vi.clearAllMocks())

  it("registers discriminator as a Better Auth user field", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    expect(opts.user?.additionalFields?.discriminator).toEqual({
      type: "string",
      required: false,
      input: false,
    })
  })
})

describe("createAuth device authorization plugin", () => {
  beforeEach(() => vi.clearAllMocks())

  it("includes deviceAuthorization and bearer plugins in production", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: { plugins: any[] } }).__options
    const pluginNames = opts.plugins.map((p: any) => p.__plugin)
    expect(pluginNames).toContain("deviceAuthorization")
    expect(pluginNames).toContain("bearer")
  })

  it("includes deviceAuthorization and bearer plugins in development", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "development" }) as never) as { __options: { plugins: any[] } }).__options
    const pluginNames = opts.plugins.map((p: any) => p.__plugin)
    expect(pluginNames).toContain("deviceAuthorization")
    expect(pluginNames).toContain("bearer")
  })

  it("validateClient accepts client IDs listed in DEVICE_CLIENT_IDS", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production", DEVICE_CLIENT_IDS: "cli-app, web-app" })
    const opts = (createAuth(env as never) as { __options: { plugins: any[] } }).__options
    const devicePlugin = opts.plugins.find((p: any) => p.__plugin === "deviceAuthorization")
    const { validateClient } = devicePlugin.cfg
    expect(validateClient("cli-app")).toBe(true)
    expect(validateClient("web-app")).toBe(true)
  })

  it("validateClient rejects client IDs not listed in DEVICE_CLIENT_IDS", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production", DEVICE_CLIENT_IDS: "cli-app" })
    const opts = (createAuth(env as never) as { __options: { plugins: any[] } }).__options
    const devicePlugin = opts.plugins.find((p: any) => p.__plugin === "deviceAuthorization")
    const { validateClient } = devicePlugin.cfg
    expect(validateClient("unknown-client")).toBe(false)
  })

  it("validateClient rejects empty string when DEVICE_CLIENT_IDS is unset", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production" })
    const opts = (createAuth(env as never) as { __options: { plugins: any[] } }).__options
    const devicePlugin = opts.plugins.find((p: any) => p.__plugin === "deviceAuthorization")
    const { validateClient } = devicePlugin.cfg
    expect(validateClient("")).toBe(false)
  })
})

describe("createAuth databaseHooks — user.create.after", () => {
  beforeEach(() => vi.clearAllMocks())

  function makeCtx(url: string) {
    const cookies: Record<string, { value: string; opts: unknown }> = {}
    return {
      request: { url },
      setCookie: vi.fn((name: string, value: string, opts: unknown) => {
        cookies[name] = { value, opts }
      }),
      cookies,
    }
  }

  it("sets is_new_signup cookie with method=email for email-otp path", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const afterHook = opts.databaseHooks!.user!.create!.after!
    const ctx = makeCtx("http://localhost:3000/api/auth/sign-in/email-otp")
    await afterHook({ id: "u1", email: "a@b.com" }, ctx)
    expect(ctx.setCookie).toHaveBeenCalledWith("is_new_signup", "email", expect.objectContaining({ maxAge: 60 }))
  })

  it("sets method=github for github callback path", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const afterHook = opts.databaseHooks!.user!.create!.after!
    const ctx = makeCtx("http://localhost:3000/api/auth/callback/github")
    await afterHook({ id: "u2" }, ctx)
    expect(ctx.setCookie).toHaveBeenCalledWith("is_new_signup", "github", expect.anything())
  })

  it("sets method=google for google callback path", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const afterHook = opts.databaseHooks!.user!.create!.after!
    const ctx = makeCtx("http://localhost:3000/api/auth/callback/google")
    await afterHook({ id: "u3" }, ctx)
    expect(ctx.setCookie).toHaveBeenCalledWith("is_new_signup", "google", expect.anything())
  })

  it("sets method=unknown for unrecognized path", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const afterHook = opts.databaseHooks!.user!.create!.after!
    const ctx = makeCtx("http://localhost:3000/api/auth/sign-up/email")
    await afterHook({ id: "u4" }, ctx)
    expect(ctx.setCookie).toHaveBeenCalledWith("is_new_signup", "unknown", expect.anything())
  })

  it("does nothing when ctx is null", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const afterHook = opts.databaseHooks!.user!.create!.after!
    await expect(afterHook({ id: "u5" }, null)).resolves.toBeUndefined()
  })
})

describe("createAuth databaseHooks — user.create.before", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectResponses = []
  })

  it("coalesces empty name to email prefix", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const beforeHook = opts.databaseHooks!.user!.create!.before!
    const result = await beforeHook({ id: "u1", name: "", email: "alice@example.com" })
    expect(result.data.name).toBe("alice")
    expect(result.data.email).toBe("alice@example.com")
    expect(result.data.discriminator).toMatch(/^\d{4}$/)
  })

  it("keeps a non-empty name and always stamps a 4-digit discriminator", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const beforeHook = opts.databaseHooks!.user!.create!.before!
    const input = { id: "u2", name: "Alice", email: "alice@example.com" }
    const result = await beforeHook(input)
    expect(result.data.name).toBe("Alice")
    expect(result.data.email).toBe("alice@example.com")
    expect(result.data.discriminator).toMatch(/^\d{4}$/)
  })

  it("coalesces whitespace-only name to email prefix", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const beforeHook = opts.databaseHooks!.user!.create!.before!
    const result = await beforeHook({ id: "u3", name: "   ", email: "bob@example.com" })
    expect(result.data.name).toBe("bob")
  })

  it("coalesces null-ish name (GitHub OAuth with no profile name) to email prefix", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const beforeHook = opts.databaseHooks!.user!.create!.before!
    // Better-Auth's GitHub adapter can pass through name as null / undefined
    // when the provider profile has no display name set.
    const result = await beforeHook({ id: "u4", email: "carol@example.com" } as {
      name?: string
      email?: string
    })
    expect(result.data.name).toBe("carol")
  })

  it("discriminator is deterministic on the provided id", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const beforeHook = opts.databaseHooks!.user!.create!.before!
    const { computeDiscriminator } = await import("@alook/shared")
    const a = await beforeHook({ id: "u_fixed_id", name: "x", email: "x@example.com" })
    const b = await beforeHook({ id: "u_fixed_id", name: "y", email: "y@example.com" })
    expect(a.data.discriminator).toBe(b.data.discriminator)
    expect(a.data.discriminator).toBe(computeDiscriminator("u_fixed_id"))
    expect(a.data.discriminator).not.toBe("0000")
  })

  it("salts past a pre-existing (name, discriminator) collision via probeAvailableDiscriminator", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const beforeHook = opts.databaseHooks!.user!.create!.before!
    const { computeDiscriminator } = await import("@alook/shared")
    const unsalted = computeDiscriminator("u_collide")
    // First probe (unsalted discriminator) reports a live collision; the
    // salted retry's probe reports the coast is clear.
    queueSelectResponse([{ id: "existing_user" }])
    queueSelectResponse([])

    const result = await beforeHook({ id: "u_collide", name: "dana", email: "dana@example.com" })

    expect(result.data.discriminator).not.toBe(unsalted)
    expect(result.data.discriminator).toBe(computeDiscriminator("u_collide:1"))
    expect(result.data.discriminator).toMatch(/^\d{4}$/)
  })
})
