import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/session"
import { CommunityShell } from "./community-shell"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function CommunityLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()
  if (!session) redirect("/sign-in")

  const currentUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    avatar: session.user.name.charAt(0).toUpperCase(),
  }

  return <CommunityShell currentUser={currentUser}>{children}</CommunityShell>
}
