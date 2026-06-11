import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const id = ctx.params?.id as string;
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const row = await queries.artifact.getArtifact(db, id, ws.workspaceId);
  if (!row) {
    return writeError("not found", 404);
  }

  const agent = await queries.agent.getAgent(db, row.agentId, ws.workspaceId, ctx.userId);
  if (!agent) {
    return writeError("not found", 404);
  }

  return writeJSON(queries.artifact.artifactToResponse(row));
});
