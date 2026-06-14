import { NextRequest } from "next/server";
import { queries, AgentDmRequestSchema, truncateTitle } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { messageToResponse } from "@/lib/api/responses";
import { broadcastToUser } from "@/lib/broadcast";

// Agent-authored DM endpoint (`alook sync send-dm`). The agent calls this to
// push exactly what the user should see — a `role:"assistant"` chat bubble that
// lands live in the open chat. Machine-token auth only (mirrors the other
// daemon routes); explicitly does NOT enqueue a task (unlike the user-send
// route at /api/conversations/[id]/messages, which would spawn another run).
export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const db = getDb(ctx.env.DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  const [body, err] = await parseBody(req, AgentDmRequestSchema);
  if (err) return err;

  // Scope-ahead: resolve the conversation by workspace id, never check ownership
  // after (AGENTS.md rule). A foreign-workspace id simply 404s — no leak.
  const conversation = await queries.conversation.getConversation(db, id, ctx.workspaceId);
  if (!conversation) {
    return writeError("conversation not found", 404);
  }

  const message = await queries.message.createMessage(db, {
    conversationId: id,
    role: "assistant",
    content: body.content,
    taskId: body.task_id ?? null,
    metadata: JSON.stringify({ kind: "dm" }),
  });

  // Auto-title if still untitled — parity with the user-send route. The query's
  // conditional WHERE title = '' makes this a no-op once a title exists.
  queries.conversation.updateConversationTitle(db, id, truncateTitle(body.content)).catch(() => {});

  broadcastToUser(conversation.userId, {
    type: "conversation.message",
    conversationId: id,
    message: messageToResponse(message),
  }).catch(() => {});

  queries.inbox.updateUnreadLatestMessage(db, id, conversation.userId, message.id).catch(() => {});

  return writeJSON({ message: messageToResponse(message) }, 201);
});
