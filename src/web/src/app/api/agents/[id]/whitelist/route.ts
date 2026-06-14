import { queries, AddWhitelistRequestSchema, TASK_TYPES } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError, parseBody, formatTimestamp } from "@/lib/middleware/helpers"
import { TaskService } from "@/lib/services/task"
import { invalidate, cacheKeys } from "@/lib/cache"

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

  const agentId = ctx.params?.id;
  if (!agentId) return writeError("agent id is required", 400);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found", 404);

  const entries = await queries.whitelist.getWhitelist(db, agentId, ws.workspaceId);
  return writeJSON(
    entries.map((w) => ({
      id: w.id,
      email: w.email,
      created_at: formatTimestamp(w.createdAt),
    }))
  );
});

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

  const agentId = ctx.params?.id;
  if (!agentId) return writeError("agent id is required", 400);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found", 404);

  const [body, err] = await parseBody(req, AddWhitelistRequestSchema);
  if (err) return err;

  const email = body.email.toLowerCase();
  const entry = await queries.whitelist.addWhitelist(db, agentId, ws.workspaceId, email);
  if (!entry) return writeError("email already whitelisted", 409);

  if (agent.runtimeId && agent.emailHandle && agent.ownerId) {
    try {
      const conv = await queries.conversation.createConversation(db, {
        workspaceId: ws.workspaceId,
        agentId: agent.id,
        userId: agent.ownerId,
        title: `Welcome: ${email}`.slice(0, 50),
        type: TASK_TYPES.EMAIL_NOTIFICATION,
      });
      const taskService = new TaskService(db);
      await taskService.enqueueTask(
        agent.id,
        conv.id,
        ws.workspaceId,
        `Your owner (${ctx.email}) has added a new contact to your whitelist: ${email}. Please compose and send them a welcome email introducing yourself as "${agent.name}". Be warm and professional. Let them know they can reach you at your email address and briefly describe how you can help them.`,
        TASK_TYPES.EMAIL_NOTIFICATION,
      );
      const dateStr = new Date().toISOString().slice(0, 10);
      invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)).catch(() => {});
      invalidate(cacheKeys.activeTaskCounts(ws.workspaceId)).catch(() => {});
    } catch {
      // Best-effort — don't fail the whitelist operation
    }
  }

  return writeJSON(
    {
      id: entry.id,
      email: entry.email,
      created_at: formatTimestamp(entry.createdAt),
    },
    201
  );
});
