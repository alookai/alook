import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("better-auth", () => ({
  betterAuth: vi.fn((opts: unknown) => ({ __options: opts })),
}))

vi.mock("better-auth/plugins", () => ({
  emailOTP: vi.fn((cfg: unknown) => ({ __plugin: "emailOTP", cfg })),
  deviceAuthorization: vi.fn((cfg: unknown) => ({ __plugin: "deviceAuthorization", cfg })),
  bearer: vi.fn(() => ({ __plugin: "bearer" })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));

vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
    DEV_EMAIL_WORKER_URL: "http://localhost:0",
  }
})

vi.mock("./email-templates", () => ({
  getOtpSubject: () => "subject",
  renderOtpEmail: () => "<html></html>",
}))

type RateLimitValue = { count: number; lastRequest: number } | undefined

function makeKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>()
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, expirationTtl: opts?.expirationTtl })
    }),
  }
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    DB: {},
    EMAIL_BUCKET: {},
    WS_DO_WORKER: {},
    EMAIL_WORKER: { fetch: vi.fn() },
    NEXT_INC_CACHE_R2_BUCKET: {},
    NEXT_TAG_CACHE_D1: {},
    NEXT_CACHE_DO_QUEUE: {},
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "gh-s",
    GOOGLE_CLIENT_ID: "gg",
    GOOGLE_CLIENT_SECRET: "gg-s",
    BETTER_AUTH_SECRET: "secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    RATE_LIMIT_KV: makeKv(),
    ...overrides,
  }
}

type AuthOptions = {
  rateLimit: {
    enabled: boolean
    customRules: Record<string, { window: number; max: number }>
    customStorage: {
      get: (key: string) => Promise<RateLimitValue>
      set: (key: string, value: RateLimitValue) => Promise<void>
    }
  }
  session?: {
    cookieCache?: {
      enabled?: boolean
      maxAge?: number
    }
  }
}

async function loadCreateAuth() {
  vi.resetModules()
  const mod = await import("./auth")
  return mod.createAuth
}

describe("createAuth rate limiting", () => {
  beforeEach(() => vi.clearAllMocks())

  it("enables rate limiting only in production", async () => {
    const createAuth = await loadCreateAuth()
    const envProd = makeEnv({ NODE_ENV: "production" })
    const optsProd = (createAuth(envProd as never) as { __options: AuthOptions }).__options
    expect(optsProd.rateLimit.enabled).toBe(true)

    const envDev = makeEnv({ NODE_ENV: "development" })
    const optsDev = (createAuth(envDev as never) as { __options: AuthOptions }).__options
    expect(optsDev.rateLimit.enabled).toBe(false)
  })

  it("uses default 5/60s for the OTP path when env vars are unset", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production" })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    expect(opts.rateLimit.customRules["/email-otp/send-verification-otp"]).toEqual({
      window: 60,
      max: 5,
    })
  })

  it("honours AUTH_OTP_RATE_LIMIT_MAX / _WINDOW_SEC overrides", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({
      NODE_ENV: "production",
      AUTH_OTP_RATE_LIMIT_MAX: "3",
      AUTH_OTP_RATE_LIMIT_WINDOW_SEC: "120",
    })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    expect(opts.rateLimit.customRules["/email-otp/send-verification-otp"]).toEqual({
      window: 120,
      max: 3,
    })
  })

  it("falls back to defaults when env overrides are non-numeric or zero", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({
      NODE_ENV: "production",
      AUTH_OTP_RATE_LIMIT_MAX: "not-a-number",
      AUTH_OTP_RATE_LIMIT_WINDOW_SEC: "0",
    })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    expect(opts.rateLimit.customRules["/email-otp/send-verification-otp"]).toEqual({
      window: 60,
      max: 5,
    })
  })

  it("customStorage round-trips values through KV with a >=60s TTL", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production" })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    const { get, set } = opts.rateLimit.customStorage
    const kv = env.RATE_LIMIT_KV as ReturnType<typeof makeKv>

    expect(await get("missing")).toBeUndefined()

    await set("k1", { count: 2, lastRequest: 123 })
    const stored = kv.store.get("k1")
    expect(stored?.value).toBe(JSON.stringify({ count: 2, lastRequest: 123 }))
    expect(stored?.expirationTtl).toBeGreaterThanOrEqual(60)

    expect(await get("k1")).toEqual({ count: 2, lastRequest: 123 })
  })

  it("clamps KV TTL to 60s when the configured window is shorter", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production", AUTH_OTP_RATE_LIMIT_WINDOW_SEC: "10" })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    const kv = env.RATE_LIMIT_KV as ReturnType<typeof makeKv>
    await opts.rateLimit.customStorage.set("k", { count: 1, lastRequest: 0 })
    expect(kv.store.get("k")?.expirationTtl).toBe(60)
  })

  it("uses the configured window as TTL when it exceeds 60s", async () => {
    const createAuth = await loadCreateAuth()
    const env = makeEnv({ NODE_ENV: "production", AUTH_OTP_RATE_LIMIT_WINDOW_SEC: "180" })
    const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
    const kv = env.RATE_LIMIT_KV as ReturnType<typeof makeKv>
    await opts.rateLimit.customStorage.set("k", { count: 1, lastRequest: 0 })
    expect(kv.store.get("k")?.expirationTtl).toBe(180)
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
