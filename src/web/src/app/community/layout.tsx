"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useSession } from "@/lib/auth-client"
import { CommunityShell } from "./community-shell"
import { avatarInitial } from "@/lib/community/avatar"

export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const { data: session, isPending } = useSession()

  useEffect(() => {
    if (!isPending && !session) {
      router.replace("/sign-in")
    }
  }, [isPending, session, router])

  if (isPending || !session) return null

  const currentUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    avatar: session.user.image || avatarInitial(session.user.name),
  }

  return <CommunityShell currentUser={currentUser}>{children}</CommunityShell>
}
