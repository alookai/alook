import { redirect } from "next/navigation"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { requireSession } from "@/lib/session"
import { WorkspaceListClient } from "./client"

function slugFromEmail(email: string): string {
  const local = email.split("@")[0] || "user"
  return local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const session = await requireSession()
  const { env } = await getCloudflareContext({ async: true })
  const db = getDb((env as Env).DB)

  let workspaces = await queries.workspace.listWorkspaces(db, session.user.id)

  // Auto-create "Personal" workspace for new users
  if (workspaces.length === 0) {
    const baseSlug = slugFromEmail(session.user.email)
    let slug = baseSlug

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ws = await queries.workspace.createWorkspace(db, {
          name: "Personal",
          slug,
        })
        await queries.member.createMember(db, {
          workspaceId: ws.id,
          userId: session.user.id,
          role: "owner",
        })
        redirect(`/studio/new?workspace_id=${ws.id}`)
      } catch (err) {
        if (isRedirectError(err)) throw err
        // Slug conflict — append random suffix and retry
        slug = `${baseSlug}-${randomSuffix()}`
      }
    }

    // If all attempts failed, reload workspaces (another request may have created one)
    workspaces = await queries.workspace.listWorkspaces(db, session.user.id)
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

  return <WorkspaceListClient workspaces={workspaces} />
}
