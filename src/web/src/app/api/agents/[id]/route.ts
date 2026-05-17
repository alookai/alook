import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, UpdateAgentRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentToResponse } from "@/lib/api/responses";
import { invalidate, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("agent id is required", 400);
  }

  const agent = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!agent) {
    return writeError("agent not found", 404);
  }

  return writeJSON(agentToResponse(agent));
});

export const PATCH = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("agent id is required", 400);
  }

  const [body, valErr] = await parseBody(req, UpdateAgentRequestSchema);
  if (valErr) return valErr;

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description;
  if (body.instructions !== undefined) data.instructions = body.instructions;
  if (body.runtime_id !== undefined) {
    const runtime = await queries.runtime.getAgentRuntimeForWorkspace(db, body.runtime_id, ws.workspaceId);
    if (!runtime) {
      return writeError("runtime not found in workspace", 400);
    }
    data.runtimeId = body.runtime_id;
  }
  if (body.runtime_config !== undefined) {
    const rc = body.runtime_config;
    const sanitized: Record<string, unknown> = {};
    if (typeof rc.model === "string") {
      sanitized.model = rc.model;
    }
    data.runtimeConfig = sanitized;
  }
  if (body.visibility !== undefined) data.visibility = body.visibility;
  if (body.avatar_url !== undefined) data.avatarUrl = body.avatar_url;

  const existing = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!existing) return writeError("agent not found", 404);
  if (existing.ownerId !== ctx.userId) return writeError("agent owner access required", 403);

  const updated = await queries.agent.updateAgent(db, id, ws.workspaceId, data as { name?: string; description?: string; instructions?: string; runtimeId?: string; runtimeConfig?: unknown; visibility?: string; avatarUrl?: string | null }, ctx.userId);
  if (!updated) {
    return writeError("agent not found", 404);
  }

  await invalidate(cacheKeys.agent(ws.workspaceId, id));

  return writeJSON(agentToResponse(updated));
});

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("agent id is required", 400);
  }

  const existing = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!existing) return writeError("agent not found", 404);
  if (existing.ownerId !== ctx.userId) return writeError("agent owner access required", 403);

  const deleted = await queries.agent.deleteAgent(db, id, ws.workspaceId, ctx.userId);
  if (!deleted) {
    return writeError("agent not found", 404);
  }

  await invalidate(cacheKeys.agent(ws.workspaceId, id));

  return new Response(null, { status: 204 });
});
