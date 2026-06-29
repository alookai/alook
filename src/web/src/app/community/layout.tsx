"use client"

import { useRouter } from "next/navigation"
import { useSession } from "@/lib/auth-client"
import { CommunityShell } from "./community-shell"

export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const { data: session, isPending } = useSession()

  if (isPending) return null
  if (!session) {
    router.replace("/sign-in")
    return null
  }

  const currentUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    avatar: session.user.image || session.user.name.charAt(0).toUpperCase(),
  }

  return <CommunityShell currentUser={currentUser}>{children}</CommunityShell>
}
