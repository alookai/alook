import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { cached, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const runtimes = await cached(cacheKeys.allRuntimes(ws.workspaceId), 120, () => queries.runtime.listAgentRuntimes(db, ws.workspaceId));

  // Overlay KV heartbeats for real-time online status (deduplicated by daemonId)
  const kv = (env as Env).CACHE_KV ?? null;
  if (kv) {
    const uniqueDaemonIds = [...new Set(runtimes.map((rt) => rt.daemonId).filter(Boolean))] as string[];
    const heartbeats = await Promise.all(
      uniqueDaemonIds.map((id) => kv.get(cacheKeys.heartbeat(ws.workspaceId, id)).catch(() => null))
    );
    const hbMap = new Map(uniqueDaemonIds.map((id, i) => [id, heartbeats[i]]));
    for (const rt of runtimes) {
      const hb = rt.daemonId ? hbMap.get(rt.daemonId) : null;
      if (hb) rt.machineLastSeenAt = hb;
    }
  }

  return writeJSON(runtimes.map(runtimeToResponse));
});
