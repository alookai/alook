"use client"

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react"
import type { Presence } from "@/lib/community/models/people"
import {
  useCommunityProfile,
  useCommunityWsStore,
} from "@/stores/community/ws"

/**
 * Thin context that carries the viewer's identity down the community tree.
 *
 * The community layout server-loads the session and drops the initial user
 * into this provider. Consumers read the current user (and can patch the
 * cached `aboutMe` after a profile mutation) without touching the giant
 * community context that used to own everything.
 *
 * NOTE: This exists because the identity isn't a fetched resource — it's a
 * prop that arrives from the layout's `useSession()` call. Moving it into a
 * TanStack Query would either duplicate the auth session hook or force every
 * consumer to gate on a loading flag that never actually flips in practice.
 */
export type CurrentUser = {
  id: string
  name: string
  email: string
  avatar: string
  avatarVersion?: number
  aboutMe?: string
  // 4-digit discriminator (`"0042"`). Hydrated alongside `aboutMe` from
  // /api/community/users/me/profile — see CommunityBootstrap.
  discriminator?: string
  // Custom status (emoji + short term), hydrated alongside `aboutMe`/
  // `discriminator`. See `hasStatus()` in status-presets.ts for the "is a
  // status set" check — don't test either field's truthiness alone.
  statusEmoji?: string | null
  statusText?: string | null
  presence?: Presence
}

const CurrentUserContext = createContext<CurrentUser | null>(null)

export function CurrentUserProvider({
  initialUser,
  children,
}: {
  initialUser: CurrentUser
  children: ReactNode
}) {
  const current = useCommunityProfile(initialUser.id)
  useLayoutEffect(() => {
    if (current?.name !== undefined && current.avatarVersion !== undefined) return
    const profiles = useCommunityWsStore.getState()
    profiles.seedProfiles(profiles.beginProfileSnapshot(), [{
      id: initialUser.id,
      ...(current?.name === undefined
        ? { identityAbout: { name: initialUser.name } }
        : {}),
      ...(current?.avatarVersion === undefined
        ? { avatar: {
            avatar: initialUser.avatar,
            avatarVersion: initialUser.avatarVersion ?? 0,
          } }
        : {}),
    }])
  }, [current?.avatarVersion, current?.name, initialUser])
  return (
    <CurrentUserContext.Provider value={initialUser}>
      {children}
    </CurrentUserContext.Provider>
  )
}

export function useCurrentUser(): CurrentUser {
  const ctx = useContext(CurrentUserContext)
  const profile = useCommunityProfile(ctx?.id)
  if (!ctx)
    throw new Error("useCurrentUser must be used within CurrentUserProvider")
  return useMemo(() => ({
    id: ctx.id,
    email: ctx.email,
    name: profile?.name ?? ctx.name,
    avatar: profile?.avatar ?? ctx.avatar,
    avatarVersion: profile?.avatarVersion ?? ctx.avatarVersion,
    aboutMe: profile?.aboutMe,
    discriminator: profile?.discriminator,
    statusEmoji: profile?.statusEmoji,
    statusText: profile?.statusText,
    presence: profile?.presence,
  }), [ctx, profile])
}
