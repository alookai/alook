import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, SkillReportSchema } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { parseBody, writeJSON, writeError } from "@/lib/middleware/helpers";
import { getDb, withD1Retry } from "@/lib/db";
import { broadcastToUser } from "@/lib/broadcast";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, err] = await parseBody(req, SkillReportSchema);
  if (err) return err;

  const row = await withD1Retry(() => queries.workspaceSkillRequest.getRequest(db, body.request_id));
  if (!row || row.workspaceId !== ctx.workspaceId) return writeError("request not found", 404);

  const result = {
    skills: body.skills ?? [],
    error: body.error,
  };

  await withD1Retry(() => queries.workspaceSkillRequest.completeRequest(db, row.id, result));

  broadcastToUser(ctx.userId, {
    type: "workspace.skills",
    agentId: row.agentId,
    requestId: row.id,
    skills: body.skills ?? [],
  }).catch(() => {});

  return writeJSON({ status: "ok" });
});
