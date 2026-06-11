import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { cached, cacheKeys } from "@/lib/cache";
import { filterVisibleAgents } from "@/lib/agent-visibility";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const statusRaw = req.nextUrl.searchParams.get("status");
  const status = statusRaw && ["active", "completed", "failed"].includes(statusRaw) ? statusRaw : undefined;
  const before = req.nextUrl.searchParams.get("before") ?? undefined;
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 30, 1), 100) : undefined;

  const multiAgent = req.nextUrl.searchParams.get("multiAgent") === "true";
  const agentId = req.nextUrl.searchParams.get("agentId") ?? undefined;
  const channel = req.nextUrl.searchParams.get("channel") ?? undefined;
  const result = await queries.task.listTraces(db, ws.workspaceId, { status, limit, before, multiAgent, agentId, channel });

  const [allAgents, allAccess] = await Promise.all([
    cached(cacheKeys.allAgents(ws.workspaceId), 300, () => queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId)),
    cached(cacheKeys.allAgentAccess(ws.workspaceId), 300, () => queries.agentAccess.getAllAgentAccessForWorkspace(db, ws.workspaceId)),
  ]);
  const agents = filterVisibleAgents(allAgents, ctx.userId, allAccess);
  const visibleIds = new Set(agents.map(a => a.id));
  const agentMap = new Map(agents.map(a => [a.id, { name: a.name, avatarUrl: a.avatarUrl }]));

  const traces = result.traces.filter(t => visibleIds.has(t.rootAgentId)).map(t => ({
    trace_id: t.traceId,
    root_prompt: t.rootPrompt,
    root_agent_id: t.rootAgentId,
    root_agent: agentMap.get(t.rootAgentId) ?? null,
    helper_agents: t.helperAgentIds.map(id => ({ id, ...agentMap.get(id) })),
    status: t.status,
    task_count: t.taskCount,
    started_at: t.startedAt,
    completed_at: t.completedAt,
    channel: t.channel,
  }));

  return writeJSON({ traces, has_more: result.hasMore });
});
