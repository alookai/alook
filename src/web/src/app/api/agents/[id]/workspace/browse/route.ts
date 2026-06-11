import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, WorkspaceFileBrowseRequestSchema } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { parseBody, writeJSON, writeError } from "@/lib/middleware/helpers";
import { getDb } from "@/lib/db";
import { cacheKeys } from "@/lib/cache";
import { broadcastToDaemon } from "@/lib/broadcast";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = ctx.params?.id;
  if (!agentId) return writeError("agent id required", 400);

  const [body, err] = await parseBody(req, WorkspaceFileBrowseRequestSchema);
  if (err) return err;

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  const row = await queries.workspaceFileRequest.createRequest(db, {
    workspaceId: ws.workspaceId,
    agentId,
    requestType: body.request_type,
    path: body.path,
  });

  const kv = (env as Env).CACHE_KV ?? null;
  if (kv) {
    kv.put(cacheKeys.hasPendingFileRequest(ws.workspaceId), "1", { expirationTtl: 60 }).catch(() => {});
  }

  // Push file request to daemon (best-effort)
  if (agent.runtimeId) {
    const runtime = await queries.runtime.getAgentRuntime(db, agent.runtimeId);
    if (runtime) {
      broadcastToDaemon(runtime.daemonId, {
        type: "daemon.file_requests",
        workspaceId: ws.workspaceId,
        requests: [{ id: row.id, agent_id: agentId, request_type: body.request_type, path: body.path }],
      }).catch(() => {});
    }
  }

  return writeJSON({ request_id: row.id });
});
