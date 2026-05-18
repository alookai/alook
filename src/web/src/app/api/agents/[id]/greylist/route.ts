import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, AddGreylistRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError, parseBody, formatTimestamp } from "@/lib/middleware/helpers"

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = ctx.params?.id;
  if (!agentId) return writeError("agent id is required", 400);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found", 404);

  const entries = await queries.greylist.getGreylist(db, agentId, ws.workspaceId);
  return writeJSON(
    entries.map((g) => ({
      id: g.id,
      email: g.email,
      created_at: formatTimestamp(g.createdAt),
    }))
  );
});

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = ctx.params?.id;
  if (!agentId) return writeError("agent id is required", 400);

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found", 404);

  const [body, err] = await parseBody(req, AddGreylistRequestSchema);
  if (err) return err;

  const email = body.email.toLowerCase();
  const result = await queries.greylist.addGreylist(db, agentId, ws.workspaceId, email);
  if (!result.ok) {
    const msg = result.reason === "whitelisted"
      ? "email is already whitelisted — remove from whitelist first"
      : "email is already greylisted";
    return writeError(msg, 409);
  }

  return writeJSON(
    {
      id: result.entry.id,
      email: result.entry.email,
      created_at: formatTimestamp(result.entry.createdAt),
    },
    201
  );
});
