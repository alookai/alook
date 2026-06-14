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

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

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

  const [messagesResult, artifactsResult, activeTaskResult, hasMoreConvsResult] =
    await Promise.allSettled([
      queries.message.listMessages(db, convId, { limit: MESSAGE_LIMIT }),
      queries.artifact.listArtifactsByConversation(db, convId, ws.workspaceId, {
        limit: ARTIFACT_LIMIT,
      }),
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
  const activeTask =
    activeTaskResult.status === "fulfilled"
      ? activeTaskResult.value
      : null;
  const hasMoreConvs =
    hasMoreConvsResult.status === "fulfilled" ? hasMoreConvsResult.value : false;

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
      // non-critical — frontend will recover via polling
    }
  }

  return writeJSON({
    conversation: conversationToResponse(conversation),
    messages: messages.map(messageToResponse),
    artifacts: artifacts.map(queries.artifact.artifactToResponse),
    active_task: activeTask ? taskToResponse(activeTask) : null,
    task_messages: taskMessages,
    has_more_messages: hasMoreMessages,
    has_more_conversations: hasMoreConvs,
    has_more_artifacts: artifacts.length >= ARTIFACT_LIMIT,
  });
});
