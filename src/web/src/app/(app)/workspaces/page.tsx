import { redirect } from "next/navigation"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { requireSession } from "@/lib/session"
import { WorkspaceListClient } from "./client"

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const session = await requireSession()
  const { env } = await getCloudflareContext({ async: true })
  const db = getDb((env as Env).DB)

  const workspaces = await queries.workspace.listWorkspaces(db, session.user.id)

  // New users with no workspaces → redirect to /studio/new to start the flow
  if (workspaces.length === 0) {
    redirect("/studio/new")
  }

  // Auto-redirect to single workspace only on post-login flow
  const params = await searchParams
  if (workspaces.length === 1 && params.auto !== undefined) {
    const agents = await queries.agent.listAgents(db, workspaces[0].id, session.user.id)
    if (agents.length === 0) {
      redirect(`/studio/new?workspace_id=${workspaces[0].id}`)
    }
    redirect(`/w/${workspaces[0].slug}/home`)
  }

  // Find most recent workspace with 0 agents to reuse for "New workspace"
  let emptyWorkspaceId: string | null = null
  for (const ws of workspaces) {
    const agents = await queries.agent.listAgents(db, ws.id, session.user.id)
    if (agents.length === 0) {
      emptyWorkspaceId = ws.id
      break
    }
  }

  return <WorkspaceListClient workspaces={workspaces} emptyWorkspaceId={emptyWorkspaceId} />
}
