"use client"

import { CommunitySelfProfileReadSchema, parseCommunitySelfProfileRead } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCanonicalProfilesProjection } from "@/lib/community-db/projections"
import { Button } from "@/components/ui/button"

import { useCommunityRuntime } from "@/stores/community/runtime"


import { useEffect, useLayoutEffect, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { loadAndSeedProfiles } from "@/lib/community/profile-seed"
import { QueryProvider } from "./QueryProvider"
import {
  CurrentUserProvider,
  type CurrentUser,
} from "@/contexts/community/current-user"
import { useCommunityWs } from "@/hooks/community/use-community-ws"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"
import { useAccountAttention } from "@/hooks/community/use-account-attention"
import { PerfTraceBootstrap } from "@/components/perf/perf-trace-bootstrap"
import { CommunityOnboardingForm } from "@/components/community/onboarding/community-onboarding-form"
import { CommunityWsReconnectBoundary } from "@/components/community/shell/community-ws-reconnect-overlay"
import { useCommunityWsStore } from "@/stores/community/ws"
import { OwnerServerDeleteRouteGuard } from "@/components/community/shell/owner-server-delete-route-guard"
import { CommunityRestoreBoundary } from "@/components/community/shell/community-restore-bootstrap"
import { CommunitySessionPendingFrame } from "@/components/community/shell/community-session-pending-frame"

const canonicalSelfProfileSchema = CommunitySelfProfileReadSchema.strip()

export function CommunityShell({
  currentUser,
  children,
}: {
  currentUser: CurrentUser
  children: ReactNode
}) {
  return (
    <QueryProvider userId={currentUser.id} initialUser={currentUser}>
      <CommunityRestoreBoundary>
        <ProfileAccountBoundary viewerId={currentUser.id}>
          <CurrentUserProvider initialUser={currentUser}>
            <CommunityBootstrap viewerId={currentUser.id}>{children}</CommunityBootstrap>
          </CurrentUserProvider>
        </ProfileAccountBoundary>
      </CommunityRestoreBoundary>
    </QueryProvider>
  )
}

function ProfileAccountBoundary({
  children,
  viewerId,
}: {
  children: ReactNode
  viewerId: string
}) {
  const communityRuntime = useCommunityRuntime()
  const activeViewerId = useCommunityWsStore((state) => state.profileViewerId)
  const pathname = usePathname()
  useLayoutEffect(() => {
    if (activeViewerId !== viewerId) {
      communityRuntime.ws.actions.activateProfileAccount(viewerId)
    }
  }, [activeViewerId, communityRuntime.ws.actions, viewerId])
  return activeViewerId === viewerId
    ? children
    : <CommunitySessionPendingFrame pathname={pathname} />
}

function CommunityBootstrap({ children, viewerId }: { children: ReactNode; viewerId: string }) {
  const profileQueryClient = useQueryClient()
  const pathname = usePathname()

  useNotificationSettings()
  useAccountAttention()
  useAccountReadState()
  useCommunityWs({ viewerUserId: viewerId })

  const registry = getCommunityDbRegistry(profileQueryClient)
  const projection = useCanonicalProfilesProjection([viewerId])
  const projectedSelf = canonicalSelfProfileSchema.safeParse(projection.resourceProfiles.get(viewerId))
  const selfReady = projection.isReady && !projection.isError && projectedSelf.success && projectedSelf.data.id === viewerId
  const canonicalSelf = canonicalSelfProfileSchema.safeParse(registry?.collections.profiles.get(viewerId))
  const hasCanonicalSelf = canonicalSelf.success && canonicalSelf.data.id === viewerId
  const { isSuccess, isFetching, isError, refetch } = useQuery({
    queryKey: communityKeys.selfProfile(),
    queryFn: async ({ signal }) => {
      const profile = await loadAndSeedProfiles(
      async origin => parseCommunitySelfProfileRead(await apiFetch<unknown>("/api/community/users/me/profile", { ...origin, signal }), viewerId),
      (profile) => [{
        id: profile.id,
        identityAbout: {
          name: profile.name,
          discriminator: profile.discriminator,
          aboutMe: profile.aboutMe,
          bannerColor: profile.bannerColor,
        },
        avatar: {
          avatar: profile.avatar,
          avatarVersion: profile.avatarVersion,
        },
        status: {
          statusEmoji: profile.statusEmoji,
          statusText: profile.statusText,
        },
      }], registry, signal,
      )
      const published = canonicalSelfProfileSchema.parse(registry?.collections.profiles.get(viewerId))
      if (published.id !== viewerId) throw new Error("Self profile publication mismatch")
      return { id: profile.id }
    },
    enabled: registry?.accountId === viewerId,
    staleTime: hasCanonicalSelf ? 5 * 60_000 : 0,
  })

  useEffect(() => {
    if (projection.isReady && !projection.isError && !hasCanonicalSelf && isSuccess && !isFetching) {
      void refetch()
    }
  }, [projection.isReady, projection.isError, hasCanonicalSelf, isSuccess, isFetching, refetch])

  if (!selfReady) {
    const failed = projection.isError || isError
    return (
      <CommunitySessionPendingFrame pathname={pathname}>
        {failed ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8" role="alert">
          <p>Could not load your profile.</p>
          {projection.isError
            ? <Button className="h-11 sm:h-9" onClick={() => window.location.reload()}>Reload</Button>
            : <Button className="h-11 sm:h-9" disabled={isFetching} onClick={() => { void refetch() }}>Try again</Button>}
        </div> : undefined}
      </CommunitySessionPendingFrame>
    )
  }

  return (
    <>
      <PerfTraceBootstrap />
      <CommunityWsReconnectBoundary>
        <OwnerServerDeleteRouteGuard />
        <CommunityOnboardingForm />
        {children}
      </CommunityWsReconnectBoundary>
    </>
  )
}
