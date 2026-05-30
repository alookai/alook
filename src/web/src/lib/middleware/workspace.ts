import { NextRequest, NextResponse } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { cached, cacheKeys } from "@/lib/cache"
import type { AuthContext } from "./auth"

export async function withWorkspaceMember(
  req: NextRequest,
  auth: AuthContext & { params?: Record<string, string> }
): Promise<{ workspaceId: string; memberRole: string } | NextResponse> {
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

  const membership = await cached(
    cacheKeys.member(workspaceId, auth.userId),
    1800,
    () => queries.member.getMemberByUserAndWorkspace(db, auth.userId, workspaceId),
  )
  if (!membership && auth.workspaceId === workspaceId) {
    return { workspaceId, memberRole: "member" }
  }
  if (!membership) {
    return NextResponse.json(
      { error: "workspace not found" },
      { status: 404 }
    )
  }

  return { workspaceId, memberRole: membership.role }
}

export async function withWorkspaceOwner(
  req: NextRequest,
  auth: AuthContext & { params?: Record<string, string> }
): Promise<{ workspaceId: string; memberRole: string } | NextResponse> {
  const result = await withWorkspaceMember(req, auth)
  if (result instanceof NextResponse) return result

  if (result.memberRole !== "owner") {
    return NextResponse.json(
      { error: "owner access required" },
      { status: 403 }
    )
  }

  return result
}
