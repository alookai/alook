import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CONVERSATION_TYPES, queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError, writeJSON } from "@/lib/middleware/helpers";
import {
  conversationBranchToResponse,
  messageToResponse,
} from "@/lib/api/responses";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("conversation id is required", 400);

  const conversation = await queries.conversation.getConversation(
    db,
    id,
    ws.workspaceId,
  );
  if (!conversation) return writeError("conversation not found", 404);
  if (conversation.userId !== ctx.userId) {
    return writeError("conversation access denied", 403);
  }
  if (conversation.type !== CONVERSATION_TYPES.MESSAGE_BRANCH) {
    return writeError("conversation is not a message branch", 404);
  }

  const origin = await queries.conversationBranch.getBranchOrigin(db, {
    workspaceId: ws.workspaceId,
    branchConversationId: id,
  });
  if (!origin) return writeError("branch origin not found", 404);

  return writeJSON({
    branch: conversationBranchToResponse(origin.branch),
    root_message: messageToResponse(origin.rootMessage),
  });
});
