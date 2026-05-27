"use client"
import { createAuthClient } from "better-auth/react"
import { emailOTPClient, deviceAuthorizationClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL || "",
  plugins: [emailOTPClient(), deviceAuthorizationClient()],
})

export const { signIn, signUp, signOut, useSession } = authClient
