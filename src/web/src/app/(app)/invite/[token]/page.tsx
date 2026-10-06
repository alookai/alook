import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"
import { ObservedStaticContent } from "@/lib/observability/regions"

export default function RetiredWorkspaceInvitePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-8">
      <ObservedStaticContent />
      <h1 className="text-xl font-semibold">Workspace invitations have been retired</h1>
      <p className="text-muted-foreground">This link cannot join a workspace or a community server. Ask the sender for a new community invitation.</p>
      <Link href="/c/me" className={buttonVariants({ className: "self-start" })}>Open Community</Link>
    </main>
  )
}
