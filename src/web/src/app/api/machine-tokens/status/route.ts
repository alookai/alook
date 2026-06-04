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

  // Runtimes are machine-level info — if the latest token lacks runtimes_json
  // (e.g. a newly created pending token), fall back to any token that has them.
  let runtimesSource = token.runtimesJson;
  let hostnameSource = token.hostname;
  let lastUsedSource = token.lastUsedAt;

  if (!runtimesSource) {
    const withRuntimes = await queries.machineToken.getTokenWithRuntimes(db, ctx.userId);
    if (withRuntimes) {
      runtimesSource = withRuntimes.runtimesJson;
      if (!hostnameSource) hostnameSource = withRuntimes.hostname;
      if (!lastUsedSource) lastUsedSource = withRuntimes.lastUsedAt;
    }
  }

  const daemonOnline = lastUsedSource
    ? Date.now() - new Date(lastUsedSource).getTime() < DAEMON_ONLINE_THRESHOLD_MS
    : false;

  let runtimes: Array<{ id: string; type: string; version: string; status: string }> | undefined;
  if (runtimesSource) {
    try {
      const parsed = JSON.parse(runtimesSource) as Array<{ type: string; version?: string }>;
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
    hostname: hostnameSource || undefined,
    daemon_online: daemonOnline,
    runtimes,
  });
});
