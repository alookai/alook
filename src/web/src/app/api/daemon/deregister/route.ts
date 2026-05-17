import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { DeregisterRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

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

  // Single broadcast at daemon level
  broadcastToUser(ctx.userId, {
    type: "runtime.status",
    daemonId: body.daemon_id,
    workspaceId: ctx.workspaceId,
    status: "offline",
  }).catch(() => {});

  return writeJSON({ status: "ok" });
});
