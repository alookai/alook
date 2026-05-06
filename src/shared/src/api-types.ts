import type {
  User,
  Workspace,
  Agent,
  AgentRuntime,
  Conversation,
  Message,
  TaskMessage,
  MachineToken,
  CalendarEvent,
  Issue,
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

export type ListCalendarEventsResponse = ApiListResponse<CalendarEvent>;
export type GetCalendarEventResponse = ApiResponse<CalendarEvent>;
export type ListIssuesResponse = ApiListResponse<Issue>;
export type GetIssueResponse = ApiResponse<Issue>;

export interface CreateCalendarEventRequest {
  agent_id: string;
  title: string;
  description?: string;
  scheduled_at: string;
  repeat_interval?: string;
  repeat_stop_date?: string;
}

export interface UpdateCalendarEventRequest {
  title?: string;
  description?: string | null;
  agent_id?: string;
  scheduled_at?: string;
  repeat_interval?: string | null;
  repeat_stop_date?: string | null;
  scope?: "this" | "following";
  /** ISO of the occurrence being edited; only meaningful for scope="this". */
  occurrence_at?: string;
}

export interface DeleteCalendarEventRequest {
  scope?: "this" | "following";
  /**
   * ISO of the occurrence being deleted. Defaults to the parent's
   * current `scheduled_at` (next fire) when omitted.
   */
  occurrence_at?: string;
}

export interface CreateIssueRequest {
  agent_id: string;
  title: string;
  description?: string;
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  status?: Issue["status"];
}

export interface CreateIssueCommentRequest {
  content: string;
}

export interface CreateAgentLinkRequest {
  source_agent_id: string;
  target_agent_id: string;
  instruction?: string;
}

export interface UpdateAgentLinkRequest {
  instruction: string;
}

export interface CreateWorkspaceRequest {
  name: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  instructions?: string;
  runtime_id?: string;
  runtime_config?: Record<string, unknown>;
  max_concurrent_tasks?: number;
  email_handle?: string;
  visibility?: string;
  avatar_url?: string | null;
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
