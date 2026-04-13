// Types
export type {
  User,
  Workspace,
  Agent,
  AgentRuntime,
  Conversation,
  Message,
  AgentTask,
  TaskAgentData,
  TaskMessage,
  MachineToken,
  Email,
  EmailAttachment,
  LoginResponse,
  CreateAgentRequest,
  WsMessage,
} from "./types";

// API types
export type {
  ApiResponse,
  ApiListResponse,
  ApiErrorResponse,
  GetUserResponse,
  ListWorkspacesResponse,
  GetWorkspaceResponse,
  ListAgentsResponse,
  GetAgentResponse,
  ListRuntimesResponse,
  GetRuntimeResponse,
  ListConversationsResponse,
  GetConversationResponse,
  ListMessagesResponse,
  ListTasksResponse,
  GetTaskResponse,
  ListTaskMessagesResponse,
  ListMachineTokensResponse,
  CreateWorkspaceRequest,
  UpdateAgentRequest,
  SendMessageRequest,
  CreateMachineTokenRequest,
  CreateMachineTokenResponse,
} from "./api-types";

// Constants
export {
  AgentStatus,
  RuntimeStatus,
  TaskStatus,
  MessageRole,
  HEARTBEAT_INTERVAL_MS,
  OFFLINE_THRESHOLD_MS,
  EVENT_POLL_INTERVAL_MS,
  AGENT_HANDLE_MIN_LENGTH,
  DEV_WEB_URL,
  DEV_WS_DO_URL,
  DEV_EMAIL_WORKER_URL,
} from "./constants";

export type {
  AgentStatusType,
  RuntimeStatusType,
  TaskStatusType,
  MessageRoleType,
} from "./constants";

// Schemas
export {
  TaskStatusSchema,
  ClaimedTaskRowSchema,
  TaskAgentDataApiSchema,
  TaskApiBaseSchema,
  TaskApiSchema,
  ClaimTaskResponseSchema,
  RegisterResponseSchema,
  DaemonRuntimeItemSchema,
  ActivateTokenRuntimeSchema,
  ActivateTokenRequestSchema,
  RegisterDaemonRequestSchema,
  DeregisterRequestSchema,
  HeartbeatRequestSchema,
  CompleteTaskRequestSchema,
  FailTaskRequestSchema,
  MessageItemSchema,
  ReportMessagesRequestSchema,
} from "./schemas";

export type {
  ClaimedTaskRow,
  TaskAgentDataApi,
  TaskApiBase,
  TaskApi,
  ClaimTaskResponse,
  RegisterResponse,
  DaemonRuntimeItem,
  ActivateTokenRuntime,
  ActivateTokenRequest,
  RegisterDaemonRequest,
  DeregisterRequest,
  HeartbeatRequest,
  CompleteTaskRequest,
  FailTaskRequest,
  MessageItem,
  ReportMessagesRequest,
} from "./schemas";

// Database
export { createDb } from "./db/index";
export type { Database } from "./db/index";
export * as schema from "./db/schema";
export * as queries from "./db/queries-index";

// Utils
export { parseEmailHandle, toAlookAddress, isValidHandle } from "./utils/email";
export { isValidToken, isValidEmail } from "./utils/validation";
export { isOnline, formatStatus } from "./utils/status";
export { isUniqueConstraintError } from "./utils/db-errors";
