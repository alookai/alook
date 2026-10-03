import type {
Artifact,
Conversation,
Message,
TaskApi,
TaskMessageResponse,
} from "@alook/shared";
import type { PendingFile } from "@/hooks/use-file-attachments";
import type { ApiRequestOptions } from "./client";
import { apiFetch,apiFetchResponse,wsQuery } from "./client";

export const createConversation = (agentId: string, workspaceId: string, channel?: string, options?: ApiRequestOptions) =>
  apiFetch<Conversation>(`/api/conversations${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, ...(channel ? { channel } : {}) }),
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
  options?: ApiRequestOptions,
) => {
  const extra: Record<string, string> = { exclude: opts.exclude, before: opts.before };
  if (opts.channel) extra.channel = opts.channel;
  if (opts.limit) extra.limit = String(opts.limit);
  return apiFetch<{ conversations: PreviousConversation[]; has_more: boolean }>(
    `/api/agents/${agentId}/conversations${wsQuery(workspaceId, extra)}`, options,
  );
};

export const chatInit = (agentId: string, workspaceId: string, channel?: string, options?: ApiRequestOptions) =>
  apiFetch<ChatInitResponse>(`/api/agents/${agentId}/chat-init${wsQuery(workspaceId)}`, {
    ...options,
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
  options?: ApiRequestOptions,
) => {
  const extra: Record<string, string> = {};
  if (opts?.newestMessageId) extra.newest_message_id = opts.newestMessageId;
  if (opts?.messageCount) extra.message_count = String(opts.messageCount);
  return apiFetch<ConversationInitResponse>(
    `/api/conversations/${conversationId}/init${wsQuery(workspaceId, extra)}`, options,
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
  options?: ApiRequestOptions,
) => {
  const extra: Record<string, string> = {};
  if (opts.conversationId) extra.conversation_id = opts.conversationId;
  if (opts.agentId) extra.agent_id = opts.agentId;
  if (opts.channel) extra.channel = opts.channel;
  return apiFetch<FreshnessCheckResponse>(
    `/api/conversations/check-fresh${wsQuery(workspaceId, extra)}`, options,
  );
};

export const listMessages = (
  conversationId: string,
  workspaceId: string,
  opts?: { limit?: number; before?: string; beforeId?: string },
  options?: ApiRequestOptions,
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.beforeId) extra.before_id = opts.beforeId;
  return apiFetch<{ messages: Message[]; has_more: boolean }>(
    `/api/conversations/${conversationId}/messages${wsQuery(workspaceId, extra)}`, options,
  );
};

export const listMessagesAroundTask = (
  conversationId: string,
  workspaceId: string,
  taskId: string,
  options?: ApiRequestOptions,
) =>
  apiFetch<Message[]>(
    `/api/conversations/${conversationId}/messages${wsQuery(workspaceId, { around_task: taskId })}`, options,
  );

export const sendMessage = async (
  conversationId: string,
  content: string,
  workspaceId: string,
  files?: PendingFile[],
  metadata?: Record<string, unknown>,
  options?: ApiRequestOptions,
): Promise<{ message: Message; task: TaskApi }> => {
  if (!files || files.length === 0) {
    return apiFetch<{ message: Message; task: TaskApi }>(
      `/api/conversations/${conversationId}/messages${wsQuery(workspaceId)}`,
      {
        ...options,
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

  const res = await apiFetchResponse(`/api/conversations/${conversationId}/messages${wsQuery(workspaceId)}`, { ...options, method: "POST", body: fd });
  const data = await res.json() as { message: Message; task: TaskApi };
  options?.assertActive?.();
  if (options?.signal?.aborted) throw new DOMException("Cancelled chat upload", "AbortError");
  return data;
};

// Active task for conversation
export const getActiveTask = (conversationId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<TaskApi | undefined>(`/api/conversations/${conversationId}/active-task${wsQuery(workspaceId)}`, options);

export const cancelActiveTask = (conversationId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<TaskApi>(`/api/conversations/${conversationId}/active-task${wsQuery(workspaceId)}`, {
    ...options,
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

export const createThread = (
  conversationId: string,
  parentMessageId: string,
  content: string,
  workspaceId: string,
  options?: ApiRequestOptions,
) =>
  apiFetch<{
    conversation: Conversation;
    message: Message;
    task: TaskApi;
  }>(`/api/conversations/${conversationId}/threads${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ parent_message_id: parentMessageId, content }),
  });

export const getThreadSummaries = (conversationId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ thread_summaries: ThreadSummary[] }>(
    `/api/conversations/${conversationId}/threads${wsQuery(workspaceId)}`, options
  );
