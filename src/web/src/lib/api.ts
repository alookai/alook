import type {
  Agent,
  AgentEmailAccount,
  AgentRuntime,
  Artifact,
  CalendarEvent,
  Channel,
  Conversation,
  CreateAgentRequest,
  CreateCalendarEventRequest,
  CreateEmailAccountRequest,
  UpdateCalendarEventRequest,
  UpdateEmailAccountRequest,
  DeleteCalendarEventRequest,
  UpdateAgentRequest,
  Email,
  LoginResponse,
  MeetingSession,
  Message,
  TaskApi,
  TaskMessage,
  User,
  Workspace,
} from "@alook/shared";
import { ApiError } from "@/lib/errors";

const API_BASE = "";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError("Unable to connect — check your network", 0);
    }
    throw err;
  }

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/sign-in";
    }
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
      // non-JSON body (HTML from proxy, empty body, etc.)
    }

    if (res.status === 429) {
      throw new ApiError("Please wait a moment before trying again", 429);
    }

    if (res.status >= 500) {
      throw new ApiError(
        serverError || "Something went wrong — please try again",
        res.status,
        details,
      );
    }

    throw new ApiError(
      serverError || "Something went wrong",
      res.status,
      details,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// Me
export const getMe = () => apiFetch<User>("/api/me");

// Workspaces
export const listWorkspaces = () => apiFetch<Workspace[]>("/api/workspaces");

export const createWorkspace = (name: string) =>
  apiFetch<Workspace>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

// Helper to build query strings with workspace_id
function wsQuery(workspaceId: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ workspace_id: workspaceId, ...extra });
  return `?${params.toString()}`;
}

// Config
export const fetchModelOptions = () =>
  apiFetch<Record<string, string[]>>("/api/config/model-options");

// Agents
export const listAgents = (workspaceId: string) =>
  apiFetch<Agent[]>(`/api/agents${wsQuery(workspaceId)}`);

export const createAgent = (req: CreateAgentRequest, workspaceId: string) =>
  apiFetch<Agent>(`/api/agents${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify(req),
  });

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

export const getMinCliVersion = () =>
  apiFetch<{ min_cli_version: string | null }>("/api/config/min-version");

export const fetchLatestCliVersion = () =>
  apiFetch<{ version: string }>("/api/cli/latest-version");

// Channels
export const listChannels = (workspaceId: string) =>
  apiFetch<Channel[]>(`/api/channels${wsQuery(workspaceId)}`);

export const createChannelApi = (workspaceId: string, name: string) =>
  apiFetch<Channel>(`/api/channels${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const renameChannelApi = (id: string, workspaceId: string, name: string) =>
  apiFetch<Channel>(`/api/channels/${id}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const deleteChannelApi = (id: string, workspaceId: string) =>
  apiFetch<{ ok: boolean }>(`/api/channels/${id}${wsQuery(workspaceId)}`, {
    method: "DELETE",
  });

// Conversations
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
  buffered_messages: Message[];
  active_task: TaskApi | null;
  task_messages: TaskMessage[];
  has_more_messages: boolean;
  previous_conversations: PreviousConversation[];
  has_more_conversations: boolean;
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
  return apiFetch<Message[]>(
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
  files?: File[],
): Promise<{ message: Message; task: TaskApi }> => {
  if (!files || files.length === 0) {
    return apiFetch<{ message: Message; task: TaskApi }>(
      `/api/conversations/${conversationId}/messages${wsQuery(workspaceId)}`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    );
  }

  const fd = new FormData();
  fd.append("content", content);
  for (const file of files) {
    fd.append("file", file);
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

// Buffered messages (follow-up queue)
export const listBufferedMessages = (conversationId: string, workspaceId: string) =>
  apiFetch<Message[]>(
    `/api/conversations/${conversationId}/buffered-messages${wsQuery(workspaceId)}`
  );

export const createBufferedMessage = async (
  conversationId: string,
  content: string,
  workspaceId: string,
  files?: File[],
): Promise<{ message: Message }> => {
  if (!files || files.length === 0) {
    return apiFetch<{ message: Message }>(
      `/api/conversations/${conversationId}/buffered-messages${wsQuery(workspaceId)}`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    );
  }

  const fd = new FormData();
  fd.append("content", content);
  for (const file of files) {
    fd.append("file", file);
  }

  let res: Response;
  try {
    res = await fetch(
      `/api/conversations/${conversationId}/buffered-messages${wsQuery(workspaceId)}`,
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
    if (res.status === 429) throw new ApiError(serverError || "Maximum follow-ups reached", 429);
    if (res.status >= 500) throw new ApiError(serverError || "Something went wrong — please try again", res.status, details);
    throw new ApiError(serverError || "Something went wrong", res.status, details);
  }

  return res.json() as Promise<{ message: Message }>;
};

export const deleteBufferedMessage = (conversationId: string, messageId: string, workspaceId: string) =>
  apiFetch<void>(
    `/api/conversations/${conversationId}/buffered-messages/${messageId}${wsQuery(workspaceId)}`,
    { method: "DELETE" },
  );

export const deleteAllBufferedMessages = (conversationId: string, workspaceId: string) =>
  apiFetch<void>(
    `/api/conversations/${conversationId}/buffered-messages${wsQuery(workspaceId)}`,
    { method: "DELETE" },
  );

// Active task for conversation (recovery on page refresh)
export const getActiveTask = (conversationId: string, workspaceId: string) =>
  apiFetch<TaskApi | undefined>(`/api/conversations/${conversationId}/active-task${wsQuery(workspaceId)}`);

export const cancelActiveTask = (conversationId: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/conversations/${conversationId}/active-task${wsQuery(workspaceId)}`, {
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

// Tasks (polling)
export const getTask = (id: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/tasks/${id}${wsQuery(workspaceId)}`);

export const getTaskMessages = (id: string, workspaceId: string, since?: number) =>
  apiFetch<TaskMessage[]>(
    `/api/tasks/${id}/messages${wsQuery(workspaceId, since ? { since: String(since) } : undefined)}`
  );

export const retryTask = (id: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/tasks/${id}/retry${wsQuery(workspaceId)}`, {
    method: "POST",
  });

// Emails
export const listEmails = (agentId: string, workspaceId: string, folder?: string, address?: string) =>
  apiFetch<Email[]>(`/api/email${wsQuery(workspaceId, { agentId, ...(folder ? { folder } : {}), ...(address ? { address } : {}) })}`);

export const getEmail = (id: string, workspaceId: string) =>
  apiFetch<Email>(`/api/email/${id}${wsQuery(workspaceId)}`);

export const getEmailThread = (id: string, workspaceId: string) =>
  apiFetch<Email[]>(`/api/email/${id}/thread${wsQuery(workspaceId)}`);

export const getEmailBody = async (id: string, workspaceId: string): Promise<{ content: string; isHtml: boolean }> => {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await fetch(`/api/email/${id}/body?${params}`, { credentials: "include" });
  if (!res.ok) return { content: "(body not available)", isHtml: false };
  const contentType = res.headers.get("Content-Type") ?? "";
  const content = await res.text();
  return { content, isHtml: contentType.includes("text/html") };
};

export const deleteEmail = (id: string, workspaceId: string) =>
  apiFetch<void>(`/api/email/${id}${wsQuery(workspaceId)}`, { method: "DELETE" });

export const uploadEmailAttachment = async (
  file: File,
  workspaceId: string,
): Promise<{ key: string; filename: string; size: number; contentType: string }> => {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/email/upload${wsQuery(workspaceId)}`, {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "Upload failed");
    throw new ApiError(msg, res.status);
  }
  return res.json();
};

export const sendEmail = (
  agentId: string,
  to: string,
  subject: string,
  htmlBody: string,
  workspaceId: string,
  attachments?: { key: string; filename: string; size: number; contentType: string }[],
  threading?: { inReplyTo?: string; references?: string },
  customAccountId?: string,
) =>
  apiFetch<Email>(`/api/email/send${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ agentId, to, subject, htmlBody, attachments, ...threading, customAccountId }),
  });

// Calendar events
export const listCalendarEvents = (
  workspaceId: string,
  opts?: { agentId?: string; from?: string; to?: string }
) => {
  const extra: Record<string, string> = {};
  if (opts?.agentId) extra.agentId = opts.agentId;
  if (opts?.from) extra.from = opts.from;
  if (opts?.to) extra.to = opts.to;
  return apiFetch<CalendarEvent[]>(`/api/calendar${wsQuery(workspaceId, extra)}`);
};

export const createCalendarEvent = (
  req: CreateCalendarEventRequest,
  workspaceId: string
) =>
  apiFetch<CalendarEvent>(`/api/calendar${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify(req),
  });

export const updateCalendarEvent = (
  id: string,
  patch: UpdateCalendarEventRequest,
  workspaceId: string
) =>
  apiFetch<CalendarEvent>(`/api/calendar/${id}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const deleteCalendarEvent = (
  id: string,
  workspaceId: string,
  body?: DeleteCalendarEventRequest
) =>
  apiFetch<CalendarEvent>(`/api/calendar/${id}${wsQuery(workspaceId)}`, {
    method: "DELETE",
    ...(body && body.scope
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });

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

// Members
export const getMemberMe = (workspaceId: string) =>
  apiFetch<{ global_instruction: string }>(`/api/members/me${wsQuery(workspaceId)}`);

export const updateMemberMe = (workspaceId: string, globalInstruction: string) =>
  apiFetch<{ global_instruction: string }>(`/api/members/me${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ global_instruction: globalInstruction }),
  });

// Artifacts
export const listArtifacts = (conversationId: string, workspaceId: string) =>
  apiFetch<Artifact[]>(`/api/artifacts${wsQuery(workspaceId, { conversation_id: conversationId })}`);

export const getArtifactContent = async (id: string, workspaceId: string): Promise<string> => {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await fetch(`/api/artifacts/${id}/content?${params}`, { credentials: "include" });
  if (!res.ok) return "(content not available)";
  return res.text();
};

// Auth (Better Auth — redirect helpers only, actual auth via Better Auth client)
export const signOut = async () => {
  if (typeof window !== "undefined") {
    window.location.href = "/sign-in";
  }
};

// Legacy compat: verifyCode via Better Auth is handled by auth-client.ts
export const verifyCode = (email: string, code: string) =>
  apiFetch<LoginResponse>("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });

// --- Workspace management ---

export const updateWorkspace = (workspaceId: string, data: { name?: string; slug?: string }) =>
  apiFetch<Workspace>(`/api/workspaces/${workspaceId}${wsQuery(workspaceId)}`, { method: "PATCH", body: JSON.stringify(data) });

export const deleteWorkspace = (workspaceId: string, confirmName: string) =>
  apiFetch<void>(`/api/workspaces/${workspaceId}${wsQuery(workspaceId)}`, { method: "DELETE", body: JSON.stringify({ confirm_name: confirmName }) });

// --- Members ---

export interface MemberEntry {
  id: string; user_id: string; role: string; name: string; email: string; image: string | null; created_at: string;
}

export const listMembers = (workspaceId: string) =>
  apiFetch<MemberEntry[]>(`/api/workspaces/${workspaceId}/members${wsQuery(workspaceId)}`);

export const removeMember = (workspaceId: string, memberId: string) =>
  apiFetch<void>(`/api/workspaces/${workspaceId}/members/${memberId}${wsQuery(workspaceId)}`, { method: "DELETE" });

// --- Invites ---

export interface InviteEntry {
  id: string; token: string; expires_at: string; created_at: string;
}

export const listInvites = (workspaceId: string) =>
  apiFetch<InviteEntry[]>(`/api/workspaces/${workspaceId}/invites${wsQuery(workspaceId)}`);

export const createInvite = (workspaceId: string) =>
  apiFetch<InviteEntry>(`/api/workspaces/${workspaceId}/invites${wsQuery(workspaceId)}`, { method: "POST" });

export const revokeInvite = (workspaceId: string, inviteId: string) =>
  apiFetch<void>(`/api/workspaces/${workspaceId}/invites/${inviteId}${wsQuery(workspaceId)}`, { method: "DELETE" });

// --- Workspace overview ---

export interface OverviewEmailAccount {
  id: string;
  agent_id: string;
  email_address: string;
  status: string;
  error_message: string;
  last_synced_at: string | null;
}

export interface OverviewRecentTask {
  id: string;
  agent_id: string;
  type: string;
  status: string;
  prompt: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface OverviewCalendarEvent {
  id: string;
  agent_id: string;
  title: string;
  description: string | null;
  scheduled_at: string;
  repeat_interval: string | null;
  repeat_stop_at: string | null;
  last_triggered_at: string | null;
}

export interface OverviewMember {
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

export const getWorkspaceOverview = (workspaceId: string) =>
  apiFetch<WorkspaceOverview>(`/api/workspaces/${workspaceId}/overview${wsQuery(workspaceId)}`);

// --- Invite accept ---

export interface InviteInfo {
  workspace_name: string; workspace_id: string; invited_by: string;
}

export interface InviteAcceptResult {
  workspace_id: string; workspace_slug: string;
}

export const getInviteInfo = (token: string) => apiFetch<InviteInfo>(`/api/invite/${token}`);
export const acceptInvite = (token: string) => apiFetch<InviteAcceptResult>(`/api/invite/${token}`, { method: "POST" });

// --- Agent access ---

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
}

export const listAgentPins = (workspaceId: string) =>
  apiFetch<AgentPin[]>(`/api/agents/pins${wsQuery(workspaceId)}`);

export const pinAgent = (workspaceId: string, agentId: string) =>
  apiFetch<{ pinned: boolean }>(`/api/agents/${agentId}/pin${wsQuery(workspaceId)}`, { method: "POST" });

export const unpinAgent = (workspaceId: string, agentId: string) =>
  apiFetch<void>(`/api/agents/${agentId}/pin${wsQuery(workspaceId)}`, { method: "DELETE" });

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
