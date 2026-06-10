import { redirect } from "next/navigation"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { getSession } from "@/lib/session"
import { WorkspaceProvider } from "@/contexts/workspace-context"
import { AgentProvider } from "@/contexts/agent-context"
import { ChannelProvider } from "@/contexts/channel-context"
import { InboxCountProvider } from "@/contexts/inbox-count-context"
import { FlagCountProvider } from "@/contexts/flag-count-context"
import { WorkspaceShell } from "@/components/workspace-shell"

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
  const db = getDb((env as Env).DB)

  const ws = await queries.workspace.getWorkspaceBySlug(db, slug)
  if (!ws) redirect("/workspaces")

  const membership = await queries.member.getMemberByUserAndWorkspace(
    db,
    session.user.id,
    ws.id
  )
  if (!membership) redirect("/workspaces")

  if (!ws.onboarded) {
    redirect(`/studio/new?workspace_id=${ws.id}`)
  }

  return (
    <WorkspaceProvider workspaceId={ws.id} slug={slug}>
      <AgentProvider workspaceId={ws.id}>
        <InboxCountProvider>
          <FlagCountProvider>
            <ChannelProvider workspaceId={ws.id}>
              <WorkspaceShell>{children}</WorkspaceShell>
            </ChannelProvider>
          </FlagCountProvider>
        </InboxCountProvider>
      </AgentProvider>
    </WorkspaceProvider>
  )
}
