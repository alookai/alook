import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { cached, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const db = getDb(ctx.env.DB);
  const data = await cached(cacheKeys.pins(ws.workspaceId, ctx.userId), 30, async () => {
    const [pins, sidebarOrder] = await Promise.all([
      queries.agentPin.listPins(db, ws.workspaceId, ctx.userId),
      queries.agentSidebarOrder.listOrder(db, ws.workspaceId, ctx.userId),
    ]);
    return {
      pins: pins.map((p) => ({ id: p.id, agent_id: p.agentId, created_at: p.createdAt, position: p.position })),
      sidebar_order: sidebarOrder.map((o) => ({ agent_id: o.agentId, position: o.position })),
    };
  });
  return writeJSON(data);
});
