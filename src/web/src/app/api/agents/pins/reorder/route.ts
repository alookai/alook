import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";
import { invalidate, cacheKeys } from "@/lib/cache";

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

  const existingPins = await queries.agentPin.listPins(db, ws.workspaceId, ctx.userId);
  const pinnedIds = new Set(existingPins.map((p) => p.agentId));
  for (const id of ids) {
    if (!pinnedIds.has(id)) return writeError(`Agent ${id} is not pinned`, 400);
  }

  await queries.agentPin.reorderPins(db, ws.workspaceId, ctx.userId, ids);
  invalidate(cacheKeys.pins(ws.workspaceId, ctx.userId)).catch(() => {});
  return new Response(null, { status: 204 });
});
