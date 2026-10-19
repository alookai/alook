import { formatTimestamp, formatTimestampNullable } from "@/lib/middleware/helpers";
import { TaskApiBaseSchema, TASK_TYPES, schema, type Message } from "@alook/shared";

type MessageRow = typeof schema.message.$inferSelect;

export function taskToResponse(t: {
  id: string;
  agentId: string;
  runtimeId: string;
  conversationId: string;
  workspaceId: string;
  prompt: string;
  type?: string;
  contextKey?: string | null;
  context?: unknown;
  status: string;
  priority: number;
  dispatchedAt: Date | string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  result?: unknown;
  error?: string | null;
  createdAt: Date | string;
  traceId?: string | null;
  parentTaskId?: string | null;
}) {
  return TaskApiBaseSchema.parse({
    id: t.id,
    agent_id: t.agentId,
    runtime_id: t.runtimeId,
    conversation_id: t.conversationId,
    workspace_id: t.workspaceId,
    prompt: t.prompt,
    type: t.type ?? TASK_TYPES.USER_DM_MESSAGE,
    context_key: t.contextKey ?? null,
    context: t.context ?? null,
    status: t.status,
    priority: t.priority,
    dispatched_at: formatTimestampNullable(t.dispatchedAt),
    started_at: formatTimestampNullable(t.startedAt),
    completed_at: formatTimestampNullable(t.completedAt),
    result: t.result ?? null,
    error: t.error || null,
    created_at: formatTimestamp(t.createdAt),
    trace_id: t.traceId ?? null,
    parent_task_id: t.parentTaskId ?? null,
  });
}

export function messageToResponse(m: MessageRow): Message {
  const resp: Message = {
    id: m.id,
    conversation_id: m.conversationId,
    role: m.role as Message["role"],
    content: m.content,
    task_id: m.taskId || null,
    attachment_ids: m.attachmentIds ? JSON.parse(m.attachmentIds) : null,
    metadata: m.metadata ? JSON.parse(m.metadata) : null,
    created_at: formatTimestamp(m.createdAt),
  };
  if (m.status === "active") {
    resp.status = "active";
  }
  return resp;
}
