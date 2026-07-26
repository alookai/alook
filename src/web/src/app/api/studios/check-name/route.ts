import { NextRequest } from "next/server";
import { queries, sanitizeSlug } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const wsParam = req.nextUrl.searchParams.get("workspace_id");
  let currentWorkspaceId: string | null = null;

  if (wsParam) {
    const ws = await withWorkspaceMember(req, ctx);
    if (ws instanceof Response) return ws;
    currentWorkspaceId = ws.workspaceId;
  }

  const name = req.nextUrl.searchParams.get("name");
  if (!name || !name.trim()) {
    return writeError("name query parameter is required", 400);
  }

  const slug = sanitizeSlug(name.trim());
  if (!slug) {
    return writeError("name produces an invalid slug", 400);
  }

  const db = getDb(ctx.env.DB);

  const existing = await queries.workspace.getWorkspaceBySlug(db, slug);
  const available = !existing || (currentWorkspaceId !== null && existing.id === currentWorkspaceId);

  return writeJSON({
    available,
    suggested_slug: slug,
    ...(available ? {} : { conflict_reason: "slug_taken" }),
  });
});
