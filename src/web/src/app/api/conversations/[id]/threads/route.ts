import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, TASK_TYPES, truncateTitle, CreateThreadRequestSchema, isUniqueConstraintError } from "@alook/shared";
import { getDb } from "@/lib/db";
import { nanoid } from "nanoid";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { conversationToResponse, messageToResponse, taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { log } from "@/lib/logger";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const conversationId = ctx.params?.id;
  if (!conversationId) {
    return writeError("conversation id is required", 400);
  }

  const [body, valErr] = await parseBody(req, CreateThreadRequestSchema);
  if (valErr) return valErr;

  const parentConv = await queries.conversation.getConversation(db, conversationId, ws.workspaceId);
  if (!parentConv || parentConv.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  const rootMessage = await queries.message.getMessage(db, body.parent_message_id);
  if (!rootMessage || rootMessage.conversationId !== conversationId) {
    return writeError("parent message not found in this conversation", 404);
  }

  // Idempotent: check if thread already exists for this parent_message_id
  const existing = await queries.conversation.getThreadByParentMessage(
    db, body.parent_message_id, ws.workspaceId
  );
  if (existing) {
    // Thread already exists — create message in the existing thread and enqueue task
    const threadMessage = await queries.message.createMessage(db, {
      conversationId: existing.id,
      role: "user",
      content: body.content,
    });

    broadcastToUser(ctx.userId, {
      type: "conversation.message",
      conversationId: existing.id,
      message: messageToResponse(threadMessage),
    }).catch(() => {});

    const taskService = new TaskService(db);
    const traceId = "tr_" + nanoid();
    try {
      const task = await taskService.enqueueTask(
        parentConv.agentId,
        existing.id,
        ws.workspaceId,
        body.content,
        TASK_TYPES.USER_DM_MESSAGE,
        {
          contextKey: existing.id,
          context: { message_id: threadMessage.id },
          traceId,
          parentTaskId: null,
        },
      );
      queries.message.updateMessageTaskId(db, threadMessage.id, task.id).catch(() => {});
      return writeJSON({
        conversation: conversationToResponse(existing),
        message: messageToResponse(threadMessage),
        task: taskToResponse(task),
      }, 200);
    } catch (err: unknown) {
      log.error("enqueueTask error (thread)", { err });
      return writeError("failed to enqueue task", 500);
    }
  }

  // Create new thread conversation (catch unique-violation from concurrent requests)
  const threadTitle = truncateTitle(rootMessage.content).slice(0, 80);
  let threadConv;
  try {
    threadConv = await queries.conversation.createConversation(db, {
      workspaceId: ws.workspaceId,
      agentId: parentConv.agentId,
      userId: ctx.userId,
      title: "",
      type: TASK_TYPES.USER_DM_MESSAGE,
      channel: parentConv.channel ?? "default",
      parentMessageId: body.parent_message_id,
      threadTitle,
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const raced = await queries.conversation.getThreadByParentMessage(
      db, body.parent_message_id, ws.workspaceId
    );
    if (!raced) throw err;
    threadConv = raced;
  }

  broadcastToUser(ctx.userId, {
    type: "thread.created",
    conversationId,
    threadConversationId: threadConv.id,
    parentMessageId: body.parent_message_id,
    threadTitle,
  }).catch(() => {});

  // If no content, return just the conversation (eager creation, no message/task)
  if (!body.content) {
    return writeJSON({ conversation: conversationToResponse(threadConv), message: null, task: null }, 201);
  }

  // Fetch parent conversation history up to and including root message
  const historyMessages = await queries.message.listMessagesUpTo(
    db, conversationId, body.parent_message_id
  );
  const rootMsg = historyMessages.find(m => m.id === body.parent_message_id);
  const historyWithoutRoot = historyMessages
    .filter(m => m.id !== body.parent_message_id)
    .map(m => ({ role: m.role, content: m.content, created_at: m.createdAt }));
  const rootMessageContext = rootMsg
    ? { role: rootMsg.role, content: rootMsg.content }
    : null;

  // Create user message in thread
  const threadMessage = await queries.message.createMessage(db, {
    conversationId: threadConv.id,
    role: "user",
    content: body.content,
  });

  broadcastToUser(ctx.userId, {
    type: "conversation.message",
    conversationId: threadConv.id,
    message: messageToResponse(threadMessage),
  }).catch(() => {});

  const taskContext: Record<string, unknown> = {
    message_id: threadMessage.id,
    conversation_history: historyWithoutRoot,
    ...(rootMessageContext ? { root_message: rootMessageContext } : {}),
  };

  const traceId = "tr_" + nanoid();
  const taskService = new TaskService(db);
  try {
    const task = await taskService.enqueueTask(
      parentConv.agentId,
      threadConv.id,
      ws.workspaceId,
      body.content,
      TASK_TYPES.USER_DM_MESSAGE,
      {
        contextKey: threadConv.id,
        context: taskContext,
        traceId,
        parentTaskId: null,
      },
    );

    queries.message.updateMessageTaskId(db, threadMessage.id, task.id).catch(() => {});

    const dateStr = new Date().toISOString().slice(0, 10);
    invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)).catch(() => {});

    return writeJSON({
      conversation: conversationToResponse(threadConv),
      message: messageToResponse(threadMessage),
      task: taskToResponse(task),
    }, 201);
  } catch (err: unknown) {
    log.error("enqueueTask error (thread create)", { err });
    return writeError("failed to enqueue task", 500);
  }
});

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const conversationId = ctx.params?.id;
  if (!conversationId) {
    return writeError("conversation id is required", 400);
  }

  const conv = await queries.conversation.getConversation(db, conversationId, ws.workspaceId);
  if (!conv || conv.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  try {
    const threads = await queries.conversation.getThreadsByConversation(
      db, ws.workspaceId, conversationId
    );

    const summaries = threads.map(t => ({
      thread_id: t.id,
      parent_message_id: t.parentMessageId,
      thread_title: t.threadTitle,
      reply_count: t.replyCount,
      last_reply_at: t.lastReplyAt,
      created_at: t.createdAt,
    }));

    return writeJSON({ thread_summaries: summaries });
  } catch (err: unknown) {
    log.error("getThreadsByConversation error", { err });
    return writeError("failed to fetch thread summaries", 500);
  }
});
