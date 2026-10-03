"use client"

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react"
import type { Presence } from "@/lib/community/models/people"
import {
  useCanonicalCommunityProfile,
} from "@/lib/community-db/projections"

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

const CurrentUserContext = createContext<Pick<CurrentUser, "id" | "email"> | null>(null)

export function CurrentUserProvider({ initialUser, children }: { initialUser: CurrentUser; children: ReactNode }) {
  const identity = useMemo(() => ({ id: initialUser.id, email: initialUser.email }), [initialUser.id, initialUser.email])
  return <CurrentUserContext.Provider value={identity}>{children}</CurrentUserContext.Provider>
}


export function useCurrentUser(): CurrentUser {
  const ctx = useContext(CurrentUserContext)
  const profile = useCanonicalCommunityProfile(ctx?.id)
  if (!ctx)
    throw new Error("useCurrentUser must be used within CurrentUserProvider")
  return useMemo(() => ({
    id: ctx.id,
    email: ctx.email,
    name: profile?.name ?? "",
    avatar: profile?.avatar ?? "",
    avatarVersion: profile?.avatarVersion,
    aboutMe: profile?.aboutMe,
    discriminator: profile?.discriminator,
    statusEmoji: profile?.statusEmoji,
    statusText: profile?.statusText,
    presence: profile?.presence,
  }), [ctx, profile])
}
