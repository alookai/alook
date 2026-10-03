import type { Workspace } from "@alook/shared";
import { apiFetch,wsQuery,type ApiRequestOptions } from "./client";

export const listWorkspaces = (options?: ApiRequestOptions) => apiFetch<Workspace[]>("/api/workspaces", options);

export const updateWorkspace = (workspaceId: string, data: { name?: string; slug?: string }, options?: ApiRequestOptions) =>
  apiFetch<Workspace>(`/api/workspaces/${workspaceId}${wsQuery(workspaceId)}`, { ...options, method: "PATCH", body: JSON.stringify(data) });

export const deleteWorkspace = (workspaceId: string, confirmName: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/workspaces/${workspaceId}${wsQuery(workspaceId)}`, { ...options, method: "DELETE", body: JSON.stringify({ confirm_name: confirmName }) });

// Members
export interface MemberEntry {
  id: string; user_id: string; role: string; name: string; email: string; image: string | null; created_at: string;
}

export const listMembers = (workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<MemberEntry[]>(`/api/workspaces/${workspaceId}/members${wsQuery(workspaceId)}`, options);

export const removeMember = (workspaceId: string, memberId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/workspaces/${workspaceId}/members/${memberId}${wsQuery(workspaceId)}`, { ...options, method: "DELETE" });

export const getMemberMe = (workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ global_instruction: string }>(`/api/members/me${wsQuery(workspaceId)}`, options);

export const updateMemberMe = (workspaceId: string, globalInstruction: string, options?: ApiRequestOptions) =>
  apiFetch<{ global_instruction: string }>(`/api/members/me${wsQuery(workspaceId)}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify({ global_instruction: globalInstruction }),
  });

// Invites
export interface InviteEntry {
  id: string; token: string; expires_at: string; created_at: string;
}

export const listInvites = (workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<InviteEntry[]>(`/api/workspaces/${workspaceId}/invites${wsQuery(workspaceId)}`, options);

export const createInvite = (workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<InviteEntry>(`/api/workspaces/${workspaceId}/invites${wsQuery(workspaceId)}`, { ...options, method: "POST" });

export const revokeInvite = (workspaceId: string, inviteId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/workspaces/${workspaceId}/invites/${inviteId}${wsQuery(workspaceId)}`, { ...options, method: "DELETE" });

// Invite accept
export interface InviteInfo {
  workspace_name: string; workspace_id: string; invited_by: string;
}

export interface InviteAcceptResult {
  workspace_id: string; workspace_slug: string;
}

export const getInviteInfo = (token: string, options?: ApiRequestOptions) => apiFetch<InviteInfo>(`/api/invite/${token}`, options);
export const acceptInvite = (token: string, options?: ApiRequestOptions) => apiFetch<InviteAcceptResult>(`/api/invite/${token}`, { ...options, method: "POST" });

// Overview
interface OverviewEmailAccount {
  id: string;
  agent_id: string;
  email_address: string;
  status: string;
  error_message: string;
  last_synced_at: string | null;
}

interface OverviewRecentTask {
  id: string;
  agent_id: string;
  type: string;
  status: string;
  prompt: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

interface OverviewCalendarEvent {
  id: string;
  agent_id: string;
  title: string;
  description: string | null;
  scheduled_at: string;
  repeat_interval: string | null;
  repeat_stop_at: string | null;
  last_triggered_at: string | null;
}

interface OverviewMember {
  id: string;
  user_id: string;
  role: string;
  name: string;
  email: string;
  image: string | null;
  created_at: string;
}

export interface WorkspaceOverview {
  email_stats: { inbound: number; outbound: number; unread: number; rejected: number };
  email_accounts: OverviewEmailAccount[];
  task_stats: { completed: number; failed: number; cancelled: number; queued: number; stale: number };
  recent_tasks: OverviewRecentTask[];
  conversation_counts: Record<string, number>;
  members: OverviewMember[];
  pending_invites: number;
  calendar_events: OverviewCalendarEvent[];
}

export const getWorkspaceOverview = (workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<WorkspaceOverview>(`/api/workspaces/${workspaceId}/overview${wsQuery(workspaceId)}`, options);
