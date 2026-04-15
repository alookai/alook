import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { DeregisterRequestSchema } from "@alook/shared";
import { log } from "@/lib/logger";
import { broadcastToUser } from "@/lib/broadcast";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const [body, err] = await parseBody(req, DeregisterRequestSchema);
  if (err) return err;

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  // Look up all runtimes by (daemonId, workspaceId)
  const runtimeIds = await queries.runtime.getRuntimeIdsByDaemon(
    db,
    body.daemon_id,
    ctx.workspaceId,
  );

  for (const id of runtimeIds) {
    try {
      await queries.runtime.setAgentRuntimeOffline(db, id);
    } catch (e) {
      log.warn("Failed to set runtime offline", { runtimeId: id, err: e });
    }
  }

  // Single broadcast at daemon level
  if (runtimeIds.length > 0) {
    broadcastToUser(ctx.userId, {
      type: "runtime.status",
      daemonId: body.daemon_id,
      workspaceId: ctx.workspaceId,
      status: "offline",
    }).catch(() => {});
  }

  return writeJSON({ status: "ok" });
});
