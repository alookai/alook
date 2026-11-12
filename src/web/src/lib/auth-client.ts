"use client"
import { beginSessionSignOut } from "./session-transport"
import { authClient } from "./auth-session"
export { authClient, signIn, signUp, useSession, currentSessionViewer } from "./auth-session"
import { captureTelemetryIdentityRetirement } from "@/lib/observability/client"
import {
  resumeMobileSystemNotificationRegistration,
  suspendMobileSystemNotificationRegistration,
  unregisterCurrentMobileSystemNotification,
} from "@/lib/community/mobile-system-notification"

async function signOutOriginal(assertOriginal: () => void, args: Parameters<typeof authClient.signOut>) {
  const options = { ...args[1], ...args[0]?.fetchOptions }
  const assertActive = () => { if (options?.signal?.aborted) throw new DOMException("Retired sign-out", "AbortError"); assertOriginal() }
  assertActive()
  const lease = beginSessionSignOut(assertActive)
  const finishTelemetrySignOut = captureTelemetryIdentityRetirement()
  suspendMobileSystemNotificationRegistration()
  try {
    await lease.drain(options?.signal ?? undefined)
    await unregisterCurrentMobileSystemNotification(lease.fetch, { signal: options?.signal ?? undefined, assertActive }).catch(() => { assertActive() })
    assertActive()
    const result = await authClient.signOut({ ...args[0], fetchOptions: { ...options, customFetchImpl: lease.fetch } })
    if ("error" in result && result.error) { assertActive(); resumeMobileSystemNotificationRegistration() }
    else { assertActive(); finishTelemetrySignOut() }
    return result
  } catch (error) {
    try { assertActive(); resumeMobileSystemNotificationRegistration() } catch {}
    throw error
  } finally { lease.release() }
}

export const signOut = ((...args: Parameters<typeof authClient.signOut>) => signOutOriginal(() => undefined, args)) as typeof authClient.signOut
export const signOutWithOrigin = (assertActive: () => void, ...args: Parameters<typeof authClient.signOut>) => signOutOriginal(assertActive, args)
