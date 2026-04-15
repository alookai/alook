import { betterAuth } from "better-auth"
import { emailOTP } from "better-auth/plugins"
import { getOtpSubject, renderOtpEmail } from "./email-templates"

const isOtp = (env: Env) => env.AUTH_MODE === "otp"

export function createAuth(env: Env) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: !isOtp(env),
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
    plugins: isOtp(env)
      ? [
          emailOTP({
            async sendVerificationOTP({ email, otp, type }) {
              await env.SEND_EMAIL.send({
                from: "no-reply@alook.ai",
                to: email,
                subject: getOtpSubject(type),
                html: renderOtpEmail(otp, type),
              })
            },
          }),
        ]
      : [],
  })
}
