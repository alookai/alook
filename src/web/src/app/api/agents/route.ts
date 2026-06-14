import { NextRequest } from "next/server";
import { queries, isValidHandle, isOnline, CreateAgentRequestSchema, TASK_TYPES } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { invalidate, cached, cacheKeys } from "@/lib/cache";
import { filterVisibleAgents } from "@/lib/agent-visibility";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB)

  const [allAgents, allAccess] = await Promise.all([
    queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId),
    cached(cacheKeys.allAgentAccess(ws.workspaceId), 300, () => queries.agentAccess.getAllAgentAccessForWorkspace(db, ws.workspaceId)),
  ]);
  const agents = filterVisibleAgents(allAgents, ctx.userId, allAccess);
  return writeJSON(agents.map(agentToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB)

  const [body, valErr] = await parseBody(req, CreateAgentRequestSchema);
  if (valErr) return valErr;

  const name = body.name.trim();
  const runtimeId = body.runtime_id;

  let maxConcurrentTasks = body.max_concurrent_tasks || 0;
  if (maxConcurrentTasks <= 0) maxConcurrentTasks = 6;

  const emailHandle = typeof body.email_handle === "string" ? body.email_handle.trim().toLowerCase() : "";
  if (emailHandle) {
    if (!isValidHandle(emailHandle)) {
      return writeError("email_handle must be 4+ alphanumeric/dash characters", 400);
    }
    const existing = await queries.agent.getAgentByHandle(db, emailHandle);
    if (existing) {
      return writeError("Handle already taken", 409);
    }
  }

  const runtime = await queries.runtime.getAgentRuntimeForWorkspace(
    db,
    runtimeId,
    ws.workspaceId,
    ctx.userId
  );
  if (!runtime) {
    return writeError("runtime not found in workspace", 404);
  }

  const rc = body.runtime_config;
  const sanitizedRc: Record<string, unknown> | null = rc
    ? { ...(typeof rc.model === "string" ? { model: rc.model } : {}) }
    : null;

  const newAgent = await queries.agent.createAgent(db, {
    workspaceId: ws.workspaceId,
    name,
    description: body.description,
    instructions: body.instructions,
    runtimeId,
    runtimeMode: runtime.runtimeMode,
    runtimeConfig: sanitizedRc,
    visibility: "private",
    maxConcurrentTasks,
    ownerId: ctx.userId,
    emailHandle: emailHandle || null,
    avatarUrl: body.avatar_url ?? null,
  });

  if (emailHandle && ctx.email) {
    await queries.whitelist.addWhitelist(db, newAgent.id, ws.workspaceId, ctx.email.toLowerCase());
  }

  await Promise.all([
    invalidate(cacheKeys.allHandles(ws.workspaceId)),
    invalidate(cacheKeys.allAgentAccess(ws.workspaceId)),
  ]);

  // Send welcome email to owner
  if (newAgent.runtimeId && newAgent.emailHandle && ctx.email && isOnline(runtime.machineLastSeenAt)) {
    try {
      const conv = await queries.conversation.createConversation(db, {
        workspaceId: ws.workspaceId,
        agentId: newAgent.id,
        userId: ctx.userId,
        title: `Welcome: ${ctx.email}`.slice(0, 50),
        type: TASK_TYPES.EMAIL_NOTIFICATION,
      });
      const taskService = new TaskService(db);
      await taskService.enqueueTask(
        newAgent.id,
        conv.id,
        ws.workspaceId,
        `You have just been created by your owner (${ctx.email}). Please send them a welcome email introducing yourself as "${name}". In the email: 1) Introduce yourself warmly — your name, your email address, and what you can help with. 2) Briefly introduce the Alook platform — a personal AI agent platform where agents can handle emails, schedule tasks, and work autonomously. 3) Let them know they can chat with you directly or email you anytime. Be warm, professional, and concise.`,
        TASK_TYPES.EMAIL_NOTIFICATION,
      );
      const dateStr = new Date().toISOString().slice(0, 10);
      invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)).catch(() => {});
      invalidate(cacheKeys.activeTaskCounts(ws.workspaceId)).catch(() => {});
    } catch {
      // Best-effort — don't fail agent creation
    }
  }

  if (isOnline(runtime.machineLastSeenAt)) {
    const taskService = new TaskService(db);
    await taskService.reconcileAgentStatus(newAgent.id, ws.workspaceId);
    const updated = await queries.agent.getAgent(
      db,
      newAgent.id,
      ws.workspaceId,
      ctx.userId
    );
    if (updated) return writeJSON(agentToResponse(updated), 201);
  }

  return writeJSON(agentToResponse(newAgent), 201);
});
