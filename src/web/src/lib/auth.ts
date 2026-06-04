import { betterAuth } from "better-auth"
import { emailOTP, deviceAuthorization, bearer } from "better-auth/plugins"
import { createLogger, DEV_EMAIL_WORKER_URL, resolveMode } from "@alook/shared"
import { getOtpSubject, renderOtpEmail } from "./email-templates"

const log = createLogger({ service: "auth" })

const OTP_RATE_LIMIT_PATH = "/email-otp/send-verification-otp"
const DEFAULT_OTP_RATE_LIMIT_MAX = 5
const DEFAULT_OTP_RATE_LIMIT_WINDOW_SEC = 60
const KV_MIN_TTL_SEC = 60

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function createAuth(env: Env) {
  const mode = resolveMode({ nodeEnv: env.NODE_ENV ?? process.env.NODE_ENV })
  const isProd = mode === "production"
  const otpMax = parsePositiveInt(env.AUTH_OTP_RATE_LIMIT_MAX, DEFAULT_OTP_RATE_LIMIT_MAX)
  const otpWindow = parsePositiveInt(
    env.AUTH_OTP_RATE_LIMIT_WINDOW_SEC,
    DEFAULT_OTP_RATE_LIMIT_WINDOW_SEC,
  )
  const kvTtl = Math.max(KV_MIN_TTL_SEC, otpWindow)

  const validateClient = (clientId: string) => {
    const allowed = (env.DEVICE_CLIENT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
    return allowed.includes(clientId)
  }

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    // Signed session-data cookie lets getSession() validate without hitting D1.
    // Fixes first-login 401 for newly-registered users: the just-written user row
    // may not yet be visible on a D1 read-replica, but the signed cookie carries
    // the session payload set by the sign-in handler itself.
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    emailAndPassword: {
      enabled: !isProd,
      requireEmailVerification: false,
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    rateLimit: {
      enabled: isProd,
      customRules: {
        [OTP_RATE_LIMIT_PATH]: { window: otpWindow, max: otpMax },
      },
      customStorage: {
        get: async (key) => {
          const raw = await env.RATE_LIMIT_KV.get(key)
          return raw ? JSON.parse(raw) : undefined
        },
        set: async (key, value) => {
          await env.RATE_LIMIT_KV.put(key, JSON.stringify(value), { expirationTtl: kvTtl })
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user, ctx) => {
            if (!ctx) return
            const path = ctx.request?.url ? new URL(ctx.request.url).pathname : ""
            let method = "unknown"
            if (path.includes("email-otp")) method = "email"
            else if (path.includes("github")) method = "github"
            else if (path.includes("google")) method = "google"
            ctx.setCookie("is_new_signup", method, {
              maxAge: 60,
              path: "/",
              httpOnly: false,
              secure: isProd,
              sameSite: "lax",
            })
          },
        },
      },
    },
    plugins: isProd
      ? [
          deviceAuthorization({ verificationUri: "/device", validateClient, expiresIn: "5m", schema: {} }),
          bearer(),
          emailOTP({
            async sendVerificationOTP({ email, otp, type }) {
              log.info("sending OTP email", { to: email, type })
              try {
                const otpPayload = JSON.stringify({
                  to: email,
                  subject: getOtpSubject(type),
                  html: renderOtpEmail(otp, type),
                })
                const fetchOpts = {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: otpPayload,
                }
                let res: Response
                try {
                  res = await env.EMAIL_WORKER.fetch("http://internal/send/otp", fetchOpts)
                } catch {
                  res = await fetch(`${DEV_EMAIL_WORKER_URL}/send/otp`, fetchOpts)
                }
                if (!res.ok) {
                  const errBody = await res.text()
                  throw new Error(`EMAIL_WORKER /send/otp failed: ${res.status} ${errBody}`)
                }
                log.info("OTP email sent", { to: email, type })
              } catch (err) {
                log.error("OTP email failed", { to: email, type, err })
                throw err
              }
            },
          }),
        ]
      : [
          deviceAuthorization({ verificationUri: "/device", validateClient, expiresIn: "5m", schema: {} }),
          bearer(),
        ],
  })
}
