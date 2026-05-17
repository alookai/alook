import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { runtimeToResponse } from "@/lib/api/responses";
import { sweepStaleState } from "@/lib/services/sweep";
import { cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  // Sweep stale state: mark offline runtimes, fail stuck tasks, reconcile agents
  await sweepStaleState(db, ws.workspaceId);

  const runtimes = await queries.runtime.listAgentRuntimes(db, ws.workspaceId);

  // Overlay KV heartbeats for real-time online status
  const kv = (env as Env).CACHE_KV ?? null;
  if (kv) {
    await Promise.all(runtimes.map(async (rt) => {
      if (rt.daemonId) {
        const hb = await kv.get(cacheKeys.heartbeat(ws.workspaceId, rt.daemonId)).catch(() => null);
        if (hb) (rt as any).machineLastSeenAt = hb;
      }
    }));
  }

  return writeJSON(runtimes.map(runtimeToResponse));
});
