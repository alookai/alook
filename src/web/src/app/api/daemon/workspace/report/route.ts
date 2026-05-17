import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, WorkspaceFileReportSchema } from "@alook/shared";
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

  const [body, err] = await parseBody(req, WorkspaceFileReportSchema);
  if (err) return err;

  const row = await withD1Retry(() => queries.workspaceFileRequest.getRequest(db, body.request_id));
  if (!row) return writeError("request not found", 404);

  const result = {
    entries: body.entries,
    content: body.content,
    isBinary: body.isBinary,
    error: body.error,
    path: body.path,
  };

  await withD1Retry(() => queries.workspaceFileRequest.completeRequest(db, row.id, result));

  broadcastToUser(ctx.userId, {
    type: "workspace.files",
    agentId: row.agentId,
    requestId: row.id,
    requestType: row.requestType as "tree" | "read",
    result,
  }).catch(() => {});

  return writeJSON({ status: "ok" });
});
