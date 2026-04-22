import type {
  Agent,
  AgentEmailAccount,
  AgentRuntime,
  Artifact,
  CalendarEvent,
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

export const fetchLatestCliVersion = () =>
  apiFetch<{ version: string }>("/api/cli/latest-version");

// Conversations
export const listConversations = (workspaceId: string) =>
  apiFetch<Conversation[]>(`/api/conversations${wsQuery(workspaceId)}`);

export const createConversation = (agentId: string, workspaceId: string) =>
  apiFetch<Conversation>(`/api/conversations${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId }),
  });

export const getConversation = (id: string, workspaceId: string) =>
  apiFetch<Conversation>(`/api/conversations/${id}${wsQuery(workspaceId)}`);

export const listAgentConversations = (agentId: string, workspaceId: string) =>
  apiFetch<Conversation[]>(`/api/agents/${agentId}/conversations${wsQuery(workspaceId)}`);

export const getOrCreateAgentConversation = (agentId: string, workspaceId: string) =>
  apiFetch<Conversation>(`/api/agents/${agentId}/conversation${wsQuery(workspaceId)}`, {
    method: "POST",
  });

export interface ChatInitResponse {
  conversation: Conversation;
  messages: Message[];
  artifacts: Artifact[];
  buffered_messages: Message[];
  active_task: TaskApi | null;
  task_messages: TaskMessage[];
  has_more_messages: boolean;
}

export const chatInit = (agentId: string, workspaceId: string) =>
  apiFetch<ChatInitResponse>(`/api/agents/${agentId}/chat-init${wsQuery(workspaceId)}`, {
    method: "POST",
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

// Tasks (polling)
export const getTask = (id: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/tasks/${id}${wsQuery(workspaceId)}`);

export const getTaskMessages = (id: string, workspaceId: string, since?: number) =>
  apiFetch<TaskMessage[]>(
    `/api/tasks/${id}/messages${wsQuery(workspaceId, since ? { since: String(since) } : undefined)}`
  );

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
