import { createDb, queries } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { taskToActivityResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = createDb(ctx.env.DB);

  const id = ctx.params?.id;
  if (!id) return writeError("agent id is required", 400);

  const agent = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found", 404);

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const before = url.searchParams.get("before") || undefined;
  const beforeId = url.searchParams.get("before_id") || undefined;
  const statusParam = url.searchParams.get("status");
  const typeParam = url.searchParams.get("type");

  const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
  const limit = Number.isNaN(parsedLimit) ? 30 : Math.min(Math.max(parsedLimit, 1), 100);

  const status = statusParam ? statusParam.split(",").filter(Boolean) : undefined;
  const type = typeParam ? typeParam.split(",").filter(Boolean) : undefined;

  const result = await queries.task.listTaskHistory(db, id, ws.workspaceId, {
    limit,
    before,
    beforeId,
    status,
    type,
  });

  return writeJSON({
    tasks: result.tasks.map(taskToActivityResponse),
    has_more: result.hasMore,
  });
});
