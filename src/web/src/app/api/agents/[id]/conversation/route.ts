import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { conversationToResponse } from "@/lib/api/responses";

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("agent id is required", 400);
  }

  const agent = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!agent) {
    return writeError("agent not found", 404);
  }

  let channel: string | undefined;
  try {
    const body = (await req.json()) as { channel?: string };
    channel = typeof body.channel === "string" ? body.channel : undefined;
  } catch {
    // no body — backward compatible
  }

  const conversation = await queries.conversation.getOrCreateAgentConversation(
    db,
    ws.workspaceId,
    ctx.userId,
    id,
    channel
  );

  return writeJSON(conversationToResponse(conversation));
});
