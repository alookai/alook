import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, UpdateAgentLinkRequestSchema } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { agentLinkToResponse } from "@/lib/api/responses";
import { invalidateMany, cacheKeys } from "@/lib/cache";

export const PATCH = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("agent link id is required", 400);

  const [body, err] = await parseBody(req, UpdateAgentLinkRequestSchema);
  if (err) return err;

  const updated = await queries.agentLink.update(db, id, ws.workspaceId, {
    instruction: body.instruction,
  });
  if (!updated) return writeError("agent link not found", 404);

  await invalidateMany([
    cacheKeys.colleaguesByAgent(ws.workspaceId, updated.sourceAgentId),
    cacheKeys.colleaguesByAgent(ws.workspaceId, updated.targetAgentId),
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

  const deleted = await queries.agentLink.remove(db, id, ws.workspaceId);
  if (!deleted) return writeError("agent link not found", 404);

  await invalidateMany([
    cacheKeys.colleaguesByAgent(ws.workspaceId, deleted.sourceAgentId),
    cacheKeys.colleaguesByAgent(ws.workspaceId, deleted.targetAgentId),
  ]);

  return writeJSON(agentLinkToResponse(deleted));
});
