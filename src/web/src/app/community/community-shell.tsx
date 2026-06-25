"use client"

import type { ReactNode } from "react"
import { CommunityProvider, type CurrentUser } from "@/contexts/community/context"

/**
 * Client wrapper that provides the CommunityContext to all community pages.
 * The layout.tsx (server component) handles auth; this handles the client provider.
 */
export function CommunityShell({
  currentUser,
  children,
}: {
  currentUser: CurrentUser
  children: ReactNode
}) {
  return (
    <CommunityProvider currentUser={currentUser}>
      {children}
    </CommunityProvider>
  )
}
