import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, HeartbeatRequestSchema, OFFLINE_THRESHOLD_MS } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { broadcastToUser } from "@/lib/broadcast";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();

  const [body, err] = await parseBody(req, HeartbeatRequestSchema);
  if (err) return err;

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const db = getDb((env as Env).DB);
  let wasOffline = false;
  try {
    const existing = await queries.machine.getMachineByDaemon(db, body.daemon_id, ctx.workspaceId!);
    if (!existing || !existing.lastSeenAt || Date.now() - new Date(existing.lastSeenAt).getTime() >= OFFLINE_THRESHOLD_MS) {
      wasOffline = true;
    }
    await queries.machine.upsertMachine(db, {
      daemonId: body.daemon_id,
      workspaceId: ctx.workspaceId!,
      deviceInfo: body.daemon_id,
    });
  } catch (e) {
    log.warn("heartbeat: machine upsert failed", { daemonId: body.daemon_id, err: String(e) });
  }

  if (wasOffline) {
    broadcastToUser(ctx.userId, {
      type: "runtime.status",
      daemonId: body.daemon_id,
      workspaceId: ctx.workspaceId,
      status: "online",
    }).catch(() => {});
  }

  return writeJSON({ ok: true });
});
