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
  opts?: { limit?: number; before?: string; types?: string[] }
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.types?.length) extra.types = opts.types.join(",");
  return apiFetch<{ items: InboxItem[]; has_more: boolean }>(
    `/api/inbox${wsQuery(workspaceId, extra)}`
  );
};

export const getInboxCount = (workspaceId: string, opts?: { types?: string[] }) => {
  const extra: Record<string, string> = {};
  if (opts?.types?.length) extra.types = opts.types.join(",");
  return apiFetch<{ count: number }>(`/api/inbox/count${wsQuery(workspaceId, extra)}`);
};

export const markInboxRead = (conversationId: string, workspaceId: string) =>
  apiFetch<void>(`/api/inbox/read${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });

export const markAllInboxRead = (workspaceId: string) =>
  apiFetch<void>(`/api/inbox/read-all${wsQuery(workspaceId)}`, {
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
  opts?: { limit?: number; before?: string }
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  return apiFetch<{ items: FlaggedItem[]; has_more: boolean }>(
    `/api/flags${wsQuery(workspaceId, extra)}`
  );
};

export const getFlaggedCount = (workspaceId: string) =>
  apiFetch<{ count: number }>(`/api/flags/count${wsQuery(workspaceId)}`);

export const flagMessage = (workspaceId: string, messageId: string) =>
  apiFetch<{ flagged: boolean }>(`/api/flags${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ messageId }),
  });

export const unflagMessage = (workspaceId: string, messageId: string) =>
  apiFetch<void>(`/api/flags/${messageId}${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

export const listFlaggedMessageIds = (workspaceId: string, conversationId: string) =>
  apiFetch<{ message_ids: string[] }>(
    `/api/flags${wsQuery(workspaceId, { conversation_id: conversationId, ids_only: "true" })}`
  );
