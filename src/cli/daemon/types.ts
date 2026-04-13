export interface Task {
  id: string;
  agentId: string;
  runtimeId: string;
  conversationId: string;
  workspaceId: string;
  prompt: string;
  status: string;
  priority: number;
  agent?: TaskAgentData;
  priorSessionId?: string;
  repos?: RepoData[];
  createdAt: string;
}

export interface TaskAgentData {
  id?: string;
  name: string;
  instructions: string;
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
    agent: api.agent
      ? { name: api.agent.name, instructions: api.agent.instructions }
      : undefined,
    priorSessionId: api.prior_session_id ?? undefined,
    repos: undefined,
    createdAt: api.created_at,
  };
}
