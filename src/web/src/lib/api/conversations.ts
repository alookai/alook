import type {
  Artifact,
  Conversation,
  Message,
  TaskApi,
  TaskMessageResponse,
} from "@alook/shared";
import { ApiError } from "@/lib/errors";
import type { PendingFile } from "@/hooks/use-file-attachments";
import { apiFetch, wsQuery } from "./client";

export const listConversations = (workspaceId: string, channel?: string) =>
  apiFetch<Conversation[]>(`/api/conversations${wsQuery(workspaceId, channel ? { channel } : undefined)}`);

export const createConversation = (agentId: string, workspaceId: string, channel?: string) =>
  apiFetch<Conversation>(`/api/conversations${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, ...(channel ? { channel } : {}) }),
  });

export const getConversation = (id: string, workspaceId: string) =>
  apiFetch<Conversation>(`/api/conversations/${id}${wsQuery(workspaceId)}`);

export const listAgentConversations = (agentId: string, workspaceId: string, channel?: string) =>
  apiFetch<Conversation[]>(`/api/agents/${agentId}/conversations${wsQuery(workspaceId, channel ? { channel } : undefined)}`);

export const getOrCreateAgentConversation = (agentId: string, workspaceId: string, channel?: string) =>
  apiFetch<Conversation>(`/api/agents/${agentId}/conversation${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ ...(channel ? { channel } : {}) }),
  });

export interface PreviousConversation {
  id: string;
  created_at: string;
}

export interface ChatInitResponse {
  conversation: Conversation;
  messages: Message[];
  artifacts: Artifact[];
  active_task: TaskApi | null;
  task_messages: TaskMessageResponse[];
  has_more_messages: boolean;
  has_more_conversations: boolean;
  has_more_artifacts: boolean;
}

export const listPreviousConversations = (
  agentId: string,
  workspaceId: string,
  opts: { exclude: string; before: string; channel?: string; limit?: number },
) => {
  const extra: Record<string, string> = { exclude: opts.exclude, before: opts.before };
  if (opts.channel) extra.channel = opts.channel;
  if (opts.limit) extra.limit = String(opts.limit);
  return apiFetch<{ conversations: PreviousConversation[]; has_more: boolean }>(
    `/api/agents/${agentId}/conversations${wsQuery(workspaceId, extra)}`,
  );
};

export const chatInit = (agentId: string, workspaceId: string, channel?: string) =>
  apiFetch<ChatInitResponse>(`/api/agents/${agentId}/chat-init${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ ...(channel ? { channel } : {}) }),
  });

export interface ConversationInitResponse {
  conversation: Conversation;
  messages: Message[] | null;
  has_more_messages: boolean;
  has_more_conversations: boolean;
  has_more_artifacts: boolean;
  artifacts: Artifact[];
  flagged_message_ids: string[];
  active_task: TaskApi | null;
  task_messages: TaskMessageResponse[];
  cache_valid: boolean;
  message_count: number;
  root_message?: Message | null;
}

export const conversationInit = (
  conversationId: string,
  workspaceId: string,
  opts?: { newestMessageId?: string; messageCount?: number },
) => {
  const extra: Record<string, string> = {};
  if (opts?.newestMessageId) extra.newest_message_id = opts.newestMessageId;
  if (opts?.messageCount) extra.message_count = String(opts.messageCount);
  return apiFetch<ConversationInitResponse>(
    `/api/conversations/${conversationId}/init${wsQuery(workspaceId, extra)}`,
  );
};

export interface FreshnessCheckResponse {
  conversation_id: string;
  newest_message_id: string | null;
  message_count: number;
}

export const checkFreshness = (
  opts: { conversationId?: string; agentId?: string; channel?: string },
  workspaceId: string,
) => {
  const extra: Record<string, string> = {};
  if (opts.conversationId) extra.conversation_id = opts.conversationId;
  if (opts.agentId) extra.agent_id = opts.agentId;
  if (opts.channel) extra.channel = opts.channel;
  return apiFetch<FreshnessCheckResponse>(
    `/api/conversations/check-fresh${wsQuery(workspaceId, extra)}`,
  );
};

export const deleteConversation = (id: string, workspaceId: string) =>
  apiFetch<void>(`/api/conversations/${id}${wsQuery(workspaceId)}`, { method: "DELETE" });

export const listMessages = (
  conversationId: string,
  workspaceId: string,
  opts?: { limit?: number; before?: string; beforeId?: string }
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.beforeId) extra.before_id = opts.beforeId;
  return apiFetch<{ messages: Message[]; has_more: boolean }>(
    `/api/conversations/${conversationId}/messages${wsQuery(workspaceId, extra)}`
  );
};

export const listMessagesAroundTask = (
  conversationId: string,
  workspaceId: string,
  taskId: string
) =>
  apiFetch<Message[]>(
    `/api/conversations/${conversationId}/messages${wsQuery(workspaceId, { around_task: taskId })}`
  );

export const sendMessage = async (
  conversationId: string,
  content: string,
  workspaceId: string,
  files?: PendingFile[],
  metadata?: Record<string, unknown>,
): Promise<{ message: Message; task: TaskApi }> => {
  if (!files || files.length === 0) {
    return apiFetch<{ message: Message; task: TaskApi }>(
      `/api/conversations/${conversationId}/messages${wsQuery(workspaceId)}`,
      {
        method: "POST",
        body: JSON.stringify({ content, ...(metadata ? { metadata } : {}) }),
      },
    );
  }

  const fd = new FormData();
  fd.append("content", content);
  if (metadata) fd.append("metadata", JSON.stringify(metadata));
  for (const pf of files) {
    fd.append("file", pf.file);
  }
  for (let i = 0; i < files.length; i++) {
    const blob = files[i].thumbnailBlob;
    if (blob) fd.append(`thumbnail:${i}`, blob, "thumbnail.jpg");
  }

  let res: Response;
  try {
    res = await fetch(
      `/api/conversations/${conversationId}/messages${wsQuery(workspaceId)}`,
      { method: "POST", credentials: "include", body: fd },
    );
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError("Unable to connect — check your network", 0);
    }
    throw err;
  }

  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/sign-in";
    throw new ApiError("Unauthorized", 401);
  }

  if (!res.ok) {
    let serverError: string | undefined;
    let details: string[] | undefined;
    try {
      const body = (await res.json()) as { error?: string; details?: string[] };
      serverError = body.error;
      details = body.details;
    } catch {
      // non-JSON body
    }
    if (res.status === 429) throw new ApiError("Please wait a moment before trying again", 429);
    if (res.status >= 500) throw new ApiError(serverError || "Something went wrong — please try again", res.status, details);
    throw new ApiError(serverError || "Something went wrong", res.status, details);
  }

  return res.json() as Promise<{ message: Message; task: TaskApi }>;
};

// Active task for conversation
export const getActiveTask = (conversationId: string, workspaceId: string) =>
  apiFetch<TaskApi | undefined>(`/api/conversations/${conversationId}/active-task${wsQuery(workspaceId)}`);

export const cancelActiveTask = (conversationId: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/conversations/${conversationId}/active-task${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

// Threads
export interface ThreadSummary {
  thread_id: string;
  parent_message_id: string;
  thread_title: string;
  reply_count: number;
  last_reply_at: string | null;
  created_at: string;
}

export interface ThreadListItem {
  id: string;
  parent_message_id: string;
  thread_title: string;
  reply_count: number;
  last_reply_at: string | null;
  last_reply_preview: string;
  created_at: string;
}

export const createThread = (
  conversationId: string,
  parentMessageId: string,
  content: string,
  workspaceId: string,
) =>
  apiFetch<{
    conversation: Conversation;
    message: Message;
    task: TaskApi;
  }>(`/api/conversations/${conversationId}/threads${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ parent_message_id: parentMessageId, content }),
  });

export const getThreadSummaries = (conversationId: string, workspaceId: string) =>
  apiFetch<{ thread_summaries: ThreadSummary[] }>(
    `/api/conversations/${conversationId}/threads${wsQuery(workspaceId)}`
  );

export const listAgentThreads = (
  agentId: string,
  workspaceId: string,
  opts?: { limit?: number; before?: string }
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  return apiFetch<{ threads: ThreadListItem[]; has_more: boolean }>(
    `/api/agents/${agentId}/threads${wsQuery(workspaceId, extra)}`
  );
};
