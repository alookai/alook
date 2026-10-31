import { cookies } from "next/headers"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { resolveMode } from "@alook/shared"
import { resolveAppleAuthConfig } from "@/lib/apple-auth"
import { LAST_LOGIN_METHOD_COOKIE, normalizeLoginMethod } from "@/lib/last-login-method"
import SignInPageClient from "./sign-in-client"

export default async function SignInPage() {
  const [{ env }, cookieStore] = await Promise.all([
    getCloudflareContext({ async: true }),
    cookies(),
  ])
  const mode = resolveMode({ nodeEnv: env.NODE_ENV ?? process.env.NODE_ENV })
  const isProd = mode === "production" || (mode === "dev" && env.DEV_AUTH_OTP === "1")
  const appleEnabled = resolveAppleAuthConfig(env).enabled
  const initialLastUsedMethod = normalizeLoginMethod(
    cookieStore.get(LAST_LOGIN_METHOD_COOKIE)?.value,
  )

  return (
    <SignInPageClient
      isProd={isProd}
      appleEnabled={appleEnabled}
      initialLastUsedMethod={initialLastUsedMethod}
    />
  )
}
