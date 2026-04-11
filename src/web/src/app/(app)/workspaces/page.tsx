import { redirect } from "next/navigation"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
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

export default async function WorkspacesPage() {
  const session = await requireSession()
  const { env } = await getCloudflareContext({ async: true })
  const db = createDb((env as Env).DB)

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
        redirect(`/w/${ws.slug}/home`)
      } catch {
        // Slug conflict — append random suffix and retry
        slug = `${baseSlug}-${randomSuffix()}`
      }
    }

    // If all attempts failed, reload workspaces (another request may have created one)
    workspaces = await queries.workspace.listWorkspaces(db, session.user.id)
  }

  // Single workspace — skip the list page
  if (workspaces.length === 1) {
    redirect(`/w/${workspaces[0].slug}/home`)
  }

  return <WorkspaceListClient workspaces={workspaces} />
}
