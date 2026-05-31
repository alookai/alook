import type {
  Agent,
  AgentEmailAccount,
  AgentLink,
  AgentRuntime,
  Artifact,
  CalendarEvent,
  Channel,
  Conversation,
  CreateIssueRequest,
  CreateAgentLinkRequest,
  CreateAgentRequest,
  CreateCalendarEventRequest,
  CreateEmailAccountRequest,
  UpdateAgentLinkRequest,
  UpdateCalendarEventRequest,
  UpdateEmailAccountRequest,
  DeleteCalendarEventRequest,
  UpdateAgentRequest,
  Email,
  Issue,
  IssueComment,
  LoginResponse,
  MeetingSession,
  Message,
  TaskApi,
  TaskMessageResponse,
  UpdateIssueRequest,
  User,
  Workspace,
} from "@alook/shared";
import { ApiError } from "@/lib/errors";

const API_BASE = "";

const MOCK_NETWORK_ENABLED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_MOCK_NETWORK === "true";
const MOCK_NETWORK_DELAY_MS = parseInt(process.env.NEXT_PUBLIC_MOCK_NETWORK_DELAY_MS || "300", 10) || 300;
let mockNetworkLogged = false;

function humanizeValidationDetail(detail: string): string {
  const [rawField, ...rest] = detail.split(":");
  const rawMessage = rest.join(":").trim();
  if (!rawMessage) return detail;

  const field = rawField.trim();
  const label = field
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
  let message = rawMessage.replace(/^required$/i, "is required");

  const normalizedMessage = message.toLowerCase().replace(/[_-]+/g, " ");
  const normalizedField = field.toLowerCase().replace(/[_-]+/g, " ");
  if (normalizedField && normalizedMessage.startsWith(`${normalizedField} `)) {
    message = message.slice(field.length).trimStart();
  }

  return label ? `${label} ${message}` : message;
}

function getReadableErrorMessage(error: string | undefined, details: string[] | undefined) {
  if (error === "validation error" && details?.length) {
    return humanizeValidationDetail(details[0]);
  }
  return error;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (MOCK_NETWORK_ENABLED) {
    if (!mockNetworkLogged) {
      console.info(`[Mock Network] Enabled — ${MOCK_NETWORK_DELAY_MS}ms delay on all API requests`);
      mockNetworkLogged = true;
    }
    await new Promise((r) => setTimeout(r, MOCK_NETWORK_DELAY_MS));
  }

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
        getReadableErrorMessage(serverError, details) ||
          "Something went wrong — please try again",
        res.status,
        details,
      );
    }

    throw new ApiError(
      getReadableErrorMessage(serverError, details) || "Something went wrong",
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

export const createWorkspace = (name: string, slug?: string) =>
  apiFetch<Workspace>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace" }),
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
  apiFetch<{ version: string; package: string }>("/api/cli/latest-version");

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

export const reorderChannelsApi = (workspaceId: string, orderedChannelIds: string[]) =>
  apiFetch<void>(`/api/channels/reorder${wsQuery(workspaceId)}`, {
    method: "PUT",
    body: JSON.stringify({ ordered_channel_ids: orderedChannelIds }),
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
  buffered_messages: Message[];
  flagged_message_ids: string[];
  thinking_counts: Record<string, number>;
  active_task: TaskApi | null;
  task_messages: TaskMessageResponse[];
  cache_valid: boolean;
  message_count: number;
}

export const conversationInit = (
  conversationId: string,
  workspaceId: string,
  opts?: { newestMessageId?: string; messageCount?: number },
) => {
  const extra: Record<string, string> = {};
  if (opts?.newestMessageId) extra.newest_message_id = opts.newestMessageId;
  // Omit a 0 count: the server treats the param as a count to compare against,
  // and the string "0" is truthy server-side, so sending it forces
  // `serverMessageCount === 0` to fail for every non-empty conversation. 0 here
  // means "unknown count" — rely on newestMessageId for the freshness compare.
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

// Tasks (polling)
export const getTask = (id: string, workspaceId: string) =>
  apiFetch<TaskApi>(`/api/tasks/${id}${wsQuery(workspaceId)}`);

export const getTaskMessages = (id: string, workspaceId: string, since?: number) =>
  apiFetch<TaskMessageResponse[]>(
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

export const updateEmailStatus = (id: string, workspaceId: string, status: string) =>
  apiFetch<Email>(`/api/email/${id}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });

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

export const getCalendarEvent = (id: string, workspaceId: string) =>
  apiFetch<CalendarEvent>(`/api/calendar/${id}${wsQuery(workspaceId)}`);

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

// Issues
export type IssueListItem = Issue & { thread_agent_ids?: string[] };

export interface IssueDetailResponse {
  issue: Issue & { trace_id?: string | null };
  messages: Message[];
  comments: IssueComment[];
  artifacts: Artifact[];
}

export const listIssues = (
  workspaceId: string,
  opts?: { agentId?: string; status?: string; terminal?: boolean }
) => {
  const extra: Record<string, string> = {};
  if (opts?.agentId) extra.agentId = opts.agentId;
  if (opts?.status) extra.status = opts.status;
  if (opts?.terminal !== undefined) extra.terminal = String(opts.terminal);
  return apiFetch<IssueListItem[]>(`/api/issues${wsQuery(workspaceId, extra)}`);
};

export const createIssue = async (
  workspaceId: string,
  req: CreateIssueRequest & { files?: File[] },
): Promise<{ issue: Issue; message?: Message; task?: TaskApi }> => {
  if (!req.files || req.files.length === 0) {
    return apiFetch<{ issue: Issue; message?: Message; task?: TaskApi }>(`/api/issues${wsQuery(workspaceId)}`, {
      method: "POST",
      body: JSON.stringify({
        agent_id: req.agent_id,
        title: req.title,
        description: req.description,
      }),
    });
  }

  const fd = new FormData();
  if (req.agent_id) fd.append("agent_id", req.agent_id);
  fd.append("title", req.title);
  fd.append("description", req.description ?? "");
  for (const file of req.files) {
    fd.append("file", file);
  }

  let res: Response;
  try {
    res = await fetch(`/api/issues${wsQuery(workspaceId)}`, {
      method: "POST",
      credentials: "include",
      body: fd,
    });
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

  return res.json() as Promise<{ issue: Issue; message?: Message; task?: TaskApi }>;
};

export const getIssue = (workspaceId: string, issueId: string) =>
  apiFetch<IssueDetailResponse>(`/api/issues/${issueId}${wsQuery(workspaceId)}`);

export const updateIssue = (workspaceId: string, issueId: string, patch: UpdateIssueRequest) =>
  apiFetch<Issue>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const commentIssue = (workspaceId: string, issueId: string, content: string) =>
  apiFetch<{ message: Message }>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });

export const deleteIssue = (workspaceId: string, issueId: string) =>
  apiFetch<void>(`/api/issues/${issueId}${wsQuery(workspaceId)}`, { method: "DELETE" });

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

// Traces
export interface TraceListItem {
  trace_id: string;
  root_prompt: string;
  root_agent_id: string;
  root_agent: { name: string; avatarUrl: string | null } | null;
  helper_agents: { id: string; name?: string; avatarUrl?: string | null }[];
  status: string;
  task_count: number;
  started_at: string;
  completed_at: string | null;
  channel: string;
}

export interface TraceTask {
  id: string;
  agent_id: string;
  agent: { name: string; email_handle: string | null; avatarUrl: string | null } | null;
  parent_task_id: string | null;
  prompt: string;
  status: string;
  type: string;
  conversation_id: string;
  created_at: string;
  completed_at: string | null;
}

export const listTraces = (
  workspaceId: string,
  opts?: { status?: string; limit?: number; before?: string; multiAgent?: boolean; agentId?: string; channel?: string }
) => {
  const extra: Record<string, string> = {};
  if (opts?.limit) extra.limit = String(opts.limit);
  if (opts?.before) extra.before = opts.before;
  if (opts?.status) extra.status = opts.status;
  if (opts?.multiAgent) extra.multiAgent = "true";
  if (opts?.agentId) extra.agentId = opts.agentId;
  if (opts?.channel) extra.channel = opts.channel;
  return apiFetch<{ traces: TraceListItem[]; has_more: boolean }>(
    `/api/traces${wsQuery(workspaceId, extra)}`
  );
};

export const getTrace = (traceId: string, workspaceId: string) =>
  apiFetch<{ trace_id: string; channel: string; tasks: TraceTask[] }>(
    `/api/traces/${traceId}${wsQuery(workspaceId)}`
  );
