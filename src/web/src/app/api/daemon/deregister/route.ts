import { NextRequest } from "next/server";
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { DeregisterRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  const [body, err] = await parseBody(req, DeregisterRequestSchema);
  if (err) return err;

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  // Set machine last_seen_at to null — non-critical, daemon is already shutting down
  try {
    await queries.machine.setMachineLastSeenNull(
      db,
      body.daemon_id,
      ctx.workspaceId,
    );
  } catch (e) {
    log.warn("deregister: setMachineLastSeenNull failed", { daemonId: body.daemon_id, err: String(e) });
  }

  await Promise.all([
    invalidate(cacheKeys.runtimeIds(ctx.workspaceId, body.daemon_id)),
    invalidate(cacheKeys.allRuntimes(ctx.workspaceId)),
  ]);

  // Single broadcast at daemon level
  broadcastToUser(ctx.userId, {
    type: "runtime.status",
    daemonId: body.daemon_id,
    workspaceId: ctx.workspaceId,
    status: "offline",
  }).catch(() => {});

  return writeJSON({ status: "ok" });
});
