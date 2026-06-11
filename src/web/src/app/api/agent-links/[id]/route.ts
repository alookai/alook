import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, UpdateAgentLinkRequestSchema } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentLinkToResponse } from "@/lib/api/responses";
import { invalidate, cacheKeys } from "@/lib/cache";

export const PATCH = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("agent link id is required", 400);

  const link = await queries.agentLink.getById(db, id, ws.workspaceId);
  if (!link) return writeError("not found", 404);

  const [sourceAgent, targetAgent] = await Promise.all([
    queries.agent.getAgent(db, link.sourceAgentId, ws.workspaceId, ctx.userId),
    queries.agent.getAgent(db, link.targetAgentId, ws.workspaceId, ctx.userId),
  ]);
  if (!sourceAgent && !targetAgent) return writeError("not found", 404);

  const [body, err] = await parseBody(req, UpdateAgentLinkRequestSchema);
  if (err) return err;

  const updated = await queries.agentLink.update(db, id, ws.workspaceId, {
    instruction: body.instruction,
  });
  if (!updated) return writeError("not found", 404);

  await Promise.all([
    invalidate(cacheKeys.allColleagues(ws.workspaceId)),
    invalidate(cacheKeys.agentLinks(ws.workspaceId)),
  ]);

  return writeJSON(agentLinkToResponse(updated));
});

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("agent link id is required", 400);

  const link = await queries.agentLink.getById(db, id, ws.workspaceId);
  if (!link) return writeError("not found", 404);

  const [sourceAgent, targetAgent] = await Promise.all([
    queries.agent.getAgent(db, link.sourceAgentId, ws.workspaceId, ctx.userId),
    queries.agent.getAgent(db, link.targetAgentId, ws.workspaceId, ctx.userId),
  ]);
  if (!sourceAgent && !targetAgent) return writeError("not found", 404);

  const deleted = await queries.agentLink.remove(db, id, ws.workspaceId);
  if (!deleted) return writeError("not found", 404);

  await Promise.all([
    invalidate(cacheKeys.allColleagues(ws.workspaceId)),
    invalidate(cacheKeys.agentLinks(ws.workspaceId)),
  ]);

  return writeJSON(agentLinkToResponse(deleted));
});
