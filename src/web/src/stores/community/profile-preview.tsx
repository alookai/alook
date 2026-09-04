"use client"

import { createContext, useContext, type Context, type ReactNode } from "react"
import type { CommunityProfile } from "@/lib/community/models/people"

type PreviewProfiles = ReadonlyMap<string, CommunityProfile>

let communityPreviewProfilesContext: Context<PreviewProfiles | null> | undefined

function getCommunityPreviewProfilesContext() {
  communityPreviewProfilesContext ??= createContext<PreviewProfiles | null>(null)
  return communityPreviewProfilesContext
}

export function CommunityPreviewProfileOwner({
  profiles,
  children,
}: {
  profiles: PreviewProfiles
  children: ReactNode
}) {
  const CommunityPreviewProfilesContext = getCommunityPreviewProfilesContext()
  return (
    <CommunityPreviewProfilesContext.Provider value={profiles}>
      {children}
    </CommunityPreviewProfilesContext.Provider>
  )
}

export function useCommunityPreviewProfiles() {
  return useContext(getCommunityPreviewProfilesContext())
}
