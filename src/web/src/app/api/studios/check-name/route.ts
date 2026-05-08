import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const name = req.nextUrl.searchParams.get("name");
  if (!name || !name.trim()) {
    return writeError("name query parameter is required", 400);
  }

  const slug = slugify(name.trim());
  if (!slug) {
    return writeError("name produces an invalid slug", 400);
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const existing = await queries.workspace.getWorkspaceBySlug(db, slug);
  const available = !existing || existing.id === ws.workspaceId;

  return writeJSON({
    available,
    suggested_slug: slug,
    ...(available ? {} : { conflict_reason: "slug_taken" }),
  });
});
