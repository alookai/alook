import type { ApiRequestOptions } from "./client";
import { apiFetch, wsQuery } from "./client";

// Inbox
export interface InboxItem {
  id: string;
  agent_id: string;
  title: string;
  channel: string;
  latest_response: string;
  latest_response_at: string;
  root_prompt: string | null;
  agent_name: string | null;
  agent_avatar_url: string | null;
  root_task_status: string | null;
  root_task_type: string | null;
}

export const listInboxItems = (
  workspaceId: string,
  opts?: { limit?: number; before?: string; types?: string[] },
  options?: RequestInit
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.types?.length) extra.types = opts.types.join(",");
  return apiFetch<{ items: InboxItem[]; has_more: boolean }>(
    `/api/inbox${wsQuery(workspaceId, extra)}`, options
  );
};

export const getInboxCount = (workspaceId: string, opts?: { types?: string[] }, options?: RequestInit) => {
  const extra: Record<string, string> = {};
  if (opts?.types?.length) extra.types = opts.types.join(",");
  return apiFetch<{ count: number }>(`/api/inbox/count${wsQuery(workspaceId, extra)}`, options);
};

export const markInboxRead = (conversationId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/inbox/read${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });

export const markAllInboxRead = (workspaceId: string, options?: RequestInit) =>
  apiFetch<void>(`/api/inbox/read-all${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
  });

// Flags
export interface FlaggedItem {
  id: string;
  message_id: string;
  message_content: string;
  message_role: string;
  message_created_at: string;
  conversation_id: string;
  conversation_title: string;
  agent_id: string;
  agent_name: string | null;
  agent_avatar_url: string | null;
  flagged_at: string;
}

export const listFlaggedItems = (
  workspaceId: string,
  opts?: { limit?: number; before?: string },
  options?: RequestInit
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  return apiFetch<{ items: FlaggedItem[]; has_more: boolean }>(
    `/api/flags${wsQuery(workspaceId, extra)}`, options
  );
};

export const getFlaggedCount = (workspaceId: string, options?: RequestInit) =>
  apiFetch<{ count: number }>(`/api/flags/count${wsQuery(workspaceId)}`, options);

export const flagMessage = (workspaceId: string, messageId: string, options?: ApiRequestOptions) =>
  apiFetch<{ flagged: boolean }>(`/api/flags${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ messageId }),
  });

export const unflagMessage = (workspaceId: string, messageId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/flags/${messageId}${wsQuery(workspaceId)}`, {
    ...options,
    method: "DELETE",
  });

export const listFlaggedMessageIds = (workspaceId: string, conversationId: string, options?: ApiRequestOptions) =>
  apiFetch<{ message_ids: string[] }>(
    `/api/flags${wsQuery(workspaceId, { conversation_id: conversationId, ids_only: "true" })}`, options,
  );
