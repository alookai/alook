import type {
  Agent,
  AgentRuntime,
  Conversation,
  CreateAgentRequest,
  UpdateAgentRequest,
  Email,
  LoginResponse,
  Message,
  AgentTask,
  TaskMessage,
  User,
  Workspace,
} from "@alook/shared";
import { ApiError } from "@/lib/errors";

// Re-export AgentRuntime as Runtime for convenience
export type Runtime = AgentRuntime;
export type Task = AgentTask;

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
  apiFetch<Runtime[]>(`/api/runtimes${wsQuery(workspaceId)}`);

export const deleteMachine = (daemonId: string, workspaceId: string) =>
  apiFetch<void>(
    `/api/runtimes/machine${wsQuery(workspaceId, { daemon_id: daemonId })}`,
    { method: "DELETE" }
  );

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

export const deleteConversation = (id: string, workspaceId: string) =>
  apiFetch<void>(`/api/conversations/${id}${wsQuery(workspaceId)}`, { method: "DELETE" });

export const listMessages = (conversationId: string, workspaceId: string) =>
  apiFetch<Message[]>(`/api/conversations/${conversationId}/messages${wsQuery(workspaceId)}`);

export const sendMessage = (conversationId: string, content: string, workspaceId: string) =>
  apiFetch<{ message: Message; task: Task }>(
    `/api/conversations/${conversationId}/messages${wsQuery(workspaceId)}`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    }
  );

// Machine tokens
export const createMachineToken = (name?: string, workspaceId?: string) =>
  apiFetch<{ token: string; id: string; name: string; created_at: string }>(
    `/api/machine-tokens${workspaceId ? wsQuery(workspaceId) : ""}`,
    {
      method: "POST",
      body: JSON.stringify({ name: name || "default" }),
    }
  );

// Tasks (polling)
export const getTask = (id: string, workspaceId: string) =>
  apiFetch<Task>(`/api/tasks/${id}${wsQuery(workspaceId)}`);

export const getTaskMessages = (id: string, workspaceId: string, since?: number) =>
  apiFetch<TaskMessage[]>(
    `/api/tasks/${id}/messages${wsQuery(workspaceId, since ? { since: String(since) } : undefined)}`
  );

// Emails
export const listEmails = (agentId: string, workspaceId: string, folder?: string) =>
  apiFetch<Email[]>(`/api/email${wsQuery(workspaceId, { agentId, ...(folder ? { folder } : {}) })}`);

export const getEmail = (id: string, workspaceId: string) =>
  apiFetch<Email>(`/api/email/${id}${wsQuery(workspaceId)}`);

export const getEmailBody = async (id: string, workspaceId: string): Promise<string> => {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await fetch(`/api/email/${id}/body?${params}`, { credentials: "include" });
  if (!res.ok) return "(body not available)";
  return res.text();
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
) =>
  apiFetch<Email>(`/api/email/send${wsQuery(workspaceId)}`, {
    method: "POST",
    body: JSON.stringify({ agentId, to, subject, htmlBody, attachments }),
  });

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
