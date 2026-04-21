import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const id = ctx.params?.id as string;
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const bucket = (env as Env).EMAIL_BUCKET;

  const row = await queries.artifact.getArtifact(db, id, ws.workspaceId);
  if (!row) {
    return writeError("artifact not found", 404);
  }

  const object = await bucket.get(row.r2Key);
  if (!object) {
    return writeError("artifact content not found", 404);
  }

  const download = req.nextUrl.searchParams.get("download");
  const headers: Record<string, string> = {
    "Content-Type": row.contentType,
    "Content-Length": String(row.size),
  };
  if (download !== null) {
    headers["Content-Disposition"] = `attachment; filename="${row.filename.replace(/"/g, '\\"')}"`;
  } else {
    headers["Content-Disposition"] = `inline; filename="${row.filename.replace(/"/g, '\\"')}"`;
  }

  return new Response(object.body, { headers });
});
