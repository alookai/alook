import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import type { AuthContext } from "./auth"

export interface WorkspaceContext extends AuthContext {
  workspaceId: string
}

export async function withWorkspaceMember(
  req: NextRequest,
  auth: AuthContext
): Promise<{ workspaceId: string } | NextResponse> {
  const workspaceId =
    req.nextUrl.searchParams.get("workspace_id") ||
    req.headers.get("X-Workspace-ID") ||
    auth.workspaceId

  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    )
  }

  if (!auth.userId) {
    return NextResponse.json(
      { error: "user not authenticated" },
      { status: 401 }
    )
  }

  const { env } = await getCloudflareContext({ async: true })
  const db = getDb((env as Env).DB)

  const membership = await queries.member.getMemberByUserAndWorkspace(
    db,
    auth.userId,
    workspaceId
  )
  if (!membership) {
    return NextResponse.json(
      { error: "workspace not found" },
      { status: 404 }
    )
  }

  return { workspaceId }
}
