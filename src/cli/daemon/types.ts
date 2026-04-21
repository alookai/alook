export interface Task {
  id: string;
  agentId: string;
  runtimeId: string;
  conversationId: string;
  workspaceId: string;
  prompt: string;
  status: string;
  priority: number;
  type: string;
  contextKey?: string | null;
  context?: Record<string, unknown>;
  agent?: TaskAgentData;
  repos?: RepoData[];
  createdAt: string;
}

export interface Attachment {
  path: string;
  content_type: string;
  filename: string;
}

export interface TaskAgentData {
  id?: string;
  name: string;
  instructions: string;
  emailHandle?: string | null;
  emailAddresses?: string[];
  userEmail?: string | null;
  runtimeConfig?: Record<string, unknown>;
}

export interface RepoData {
  url: string;
  description: string;
}

export interface TaskResult {
  status: "completed" | "failed";
  comment: string;
  branchName?: string;
  sessionId?: string;
}

export interface RuntimeInfo {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  status: string;
}

export interface AgentMessage {
  type:
    | "text"
    | "thinking"
    | "tool-use"
    | "tool-result"
    | "status"
    | "error"
    | "log";
  content?: string;
  tool?: string;
  callId?: string;
  input?: Record<string, unknown>;
  output?: string;
  status?: string;
  level?: string;
}

export interface AgentResult {
  status: "completed" | "failed" | "aborted" | "timeout";
  output: string;
  error: string;
  durationMs: number;
  sessionId: string;
}

export interface ExecOptions {
  cwd: string;
  model?: string;
  env?: Record<string, string>;
  maxTurns?: number;
  timeout?: number;
  resumeSessionId?: string;
}

/** Serialized input passed from daemon to the detached session-runner process. */
export interface SessionRunnerInput {
  task: Task;
  provider: string;
  cliPath: string;
  model: string;
  serverURL: string;
  token: string;
  workspacesRoot: string;
  agentTimeout: number;
  logFilePath?: string;
}

/** Convert a validated TaskApi (snake_case wire format) to the internal Task type. */
export function fromApiTask(api: import("@alook/shared").TaskApi): Task {
  return {
    id: api.id,
    agentId: api.agent_id,
    runtimeId: api.runtime_id,
    conversationId: api.conversation_id,
    workspaceId: api.workspace_id,
    prompt: api.prompt,
    status: api.status,
    priority: api.priority,
    type: api.type,
    contextKey: api.context_key ?? null,
    context: (api.context as Record<string, unknown>) ?? undefined,
    agent: api.agent
      ? { name: api.agent.name, instructions: api.agent.instructions, emailHandle: api.agent.email_handle ?? undefined, emailAddresses: api.agent.email_addresses ?? [], userEmail: api.agent.user_email ?? undefined, runtimeConfig: api.agent.runtime_config ?? undefined }
      : undefined,
    repos: undefined,
    createdAt: api.created_at,
  };
}
