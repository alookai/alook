import { Suspense, type ReactNode } from "react"
import { getSession } from "@/lib/session"
import { avatarInitial } from "@/lib/community/avatar"
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
  const currentUser = session
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        avatar: session.user.image || avatarInitial(session.user.name),
        avatarVersion: 0,
      }
    : null

  return (
    <CommunityLayoutClient currentUser={currentUser} sidebar={sidebar}>
      {children}
    </CommunityLayoutClient>
  )
}
