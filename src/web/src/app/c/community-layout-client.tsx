"use client"

import { useEffect, useState } from "react"
import { notFound, usePathname, useRouter, useSearchParams } from "next/navigation"
import { authClient, useSession } from "@/lib/auth-client"
import { avatarInitial } from "@/lib/community/avatar"
import { CommunityShell } from "./community-shell"
import { CommunityRouteFrame } from "@/components/community/shell/community-route-frame"
import { SignupTracker } from "@/components/signup-tracker"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { AuthenticatedContextMenuBoundary } from "@/components/authenticated-context-menu-boundary"
import { AuthenticatedNativeOauthCleanup } from "@/components/authenticated-native-oauth-cleanup"
import { Button } from "@/components/ui/button"
import { useHydratedClient } from "@/components/community/shell/use-hydrated-client"
import { clearCommunityColdEntryAttempts, retireCommunityColdEntryAttempt } from "@/lib/community/last-community-route"
import type { CurrentUser } from "@/contexts/community/current-user"
import { CommunityApplicationNavigation } from "@/contexts/community/application-navigation"

export function CommunityLayoutClient() {
  const hydrated = useHydratedClient()
  const pathname = usePathname()
  if (!hydrated) return <CommunitySessionPendingFrame pathname="/c" />
  if (resolveCommunityModulePlan(pathname).route === "unknown") notFound()
  return <CommunityApplicationNavigation value={true}><CommunityAccountEntry pathname={pathname} /></CommunityApplicationNavigation>
}

function CommunityAccountEntry({ pathname }: { pathname: string }) {
  const session = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const user = session.data?.user
  const invalid = !!user && (("isBot" in user && user.isBot === true)
    || ("deletedAt" in user && user.deletedAt != null))
  const ready = !session.isPending && !session.error
  const currentUser: CurrentUser | null = ready && user && !invalid ? {
    id: user.id, email: user.email, name: user.name,
    avatar: user.image || avatarInitial(user.name),
    ...("discriminator" in user && typeof user.discriminator === "string" ? { discriminator: user.discriminator } : {}),
  } : null
  const search = searchParams.toString()
  const currentUserId = currentUser?.id
  const [retry, setRetry] = useState(0)
  const [signOutFailed, setSignOutFailed] = useState(false)

  useEffect(() => {
    if (!ready || currentUserId) return
    clearCommunityColdEntryAttempts()
    const destination = `${pathname}${search ? `?${search}` : ""}${window.location.hash}`
    const redirect = () => router.replace(`/sign-in?${new URLSearchParams({ redirect: destination })}`)
    if (!invalid) { redirect(); return }
    let active = true
    setSignOutFailed(false)
    void authClient.signOut().then(result => {
      if (!active) return
      if (result.error) setSignOutFailed(true)
      else redirect()
    }).catch(() => { if (active) setSignOutFailed(true) })
    return () => { active = false }
  }, [currentUserId, invalid, pathname, ready, retry, router, search])

  useEffect(() => {
    if (currentUserId) retireCommunityColdEntryAttempt(currentUserId, pathname)
  }, [currentUserId, pathname])

  if (!currentUser) return <CommunitySessionPendingFrame pathname={pathname}>
    {session.error || signOutFailed ? <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8" role="alert">
      <p>Couldn&apos;t check your account.</p>
      <Button variant="outline" onClick={() => { setRetry(value => value + 1); void session.refetch() }}>Retry</Button>
    </div> : undefined}
  </CommunitySessionPendingFrame>

  return <AuthenticatedContextMenuBoundary>
    <AuthenticatedNativeOauthCleanup />
    <CommunityShell key={currentUser.id} currentUser={currentUser}>
      <SignupTracker redirectTo="/c/me/machines" />
      <CommunityRouteFrame sidebar={null}>{null}</CommunityRouteFrame>
    </CommunityShell>
  </AuthenticatedContextMenuBoundary>
}
