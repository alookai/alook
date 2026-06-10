import { redirect } from "next/navigation"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, generateWorkspaceSlug } from "@alook/shared"
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

  if (workspaces.length === 0) {
    const ws = await queries.workspace.createWorkspace(db, {
      name: "Personal",
      slug: generateWorkspaceSlug(),
    })
    await queries.member.createMember(db, {
      workspaceId: ws.id,
      userId: session.user.id,
      role: "owner",
    })
    redirect(`/studio/new?workspace_id=${ws.id}`)
  }

  const params = await searchParams
  if (workspaces.length === 1 && params.auto !== undefined) {
    if (!workspaces[0].onboarded) {
      redirect(`/studio/new?workspace_id=${workspaces[0].id}`)
    }
    redirect(`/w/${workspaces[0].slug}/home`)
  }

  return <WorkspaceListClient workspaces={workspaces} />
}
