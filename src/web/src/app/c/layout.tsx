import type { ReactNode } from "react"
import { getSession } from "@/lib/session"
import { avatarInitial } from "@/lib/community/avatar"
import { CommunityLayoutClient } from "./community-layout-client"

export default async function CommunityLayout({ children }: { children: ReactNode }) {
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
    <CommunityLayoutClient currentUser={currentUser}>
      {children}
    </CommunityLayoutClient>
  )
}
