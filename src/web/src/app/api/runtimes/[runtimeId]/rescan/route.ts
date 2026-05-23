import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { broadcastToDaemon } from "@/lib/broadcast";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const runtimeId = req.nextUrl.pathname.split("/runtimes/")[1]?.split("/")[0];
  if (!runtimeId) return writeError("runtime id required", 400);

  const runtime = await queries.runtime.getAgentRuntimeForWorkspace(
    db,
    runtimeId,
    ws.workspaceId,
  );
  if (!runtime) return writeError("runtime not found", 404);

  await queries.machine.setPendingRescan(db, runtime.daemonId, ws.workspaceId);

  broadcastToDaemon(runtime.daemonId, { type: "daemon.rescan" }).catch(() => {});

  return writeJSON({ pending_rescan: true });
});
