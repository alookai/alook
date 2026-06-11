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

  const conversationId = req.nextUrl.searchParams.get("conversation_id");
  if (!conversationId) {
    return writeError("conversation_id is required", 400);
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const conv = await queries.conversation.getConversation(db, conversationId, ws.workspaceId);
  if (!conv || conv.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  const rows = await queries.artifact.listArtifactsByConversation(
    db,
    conversationId,
    ws.workspaceId,
  );

  return writeJSON(rows.map(queries.artifact.artifactToResponse));
});
