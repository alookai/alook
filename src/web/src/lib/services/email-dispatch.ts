import { queries, TASK_TYPES, extractThreadId, buildEmailMapKey } from "@alook/shared"
import { nanoid } from "nanoid"
import type { Database } from "@alook/shared"
import { TaskService } from "@/lib/services/task"
import { broadcastToUser } from "@/lib/broadcast"
import { taskToResponse } from "@/lib/api/responses"

interface EmailRow {
  id: string
  fromEmail: string
  toEmail: string
  subject: string
  messageId: string
  inReplyTo: string
  references: string
  agentId: string
  workspaceId: string
}

interface AgentRow {
  id: string
  workspaceId: string
  ownerId: string | null
}

interface DispatchOpts {
  isInternal?: boolean
  senderConversationId?: string
  senderAgentId?: string
  traceId?: string
  sourceTaskId?: string
}

export async function dispatchEmailToAgent(
  db: Database,
  email: EmailRow,
  agent: AgentRow,
  opts: DispatchOpts = {},
): Promise<{ conversationId: string; taskId: string }> {
  const ownerId = agent.ownerId!
  const threadId = extractThreadId(email.references, email.inReplyTo, email.messageId)
  const mapKey = threadId ? buildEmailMapKey(agent.id, threadId) : null
  let conversationType: string = TASK_TYPES.EMAIL_NOTIFICATION
  let dmUser: { name: string; email: string } | undefined
  let conversationId: string | null = null

  if (mapKey) {
    conversationId = await queries.conversationMap.findByKey(db, mapKey, email.workspaceId)
  }

  if (conversationId) {
    const conv = await queries.conversation.getConversation(db, conversationId, email.workspaceId)
    if (conv) {
      conversationType = conv.type
      if (conv.type === TASK_TYPES.USER_DM_MESSAGE && conv.userId) {
        const u = await queries.user.getUserSelf(db, conv.userId)
        if (u) dmUser = { name: u.name, email: u.email }
      }
    }
  } else {
    let inheritedChannel: string | undefined
    if (opts.sourceTaskId) {
      const parentTask = await queries.task.getTask(db, opts.sourceTaskId, email.workspaceId)
      if (parentTask) {
        const parentConv = await queries.conversation.getConversation(db, parentTask.conversationId, email.workspaceId)
        if (parentConv) inheritedChannel = parentConv.channel
      }
    }
    const conv = await queries.conversation.createConversation(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      userId: ownerId,
      title: `Email: ${email.subject}`.slice(0, 50),
      type: TASK_TYPES.EMAIL_NOTIFICATION,
      ...(inheritedChannel && inheritedChannel !== "default" ? { channel: inheritedChannel } : {}),
    })
    conversationId = conv.id

    if (mapKey) {
      await queries.conversationMap.createMapping(db, {
        key: mapKey,
        workspaceId: email.workspaceId,
        conversationId,
      })
    }
  }

  const prompt = `New email from ${email.fromEmail}: ${email.subject}`
  const crossLink = opts.isInternal && opts.senderConversationId && opts.senderAgentId !== email.agentId
    ? { targetConversationId: opts.senderConversationId, targetAgentId: opts.senderAgentId }
    : {}
  const emailMetadata = JSON.stringify({ emailId: email.id, subject: email.subject, from: email.fromEmail, to: email.toEmail, direction: "inbound" as const, ...crossLink })
  const msg = await queries.message.createMessage(db, {
    conversationId,
    role: "event",
    content: prompt,
    metadata: emailMetadata,
  })

  if (conversationType === TASK_TYPES.USER_DM_MESSAGE) {
    broadcastToUser(ownerId, {
      type: "conversation.message",
      conversationId,
      message: {
        id: msg.id,
        conversation_id: msg.conversationId,
        role: msg.role as "event",
        content: msg.content,
        task_id: msg.taskId,
        attachment_ids: null,
        metadata: { emailId: email.id, subject: email.subject, from: email.fromEmail, to: email.toEmail, direction: "inbound" },
        created_at: msg.createdAt,
      },
    }).catch(() => {})
  }

  const taskService = new TaskService(db)
  const context: Record<string, unknown> = { conversationType }
  if (dmUser) context.dmUser = dmUser
  if (opts.isInternal) context.isInternal = true
  context.emailId = email.id
  const traceId = opts.traceId || ("tr_" + nanoid())
  const parentTaskId = opts.traceId ? (opts.sourceTaskId || null) : null
  const task = await taskService.enqueueTask(agent.id, conversationId, agent.workspaceId, prompt, TASK_TYPES.EMAIL_NOTIFICATION, { contextKey: conversationId, context, traceId, parentTaskId })
  queries.message.updateMessageTaskId(db, msg.id, task.id).catch(() => {})

  if (conversationType === TASK_TYPES.USER_DM_MESSAGE) {
    broadcastToUser(ownerId, {
      type: "task.created",
      conversationId,
      task: taskToResponse(task),
    }).catch(() => {})
  }

  return { conversationId, taskId: task.id }
}
