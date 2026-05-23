import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, TASK_TYPES, MeetingStatus, extractThreadId, buildEmailMapKey, EmailNotifyRequestSchema } from "@alook/shared"
import { nanoid } from "nanoid"
import { getDb } from "@/lib/db"
import { writeJSON, parseBody } from "@/lib/middleware/helpers"
import { TaskService } from "@/lib/services/task"
import { broadcastToUser } from "@/lib/broadcast"
import { taskToResponse } from "@/lib/api/responses"
import { invalidate, cacheKeys } from "@/lib/cache"

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, valErr] = await parseBody(req, EmailNotifyRequestSchema);
  if (valErr) return valErr;

  const agent = await queries.agent.getAgent(db, body.agentId, body.workspaceId)

  const email = await queries.email.createEmail(db, {
    agentId: body.agentId,
    workspaceId: body.workspaceId,
    fromEmail: body.from,
    toEmail: body.to ?? "",
    subject: body.subject,
    r2Key: body.r2Key,
    isWhitelisted: body.isWhitelisted,
    forwarded: body.forwarded,
    messageId: body.messageId,
    inReplyTo: body.inReplyTo,
    references: body.references,
    direction: "inbound",
    attachments: body.attachments,
  })

  if (body.meetingInfo && agent) {
    const mi = body.meetingInfo
    await queries.meetingSession.createMeetingSession(db, {
      agentId: body.agentId,
      workspaceId: body.workspaceId,
      title: mi.title || body.subject,
      meetingUrl: mi.meetingUrl,
      status: body.isWhitelisted ? MeetingStatus.SCHEDULED : MeetingStatus.PENDING,
      fromEmail: body.from,
      isWhitelisted: body.isWhitelisted,
      participants: mi.attendees.map(a => a.email),
      scheduledAt: mi.startTime,
    })
  }

  if (body.isWhitelisted && agent && agent.runtimeId && agent.ownerId) {
    const threadId = extractThreadId(body.references, body.inReplyTo, body.messageId);
    const mapKey = threadId ? buildEmailMapKey(agent.id, threadId) : null;

    let conversationId: string | null = null;
    let conversationType: string = TASK_TYPES.EMAIL_NOTIFICATION;
    let dmUser: { name: string; email: string } | undefined;

    if (mapKey) {
      conversationId = await queries.conversationMap.findByKey(db, mapKey, body.workspaceId);
    }

    if (conversationId) {
      const conv = await queries.conversation.getConversation(db, conversationId, body.workspaceId);
      if (conv) {
        conversationType = conv.type;
        if (conv.type === TASK_TYPES.USER_DM_MESSAGE && conv.userId) {
          const u = await queries.user.getUser(db, conv.userId);
          if (u) dmUser = { name: u.name, email: u.email };
        }
      }
    } else {
      let inheritedChannel: string | undefined;
      if (body.sourceTaskId) {
        const parentTask = await queries.task.getTask(db, body.sourceTaskId, body.workspaceId);
        if (parentTask) {
          const parentConv = await queries.conversation.getConversation(db, parentTask.conversationId, body.workspaceId);
          if (parentConv) inheritedChannel = parentConv.channel;
        }
      }
      const conv = await queries.conversation.createConversation(db, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        userId: agent.ownerId,
        title: `Email: ${body.subject}`.slice(0, 50),
        type: TASK_TYPES.EMAIL_NOTIFICATION,
        ...(inheritedChannel && inheritedChannel !== "default" ? { channel: inheritedChannel } : {}),
      })
      conversationId = conv.id;

      if (mapKey) {
        await queries.conversationMap.createMapping(db, {
          key: mapKey,
          workspaceId: body.workspaceId,
          conversationId,
        });
      }
    }

    const prompt = `New email from ${body.from}: ${body.subject}`;
    const emailMetadata = JSON.stringify({ emailId: email.id });
    const msg = await queries.message.createMessage(db, {
      conversationId,
      role: "event",
      content: prompt,
      metadata: emailMetadata,
    })

    if (conversationType === TASK_TYPES.USER_DM_MESSAGE) {
      broadcastToUser(agent.ownerId, {
        type: "conversation.message",
        conversationId,
        message: {
          id: msg.id,
          conversation_id: msg.conversationId,
          role: msg.role as "event",
          content: msg.content,
          task_id: msg.taskId,
          attachment_ids: null,
          metadata: { emailId: email.id },
          created_at: msg.createdAt,
        },
      }).catch(() => {})
    }

    const taskService = new TaskService(db)
    const context: Record<string, unknown> = { conversationType };
    if (dmUser) context.dmUser = dmUser;
    if (body.isInternal) context.isInternal = true;
    const traceId = body.traceId || ("tr_" + nanoid());
    const parentTaskId = body.traceId ? (body.sourceTaskId || null) : null;
    const task = await taskService.enqueueTask(agent.id, conversationId, agent.workspaceId, prompt, TASK_TYPES.EMAIL_NOTIFICATION, { contextKey: conversationId, context, traceId, parentTaskId })
    queries.message.updateMessageTaskId(db, msg.id, task.id).catch(() => {})

    if (conversationType === TASK_TYPES.USER_DM_MESSAGE) {
      broadcastToUser(agent.ownerId, {
        type: "task.created",
        conversationId,
        task: taskToResponse(task),
      }).catch(() => {});
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  await Promise.all([
    invalidate(cacheKeys.overviewEmailStats(body.workspaceId)),
    invalidate(cacheKeys.overviewTaskStats(body.workspaceId, dateStr)),
  ]);

  if (agent?.ownerId) {
    broadcastToUser(agent.ownerId, { type: "email.received", agentId: body.agentId }).catch(() => {})
  }

  return writeJSON({ ok: true })
}
