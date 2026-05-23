import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { cached, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const counts = await cached(cacheKeys.activeTaskCounts(ws.workspaceId), 10, async () => {
    const rows = await queries.task.listActiveTaskCountsByWorkspace(db, ws.workspaceId);
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.agentId] = Number(row.count);
    }
    return result;
  });

  return writeJSON({ counts });
});
