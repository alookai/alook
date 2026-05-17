import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  queries,
  CreateAgentLinkRequestSchema,
  isUniqueConstraintError,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentLinkToResponse } from "@/lib/api/responses";
import { invalidateMany, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
  const offset = Number(url.searchParams.get("offset")) || 0;

  const rows = await queries.agentLink.listByWorkspace(db, ws.workspaceId, { limit, offset });
  return writeJSON(rows.map(agentLinkToResponse));
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
    await invalidateMany([
      cacheKeys.colleaguesByAgent(ws.workspaceId, body.source_agent_id),
      cacheKeys.colleaguesByAgent(ws.workspaceId, body.target_agent_id),
    ]);
    return writeJSON(agentLinkToResponse(created), 201);
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      return writeError("link already exists between these agents", 409);
    }
    throw e;
  }
});
