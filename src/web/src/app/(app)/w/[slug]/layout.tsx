import { redirect } from "next/navigation"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
import { getSession } from "@/lib/session"
import { WorkspaceProvider } from "@/contexts/workspace-context"
import { AgentProvider } from "@/contexts/agent-context"
import { AppSidebar } from "@/components/app-sidebar"
import { GradientBackground } from "@/components/gradient-background"

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  const session = await getSession()
  if (!session) redirect("/sign-in")

  const { slug } = await params
  const { env } = await getCloudflareContext({ async: true })
  const db = createDb((env as Env).DB)

  const ws = await queries.workspace.getWorkspaceBySlug(db, slug)
  if (!ws) redirect("/workspaces")

  const membership = await queries.member.getMemberByUserAndWorkspace(
    db,
    session.user.id,
    ws.id
  )
  if (!membership) redirect("/workspaces")

  return (
    <WorkspaceProvider workspaceId={ws.id} slug={slug}>
      <AgentProvider workspaceId={ws.id}>
        <div className="flex h-screen overflow-hidden relative">
          <GradientBackground />
          <AppSidebar />
          <div className="flex-1 min-w-0 p-2 pl-0">
            <main className="h-full rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
              {children}
            </main>
          </div>
        </div>
      </AgentProvider>
    </WorkspaceProvider>
  )
}
