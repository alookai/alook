import { betterAuth } from "better-auth"
import { emailOTP } from "better-auth/plugins"
import { createLogger, DEV_EMAIL_WORKER_URL } from "@alook/shared"
import { getOtpSubject, renderOtpEmail } from "./email-templates"

const isProd = process.env.NODE_ENV === "production"
const log = createLogger({ service: "auth" })

export function createAuth(env: Env) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
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
    plugins: isProd
      ? [
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
      : [],
  })
}
