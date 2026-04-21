import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDb, queries } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = createDb((env as Env).DB);

  const rows = await queries.task.listActiveTaskCountsByWorkspace(db, ws.workspaceId);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.agentId] = Number(row.count);
  }

  return writeJSON({ counts });
});
