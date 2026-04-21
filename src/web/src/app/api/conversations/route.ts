import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, CreateConversationRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, parseBody } from "@/lib/middleware/helpers";
import { conversationToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const conversations = await queries.conversation.listConversations(
    db,
    ws.workspaceId,
    ctx.userId
  );
  return writeJSON(conversations.map(conversationToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, valErr] = await parseBody(req, CreateConversationRequestSchema);
  if (valErr) return valErr;

  const conversation = await queries.conversation.createConversation(db, {
    workspaceId: ws.workspaceId,
    agentId: body.agent_id,
    userId: ctx.userId,
    title: "",
  });

  return writeJSON(conversationToResponse(conversation), 201);
});
