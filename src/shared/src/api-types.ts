import type {
  User,
  Workspace,
  Agent,
  AgentRuntime,
  Conversation,
  Message,
  TaskMessage,
  MachineToken,
} from "./types";
import type { TaskApi } from "./schemas";

export interface ApiResponse<T> {
  data: T;
}

export interface ApiListResponse<T> {
  data: T[];
  total?: number;
}

export interface ApiErrorResponse {
  error: string;
  code?: string;
}

export type GetUserResponse = ApiResponse<User>;
export type ListWorkspacesResponse = ApiListResponse<Workspace>;
export type GetWorkspaceResponse = ApiResponse<Workspace>;

export type ListAgentsResponse = ApiListResponse<Agent>;
export type GetAgentResponse = ApiResponse<Agent>;

export type ListRuntimesResponse = ApiListResponse<AgentRuntime>;
export type GetRuntimeResponse = ApiResponse<AgentRuntime>;

export type ListConversationsResponse = ApiListResponse<Conversation>;
export type GetConversationResponse = ApiResponse<Conversation>;

export type ListMessagesResponse = ApiListResponse<Message>;

export type ListTasksResponse = ApiListResponse<TaskApi>;
export type GetTaskResponse = ApiResponse<TaskApi>;

export type ListTaskMessagesResponse = ApiListResponse<TaskMessage>;

export type ListMachineTokensResponse = ApiListResponse<MachineToken>;

export interface CreateWorkspaceRequest {
  name: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  instructions?: string;
  runtime_config?: Record<string, unknown>;
  max_concurrent_tasks?: number;
  email_handle?: string;
}

export interface SendMessageRequest {
  content: string;
}

export interface CreateMachineTokenRequest {
  name: string;
}

export interface CreateMachineTokenResponse {
  token: string;
  id: string;
  name: string;
}
