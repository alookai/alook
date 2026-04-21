import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, isValidHandle, isOnline, CreateAgentRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { sweepStaleState } from "@/lib/services/sweep";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  // Sweep stale state: catches stuck tasks even when all daemons are dead
  await sweepStaleState(db, ws.workspaceId);

  const agents = await queries.agent.listAgents(db, ws.workspaceId);
  return writeJSON(agents.map(agentToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

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
    ws.workspaceId
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
  });

  if (emailHandle && ctx.email) {
    await queries.whitelist.addWhitelist(db, newAgent.id, ws.workspaceId, ctx.email.toLowerCase());
  }

  if (isOnline(runtime.machineLastSeenAt)) {
    const taskService = new TaskService(db);
    await taskService.reconcileAgentStatus(newAgent.id, ws.workspaceId);
    const updated = await queries.agent.getAgent(
      db,
      newAgent.id,
      ws.workspaceId
    );
    if (updated) return writeJSON(agentToResponse(updated), 201);
  }

  return writeJSON(agentToResponse(newAgent), 201);
});
