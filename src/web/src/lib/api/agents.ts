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
  UpdateAgentRequest,
  UpdateEmailAccountRequest,
} from "@alook/shared";
import { apiFetch, wsQuery } from "./client";

// Agents
export const listAgents = (workspaceId: string) =>
  apiFetch<Agent[]>(`/api/agents${wsQuery(workspaceId)}`);

export const createAgent = (req: CreateAgentRequest, workspaceId: string) =>
  apiFetch<Agent>(`/api/agents${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify(req),
  });

export const getAgent = (id: string, workspaceId: string) =>
  apiFetch<Agent>(`/api/agents/${id}${wsQuery(workspaceId)}`);

export const updateAgent = (id: string, req: UpdateAgentRequest, workspaceId: string) =>
  apiFetch<Agent>(`/api/agents/${id}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(req),
  });

export const deleteAgent = (id: string, workspaceId: string) =>
  apiFetch<void>(`/api/agents/${id}${wsQuery(workspaceId)}`, { method: "DELETE" });

// Runtimes
export const listRuntimes = (workspaceId: string) =>
  apiFetch<AgentRuntime[]>(`/api/runtimes${wsQuery(workspaceId)}`);

export const deleteMachine = (daemonId: string, workspaceId: string) =>
  apiFetch<void>(
    `/api/runtimes/machine${wsQuery(workspaceId, { daemon_id: daemonId })}`,
    { method: "DELETE" }
  );

export const triggerRuntimeUpdate = (runtimeId: string, workspaceId: string) =>
  apiFetch<{ pending_update_version: string }>(
    `/api/runtimes/${runtimeId}/update${wsQuery(workspaceId)}`,
    { method: "POST" }
  );

export const triggerRuntimeRescan = (runtimeId: string, workspaceId: string) =>
  apiFetch<{ pending_rescan: boolean }>(
    `/api/runtimes/${runtimeId}/rescan${wsQuery(workspaceId)}`,
    { method: "POST" }
  );

// Agent active tasks
export const listAgentActiveTaskCounts = (workspaceId: string) =>
  apiFetch<{ counts: Record<string, number> }>(`/api/agents/active-task-counts${wsQuery(workspaceId)}`);

export interface ActiveTask {
  id: string;
  status: string;
  type: string;
  created_at: string;
}

export const listAgentActiveTasks = (agentId: string, workspaceId: string) =>
  apiFetch<{ tasks: ActiveTask[] }>(`/api/agents/${agentId}/active-tasks${wsQuery(workspaceId)}`);

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

export const listWorkspaceActiveTasks = (workspaceId: string) =>
  apiFetch<{ tasks: WorkspaceActiveTask[] }>(`/api/agents/active-tasks${wsQuery(workspaceId)}`);

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
  opts?: { limit?: number; before?: string; beforeId?: string; status?: string; type?: string }
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.beforeId) extra.before_id = opts.beforeId;
  if (opts?.status) extra.status = opts.status;
  if (opts?.type) extra.type = opts.type;
  return apiFetch<{ tasks: ActivityTask[]; has_more: boolean }>(
    `/api/agents/${agentId}/activity${wsQuery(workspaceId, extra)}`
  );
};

// Whitelist
export interface WhitelistEntry {
  id: string;
  email: string;
  created_at: string;
}

export const listWhitelist = (agentId: string, workspaceId: string) =>
  apiFetch<WhitelistEntry[]>(`/api/agents/${agentId}/whitelist${wsQuery(workspaceId)}`);

export const addWhitelistEmail = (agentId: string, email: string, workspaceId: string) =>
  apiFetch<WhitelistEntry>(`/api/agents/${agentId}/whitelist${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });

export const removeWhitelistEmail = (agentId: string, whitelistId: string, workspaceId: string) =>
  apiFetch<void>(`/api/agents/${agentId}/whitelist/${whitelistId}${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

// Agent Links
export const listAgentLinks = (workspaceId: string) =>
  apiFetch<AgentLink[]>(`/api/agent-links${wsQuery(workspaceId)}`);

export const createAgentLink = (req: CreateAgentLinkRequest, workspaceId: string) =>
  apiFetch<AgentLink>(`/api/agent-links${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify(req),
  });

export const updateAgentLink = (id: string, req: UpdateAgentLinkRequest, workspaceId: string) =>
  apiFetch<AgentLink>(`/api/agent-links/${id}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(req),
  });

export const deleteAgentLink = (id: string, workspaceId: string) =>
  apiFetch<AgentLink>(`/api/agent-links/${id}${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

// Email Accounts
export const listEmailAccounts = (agentId: string, workspaceId: string) =>
  apiFetch<AgentEmailAccount[]>(`/api/agents/${agentId}/email-accounts${wsQuery(workspaceId)}`);

export const createEmailAccount = (agentId: string, data: CreateEmailAccountRequest, workspaceId: string) =>
  apiFetch<AgentEmailAccount>(`/api/agents/${agentId}/email-accounts${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateEmailAccount = (agentId: string, accountId: string, data: UpdateEmailAccountRequest, workspaceId: string) =>
  apiFetch<AgentEmailAccount>(`/api/agents/${agentId}/email-accounts/${accountId}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

export const deleteEmailAccount = (agentId: string, accountId: string, workspaceId: string) =>
  apiFetch<{ ok: boolean }>(`/api/agents/${agentId}/email-accounts/${accountId}${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

export const testEmailConnection = (agentId: string, accountId: string, workspaceId: string) =>
  apiFetch<{ imap: string; smtp: string }>(`/api/agents/${agentId}/email-accounts/${accountId}/test${wsQuery(workspaceId)}`, {
    method: "POST",
  });

export const syncEmailAccount = (agentId: string, accountId: string, workspaceId: string) =>
  apiFetch<{ ok: boolean }>(`/api/agents/${agentId}/email-accounts/${accountId}/sync${wsQuery(workspaceId)}`, {
    method: "POST",
  });

// Agent Access
export interface AgentAccessEntry {
  id: string; user_id: string; name: string; email: string; created_at: string;
}

export const listAgentAccess = (workspaceId: string, agentId: string) =>
  apiFetch<AgentAccessEntry[]>(`/api/agents/${agentId}/access${wsQuery(workspaceId)}`);

export const grantAgentAccess = (workspaceId: string, agentId: string, userId: string) =>
  apiFetch<{ id: string; user_id: string }>(`/api/agents/${agentId}/access${wsQuery(workspaceId)}`, { method: "POST", body: JSON.stringify({ user_id: userId }) });

export const revokeAgentAccess = (workspaceId: string, agentId: string, userId: string, removeWhitelist = false) =>
  apiFetch<void>(`/api/agents/${agentId}/access/${userId}${wsQuery(workspaceId)}${removeWhitelist ? "&remove_whitelist=true" : ""}`, { method: "DELETE" });

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

export const listAgentPins = (workspaceId: string) =>
  apiFetch<{ pins: AgentPin[]; sidebar_order: SidebarOrder[] }>(`/api/agents/pins${wsQuery(workspaceId)}`);

export const pinAgent = (workspaceId: string, agentId: string) =>
  apiFetch<{ pinned: boolean }>(`/api/agents/${agentId}/pin${wsQuery(workspaceId)}`, { method: "POST" });

export const unpinAgent = (workspaceId: string, agentId: string) =>
  apiFetch<void>(`/api/agents/${agentId}/pin${wsQuery(workspaceId)}`, { method: "DELETE" });

export const reorderAgentPins = (workspaceId: string, orderedAgentIds: string[]) =>
  apiFetch<void>(`/api/agents/pins/reorder${wsQuery(workspaceId)}`, {
    method: "PUT",
    body: JSON.stringify({ ordered_agent_ids: orderedAgentIds }),
  });

export const reorderUnpinnedAgents = (workspaceId: string, orderedAgentIds: string[]) =>
  apiFetch<void>(`/api/agents/sidebar/reorder${wsQuery(workspaceId)}`, {
    method: "PUT",
    body: JSON.stringify({ ordered_agent_ids: orderedAgentIds }),
  });

// Workspace file browsing
export const requestWorkspaceBrowse = (
  agentId: string,
  workspaceId: string,
  requestType: "tree" | "read",
  path: string,
) =>
  apiFetch<{ request_id: string }>(
    `/api/agents/${agentId}/workspace/browse${wsQuery(workspaceId)}`,
    {
      method: "POST",
      body: JSON.stringify({ request_type: requestType, path }),
    },
  );

// Skill browsing
export const getAgentSkills = (agentId: string, workspaceId: string) =>
  apiFetch<{ skills: { name: string; description: string; isGlobal?: boolean }[] }>(
    `/api/agents/${agentId}/skills${wsQuery(workspaceId)}`,
  );

// Meetings
export const listMeetings = (agentId: string, workspaceId: string) =>
  apiFetch<MeetingSession[]>(`/api/agents/${agentId}/meetings${wsQuery(workspaceId)}`);

export const getMeeting = (agentId: string, meetingId: string, workspaceId: string) =>
  apiFetch<MeetingSession>(`/api/agents/${agentId}/meetings/${meetingId}${wsQuery(workspaceId)}`);

export const createMeeting = (agentId: string, workspaceId: string, data: {
  meetingUrl: string;
  title?: string;
  participants?: string[];
}) =>
  apiFetch<MeetingSession>(`/api/agents/${agentId}/meetings${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify(data),
  });

export const stopMeeting = (agentId: string, meetingId: string, workspaceId: string) =>
  apiFetch<MeetingSession & { transcript?: string }>(`/api/agents/${agentId}/meetings/${meetingId}/stop${wsQuery(workspaceId)}`, {
    method: "POST",
  });

export const approveMeeting = (agentId: string, meetingId: string, workspaceId: string) =>
  apiFetch<MeetingSession>(`/api/agents/${agentId}/meetings/${meetingId}/approve${wsQuery(workspaceId)}`, {
    method: "POST",
  });

export const deleteMeeting = (agentId: string, meetingId: string, workspaceId: string) =>
  apiFetch<void>(`/api/agents/${agentId}/meetings/${meetingId}${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

// Machine tokens
export const createMachineToken = (name?: string, workspaceId?: string) =>
  apiFetch<{ token: string; id: string; name: string; created_at: string }>(
    `/api/machine-tokens${workspaceId ? wsQuery(workspaceId) : ""}`,
    {
      method: "POST",
      body: JSON.stringify({ name: name || "default" }),
    }
  );

export const getMachineTokenStatus = () =>
  apiFetch<{ status: "pending" | "active" | null; token?: string; workspace_id?: string; hostname?: string; daemon_online?: boolean }>(
    "/api/machine-tokens/status",
  );
