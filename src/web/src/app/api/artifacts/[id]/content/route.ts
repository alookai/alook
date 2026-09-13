import { contentDisposition } from "@/lib/content-disposition"
import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const id = ctx.params?.id as string;
  const db = getDb(ctx.env.DB);
  const bucket = ctx.env.EMAIL_BUCKET;

  const row = await queries.artifact.getArtifact(db, id, ws.workspaceId);
  if (!row) {
    return writeError("not found", 404);
  }

  const agent = await queries.agent.getAgent(db, row.agentId, ws.workspaceId, ctx.userId);
  if (!agent) {
    return writeError("not found", 404);
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
    headers["Content-Disposition"] = contentDisposition("attachment", row.filename);
  } else {
    headers["Content-Disposition"] = contentDisposition("inline", row.filename);
  }

  return new Response(object.body, { headers });
});
