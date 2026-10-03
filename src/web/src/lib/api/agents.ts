import type { ApiRequestOptions } from "./client";
import type {
Agent,
AgentEmailAccount,
AgentLink,
AgentRuntime,
CreateAgentLinkRequest,
CreateAgentRequest,
CreateEmailAccountRequest,
MeetingSession,
UpdateAgentLinkRequest,
UpdateAgentRequest
} from "@alook/shared";
import { apiFetch,wsQuery } from "./client";

// Agents
export const listAgents = (workspaceId: string, options?: RequestInit) =>
  apiFetch<Agent[]>(`/api/agents${wsQuery(workspaceId)}`, options);

export const createAgent = (req: CreateAgentRequest, workspaceId: string, options?: RequestInit) =>
  apiFetch<Agent>(`/api/agents${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify(req),
  });

export const getAgent = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<Agent>(`/api/agents/${id}${wsQuery(workspaceId)}`, options);

export const updateAgent = (id: string, req: UpdateAgentRequest, workspaceId: string, options?: RequestInit) =>
  apiFetch<Agent>(`/api/agents/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify(req),
  });

export const deleteAgent = (id: string, workspaceId: string, options?: RequestInit) =>
  apiFetch<void>(`/api/agents/${id}${wsQuery(workspaceId)}`, { ...options, method: "DELETE" });

// Runtimes
export const listRuntimes = (workspaceId: string, options?: RequestInit) =>
  apiFetch<AgentRuntime[]>(`/api/runtimes${wsQuery(workspaceId)}`, options);

export const deleteMachine = (daemonId: string, workspaceId: string, options?: RequestInit) =>
  apiFetch<void>(
    `/api/runtimes/machine${wsQuery(workspaceId, { daemon_id: daemonId })}`,
    { ...options, method: "DELETE" }
  );

export const triggerRuntimeUpdate = (runtimeId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ pending_update_version: string }>(
    `/api/runtimes/${runtimeId}/update${wsQuery(workspaceId)}`,
    { ...options, method: "POST" }
  );

export const triggerRuntimeRescan = (runtimeId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ pending_rescan: boolean }>(
    `/api/runtimes/${runtimeId}/rescan${wsQuery(workspaceId)}`,
    { ...options, method: "POST" }
  );

// Agent active tasks
export const listAgentActiveTaskCounts = (workspaceId: string, options?: RequestInit) =>
  apiFetch<{ counts: Record<string, number> }>(`/api/agents/active-task-counts${wsQuery(workspaceId)}`, options);

export interface WorkspaceActiveTask {
  id: string;
  agent_id: string;
  agent: { name: string; avatarUrl: string | null } | null;
  prompt: string;
  status: string;
  type: string;
  conversation_id: string;
  channel: string;
  created_at: string;
}

export const listWorkspaceActiveTasks = (workspaceId: string, options?: RequestInit) =>
  apiFetch<{ tasks: WorkspaceActiveTask[] }>(`/api/agents/active-tasks${wsQuery(workspaceId)}`, options);

// Activity
export interface ActivityTask {
  id: string;
  conversation_id: string;
  type: string;
  status: string;
  prompt: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export const listAgentActivity = (
  agentId: string,
  workspaceId: string,
  opts?: { limit?: number; before?: string; beforeId?: string; status?: string; type?: string },
  options?: ApiRequestOptions
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.beforeId) extra.before_id = opts.beforeId;
  if (opts?.status) extra.status = opts.status;
  if (opts?.type) extra.type = opts.type;
  return apiFetch<{ tasks: ActivityTask[]; has_more: boolean }>(
    `/api/agents/${agentId}/activity${wsQuery(workspaceId, extra)}`, options
  );
};

// Whitelist
export interface WhitelistEntry {
  id: string;
  email: string;
  created_at: string;
}

export const listWhitelist = (agentId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<WhitelistEntry[]>(`/api/agents/${agentId}/whitelist${wsQuery(workspaceId)}`, options);

export const addWhitelistEmail = (agentId: string, email: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<WhitelistEntry>(`/api/agents/${agentId}/whitelist${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ email }),
  });

export const removeWhitelistEmail = (agentId: string, whitelistId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/agents/${agentId}/whitelist/${whitelistId}${wsQuery(workspaceId)}`, {
    ...options, method: "DELETE",
  });

// Agent Links
export const listAgentLinks = (workspaceId: string, options?: RequestInit) =>
  apiFetch<AgentLink[]>(`/api/agent-links${wsQuery(workspaceId)}`, options);

export const createAgentLink = (req: CreateAgentLinkRequest, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<AgentLink>(`/api/agent-links${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify(req),
  });

export const updateAgentLink = (id: string, req: UpdateAgentLinkRequest, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<AgentLink>(`/api/agent-links/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "PATCH",
    body: JSON.stringify(req),
  });

export const deleteAgentLink = (id: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<AgentLink>(`/api/agent-links/${id}${wsQuery(workspaceId)}`, {
    ...options,
    method: "DELETE",
  });

// Email Accounts
export const listEmailAccounts = (agentId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<AgentEmailAccount[]>(`/api/agents/${agentId}/email-accounts${wsQuery(workspaceId)}`, options);

export const createEmailAccount = (agentId: string, data: CreateEmailAccountRequest, workspaceId: string, options?: RequestInit) =>
  apiFetch<AgentEmailAccount>(`/api/agents/${agentId}/email-accounts${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify(data),
  });

export const deleteEmailAccount = (agentId: string, accountId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ ok: boolean }>(`/api/agents/${agentId}/email-accounts/${accountId}${wsQuery(workspaceId)}`, {
    ...options,
    method: "DELETE",
  });

export const syncEmailAccount = (agentId: string, accountId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ ok: boolean }>(`/api/agents/${agentId}/email-accounts/${accountId}/sync${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
  });

// Agent Access
export interface AgentAccessEntry {
  id: string; user_id: string; name: string; email: string; created_at: string;
}

export const listAgentAccess = (workspaceId: string, agentId: string, options?: ApiRequestOptions) =>
  apiFetch<AgentAccessEntry[]>(`/api/agents/${agentId}/access${wsQuery(workspaceId)}`, options);

export const grantAgentAccess = (workspaceId: string, agentId: string, userId: string, options?: ApiRequestOptions) =>
  apiFetch<{ id: string; user_id: string }>(`/api/agents/${agentId}/access${wsQuery(workspaceId)}`, { ...options, method: "POST", body: JSON.stringify({ user_id: userId }) });

export const revokeAgentAccess = (workspaceId: string, agentId: string, userId: string, removeWhitelist = false, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/agents/${agentId}/access/${userId}${wsQuery(workspaceId)}${removeWhitelist ? "&remove_whitelist=true" : ""}`, { ...options, method: "DELETE" });

// Agent Pins
export interface AgentPin {
  id: string;
  agent_id: string;
  created_at: string;
  position: number;
}

export interface SidebarOrder {
  agent_id: string;
  position: number;
}

export const listAgentPins = (workspaceId: string, options?: RequestInit) =>
  apiFetch<{ pins: AgentPin[]; sidebar_order: SidebarOrder[] }>(`/api/agents/pins${wsQuery(workspaceId)}`, options);

export const pinAgent = (workspaceId: string, agentId: string, options?: RequestInit) =>
  apiFetch<{ pinned: boolean }>(`/api/agents/${agentId}/pin${wsQuery(workspaceId)}`, { ...options, method: "POST" });

export const unpinAgent = (workspaceId: string, agentId: string, options?: RequestInit) =>
  apiFetch<void>(`/api/agents/${agentId}/pin${wsQuery(workspaceId)}`, { ...options, method: "DELETE" });

export const reorderAgentPins = (workspaceId: string, orderedAgentIds: string[], options?: RequestInit) =>
  apiFetch<void>(`/api/agents/pins/reorder${wsQuery(workspaceId)}`, {
    ...options,
    method: "PUT",
    body: JSON.stringify({ ordered_agent_ids: orderedAgentIds }),
  });

export const reorderUnpinnedAgents = (workspaceId: string, orderedAgentIds: string[], options?: RequestInit) =>
  apiFetch<void>(`/api/agents/sidebar/reorder${wsQuery(workspaceId)}`, {
    ...options,
    method: "PUT",
    body: JSON.stringify({ ordered_agent_ids: orderedAgentIds }),
  });

// Workspace file browsing
export const requestWorkspaceBrowse = (
  agentId: string,
  workspaceId: string,
  requestType: "tree" | "read",
  path: string,
  options?: ApiRequestOptions,
) =>
  apiFetch<{ request_id: string }>(
    `/api/agents/${agentId}/workspace/browse${wsQuery(workspaceId)}`,
    {
      ...options,
      method: "POST",
      body: JSON.stringify({ request_type: requestType, path }),
    },
  );

// Skill browsing
export const getAgentSkills = (agentId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<{ skills: { name: string; description: string; isGlobal?: boolean }[] }>(
    `/api/agents/${agentId}/skills${wsQuery(workspaceId)}`, options,
  );

// Meetings
export const listMeetings = (agentId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<MeetingSession[]>(`/api/agents/${agentId}/meetings${wsQuery(workspaceId)}`, options);

export const createMeeting = (agentId: string, workspaceId: string, data: {
  meetingUrl: string;
  title?: string;
  participants?: string[];
}, options?: ApiRequestOptions) =>
  apiFetch<MeetingSession>(`/api/agents/${agentId}/meetings${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
    body: JSON.stringify(data),
  });

export const stopMeeting = (agentId: string, meetingId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<MeetingSession & { transcript?: string }>(`/api/agents/${agentId}/meetings/${meetingId}/stop${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
  });

export const approveMeeting = (agentId: string, meetingId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<MeetingSession>(`/api/agents/${agentId}/meetings/${meetingId}/approve${wsQuery(workspaceId)}`, {
    ...options,
    method: "POST",
  });

export const deleteMeeting = (agentId: string, meetingId: string, workspaceId: string, options?: ApiRequestOptions) =>
  apiFetch<void>(`/api/agents/${agentId}/meetings/${meetingId}${wsQuery(workspaceId)}`, {
    ...options,
    method: "DELETE",
  });

// Machine tokens
export const createMachineToken = (name?: string, workspaceId?: string, options?: RequestInit) =>
  apiFetch<{ token: string; id: string; name: string; created_at: string }>(
    `/api/machine-tokens${workspaceId ? wsQuery(workspaceId) : ""}`,
    {
      ...options,
      method: "POST",
      body: JSON.stringify({ name: name || "default" }),
    }
  );
