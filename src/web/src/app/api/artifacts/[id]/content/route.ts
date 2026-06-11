import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

function asciiFallbackFilename(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").trim();
  return fallback || "download";
}

function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const fallback = asciiFallbackFilename(filename);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const id = ctx.params?.id as string;
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const bucket = (env as Env).EMAIL_BUCKET;

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
