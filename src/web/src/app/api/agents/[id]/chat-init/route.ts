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

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) {
    return writeError("agent id is required", 400);
  }

  const agent = await queries.agent.getAgent(db, id, ws.workspaceId);
  if (!agent) {
    return writeError("agent not found", 404);
  }

  const conversation = await queries.conversation.getOrCreateAgentConversation(
    db,
    ws.workspaceId,
    ctx.userId,
    id,
  );

  const convId = conversation.id;

  const [messagesResult, artifactsResult, bufferedResult, activeTaskResult] =
    await Promise.allSettled([
      queries.message.listMessages(db, convId, { limit: MESSAGE_LIMIT }),
      queries.artifact.listArtifactsByConversation(db, convId, ws.workspaceId),
      queries.message.listBufferedMessages(db, convId),
      queries.task.getActiveTaskByConversation(db, convId, ws.workspaceId),
    ]);

  const messages =
    messagesResult.status === "fulfilled" ? messagesResult.value : [];
  const artifacts =
    artifactsResult.status === "fulfilled" ? artifactsResult.value : [];
  const buffered =
    bufferedResult.status === "fulfilled" ? bufferedResult.value : [];
  const activeTask =
    activeTaskResult.status === "fulfilled"
      ? activeTaskResult.value
      : null;

  let taskMessages: unknown[] = [];
  if (
    activeTask &&
    activeTask.status !== "completed" &&
    activeTask.status !== "failed"
  ) {
    try {
      const tmsgs = await queries.taskMessage.listTaskMessages(
        db,
        activeTask.id,
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
    buffered_messages: buffered.map(messageToResponse),
    active_task: activeTask ? taskToResponse(activeTask) : null,
    task_messages: taskMessages,
    has_more_messages: messages.length >= MESSAGE_LIMIT,
  });
});
