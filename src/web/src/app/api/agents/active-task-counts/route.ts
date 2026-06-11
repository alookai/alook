import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { cached, cacheKeys } from "@/lib/cache";
import { filterVisibleAgents } from "@/lib/agent-visibility";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [allAgents, allAccess] = await Promise.all([
    cached(cacheKeys.allAgents(ws.workspaceId), 300, () => queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId)),
    cached(cacheKeys.allAgentAccess(ws.workspaceId), 300, () => queries.agentAccess.getAllAgentAccessForWorkspace(db, ws.workspaceId)),
  ]);
  const agents = filterVisibleAgents(allAgents, ctx.userId, allAccess);
  const visibleAgentIds = agents.map((a) => a.id);

  if (visibleAgentIds.length === 0) return writeJSON({ counts: {} });

  const rows = await queries.task.listActiveTaskCountsByWorkspace(db, ws.workspaceId, visibleAgentIds);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.agentId] = Number(row.count);
  }

  return writeJSON({ counts });
});
