import { getCloudflareContext } from "@opennextjs/cloudflare"
import { resolveMode } from "@alook/shared"
import { resolveAppleAuthConfig } from "@/lib/apple-auth"
import SignInPageClient from "./sign-in-client"

export default async function SignInPage() {
  const { env } = await getCloudflareContext({ async: true })
  const mode = resolveMode({ nodeEnv: env.NODE_ENV ?? process.env.NODE_ENV })
  const isProd = mode === "production"
  const appleEnabled = resolveAppleAuthConfig(env).enabled

  return <SignInPageClient isProd={isProd} appleEnabled={appleEnabled} />
}
