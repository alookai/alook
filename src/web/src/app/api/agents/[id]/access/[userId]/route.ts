import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const { id: agentId, userId: targetUserId } = ctx.params!;
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);
  const ag = await queries.agent.getAgent(db, agentId, ws.workspaceId);
  if (!ag) return writeError("agent not found", 404);
  if (ag.ownerId !== ctx.userId) return writeError("agent owner access required", 403);
  const accessList = await queries.agentAccess.listAgentAccess(db, agentId, ws.workspaceId);
  const member = accessList.find((a) => a.userId === targetUserId);
  const revoked = await queries.agentAccess.revokeAgentAccess(db, agentId, ws.workspaceId, targetUserId);
  if (!revoked) return writeError("access record not found", 404);
  const removeWhitelist = new URL(req.url).searchParams.get("remove_whitelist") === "true";
  if (removeWhitelist && member?.userEmail) {
    await queries.whitelist.removeWhitelistByEmail(db, agentId, ws.workspaceId, member.userEmail);
  }
  return new Response(null, { status: 204 });
});
