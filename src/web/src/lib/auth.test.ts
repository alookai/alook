import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

const appleMocks = vi.hoisted(() => ({
  generateClientSecret: vi.fn(async () => "signed-apple-client-secret"),
}))
const authLogMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))
const cloudflareMocks = vi.hoisted(() => {
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
  return {
    waitUntil,
    getCloudflareContext: vi.fn(() => ({ ctx: { waitUntil } })),
  }
})

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: cloudflareMocks.getCloudflareContext,
}))

vi.mock("better-auth", () => ({
  betterAuth: vi.fn((opts: unknown) => ({ __options: opts })),
}))

vi.mock("better-auth/plugins", () => ({
  emailOTP: vi.fn((cfg: unknown) => ({ __plugin: "emailOTP", cfg })),
  deviceAuthorization: vi.fn((cfg: unknown) => ({ __plugin: "deviceAuthorization", cfg })),
  bearer: vi.fn(() => ({ __plugin: "bearer" })),
  oneTimeToken: vi.fn((cfg: unknown) => ({ __plugin: "oneTimeToken", cfg })),
}))

vi.mock("@/lib/apple-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apple-auth")>()
  return {
    ...actual,
    generateAppleClientSecret: appleMocks.generateClientSecret,
  }
})

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
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => selectResponses.shift() ?? [],
  }
  return { select: () => chain }
}
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => makeFakeDb()),
  getPrimaryDb: vi.fn(() => makeFakeDb()),
}));

vi.mock("@alook/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return {
    ...actual,
    createLogger: () => authLogMocks,
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
  trustedOrigins?: string[]
  socialProviders?: Record<string, unknown>
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
    id?: string
    cfg?: Record<string, unknown> & {
      expiresIn?: number
      allowedAttempts?: number
      storeOTP?: string
      generateOTP?: (args: { email: string; type: EmailOtpType }) => string | undefined
      sendVerificationOTP?: (
        args: { email: string; otp: string; type: EmailOtpType },
        ctx?: {
          context: {
            internalAdapter: {
              deleteVerificationByIdentifier: (identifier: string) => Promise<void>
            }
          }
        },
      ) => Promise<void>
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
    session?: {
      create?: {
        after?: (session: unknown, ctx: unknown) => Promise<void>
      }
    }
  }
}

type EmailOtpType = "sign-in" | "email-verification" | "forget-password" | "change-email"

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

function getGenerateOtp(opts: AuthOptions) {
  const otp = opts.plugins?.find((p) => p?.__plugin === "emailOTP")
  const fn = otp?.cfg?.generateOTP
  if (!fn) throw new Error("emailOTP generator not present")
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

describe("createAuth App Review OTP", () => {
  const reviewEmail = "reviewer@example.com"
  const reviewOtp = "246810"

  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockReset().mockResolvedValue({ allowed: true })
  })

  function createReviewAuth(overrides: Partial<Record<string, unknown>> = {}) {
    return loadCreateAuth().then((createAuth) => {
      const env = makeEnv({
        NODE_ENV: "production",
        APP_REVIEW_EMAIL: `  ${reviewEmail.toUpperCase()}  `,
        APP_REVIEW_OTP: reviewOtp,
        ...overrides,
      })
      const opts = (createAuth(env as never) as { __options: AuthOptions }).__options
      return { env, opts }
    })
  }

  it("uses the fixed six-digit code only for the normalized exact sign-in email", async () => {
    const { opts } = await createReviewAuth()
    const generateOtp = getGenerateOtp(opts)

    expect(generateOtp({ email: reviewEmail.toUpperCase(), type: "sign-in" })).toBe(reviewOtp)
    expect(generateOtp({ email: `other-${reviewEmail}`, type: "sign-in" })).toBeUndefined()
    expect(generateOtp({ email: `reviewer+alias@example.com`, type: "sign-in" })).toBeUndefined()
    expect(generateOtp({ email: reviewEmail, type: "email-verification" })).toBeUndefined()
    expect(generateOtp({ email: reviewEmail, type: "forget-password" })).toBeUndefined()
    expect(generateOtp({ email: reviewEmail, type: "change-email" })).toBeUndefined()
  })

  it("keeps the DO limiter but skips email delivery for the review sign-in", async () => {
    const { env, opts } = await createReviewAuth()

    await getSendOtp(opts)({
      email: reviewEmail.toUpperCase(),
      otp: reviewOtp,
      type: "sign-in",
    })

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      env,
      "auth:otpSend",
      "app-review",
      { windowMs: 60_000, max: 5 },
    )
    expect(env.EMAIL_WORKER.fetch).not.toHaveBeenCalled()
  })

  it("keeps email delivery for similar emails and other OTP types", async () => {
    const { env, opts } = await createReviewAuth()
    const sendOtp = getSendOtp(opts)

    await sendOtp({ email: "reviewer+alias@example.com", otp: "135790", type: "sign-in" })
    await sendOtp({ email: reviewEmail, otp: "975310", type: "email-verification" })

    expect(env.EMAIL_WORKER.fetch).toHaveBeenCalledTimes(2)
    expect(cloudflareMocks.waitUntil).toHaveBeenCalledTimes(2)
  })

  it("waits for the DO gate but not ordinary email delivery", async () => {
    let allowRateLimit: ((result: { allowed: true }) => void) | undefined
    mockCheckRateLimit.mockReturnValueOnce(new Promise((resolve) => {
      allowRateLimit = resolve
    }))
    let finishEmail: ((response: Response) => void) | undefined
    const emailFetch = vi.fn(() => new Promise<Response>((resolve) => {
      finishEmail = resolve
    }))
    const { opts } = await createReviewAuth({
      EMAIL_WORKER: { fetch: emailFetch },
    })

    const send = getSendOtp(opts)({
      email: "ordinary@example.com",
      otp: "135790",
      type: "sign-in",
    })
    await Promise.resolve()
    expect(emailFetch).not.toHaveBeenCalled()
    expect(cloudflareMocks.waitUntil).not.toHaveBeenCalled()

    allowRateLimit?.({ allowed: true })
    await expect(send).resolves.toBeUndefined()
    expect(emailFetch).toHaveBeenCalledOnce()
    expect(cloudflareMocks.waitUntil).toHaveBeenCalledOnce()

    const backgroundSend = cloudflareMocks.waitUntil.mock.calls[0]?.[0]
    if (!backgroundSend) throw new Error("email send was not registered")
    let backgroundSettled = false
    void backgroundSend.then(() => { backgroundSettled = true })
    await Promise.resolve()
    expect(backgroundSettled).toBe(false)

    finishEmail?.(new Response("ok", { status: 200 }))
    await expect(backgroundSend).resolves.toBeUndefined()
  })

  it("contains background email failures after returning from the send callback", async () => {
    const { opts } = await createReviewAuth({
      EMAIL_WORKER: {
        fetch: vi.fn().mockResolvedValue(new Response("worker down", { status: 503 })),
      },
    })

    await expect(getSendOtp(opts)({
      email: "ordinary@example.com",
      otp: "135790",
      type: "sign-in",
    })).resolves.toBeUndefined()

    const backgroundSend = cloudflareMocks.waitUntil.mock.calls[0]?.[0]
    if (!backgroundSend) throw new Error("email send was not registered")
    await expect(backgroundSend).resolves.toBeUndefined()
    expect(authLogMocks.error).toHaveBeenCalledWith(
      "OTP email failed",
      expect.objectContaining({ to: "ordinary@example.com", type: "sign-in" }),
    )
  })

  it("awaits email delivery when Cloudflare background scheduling is unavailable", async () => {
    cloudflareMocks.getCloudflareContext.mockImplementationOnce(() => {
      throw new Error("context unavailable")
    })
    let finishEmail: ((response: Response) => void) | undefined
    const emailFetch = vi.fn(() => new Promise<Response>((resolve) => {
      finishEmail = resolve
    }))
    const { opts } = await createReviewAuth({
      EMAIL_WORKER: { fetch: emailFetch },
    })

    let callbackSettled = false
    const send = getSendOtp(opts)({
      email: "ordinary@example.com",
      otp: "135790",
      type: "sign-in",
    }).then(() => { callbackSettled = true })
    await vi.waitFor(() => expect(emailFetch).toHaveBeenCalledOnce())

    expect(cloudflareMocks.waitUntil).not.toHaveBeenCalled()
    expect(callbackSettled).toBe(false)
    finishEmail?.(new Response("ok", { status: 200 }))
    await expect(send).resolves.toBeUndefined()
    expect(callbackSettled).toBe(true)
  })

  it.each([undefined, "", "12345", "12345a", "1234567"])(
    "fails closed for a matching review email when the OTP secret is %j",
    async (configuredOtp) => {
      const { env, opts } = await createReviewAuth({ APP_REVIEW_OTP: configuredOtp })
      const generateOtp = getGenerateOtp(opts)

      expect(() => generateOtp({ email: reviewEmail, type: "sign-in" }))
        .toThrow("Verification code unavailable")
      expect(env.EMAIL_WORKER.fetch).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, "", "not-an-email"])(
    "does not enable the fixed path when the review email secret is %j",
    async (configuredEmail) => {
      const { env, opts } = await createReviewAuth({ APP_REVIEW_EMAIL: configuredEmail })

      expect(getGenerateOtp(opts)({ email: reviewEmail, type: "sign-in" })).toBeUndefined()
      await getSendOtp(opts)({ email: reviewEmail, otp: "135790", type: "sign-in" })
      expect(env.EMAIL_WORKER.fetch).toHaveBeenCalledOnce()
    },
  )

  it("removes the staged review challenge when the DO limiter blocks", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSec: 42 })
    const deleteVerificationByIdentifier = vi.fn(async () => undefined)
    const { env, opts } = await createReviewAuth()

    await expect(getSendOtp(opts)(
      { email: reviewEmail, otp: reviewOtp, type: "sign-in" },
      { context: { internalAdapter: { deleteVerificationByIdentifier } } },
    )).rejects.toThrow("OTP rate limit; retry in 42s")

    expect(deleteVerificationByIdentifier).toHaveBeenCalledWith(
      `sign-in-otp-${reviewEmail}`,
    )
    expect(env.EMAIL_WORKER.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(authLogMocks.warn.mock.calls)).not.toContain(reviewEmail)
    expect(JSON.stringify(authLogMocks.warn.mock.calls)).not.toContain(reviewOtp)
  })

  it("fails closed if the send callback does not receive the configured review code", async () => {
    const { env, opts } = await createReviewAuth()

    await expect(getSendOtp(opts)({
      email: reviewEmail,
      otp: "135790",
      type: "sign-in",
    })).rejects.toThrow("Verification code unavailable")
    expect(env.EMAIL_WORKER.fetch).not.toHaveBeenCalled()
  })

  it("pins the five-minute expiry, three-attempt budget, and encrypted storage", async () => {
    const { opts } = await createReviewAuth()
    const plugin = opts.plugins?.find((candidate) => candidate.__plugin === "emailOTP")

    expect(plugin?.cfg).toMatchObject({
      expiresIn: 5 * 60,
      allowedAttempts: 3,
      storeOTP: "encrypted",
    })
  })
})

describe("sendOtpEmail", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("falls back to the development email endpoint when the service binding rejects", async () => {
    const internalFetch = vi.fn().mockRejectedValue(new Error("binding unavailable"))
    const fallbackFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fallbackFetch)
    const { sendOtpEmail } = await import("./auth")
    const env = makeEnv({ EMAIL_WORKER: { fetch: internalFetch } })

    await sendOtpEmail(env as never, {
      email: "owner@example.com",
      otp: "123456",
      type: "account-deletion",
    })

    expect(fallbackFetch).toHaveBeenCalledWith(
      "http://localhost:0/send/otp",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("reports a non-successful email-worker response", async () => {
    const env = makeEnv({
      EMAIL_WORKER: {
        fetch: vi.fn().mockResolvedValue(new Response("worker down", { status: 503 })),
      },
    })
    const { sendOtpEmail } = await import("./auth")

    await expect(sendOtpEmail(env as never, {
      email: "owner@example.com",
      otp: "123456",
      type: "account-deletion",
    })).rejects.toThrow("EMAIL_WORKER /send/otp failed: 503 worker down")
  })
})

describe("createAuth native OAuth handoff", () => {
  it.each(["production", "development"])(
    "configures a server-only hashed two-minute OTT in %s",
    async (nodeEnv) => {
      const createAuth = await loadCreateAuth()
      const opts = (createAuth(makeEnv({ NODE_ENV: nodeEnv }) as never) as {
        __options: AuthOptions
      }).__options
      const plugin = opts.plugins?.find((candidate) => candidate.__plugin === "oneTimeToken")

      expect(plugin?.cfg).toMatchObject({
        expiresIn: 2,
        disableClientRequest: true,
        storeToken: "hashed",
      })
    },
  )
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

  // Prod caps the signed-cookie cache at 5min (a revoked session stops being
  // honored within that window — a real security property). Dev/test uses a
  // longer cache so the Playwright e2e-ui suite, which drives one session per
  // user for the whole >5min run, doesn't fall through to a per-request D1
  // findSession that flakes to 401 under late-run parallel load.
  it("caps the prod cookie cache at 5min but widens it in dev", async () => {
    const createAuth = await loadCreateAuth()
    const prod = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const dev = (createAuth(makeEnv({ NODE_ENV: "development" }) as never) as { __options: AuthOptions }).__options
    expect(prod.session?.cookieCache?.maxAge).toBe(5 * 60)
    expect(dev.session?.cookieCache?.maxAge).toBeGreaterThan(5 * 60)
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

describe("createAuth Apple provider", () => {
  it("omits Apple and its trusted origin when all Apple configuration is absent", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv() as never) as { __options: AuthOptions }).__options

    expect(opts.socialProviders).not.toHaveProperty("apple")
    expect(opts.trustedOrigins).not.toContain("https://appleid.apple.com")
    expect(opts.plugins).not.toContainEqual(expect.objectContaining({ id: "apple-oauth-hardening" }))
  })

  it.each(["production", "development"])(
    "enables only the hardened async built-in provider surface in %s",
    async (nodeEnv) => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({
      NODE_ENV: nodeEnv,
      APPLE_CLIENT_ID: "ai.alook.web",
      APPLE_TEAM_ID: "TEAM123456",
      APPLE_KEY_ID: "KEY1234567",
      APPLE_PRIVATE_KEY: "test-private-key-shape-is-validated-on-provider-use",
    }) as never) as { __options: AuthOptions }).__options

    expect(opts.socialProviders?.apple).toEqual(expect.any(Function))
    expect(opts.trustedOrigins).toEqual(["https://appleid.apple.com"])
    expect(opts.plugins).toContainEqual(expect.objectContaining({ id: "apple-oauth-hardening" }))

    const createAppleProvider = opts.socialProviders?.apple as () => Promise<{
      clientId: string
      clientSecret: string
      mapProfileToUser: (profile: {
        sub: string
        email?: string
        email_verified?: boolean | string
      }) => Promise<{ email?: string; emailVerified?: boolean; name?: string }>
    }>
    const provider = await createAppleProvider()
    expect(provider).toMatchObject({
      clientId: "ai.alook.web",
      clientSecret: "signed-apple-client-secret",
    })
    queueSelectResponse([{
      email: "stored@example.com",
      emailVerified: true,
      name: "Stored Person",
    }])
    await expect(provider.mapProfileToUser({ sub: "returning-sub" })).resolves.toEqual({
      email: "stored@example.com",
      emailVerified: true,
      name: "Stored Person",
    })
    expect(appleMocks.generateClientSecret).toHaveBeenCalled()
  })

  it("fails closed before Better Auth initializes when configuration is partial", async () => {
    const createAuth = await loadCreateAuth()
    expect(() => createAuth(makeEnv({ APPLE_CLIENT_ID: "ai.alook.web" }) as never))
      .toThrow("Apple authentication configuration is incomplete")
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

  it("sets method=apple for apple callback path", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as { __options: AuthOptions }).__options
    const afterHook = opts.databaseHooks!.user!.create!.after!
    const ctx = makeCtx("http://localhost:3000/api/auth/callback/apple")
    await afterHook({ id: "u-apple" }, ctx)
    expect(ctx.setCookie).toHaveBeenCalledWith("is_new_signup", "apple", expect.anything())
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

describe("createAuth databaseHooks — session.create.after", () => {
  beforeEach(() => vi.clearAllMocks())

  it("sets is_sign_in cookie with method=apple for an Apple callback", async () => {
    const createAuth = await loadCreateAuth()
    const opts = (createAuth(makeEnv({ NODE_ENV: "production" }) as never) as {
      __options: AuthOptions
    }).__options
    const afterHook = opts.databaseHooks!.session!.create!.after!
    const ctx = {
      request: { url: "http://localhost:3000/api/auth/callback/apple" },
      getCookie: vi.fn(() => undefined),
      setCookie: vi.fn(),
    }

    await afterHook({ id: "session-apple", userId: "u-apple" }, ctx)

    expect(ctx.setCookie).toHaveBeenCalledWith(
      "is_sign_in",
      "apple",
      expect.objectContaining({ maxAge: 60 }),
    )
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
    // Salt scheme is now `id:width:attempt`; the first retry stays at width 4.
    expect(result.data.discriminator).toBe(computeDiscriminator("u_collide:4:1", 4))
    expect(result.data.discriminator).toMatch(/^\d{4}$/)
  })
})
