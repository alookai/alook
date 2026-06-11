import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { emailToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("email id is required", 400);

  const email = await queries.email.getEmailById(db, id, ws.workspaceId);
  if (!email) return writeError("not found", 404);

  const agent = await queries.agent.getAgent(db, email.agentId, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("not found", 404);

  if (!email.inReplyTo) return writeJSON([]);

  const MAX_DEPTH = 50;
  const thread: typeof email[] = [];
  let currentReplyTo = email.inReplyTo;
  const seen = new Set<string>();

  while (currentReplyTo && !seen.has(currentReplyTo) && thread.length < MAX_DEPTH) {
    seen.add(currentReplyTo);
    const parent = await queries.email.getEmailByMessageId(db, currentReplyTo, ws.workspaceId);
    if (!parent) break;
    thread.unshift(parent);
    currentReplyTo = parent.inReplyTo;
  }

  return writeJSON(thread.map(emailToResponse));
});
