import { Suspense, type ReactNode } from "react"
import { getSession } from "@/lib/session"
import { avatarInitial } from "@/lib/community/avatar"
import { headers } from "next/headers"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDb, getPrimaryDb } from "@/lib/db"
import { readCommunitySelfProfile } from "@/lib/community/self-profile.server"
import { readCommunityDocumentSeed } from "@/lib/community/document-seed.server"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { COMMUNITY_DOCUMENT_ROUTE_HEADER, readCommunityDocumentRoute } from "@/lib/community/document-route"
import { CommunityLayoutClient } from "./community-layout-client"
import { CommunitySessionFallback } from "./community-session-fallback"

type CommunityLayoutProps = { children: ReactNode; sidebar: ReactNode }

export default function CommunityLayout({ children, sidebar }: CommunityLayoutProps) {
  return (
    <Suspense fallback={<CommunitySessionFallback />}>
      <CommunitySessionLayout sidebar={sidebar}>{children}</CommunitySessionLayout>
    </Suspense>
  )
}

async function CommunitySessionLayout({ children, sidebar }: CommunityLayoutProps) {
  const session = await getSession()
  // Match the REST session guard; flags retain the existing cookie-cache freshness.
  const authenticated = session && session.user.isBot !== true && (session.user.deletedAt ?? null) === null
    ? await loadDocument(session.user.id) : null
  const currentUser = authenticated?.viewer ? {
    ...authenticated.seed.selfProfile,
    email: authenticated.viewer.email,
    avatar: authenticated.seed.selfProfile.avatar || avatarInitial(authenticated.seed.selfProfile.name),
  } : null

  return (
    <CommunityLayoutClient currentUser={currentUser} initialSeed={authenticated?.seed} sidebar={sidebar}>
      {children}
    </CommunityLayoutClient>
  )
}

async function loadDocument(viewerId: string) {
  const [{ env }, requestHeaders] = await Promise.all([getCloudflareContext({ async: true }), headers()])
  const href = readCommunityDocumentRoute(requestHeaders.get(COMMUNITY_DOCUMENT_ROUTE_HEADER))
  const kind = href ? resolveCommunityModulePlan(href).main.kind : "none"
  const db = kind === "machines" || kind === "bots" ? getPrimaryDb(env.DB) : getDb(env.DB)
  const { viewer, profile } = await readCommunitySelfProfile(db, viewerId)
  if (!viewer) return null
  return { viewer, seed: await readCommunityDocumentSeed(db, viewerId, href, profile) }
}
