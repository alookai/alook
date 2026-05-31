interface TaskSender {
  name: string;
  email: string;
  isOwner: boolean;
}

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
  sender?: TaskSender;
  repos?: RepoData[];
  createdAt: string;
  traceId: string | null;
  parentTaskId: string | null;
  channel: string | null;
}

export interface Attachment {
  path: string;
  content_type: string;
  filename: string;
}

interface ColleagueData {
  name: string;
  email: string;
  description: string;
  instruction: string;
}

interface TaskAgentData {
  id?: string;
  name: string;
  instructions: string;
  emailHandle?: string | null;
  emailAddresses?: string[];
  userEmail?: string | null;
  userName?: string | null;
  runtimeConfig?: Record<string, unknown>;
  colleagues?: ColleagueData[];
}

interface RepoData {
  url: string;
  description: string;
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
  messageInactivityTimeout: number;
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
      ? {
          name: api.agent.name,
          instructions: api.agent.instructions,
          emailHandle: api.agent.email_handle ?? undefined,
          emailAddresses: api.agent.email_addresses ?? [],
          userEmail: api.agent.user_email ?? undefined,
          userName: api.agent.user_name ?? undefined,
          runtimeConfig: api.agent.runtime_config ?? undefined,
          colleagues: api.agent.colleagues?.map((c) => ({
            name: c.name,
            email: c.email,
            description: c.description,
            instruction: c.instruction,
          })) ?? [],
        }
      : undefined,
    sender: api.sender
      ? { name: api.sender.name, email: api.sender.email, isOwner: api.sender.is_owner }
      : undefined,
    repos: undefined,
    createdAt: api.created_at,
    traceId: api.trace_id ?? null,
    parentTaskId: api.parent_task_id ?? null,
    channel: api.channel ?? null,
  };
}
