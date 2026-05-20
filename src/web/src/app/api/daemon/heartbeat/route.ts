import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, HeartbeatRequestSchema } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { broadcastToUser } from "@/lib/broadcast";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();
  const { cacheKeys, throttled } = await import("@/lib/cache");

  const [body, err] = await parseBody(req, HeartbeatRequestSchema);
  if (err) return err;

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const D1_HEARTBEAT_THROTTLE_S = 15;
  const kv = (env as Env).CACHE_KV ?? null;
  let wasOffline = false;
  if (kv) {
    const prev = await kv.get(cacheKeys.heartbeat(ctx.workspaceId, body.daemon_id));
    wasOffline = !prev;
    kv.put(
      cacheKeys.heartbeat(ctx.workspaceId, body.daemon_id),
      new Date().toISOString(),
      { expirationTtl: 120 },
    ).catch(() => {});
  }

  try {
    const db = getDb((env as Env).DB);
    await throttled(
      `hb_d1:${ctx.workspaceId}:${body.daemon_id}`,
      D1_HEARTBEAT_THROTTLE_S,
      async () => {
        await queries.machine.upsertMachine(db, {
          daemonId: body.daemon_id,
          workspaceId: ctx.workspaceId!,
          deviceInfo: body.daemon_id,
        });
      },
    );
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
