import { createDb, queries } from "@alook/shared";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = createDb(ctx.env.DB);

  const id = ctx.params?.id;
  if (!id) return writeError("agent id is required", 400);

  const agent = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found", 404);

  const tasks = await queries.task.listActiveTasksByAgent(db, id, ws.workspaceId, ctx.userId);

  return writeJSON({
    tasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      type: t.type,
      created_at: t.createdAt,
    })),
  });
});
