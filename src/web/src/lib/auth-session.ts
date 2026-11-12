"use client"

import { sessionFetch } from "./session-transport"
import { createAuthClient } from "better-auth/react"
import { emailOTPClient, lastLoginMethodClient } from "better-auth/client/plugins"
import { LAST_LOGIN_METHOD_COOKIE } from "@/lib/last-login-method"
import { capturePersistedAccountIdentity, type AccountIdentityRecord } from "./persisted-account-identity"
import { isRejectedSession } from "./session-rejection"

const accountOrigins = new WeakMap<object, AccountIdentityRecord>()
function isSessionRequest(url: URL | string) {
  return new URL(url, "https://alook.invalid").pathname.endsWith("/get-session")
}
function sessionAccountId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("user" in data)) return undefined
  const user = data.user
  return user && typeof user === "object" && "id" in user && typeof user.id === "string" ? user.id : undefined
}
function rejectsAccount(data: unknown) {
  if (data === null) return true
  if (!data || typeof data !== "object" || !("user" in data)) return false
  const user = data.user
  return user === null || Boolean(user && typeof user === "object" && (("isBot" in user && user.isBot === true) || ("deletedAt" in user && user.deletedAt != null)))
}
async function retireRequestAccount(request: { signal: AbortSignal }) {
  const origin = accountOrigins.get(request)
  accountOrigins.delete(request)
  if (!origin || request.signal.aborted) return
  await import("./query-persister").then(module => module.retirePersistedAccountIdentity(origin, () => {
    if (request.signal.aborted) throw new DOMException("Retired session check", "AbortError")
  })).catch(() => undefined)
}

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL || "",
  fetchOptions: {
    customFetchImpl: sessionFetch(fetch),
    onRequest: async request => {
      if (!isSessionRequest(request.url)) return
      const origin = await capturePersistedAccountIdentity().catch(() => undefined)
      if (origin && !request.signal.aborted) accountOrigins.set(request, origin)
    },
    onSuccess: async ({ request, data }) => {
      const origin = accountOrigins.get(request)
      const viewerId = sessionAccountId(data)
      if (isSessionRequest(request.url) && (rejectsAccount(data) || origin && viewerId && viewerId !== origin.id)) await retireRequestAccount(request)
      else accountOrigins.delete(request)
    },
    onError: async ({ request, error }) => {
      if (isSessionRequest(request.url) && isRejectedSession(error)) await retireRequestAccount(request)
      else accountOrigins.delete(request)
    },
  },
  plugins: [emailOTPClient(), lastLoginMethodClient({ cookieName: LAST_LOGIN_METHOD_COOKIE })],
})

export const { signIn, signUp, useSession } = authClient
export function currentSessionViewer() {
  const session = authClient.$store.atoms.session.get()
  const user = session.data?.user
  if (isRejectedSession(session.error) || user && (("isBot" in user && user.isBot === true)
    || ("deletedAt" in user && user.deletedAt != null))) return null
  return session.isPending || session.error ? undefined : user?.id ?? null
}
