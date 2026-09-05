"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useSession } from "@/lib/auth-client"
import { CommunityShell } from "./community-shell"
import { avatarInitial } from "@/lib/community/avatar"
import { SignupTracker } from "@/components/signup-tracker"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { AuthenticatedContextMenuBoundary } from "@/components/authenticated-context-menu-boundary"
import {
  clearCommunityColdEntryAttempts,
  retireCommunityColdEntryAttempt,
} from "@/lib/community/last-community-route"
import { cacheCommunityShellRoute } from "@/lib/community/replica/shell"
import {
  clearActiveCommunityReplicaSession,
  markCommunityReplicaShellRoute,
} from "@/lib/community/replica/session"
import { useCommunityReplicaLaunch } from "@/hooks/community/replica/use-community-replica-launch"

// The invite landing page is preview-first: a logged-out visitor must be able
// to see it (and only hit the login wall on Join). It's a standalone
// full-screen page that doesn't use CommunityShell (which requires a
// logged-in user), so it's exempt from this layout's session gate AND the
// shell — its own middleware exemption keeps the server side public. Keep the
// client bypass exact so malformed invite descendants do not inherit it.
function isPublicCommunityPath(pathname: string): boolean {
  return resolveCommunityModulePlan(pathname).route === "public-invite"
}

export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [initialPathname] = useState(pathname)
  const isPublic = isPublicCommunityPath(pathname)
  const { data: session, isPending, error: sessionError } = useSession()
  const sessionUserId = session?.user.id
  const replica = useCommunityReplicaLaunch(pathname)
  const replicaRoutePlan = resolveCommunityModulePlan(pathname)
  const replicaServerId = replicaRoutePlan.main.kind === "server-conversation"
    || replicaRoutePlan.main.kind === "server-landing"
    ? replicaRoutePlan.main.serverId
    : undefined
  const localLaunch = replica.launch && (!sessionUserId || replica.launch.user.id === sessionUserId)
    ? replica.launch
    : null
  const canUseLocalIdentity = (isPending || sessionError) && localLaunch

  useEffect(() => {
    if (!isPublic && !isPending && !session && !sessionError) {
      void clearActiveCommunityReplicaSession()
      router.replace("/sign-in")
    }
  }, [isPublic, isPending, session, sessionError, router])

  useEffect(() => {
    if (isPending || sessionError) return
    if (!sessionUserId) {
      clearCommunityColdEntryAttempts()
      return
    }
    retireCommunityColdEntryAttempt(sessionUserId, pathname)
  }, [isPending, pathname, sessionError, sessionUserId])

  useEffect(() => {
    const accountId = sessionUserId ?? canUseLocalIdentity?.user.id
    if (isPublic || !accountId || typeof window === "undefined") return
    void cacheCommunityShellRoute(window.location.href).then((result) => {
      if (result.ok) return markCommunityReplicaShellRoute(accountId, pathname)
    })
  }, [canUseLocalIdentity?.user.id, isPublic, pathname, sessionUserId])

  // Public community pages (invite landing) render standalone — no session
  // gate, no CommunityShell (a logged-out visitor has no currentUser).
  if (isPublic) return <><SignupTracker />{children}</>

  if (
    (!session && !canUseLocalIdentity)
    || (replica.loading && (isPending || pathname === initialPathname))
  ) {
    return <CommunitySessionPendingFrame pathname={pathname} />
  }

  const currentUser = session ? {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    avatar: session.user.image || avatarInitial(session.user.name),
    avatarVersion: 0,
  } : canUseLocalIdentity!.user

  return (
    <AuthenticatedContextMenuBoundary>
      <SignupTracker redirectTo="/c/me/machines" />
      <CommunityShell
        currentUser={currentUser}
        replicaProjection={localLaunch?.projection ?? null}
        replicaIntents={localLaunch?.intents}
        replicaServerId={replicaServerId}
      >
        {children}
      </CommunityShell>
    </AuthenticatedContextMenuBoundary>
  )
}
