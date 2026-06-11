import {
  formatTimestamp,
  formatTimestampNullable,
} from "@/lib/middleware/helpers";
import { TaskApiBaseSchema, isOnline, TASK_TYPES } from "@alook/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function userToResponse(u: any) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatar_url: u.avatarUrl ?? null,
    created_at: formatTimestamp(u.createdAt),
    updated_at: formatTimestamp(u.updatedAt),
  };
}

export function workspaceToResponse(w: any) {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    onboarded: !!w.onboarded,
    created_at: formatTimestamp(w.createdAt),
    updated_at: formatTimestamp(w.updatedAt),
  };
}

export function agentToResponse(a: any) {
  let rc = a.runtimeConfig;
  if (!rc) rc = {};
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    runtime_id: a.runtimeId || "",
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    runtime_mode: a.runtimeMode,
    runtime_config: rc,
    status: a.status,
    max_concurrent_tasks: a.maxConcurrentTasks,
    email_handle: a.emailHandle || null,
    avatar_url: a.avatarUrl ?? null,
    visibility: a.visibility ?? "private",
    owner_id: a.ownerId ?? null,
    created_at: formatTimestamp(a.createdAt),
    updated_at: formatTimestamp(a.updatedAt),
  };
}

export function emailToResponse(e: any) {
  return {
    id: e.id,
    agent_id: e.agentId,
    from_email: e.fromEmail,
    to_email: e.toEmail,
    subject: e.subject,
    r2_key: e.r2Key,
    is_whitelisted: !!e.isWhitelisted,
    forwarded: !!e.forwarded,
    message_id: e.messageId ?? "",
    in_reply_to: e.inReplyTo ?? "",
    references: e.references ?? "",
    html_body: e.htmlBody ?? "",
    attachments: JSON.parse(e.attachments || "[]"),
    status: e.status ?? "unread",
    direction: e.direction ?? "inbound",
    created_at: formatTimestamp(e.createdAt),
  };
}

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

export function conversationToResponse(c: any) {
  const resp: any = {
    id: c.id,
    agent_id: c.agentId,
    title: c.title,
    type: c.type ?? TASK_TYPES.USER_DM_MESSAGE,
    channel: c.channel ?? "default",
    created_at: formatTimestamp(c.createdAt),
  };
  if (c.parentMessageId) {
    resp.parent_message_id = c.parentMessageId;
    resp.thread_title = c.threadTitle ?? "";
  }
  if (c.messageCount !== undefined) {
    resp.message_count = c.messageCount;
  }
  return resp;
}

export function channelToResponse(c: any) {
  return {
    id: c.id,
    workspace_id: c.workspaceId,
    name: c.name,
    position: c.position ?? 0,
    created_at: formatTimestamp(c.createdAt),
  };
}

export function messageToResponse(m: any) {
  const resp: any = {
    id: m.id,
    conversation_id: m.conversationId,
    role: m.role,
    content: m.content,
    task_id: m.taskId || null,
    attachment_ids: m.attachmentIds ? JSON.parse(m.attachmentIds) : null,
    metadata: m.metadata ? JSON.parse(m.metadata) : null,
    created_at: formatTimestamp(m.createdAt),
  };
  if (m.status && m.status !== "active") {
    resp.status = m.status;
  }
  return resp;
}

export function taskMessageToResponse(m: any) {
  return {
    id: m.id,
    seq: m.seq,
    type: m.type,
    content: m.content,
    output: m.output,
  };
}

export function runtimeToResponse(rt: any) {
  let metadata = rt.metadata;
  if (!metadata) metadata = {};
  const machineLastSeenAt = rt.machineLastSeenAt ?? null;
  const lastSeenStr = machineLastSeenAt instanceof Date
    ? machineLastSeenAt.toISOString()
    : machineLastSeenAt;
  return {
    id: rt.id,
    workspace_id: rt.workspaceId,
    daemon_id: rt.daemonId || null,
    runtime_mode: rt.runtimeMode,
    provider: rt.provider,
    status: isOnline(lastSeenStr) ? "online" : "offline",
    device_info: rt.deviceInfo,
    metadata,
    pending_update_version: rt.pendingUpdateVersion ?? null,
    pending_rescan: !!rt.pendingRescan,
    last_seen_at: formatTimestampNullable(machineLastSeenAt),
    created_at: formatTimestamp(rt.createdAt),
    updated_at: formatTimestamp(rt.updatedAt),
  };
}

export function machineTokenToResponse(mt: any) {
  return {
    id: mt.id,
    name: mt.name,
    status: mt.status,
    last_used_at: formatTimestampNullable(mt.lastUsedAt),
    created_at: formatTimestamp(mt.createdAt),
  };
}

export function meetingToResponse(m: any) {
  return {
    id: m.id,
    agent_id: m.agentId,
    workspace_id: m.workspaceId,
    title: m.title,
    meeting_url: m.meetingUrl,
    status: m.status,
    from_email: m.fromEmail ?? null,
    is_whitelisted: !!m.isWhitelisted,
    participants: m.participants ?? [],
    scheduled_at: formatTimestampNullable(m.scheduledAt),
    started_at: formatTimestampNullable(m.startedAt),
    completed_at: formatTimestampNullable(m.completedAt),
    transcript_r2_key: m.transcriptR2Key ?? null,
    summary: m.summary ?? null,
    error: m.error ?? null,
    worker_session_id: m.workerSessionId ?? null,
    created_at: formatTimestamp(m.createdAt),
    updated_at: formatTimestamp(m.updatedAt),
  };
}

export function agentLinkToResponse(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    source_agent_id: row.sourceAgentId,
    target_agent_id: row.targetAgentId,
    instruction: row.instruction,
    created_at: formatTimestamp(row.createdAt),
    updated_at: formatTimestamp(row.updatedAt),
  };
}

export function calendarEventToResponse(e: any) {
  const scheduled = formatTimestamp(e.scheduledAt);
  const occurrence = e.occurrenceAt ? formatTimestamp(e.occurrenceAt) : scheduled;
  return {
    id: e.id,
    agent_id: e.agentId,
    workspace_id: e.workspaceId,
    title: e.title,
    description: e.description ?? null,
    scheduled_at: scheduled,
    occurrence_at: occurrence,
    collapsed_count: e.collapsedCount ?? null,
    repeat_interval: e.repeatInterval ?? null,
    repeat_stop_at: formatTimestampNullable(e.repeatStopAt),
    last_triggered_at: formatTimestampNullable(e.lastTriggeredAt),
    created_at: formatTimestamp(e.createdAt),
    updated_at: formatTimestamp(e.updatedAt),
  };
}

export function issueToResponse(row: any) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    agent_id: row.agentId,
    creator_user_id: row.creatorUserId,
    conversation_id: row.conversationId,
    latest_task_id: row.latestTaskId ?? null,
    title: row.title,
    description: row.description ?? "",
    status: row.status,
    created_at: formatTimestamp(row.createdAt),
    updated_at: formatTimestamp(row.updatedAt),
    completed_at: formatTimestampNullable(row.completedAt),
  };
}

export function taskToActivityResponse(t: {
  id: string;
  conversationId: string;
  type: string;
  status: string;
  prompt: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  error?: string | null;
}) {
  const prompt = t.prompt.length > 120 ? t.prompt.slice(0, 120) : t.prompt;
  return {
    id: t.id,
    conversation_id: t.conversationId,
    type: t.type ?? TASK_TYPES.USER_DM_MESSAGE,
    status: t.status,
    prompt,
    created_at: formatTimestamp(t.createdAt),
    started_at: formatTimestampNullable(t.startedAt),
    completed_at: formatTimestampNullable(t.completedAt),
    error: t.error || null,
  };
}

export function memberToResponse(m: {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  userName: string;
  userEmail: string;
  userImage: string | null;
}) {
  return {
    id: m.id,
    user_id: m.userId,
    role: m.role,
    name: m.userName,
    email: m.userEmail,
    image: m.userImage,
    created_at: formatTimestamp(m.createdAt),
  };
}

export function inviteToResponse(inv: {
  id: string;
  token: string;
  createdBy: string;
  usedBy: string | null;
  expiresAt: string;
  createdAt: string;
}) {
  return {
    id: inv.id,
    token: inv.token,
    created_by: inv.createdBy,
    used_by: inv.usedBy,
    expires_at: formatTimestamp(inv.expiresAt),
    created_at: formatTimestamp(inv.createdAt),
  };
}
