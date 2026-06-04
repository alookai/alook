import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";

const DAEMON_ONLINE_THRESHOLD_MS = 120_000;

export const GET = withAuth(async (_req, ctx) => {
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const token = await queries.machineToken.getLatestTokenForUser(db, ctx.userId);
  if (!token) {
    return writeJSON({ status: null });
  }

  const daemonOnline = token.lastUsedAt
    ? Date.now() - new Date(token.lastUsedAt).getTime() < DAEMON_ONLINE_THRESHOLD_MS
    : false;

  let runtimes: Array<{ id: string; type: string; version: string; status: string }> | undefined;
  if (token.runtimesJson) {
    try {
      const parsed = JSON.parse(token.runtimesJson) as Array<{ type: string; version?: string }>;
      runtimes = parsed.map((rt, i) => ({
        id: `temp_${rt.type}_${i}`,
        type: rt.type,
        version: rt.version || "",
        status: daemonOnline ? "online" : "offline",
      }));
    } catch {}
  }

  return writeJSON({
    status: token.status,
    workspace_id: token.workspaceId || undefined,
    hostname: token.hostname || undefined,
    daemon_online: daemonOnline,
    runtimes,
  });
});
