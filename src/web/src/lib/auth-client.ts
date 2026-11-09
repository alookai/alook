"use client"
import { authClient } from "./auth-session"
export { authClient, signIn, signUp, useSession, currentSessionViewer } from "./auth-session"
import { captureTelemetryIdentityRetirement } from "@/lib/observability/client"
import {
  resumeMobileSystemNotificationRegistration,
  suspendMobileSystemNotificationRegistration,
  unregisterCurrentMobileSystemNotification,
} from "@/lib/community/mobile-system-notification"

async function signOutOriginal(assertOriginal: () => void, args: Parameters<typeof authClient.signOut>) {
  const options = args[0]?.fetchOptions ?? args[1]
  const assertActive = () => { if (options?.signal?.aborted) throw new DOMException("Retired sign-out", "AbortError"); assertOriginal() }
  assertActive()
  const finishTelemetrySignOut = captureTelemetryIdentityRetirement()
  suspendMobileSystemNotificationRegistration()
  try {
    await unregisterCurrentMobileSystemNotification(fetch, { signal: options?.signal ?? undefined, assertActive }).catch(() => { assertActive() })
    assertActive()
    const result = await authClient.signOut(...args)
    if ("error" in result && result.error) { assertActive(); resumeMobileSystemNotificationRegistration() }
    else { assertActive(); finishTelemetrySignOut() }
    return result
  } catch (error) {
    try { assertActive(); resumeMobileSystemNotificationRegistration() } catch {}
    throw error
  }
}

export const signOut = ((...args: Parameters<typeof authClient.signOut>) => signOutOriginal(() => undefined, args)) as typeof authClient.signOut
export const signOutWithOrigin = (assertActive: () => void, ...args: Parameters<typeof authClient.signOut>) => signOutOriginal(assertActive, args)
