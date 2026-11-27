"use client"
import { beginSessionSignOut } from "./session-transport"
import { authClient, currentSessionViewer } from "./auth-session"
export { authClient, signIn, signUp, useSession, currentSessionViewer } from "./auth-session"
import { PUSH_INSTALLATION_ID_HEADER } from "@/lib/community/notification-device-schema"
import {
  readPendingMobileSystemNotificationUnregistration,
  resumeMobileSystemNotificationRegistration,
  suspendMobileSystemNotificationRegistration,
  unregisterCurrentMobileSystemNotification,
} from "@/lib/community/mobile-system-notification"

type SignOutHeaders = NonNullable<Parameters<typeof authClient.signOut>[1]>["headers"]

function mergeSignOutHeaders(existing: SignOutHeaders, installationId: string): SignOutHeaders {
  if (!existing) return { [PUSH_INSTALLATION_ID_HEADER]: installationId }
  if (existing instanceof Headers) {
    const headers = new Headers(existing)
    headers.set(PUSH_INSTALLATION_ID_HEADER, installationId)
    return headers
  }
  return { ...existing, [PUSH_INSTALLATION_ID_HEADER]: installationId }
}

async function signOutOriginal(assertOriginal: () => void, args: Parameters<typeof authClient.signOut>) {
  const options = { ...args[1], ...args[0]?.fetchOptions }
  const assertActive = () => { if (options?.signal?.aborted) throw new DOMException("Retired sign-out", "AbortError"); assertOriginal() }
  assertActive()
  let accountId: string | undefined
  try { accountId = currentSessionViewer() ?? undefined } catch { accountId = undefined }
  const lease = beginSessionSignOut(assertActive)
  suspendMobileSystemNotificationRegistration()
  try {
    await lease.drain(options?.signal ?? undefined)
    const installationId = await unregisterCurrentMobileSystemNotification(lease.fetch, {
      signal: options?.signal ?? undefined,
      assertActive,
      accountId,
    }).catch(() => {
      assertActive()
      return readPendingMobileSystemNotificationUnregistration()?.installationId
    })
    assertActive()
    const headers = installationId
      ? mergeSignOutHeaders(options?.headers, installationId)
      : options?.headers
    const result = await authClient.signOut({
      ...args[0],
      fetchOptions: {
        ...options,
        ...(headers !== undefined ? { headers } : {}),
        customFetchImpl: lease.fetch,
      },
    })
    if ("error" in result && result.error) { assertActive(); resumeMobileSystemNotificationRegistration() }
    else { assertActive() }
    return result
  } catch (error) {
    try { assertActive(); resumeMobileSystemNotificationRegistration() } catch {}
    throw error
  } finally { lease.release() }
}

export const signOut = ((...args: Parameters<typeof authClient.signOut>) => signOutOriginal(() => undefined, args)) as typeof authClient.signOut
export const signOutWithOrigin = (assertActive: () => void, ...args: Parameters<typeof authClient.signOut>) => signOutOriginal(assertActive, args)
