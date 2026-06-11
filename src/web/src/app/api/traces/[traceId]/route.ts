import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { cached, cacheKeys } from "@/lib/cache";
import { filterVisibleAgents } from "@/lib/agent-visibility";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const traceId = ctx.params?.traceId;
  if (!traceId || typeof traceId !== "string" || !traceId.startsWith("tr_") || traceId.length > 30) {
    return writeError("invalid traceId", 400);
  }

  const tasks = await queries.task.getTraceTree(db, traceId, ws.workspaceId);
  if (tasks.length === 0) return writeError("trace not found", 404);

  const rootTask = tasks.find(t => !t.parentTaskId);
  let channel = "default";
  if (rootTask) {
    const conv = await queries.conversation.getConversation(db, rootTask.conversationId, ws.workspaceId);
    if (conv) channel = conv.channel;
  }

  const [allAgents, allAccess] = await Promise.all([
    cached(cacheKeys.allAgents(ws.workspaceId), 300, () => queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId)),
    cached(cacheKeys.allAgentAccess(ws.workspaceId), 300, () => queries.agentAccess.getAllAgentAccessForWorkspace(db, ws.workspaceId)),
  ]);
  const agents = filterVisibleAgents(allAgents, ctx.userId, allAccess);
  const visibleIds = new Set(agents.map(a => a.id));
  const agentMap = new Map(agents.map(a => [a.id, { name: a.name, email_handle: a.emailHandle, avatarUrl: a.avatarUrl }]));

  if (rootTask && !visibleIds.has(rootTask.agentId)) {
    return writeError("not found", 404);
  }

  const traceTasks = tasks.filter(t => visibleIds.has(t.agentId)).map(t => ({
    id: t.id,
    agent_id: t.agentId,
    agent: agentMap.get(t.agentId) ?? null,
    parent_task_id: t.parentTaskId,
    prompt: t.prompt,
    status: t.status,
    type: t.type,
    conversation_id: t.conversationId,
    created_at: t.createdAt,
    completed_at: t.completedAt,
  }));

  return writeJSON({ trace_id: traceId, channel, tasks: traceTasks });
});
