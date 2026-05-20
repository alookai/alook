import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, WorkspaceFileBrowseRequestSchema } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { parseBody, writeJSON, writeError } from "@/lib/middleware/helpers";
import { getDb } from "@/lib/db";
import { cacheKeys } from "@/lib/cache";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = ctx.params?.id;
  if (!agentId) return writeError("agent id required", 400);

  const [body, err] = await parseBody(req, WorkspaceFileBrowseRequestSchema);
  if (err) return err;

  const workspaceId = new URL(req.url).searchParams.get("workspace_id");
  if (!workspaceId) return writeError("workspace_id required", 400);

  const agent = await queries.agent.getAgent(db, agentId, workspaceId);
  if (!agent) return writeError("agent not found", 404);

  const row = await queries.workspaceFileRequest.createRequest(db, {
    workspaceId,
    agentId,
    requestType: body.request_type,
    path: body.path,
  });

  const kv = (env as Env).CACHE_KV ?? null;
  if (kv) {
    kv.put(cacheKeys.hasPendingFileRequest(workspaceId), "1", { expirationTtl: 60 }).catch(() => {});
  }

  return writeJSON({ request_id: row.id });
});
