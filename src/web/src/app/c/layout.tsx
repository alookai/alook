"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useSession } from "@/lib/auth-client"
import { CommunityShell } from "./community-shell"
import { avatarInitial } from "@/lib/community/avatar"
import { SignupTracker } from "@/components/signup-tracker"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { AuthenticatedContextMenuBoundary } from "@/components/authenticated-context-menu-boundary"

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
  const isPublic = isPublicCommunityPath(pathname)
  const { data: session, isPending } = useSession()

  useEffect(() => {
    if (!isPublic && !isPending && !session) {
      router.replace("/sign-in")
    }
  }, [isPublic, isPending, session, router])

  // Public community pages (invite landing) render standalone — no session
  // gate, no CommunityShell (a logged-out visitor has no currentUser).
  if (isPublic) return <><SignupTracker />{children}</>

  if (isPending || !session) return <CommunitySessionPendingFrame pathname={pathname} />

  const currentUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    avatar: session.user.image || avatarInitial(session.user.name),
    avatarVersion: 0,
  }

  return (
    <AuthenticatedContextMenuBoundary>
      <SignupTracker redirectTo="/c/me/machines" />
      <CommunityShell currentUser={currentUser}>{children}</CommunityShell>
    </AuthenticatedContextMenuBoundary>
  )
}
