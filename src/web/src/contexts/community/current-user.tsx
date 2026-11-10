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

// Keep layout identity separate from the canonical profile so profile updates
// cannot leave a second cached copy in context.
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

export type CurrentUserIdentity = Pick<CurrentUser, "id" | "email"> & Partial<Omit<CurrentUser, "id" | "email">>

const CurrentUserContext = createContext<Pick<CurrentUser, "id" | "email"> | null>(null)

export function CurrentUserProvider({ initialUser, children }: { initialUser: CurrentUserIdentity; children: ReactNode }) {
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
    discriminator: profile?.discriminator ?? undefined,
    statusEmoji: profile?.statusEmoji,
    statusText: profile?.statusText,
    presence: profile?.presence,
  }), [ctx, profile])
}
