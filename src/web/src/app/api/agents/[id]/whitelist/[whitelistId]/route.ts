import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeError } from "@/lib/middleware/helpers"

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = ctx.params?.id;
  const whitelistId = ctx.params?.whitelistId;
  if (!agentId || !whitelistId) return writeError("missing required params", 400);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  const removed = await queries.whitelist.removeWhitelist(db, whitelistId, agentId, ws.workspaceId);
  if (!removed) return writeError("whitelist entry not found", 404);

  return new Response(null, { status: 204 });
});
