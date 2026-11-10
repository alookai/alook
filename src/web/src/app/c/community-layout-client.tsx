"use client"

import { useEffect, useState, type ComponentType } from "react"
import { notFound, usePathname, useRouter, useSearchParams } from "next/navigation"
import { authClient, useSession } from "@/lib/auth-session"
import { capturePersistedAccountIdentity } from "@/lib/persisted-account-identity"
import { isRejectedSession } from "@/lib/session-rejection"
import { CommunityAccountPendingFrame } from "@/components/community/shell/community-account-pending-frame"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { Button } from "@/components/ui/button"
import { useHydratedClient } from "@/components/community/shell/use-hydrated-client"
import { clearCommunityColdEntryAttempts, retireCommunityColdEntryAttempt } from "@/lib/community/last-community-route"
import { CommunityApplicationNavigation } from "@/contexts/community/application-navigation"
import type { PersistedAccountIdentity } from "@/lib/query-persister"

export function CommunityLayoutClient() {
  const hydrated = useHydratedClient()
  const pathname = usePathname()
  if (!hydrated) return <CommunityAccountPendingFrame pathname="/c" />
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
  const rejected = isRejectedSession(session.error)
  const ready = !session.isPending && !session.error
  const confirmedId = ready && user && !invalid ? user.id : undefined
  const confirmedEmail = confirmedId ? user!.email : undefined
  const authoritative = ready || rejected || invalid
  const [localIdentity, setLocalIdentity] = useState<PersistedAccountIdentity>()
  const currentUser = authoritative
    ? confirmedId && confirmedEmail ? { id: confirmedId, email: confirmedEmail } : undefined
    : localIdentity
  const search = searchParams.toString()
  const currentUserId = currentUser?.id
  const [retry, setRetry] = useState(0)
  const [signOutFailed, setSignOutFailed] = useState(false)
  const [entry, setEntry] = useState<{ Component?: ComponentType<{ currentUser: PersistedAccountIdentity; confirmedAccountId?: string }>; failed: boolean }>({ failed: false })

  useEffect(() => {
    if (!currentUserId || entry.Component) return
    let active = true
    setEntry({ failed: false })
    void import("./community-authenticated-entry").then(module => {
      if (active) setEntry({ Component: module.CommunityAuthenticatedEntry, failed: false })
    }).catch(() => { if (active) setEntry({ failed: true }) })
    return () => { active = false }
  }, [currentUserId, entry.Component])

  useEffect(() => {
    if (authoritative) {
      setLocalIdentity(confirmedId && confirmedEmail ? { id: confirmedId, email: confirmedEmail } : undefined)
      return
    }
    let active = true
    void capturePersistedAccountIdentity().then(origin => origin
      ? import("@/lib/query-persister").then(module => module.readPersistedAccountIdentity()) : undefined).then(identity => {
      if (active) setLocalIdentity(previous => previous ?? identity)
    }).catch(() => undefined)
    return () => { active = false }
  }, [authoritative, confirmedEmail, confirmedId, retry])

  useEffect(() => {
    if (!authoritative || currentUserId) return
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
  }, [authoritative, currentUserId, invalid, pathname, retry, router, search])

  useEffect(() => {
    if (currentUserId) retireCommunityColdEntryAttempt(currentUserId, pathname)
  }, [currentUserId, pathname])

  if (!currentUser) return <CommunityAccountPendingFrame pathname={pathname}>
    {session.error || signOutFailed ? <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8" role="alert">
      <p>Couldn&apos;t check your account.</p>
      <Button variant="outline" onClick={() => { setRetry(value => value + 1); void session.refetch() }}>Retry</Button>
    </div> : undefined}
  </CommunityAccountPendingFrame>

  if (!entry.Component) return <CommunityAccountPendingFrame pathname={pathname}>
    {entry.failed ? <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8" role="alert">
      <p>Couldn&apos;t load the app.</p>
      <Button variant="outline" onClick={() => window.location.reload()}>Reload</Button>
    </div> : undefined}
  </CommunityAccountPendingFrame>

  return <entry.Component key={currentUser.id} currentUser={currentUser} confirmedAccountId={confirmedId} />
}
