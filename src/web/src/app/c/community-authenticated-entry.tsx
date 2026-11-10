"use client"

import { AuthenticatedContextMenuBoundary } from "@/components/authenticated-context-menu-boundary"
import { AuthenticatedNativeOauthCleanup } from "@/components/authenticated-native-oauth-cleanup"
import { CommunityRouteFrame } from "@/components/community/shell/community-route-frame"
import { SignupTracker } from "@/components/signup-tracker"
import type { PersistedAccountIdentity } from "@/lib/query-persister"
import { CommunityShell } from "./community-shell"

export function CommunityAuthenticatedEntry({ currentUser, confirmedAccountId }: { currentUser: PersistedAccountIdentity; confirmedAccountId?: string }) {
  const confirmed = confirmedAccountId === currentUser.id
  return <AuthenticatedContextMenuBoundary>
    {confirmed && <AuthenticatedNativeOauthCleanup />}
    <CommunityShell key={currentUser.id} currentUser={currentUser}>
      {confirmed && <SignupTracker redirectTo="/c/me/machines" />}
      <CommunityRouteFrame sidebar={null}>{null}</CommunityRouteFrame>
    </CommunityShell>
  </AuthenticatedContextMenuBoundary>
}
