import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { invalidate, cacheKeys } from "@/lib/cache";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const { id } = ctx.params!;
  const db = getDb(ctx.env.DB);
  const agent = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found", 404);
  const pin = await queries.agentPin.pinAgent(db, { agentId: id, workspaceId: ws.workspaceId, userId: ctx.userId });
  invalidate(cacheKeys.pins(ws.workspaceId, ctx.userId)).catch(() => {});
  return writeJSON({ pinned: true }, pin ? 201 : 200);
});

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const { id } = ctx.params!;
  const db = getDb(ctx.env.DB);
  await queries.agentPin.unpinAgent(db, id, ws.workspaceId, ctx.userId);
  invalidate(cacheKeys.pins(ws.workspaceId, ctx.userId)).catch(() => {});
  return new Response(null, { status: 204 });
});
