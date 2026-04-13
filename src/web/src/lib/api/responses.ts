import {
  formatTimestamp,
  formatTimestampNullable,
} from "@/lib/middleware/helpers";
import { TaskApiBaseSchema } from "@alook/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function userToResponse(u: any) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatar_url: u.avatarUrl || null,
    created_at: formatTimestamp(u.createdAt),
    updated_at: formatTimestamp(u.updatedAt),
  };
}

export function workspaceToResponse(w: any) {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
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
    html_body: e.htmlBody ?? "",
    attachments: JSON.parse(e.attachments || "[]"),
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
  status: string;
  priority: number;
  dispatchedAt: Date | string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  result?: unknown;
  error?: string | null;
  createdAt: Date | string;
}) {
  return TaskApiBaseSchema.parse({
    id: t.id,
    agent_id: t.agentId,
    runtime_id: t.runtimeId,
    conversation_id: t.conversationId,
    workspace_id: t.workspaceId,
    prompt: t.prompt,
    status: t.status,
    priority: t.priority,
    dispatched_at: formatTimestampNullable(t.dispatchedAt),
    started_at: formatTimestampNullable(t.startedAt),
    completed_at: formatTimestampNullable(t.completedAt),
    result: t.result ?? null,
    error: t.error || null,
    created_at: formatTimestamp(t.createdAt),
  });
}

export function conversationToResponse(c: any) {
  const resp: any = {
    id: c.id,
    agent_id: c.agentId,
    title: c.title,
    created_at: formatTimestamp(c.createdAt),
  };
  if (c.messageCount !== undefined) {
    resp.message_count = c.messageCount;
  }
  return resp;
}

export function messageToResponse(m: any) {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    role: m.role,
    content: m.content,
    task_id: m.taskId || null,
    created_at: formatTimestamp(m.createdAt),
  };
}

export function taskMessageToResponse(m: any) {
  const resp: any = {
    id: m.id,
    task_id: m.taskId,
    seq: m.seq,
    type: m.type,
    tool: m.tool,
    call_id: m.callId || "",
    content: m.content,
    output: m.output,
  };
  if (m.input) resp.input = m.input;
  return resp;
}

export function runtimeToResponse(rt: any) {
  let metadata = rt.metadata;
  if (!metadata) metadata = {};
  return {
    id: rt.id,
    workspace_id: rt.workspaceId,
    daemon_id: rt.daemonId || null,
    name: rt.name,
    runtime_mode: rt.runtimeMode,
    provider: rt.provider,
    status: rt.status,
    device_info: rt.deviceInfo,
    metadata,
    last_seen_at: formatTimestampNullable(rt.lastSeenAt),
    created_at: formatTimestamp(rt.createdAt),
    updated_at: formatTimestamp(rt.updatedAt),
  };
}

export function machineTokenToResponse(mt: any) {
  return {
    id: mt.id,
    name: mt.name,
    last_used_at: formatTimestampNullable(mt.lastUsedAt),
    created_at: formatTimestamp(mt.createdAt),
  };
}
