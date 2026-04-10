export interface User {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  workspace_id: string;
  runtime_id: string;
  name: string;
  description: string;
  instructions: string;
  runtime_mode: string;
  runtime_config: Record<string, unknown>;
  status: string;
  max_concurrent_tasks: number;
  created_at: string;
  updated_at: string;
}

export interface AgentRuntime {
  id: string;
  workspace_id: string;
  daemon_id: string | null;
  name: string;
  runtime_mode: string;
  provider: string;
  status: string;
  device_info: string;
  metadata: Record<string, unknown>;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  agent_id: string;
  title: string;
  created_at: string;
  message_count?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  task_id: string | null;
  created_at: string;
}

/** @deprecated Use TaskApiSchema from schemas.ts for runtime validation. */
export interface AgentTask {
  id: string;
  agent_id: string;
  runtime_id: string;
  conversation_id: string;
  workspace_id: string;
  prompt: string;
  status: string;
  priority: number;
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: unknown;
  error: string | null;
  agent?: TaskAgentData;
  created_at: string;
  prior_session_id?: string;
  prior_work_dir?: string;
}

export interface TaskAgentData {
  id: string;
  name: string;
  instructions: string;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  seq: number;
  type: string;
  tool: string;
  content: string;
  input?: Record<string, unknown>;
  output: string;
}

export interface MachineToken {
  id: string;
  name: string;
  last_used_at: string | null;
  created_at: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  instructions?: string;
  runtime_id: string;
  runtime_config?: Record<string, unknown>;
  max_concurrent_tasks?: number;
}
