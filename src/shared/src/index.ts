// Types
export type {
  User,
  Workspace,
  Agent,
  AgentRuntime,
  Machine,
  Conversation,
  Message,
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
  POLL_INTERVAL_MS,
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
  PollRequestSchema,
  PollResponseSchema,
  RegisterResponseSchema,
  DaemonRuntimeItemSchema,
  ActivateTokenRuntimeSchema,
  ActivateTokenRequestSchema,
  RegisterDaemonRequestSchema,
  DeregisterRequestSchema,
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
  PollRequest,
  PollResponse,
  RegisterResponse,
  DaemonRuntimeItem,
  ActivateTokenRuntime,
  ActivateTokenRequest,
  RegisterDaemonRequest,
  DeregisterRequest,
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

// Logger
export { Logger, createLogger } from "./logger"
export type { LogLevel, LoggerOptions } from "./logger"

// Utils
export { parseEmailHandle, toAlookAddress, isValidHandle } from "./utils/email";
export { isValidToken, isValidEmail } from "./utils/validation";
export { isOnline, formatStatus } from "./utils/status";
export { isUniqueConstraintError } from "./utils/db-errors";
