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

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

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
    channel,
  );

  const convId = conversation.id;

  const [messagesResult, artifactsResult, bufferedResult, activeTaskResult, hasMoreConvsResult] =
    await Promise.allSettled([
      queries.message.listMessages(db, convId, { limit: MESSAGE_LIMIT }),
      queries.artifact.listArtifactsByConversation(db, convId, ws.workspaceId, {
        limit: ARTIFACT_LIMIT,
      }),
      queries.message.listBufferedMessages(db, convId),
      queries.task.getActiveTaskByConversation(db, convId, ws.workspaceId),
      queries.conversation.hasPreviousConversations(
        db, ws.workspaceId, ctx.userId, id, convId, channel,
      ),
    ]);

  const { messages, has_more: hasMoreMessages } =
    messagesResult.status === "fulfilled"
      ? messagesResult.value
      : { messages: [] as never[], has_more: false };
  const artifacts =
    artifactsResult.status === "fulfilled" ? artifactsResult.value : [];
  const buffered =
    bufferedResult.status === "fulfilled" ? bufferedResult.value : [];
  const activeTask =
    activeTaskResult.status === "fulfilled"
      ? activeTaskResult.value
      : null;
  const hasMoreConvs =
    hasMoreConvsResult.status === "fulfilled" ? hasMoreConvsResult.value : false;

  // Recover orphaned buffered messages: if there are buffered messages but no
  // active task, dispatch the first one now (handles race where task completed
  // just before/after the message was buffered).
  let resolvedActiveTask = activeTask;
  let resolvedBuffered = buffered;
  if (resolvedBuffered.length > 0 && !resolvedActiveTask) {
    try {
      const taskService = new TaskService(db);
      const dispatched = await taskService.dispatchNextBufferedMessage(convId, ws.workspaceId);
      if (dispatched) {
        resolvedActiveTask = dispatched;
        resolvedBuffered = await queries.message.listBufferedMessages(db, convId);
      }
    } catch {
      // non-critical — user can still send a new message to unstick
    }
  }

  let taskMessages: unknown[] = [];
  if (
    resolvedActiveTask &&
    !["completed", "failed", "cancelled", "superseded"].includes(resolvedActiveTask.status)
  ) {
    try {
      const tmsgs = await queries.taskMessage.listTaskMessages(
        db,
        resolvedActiveTask.id,
      );
      taskMessages = tmsgs.map(taskMessageToResponse);
    } catch {
      // non-critical — frontend will recover via polling
    }
  }

  return writeJSON({
    conversation: conversationToResponse(conversation),
    messages: messages.map(messageToResponse),
    artifacts: artifacts.map(queries.artifact.artifactToResponse),
    buffered_messages: resolvedBuffered.map(messageToResponse),
    active_task: resolvedActiveTask ? taskToResponse(resolvedActiveTask) : null,
    task_messages: taskMessages,
    has_more_messages: hasMoreMessages,
    has_more_conversations: hasMoreConvs,
    has_more_artifacts: artifacts.length >= ARTIFACT_LIMIT,
  });
});
