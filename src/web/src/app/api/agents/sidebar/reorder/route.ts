import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";
import { cacheKeys, invalidate } from "@/lib/cache";

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  let raw: { ordered_agent_ids?: unknown };
  try {
    raw = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  const ids = raw.ordered_agent_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) {
    return writeError("ordered_agent_ids must be a non-empty array of strings", 400);
  }

  const db = getDb(ctx.env.DB);

  const [agents, existingPins] = await Promise.all([
    queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId),
    queries.agentPin.listPins(db, ws.workspaceId, ctx.userId),
  ]);
  const agentIds = new Set(agents.map((a) => a.id));
  const pinnedIds = new Set(existingPins.map((p) => p.agentId));
  for (const id of ids) {
    if (!agentIds.has(id)) return writeError(`Agent ${id} not found`, 400);
    if (pinnedIds.has(id)) return writeError(`Agent ${id} is pinned`, 400);
  }

  await queries.agentSidebarOrder.reorder(db, ws.workspaceId, ctx.userId, ids);
  invalidate(cacheKeys.pins(ws.workspaceId, ctx.userId)).catch(() => {});
  return new Response(null, { status: 204 });
});
