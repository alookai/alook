"use client"

import { useEffect, type ReactNode } from "react"
import { usePathname, useRouter } from "next/navigation"
import { CommunityShell } from "./community-shell"
import { SignupTracker } from "@/components/signup-tracker"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { AuthenticatedContextMenuBoundary } from "@/components/authenticated-context-menu-boundary"
import { AuthenticatedNativeOauthCleanup } from "@/components/authenticated-native-oauth-cleanup"
import {
  clearCommunityColdEntryAttempts,
  retireCommunityColdEntryAttempt,
} from "@/lib/community/last-community-route"
import type { CurrentUser } from "@/contexts/community/current-user"

function isPublicCommunityPath(pathname: string): boolean {
  return resolveCommunityModulePlan(pathname).route === "public-invite"
}

export function CommunityLayoutClient({
  children,
  currentUser,
}: {
  children: ReactNode
  currentUser: CurrentUser | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const isPublic = isPublicCommunityPath(pathname)

  useEffect(() => {
    if (!isPublic && !currentUser) router.replace("/sign-in")
  }, [currentUser, isPublic, router])

  useEffect(() => {
    if (!currentUser) {
      clearCommunityColdEntryAttempts()
      return
    }
    retireCommunityColdEntryAttempt(currentUser.id, pathname)
  }, [currentUser, pathname])

  if (isPublic) return <><SignupTracker />{children}</>
  if (!currentUser) return <CommunitySessionPendingFrame pathname={pathname} />

  return (
    <AuthenticatedContextMenuBoundary>
      <AuthenticatedNativeOauthCleanup />
      <SignupTracker redirectTo="/c/me/machines" />
      <CommunityShell currentUser={currentUser}>{children}</CommunityShell>
    </AuthenticatedContextMenuBoundary>
  )
}
