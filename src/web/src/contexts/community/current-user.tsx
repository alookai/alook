"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

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
  aboutMe?: string
  // 4-digit discriminator (`"0042"`). Hydrated alongside `aboutMe` from
  // /api/community/users/me/profile — see CommunityBootstrap.
  discriminator?: string
}

type CurrentUserContextValue = {
  currentUser: CurrentUser
  setCurrentUser: (fn: (u: CurrentUser) => CurrentUser) => void
}

const CurrentUserContext = createContext<CurrentUserContextValue | null>(null)

export function CurrentUserProvider({
  initialUser,
  children,
}: {
  initialUser: CurrentUser
  children: ReactNode
}) {
  const [currentUser, setCurrentUserState] = useState<CurrentUser>(initialUser)
  // `setCurrentUser` MUST keep a stable identity across renders. If it
  // changes each render (e.g., inlined into `useMemo` deps on `currentUser`),
  // consumers that put it in a dep array — like `CommunityShell`'s aboutMe
  // hydration effect — will re-fire on every state change and can loop.
  const setCurrentUser = useCallback(
    (fn: (u: CurrentUser) => CurrentUser) => setCurrentUserState((u) => fn(u)),
    [],
  )
  const value = useMemo<CurrentUserContextValue>(
    () => ({ currentUser, setCurrentUser }),
    [currentUser, setCurrentUser],
  )
  return (
    <CurrentUserContext.Provider value={value}>
      {children}
    </CurrentUserContext.Provider>
  )
}

export function useCurrentUser(): CurrentUser {
  const ctx = useContext(CurrentUserContext)
  if (!ctx)
    throw new Error("useCurrentUser must be used within CurrentUserProvider")
  return ctx.currentUser
}

export function useSetCurrentUser(): (fn: (u: CurrentUser) => CurrentUser) => void {
  const ctx = useContext(CurrentUserContext)
  if (!ctx)
    throw new Error("useSetCurrentUser must be used within CurrentUserProvider")
  return ctx.setCurrentUser
}
