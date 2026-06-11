import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  queries,
  CreateAgentLinkRequestSchema,
  UpsertAgentLinkRequestSchema,
  isUniqueConstraintError,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentLinkToResponse } from "@/lib/api/responses";
import { cached, invalidate, cacheKeys } from "@/lib/cache";
import { filterVisibleAgents } from "@/lib/agent-visibility";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
  const offset = Number(url.searchParams.get("offset")) || 0;

  const [allAgents, allAccess] = await Promise.all([
    cached(cacheKeys.allAgents(ws.workspaceId), 300, () => queries.agent.getAllAgentsForWorkspace(db, ws.workspaceId)),
    cached(cacheKeys.allAgentAccess(ws.workspaceId), 300, () => queries.agentAccess.getAllAgentAccessForWorkspace(db, ws.workspaceId)),
  ]);
  const visibleIds = new Set(filterVisibleAgents(allAgents, ctx.userId, allAccess).map((a) => a.id));

  const rows = await queries.agentLink.listByWorkspace(db, ws.workspaceId, { limit, offset });
  const filtered = rows
    .filter((r) => visibleIds.has(r.sourceAgentId) || visibleIds.has(r.targetAgentId))
    .map(agentLinkToResponse);

  return writeJSON(filtered);
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, err] = await parseBody(req, CreateAgentLinkRequestSchema);
  if (err) return err;

  if (body.source_agent_id === body.target_agent_id) {
    return writeError("cannot link an agent to itself", 400);
  }

  const [sourceAgent, targetAgent] = await Promise.all([
    queries.agent.getAgent(db, body.source_agent_id, ws.workspaceId, ctx.userId),
    queries.agent.getAgent(db, body.target_agent_id, ws.workspaceId, ctx.userId),
  ]);
  if (!sourceAgent) return writeError("source agent not found in workspace", 404);
  if (!targetAgent) return writeError("target agent not found in workspace", 404);

  try {
    const created = await queries.agentLink.create(db, {
      workspaceId: ws.workspaceId,
      sourceAgentId: body.source_agent_id,
      targetAgentId: body.target_agent_id,
      instruction: body.instruction,
    });
    await Promise.all([
      invalidate(cacheKeys.allColleagues(ws.workspaceId)),
      invalidate(cacheKeys.agentLinks(ws.workspaceId)),
    ]);
    return writeJSON(agentLinkToResponse(created), 201);
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      return writeError("link already exists between these agents", 409);
    }
    throw e;
  }
});

// PUT /api/agent-links?agentId=<caller> — upsert (create-or-replace) the
// relationship between the calling agent and a target agent. Idempotent: a new
// pair is created (201), an existing pair has its instruction replaced (200).
export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = new URL(req.url).searchParams.get("agentId");
  if (!agentId) {
    return writeError("agentId query param is required", 400);
  }

  const [body, err] = await parseBody(req, UpsertAgentLinkRequestSchema);
  if (err) return err;

  if (agentId === body.target_agent_id) {
    return writeError("cannot link an agent to itself", 400);
  }

  const [callerAgent, targetAgent] = await Promise.all([
    queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId),
    queries.agent.getAgent(db, body.target_agent_id, ws.workspaceId, ctx.userId),
  ]);
  if (!callerAgent) return writeError("calling agent not found in workspace", 404);
  if (!targetAgent) return writeError("target agent not found in workspace", 404);

  let row, created;
  try {
    ({ row, created } = await queries.agentLink.upsertByPair(db, {
      workspaceId: ws.workspaceId,
      sourceAgentId: agentId,
      targetAgentId: body.target_agent_id,
      instruction: body.instruction,
    }));
  } catch (e) {
    if (!isUniqueConstraintError(e)) throw e;
    // Lost a concurrent create race — the row now exists; fall back to update.
    const existing = await queries.agentLink.getByPair(
      db,
      ws.workspaceId,
      agentId,
      body.target_agent_id,
    );
    if (!existing) throw e;
    row = await queries.agentLink.update(db, existing.id, ws.workspaceId, {
      instruction: body.instruction,
    });
    created = false;
  }

  await Promise.all([
    invalidate(cacheKeys.allColleagues(ws.workspaceId)),
    invalidate(cacheKeys.agentLinks(ws.workspaceId)),
  ]);

  return writeJSON({ ...agentLinkToResponse(row), created }, created ? 201 : 200);
});
