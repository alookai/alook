import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries, isValidHandle } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { agentToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const agents = await queries.agent.listAgents(db, ws.workspaceId);
  return writeJSON(agents.map(agentToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  let body: {
    name?: string;
    description?: string;
    instructions?: string;
    runtime_id?: string;
    runtime_config?: unknown;
    max_concurrent_tasks?: number;
    email_handle?: string;
  };
  try {
    body = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  const name = (body.name || "").trim();
  if (!name) {
    return writeError("name is required", 400);
  }

  const runtimeId = body.runtime_id || "";
  if (!runtimeId) {
    return writeError("runtime_id is required", 400);
  }

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

  const newAgent = await queries.agent.createAgent(db, {
    workspaceId: ws.workspaceId,
    name,
    description: body.description || "",
    instructions: body.instructions || "",
    runtimeId,
    runtimeMode: runtime.runtimeMode,
    runtimeConfig: body.runtime_config ?? null,
    visibility: "private",
    maxConcurrentTasks,
    ownerId: ctx.userId,
    emailHandle: emailHandle || null,
  });

  if (runtime.status === "online") {
    const taskService = new TaskService(db);
    await taskService.reconcileAgentStatus(newAgent.id);
    const updated = await queries.agent.getAgentInWorkspace(
      db,
      newAgent.id,
      ws.workspaceId
    );
    if (updated) return writeJSON(agentToResponse(updated), 201);
  }

  return writeJSON(agentToResponse(newAgent), 201);
});
