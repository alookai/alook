import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { log } from "@/lib/logger";
import { broadcastToUser, broadcastToDaemon } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const daemonId = req.nextUrl.searchParams.get("daemon_id");
  if (!daemonId) {
    return writeJSON({ error: "daemon_id is required" }, 400);
  }

  try {
    await queries.runtime.deleteRuntimesByDaemonId(db, daemonId, ws.workspaceId);
    await queries.machine.deleteMachine(db, daemonId, ws.workspaceId);
    await Promise.all([
      invalidate(cacheKeys.runtimeIds(ws.workspaceId, daemonId)),
      invalidate(cacheKeys.allRuntimes(ws.workspaceId)),
    ]);
  } catch (e) {
    log.error("Failed to delete machine", { err: e });
    return writeJSON({ error: "Failed to remove machine" }, 500);
  }

  broadcastToDaemon(daemonId, {
    type: "daemon.evict",
    workspaceId: ws.workspaceId,
  }).catch(() => {});

  broadcastToUser(ctx.userId, {
    type: "runtime.deleted",
    daemonId,
  }).catch(() => {});

  return new Response(null, { status: 204 });
});
