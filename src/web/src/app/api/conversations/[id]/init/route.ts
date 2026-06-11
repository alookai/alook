import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import {
  conversationToResponse,
  messageToResponse,
  taskToResponse,
  taskMessageToResponse,
} from "@/lib/api/responses";

const MESSAGE_LIMIT = 20;
const ARTIFACT_LIMIT = 50;

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  const url = new URL(req.url);
  const newestMessageId = url.searchParams.get("newest_message_id");
  const messageCountParam = url.searchParams.get("message_count");

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation || conversation.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  const [serverNewest, serverMessageCount] = await Promise.all([
    newestMessageId ? queries.message.getNewestMessageId(db, id) : Promise.resolve(null),
    queries.message.getActiveMessageCount(db, id),
  ]);

  let cacheValid = false;
  if (newestMessageId) {
    const idMatches = serverNewest === newestMessageId;
    const countMatches = messageCountParam ? serverMessageCount === parseInt(messageCountParam, 10) : true;
    cacheValid = idMatches && countMatches;
  }

  const [messagesResult, artifacts, activeTask, flaggedMessageIds, hasMoreConversations] =
    await Promise.all([
      queries.message.listMessages(db, id, { limit: MESSAGE_LIMIT }),
      queries.artifact.listArtifactsByConversation(db, id, ws.workspaceId, {
        limit: ARTIFACT_LIMIT,
      }).catch(() => [] as Awaited<ReturnType<typeof queries.artifact.listArtifactsByConversation>>),
      queries.task.getActiveTaskByConversation(db, id, ws.workspaceId).catch(() => null),
      queries.messageFlag.listFlaggedMessageIds(db, ctx.userId, ws.workspaceId, id).catch(() => [] as string[]),
      queries.conversation.hasPreviousConversations(
        db,
        ws.workspaceId,
        ctx.userId,
        conversation.agentId,
        id,
        conversation.channel || undefined,
      ).catch(() => false),
    ]);

  const { messages, has_more: hasMoreMessages } = messagesResult;

  let taskMessages: unknown[] = [];
  if (activeTask) {
    try {
      const tmsgs = await queries.taskMessage.listTaskErrorMessages(
        db,
        activeTask.id,
        ws.workspaceId,
      );
      taskMessages = tmsgs.map(taskMessageToResponse);
    } catch {
      // non-critical
    }
  }

  // For thread conversations, fetch the root message from parent conversation
  let rootMessage = null;
  if (conversation.parentMessageId) {
    try {
      const rm = await queries.message.getMessage(db, conversation.parentMessageId);
      if (rm) rootMessage = messageToResponse(rm);
    } catch {}
  }

  return writeJSON({
    conversation: conversationToResponse(conversation),
    messages: cacheValid ? null : messages.map(messageToResponse),
    has_more_messages: hasMoreMessages,
    has_more_conversations: hasMoreConversations,
    has_more_artifacts: artifacts.length >= ARTIFACT_LIMIT,
    artifacts: artifacts.map(queries.artifact.artifactToResponse),
    flagged_message_ids: flaggedMessageIds,
    active_task: activeTask ? taskToResponse(activeTask) : null,
    task_messages: taskMessages,
    cache_valid: cacheValid,
    message_count: serverMessageCount,
    ...(rootMessage ? { root_message: rootMessage } : {}),
  });
});
