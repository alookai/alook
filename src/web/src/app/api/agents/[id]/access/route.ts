import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, GrantAgentAccessRequestSchema, type Database } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";

async function requireAgentOwner(db: Database, agentId: string, workspaceId: string, userId: string) {
  const ag = await queries.agent.getAgent(db, agentId, workspaceId, userId);
  if (!ag) return { error: writeError("agent not found", 404) };
  if (ag.ownerId !== userId) return { error: writeError("agent owner access required", 403) };
  return { agent: ag };
}

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const { id } = ctx.params!;
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);
  const check = await requireAgentOwner(db, id, ws.workspaceId, ctx.userId);
  if (check.error) return check.error;
  const accessList = await queries.agentAccess.listAgentAccess(db, id, ws.workspaceId);
  return writeJSON(accessList.map((a) => ({
    id: a.id, user_id: a.userId, name: a.userName, email: a.userEmail, created_at: a.createdAt,
  })));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;
  const { id } = ctx.params!;
  const [body, err] = await parseBody(req, GrantAgentAccessRequestSchema);
  if (err) return err;
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);
  const check = await requireAgentOwner(db, id, ws.workspaceId, ctx.userId);
  if (check.error) return check.error;
  const access = await queries.agentAccess.grantAgentAccess(db, { agentId: id, workspaceId: ws.workspaceId, userId: body.user_id });
  const accessList = await queries.agentAccess.listAgentAccess(db, id, ws.workspaceId);
  const member = accessList.find((a) => a.userId === body.user_id);
  if (member?.userEmail) {
    await queries.whitelist.addWhitelist(db, id, ws.workspaceId, member.userEmail);
  }
  return writeJSON({ id: access.id, user_id: access.userId }, 201);
});
