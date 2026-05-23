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
import { TaskService } from "@/lib/services/task";

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

  const newestMessageId = new URL(req.url).searchParams.get("newest_message_id");

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation) {
    return writeError("conversation not found", 404);
  }

  let cacheValid = false;
  if (newestMessageId) {
    const serverNewest = await queries.message.getNewestMessageId(db, id);
    cacheValid = serverNewest === newestMessageId;
  }

  const [messagesResult, artifacts, buffered, activeTask, flaggedMessageIds, hasMoreConversations] =
    await Promise.all([
      queries.message.listMessages(db, id, { limit: MESSAGE_LIMIT }),
      queries.artifact.listArtifactsByConversation(db, id, ws.workspaceId, {
        limit: ARTIFACT_LIMIT,
      }).catch(() => [] as Awaited<ReturnType<typeof queries.artifact.listArtifactsByConversation>>),
      queries.message.listBufferedMessages(db, id).catch(() => [] as Awaited<ReturnType<typeof queries.message.listBufferedMessages>>),
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

  // Orphaned-buffer recovery
  let resolvedActiveTask = activeTask;
  let resolvedBuffered = buffered;
  if (resolvedBuffered.length > 0 && !resolvedActiveTask) {
    try {
      const taskService = new TaskService(db);
      const dispatched = await taskService.dispatchNextBufferedMessage(id, ws.workspaceId);
      if (dispatched) {
        resolvedActiveTask = dispatched;
        resolvedBuffered = await queries.message.listBufferedMessages(db, id);
      }
    } catch {
      // non-critical
    }
  }

  let taskMessages: unknown[] = [];
  if (
    resolvedActiveTask &&
    !["completed", "failed", "cancelled", "superseded"].includes(resolvedActiveTask.status)
  ) {
    try {
      const tmsgs = await queries.taskMessage.listTaskMessages(db, resolvedActiveTask.id);
      taskMessages = tmsgs.map(taskMessageToResponse);
    } catch {
      // non-critical
    }
  }

  const stepCounts: Record<string, number> = {};
  if (messages.length > 0) {
    const taskIds = [
      ...new Set(
        messages
          .filter((m) => m.role === "assistant" && m.taskId)
          .map((m) => m.taskId!)
      ),
    ];
    if (taskIds.length > 0) {
      try {
        const rows = await queries.taskMessage.countTaskMessagesByTaskIds(
          db,
          taskIds,
          ws.workspaceId
        );
        for (const row of rows) {
          stepCounts[row.taskId] = row.count;
        }
      } catch {
        // non-critical
      }
    }
  }

  return writeJSON({
    conversation: conversationToResponse(conversation),
    messages: cacheValid ? null : messages.map(messageToResponse),
    has_more_messages: hasMoreMessages,
    has_more_conversations: hasMoreConversations,
    has_more_artifacts: artifacts.length >= ARTIFACT_LIMIT,
    artifacts: artifacts.map(queries.artifact.artifactToResponse),
    buffered_messages: resolvedBuffered.map(messageToResponse),
    flagged_message_ids: flaggedMessageIds,
    step_counts: stepCounts,
    active_task: resolvedActiveTask ? taskToResponse(resolvedActiveTask) : null,
    task_messages: taskMessages,
    cache_valid: cacheValid,
  });
});
