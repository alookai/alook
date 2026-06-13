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
    queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId),
    cached(cacheKeys.allAgentAccess(ws.workspaceId), 300, () => queries.agentAccess.getAllAgentAccessForWorkspace(db, ws.workspaceId)),
  ]);
  const agents = filterVisibleAgents(allAgents, ctx.userId, allAccess);
  const visibleAgentIds = agents.map((a) => a.id);
  const agentMap = new Map(agents.map((a) => [a.id, { name: a.name, avatarUrl: a.avatarUrl }]));

  if (visibleAgentIds.length === 0) return writeJSON({ tasks: [] });
  const tasks = await queries.task.listActiveTasksByWorkspace(db, ws.workspaceId, visibleAgentIds, ctx.userId);

  return writeJSON({
    tasks: tasks.map((t) => ({
      id: t.id,
      agent_id: t.agentId,
      agent: agentMap.get(t.agentId) ?? null,
      prompt: t.prompt,
      status: t.status,
      type: t.type,
      conversation_id: t.conversationId,
      channel: t.channel ?? "default",
      created_at: t.createdAt,
    })),
  });
});
