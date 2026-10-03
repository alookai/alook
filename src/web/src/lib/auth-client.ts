"use client"
import { createAuthClient } from "better-auth/react"
import { emailOTPClient, deviceAuthorizationClient } from "better-auth/client/plugins"
import {
  resumeMobileSystemNotificationRegistration,
  suspendMobileSystemNotificationRegistration,
  unregisterCurrentMobileSystemNotification,
} from "@/lib/community/mobile-system-notification"

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL || "",
  plugins: [emailOTPClient(), deviceAuthorizationClient()],
})

export const { signIn, signUp, useSession } = authClient
export function currentSessionViewer() {
  const session = authClient.$store.atoms.session.get()
  return session.isPending || session.error ? undefined : session.data?.user.id ?? null
}

async function signOutOriginal(assertOriginal: () => void, args: Parameters<typeof authClient.signOut>) {
  const options = args[0]?.fetchOptions ?? args[1]
  const assertActive = () => { if (options?.signal?.aborted) throw new DOMException("Retired sign-out", "AbortError"); assertOriginal() }
  assertActive()
  suspendMobileSystemNotificationRegistration()
  try {
    await unregisterCurrentMobileSystemNotification(fetch, { signal: options?.signal ?? undefined, assertActive }).catch(() => { assertActive() })
    assertActive()
    const result = await authClient.signOut(...args)
    if ("error" in result && result.error) { assertActive(); resumeMobileSystemNotificationRegistration() }
    return result
  } catch (error) {
    try { assertActive(); resumeMobileSystemNotificationRegistration() } catch {}
    throw error
  }
}

export const signOut = ((...args: Parameters<typeof authClient.signOut>) => signOutOriginal(() => undefined, args)) as typeof authClient.signOut
export const signOutWithOrigin = (assertActive: () => void, ...args: Parameters<typeof authClient.signOut>) => signOutOriginal(assertActive, args)
