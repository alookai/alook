import { headers } from "next/headers"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getAuth, observeAuthSession } from "@/lib/auth"

export async function getSession() {
  const { env } = await getCloudflareContext({ async: true })
  const auth = getAuth(env as Env)
  const requestHeaders = await headers()
  return observeAuthSession(auth, () => auth.api.getSession({ headers: requestHeaders }))
}

export async function requireSession() {
  const session = await getSession()
  if (!session) throw new Error("Unauthorized")
  return session
}
