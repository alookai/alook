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

export const signOut: typeof authClient.signOut = async (...args) => {
  suspendMobileSystemNotificationRegistration()
  await unregisterCurrentMobileSystemNotification().catch(() => undefined)
  try {
    const result = await authClient.signOut(...args)
    if ("error" in result && result.error) resumeMobileSystemNotificationRegistration()
    return result
  } catch (error) {
    resumeMobileSystemNotificationRegistration()
    throw error
  }
}
