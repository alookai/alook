import type { TaskApi, WorkspaceFileEntry } from "./schemas";

export type EmailDirection = "inbound" | "outbound";

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
  email_handle: string | null;
  visibility: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRuntime {
  id: string;
  workspace_id: string;
  daemon_id: string | null;
  runtime_mode: string;
  provider: string;
  status: string;
  device_info: string;
  metadata: Record<string, unknown>;
  pending_update_version?: string | null;
  pending_rescan?: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  agent_id: string;
  title: string;
  type: string;
  channel: string;
  created_at: string;
  message_count?: number;
}

export interface Channel {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
}

export interface CalendarEvent {
  id: string;
  agent_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  scheduled_at: string;
  /**
   * For non-recurring events, equal to `scheduled_at`. For recurring events
   * expanded by the server, this is the ISO of the specific occurrence the
   * row represents.
   */
  occurrence_at: string;
  repeat_interval: string | null;
  repeat_stop_at: string | null;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "event";
  content: string;
  task_id: string | null;
  attachment_ids: string[] | null;
  status?: "active" | "buffered";
  created_at: string;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  seq: number;
  type: string;
  tool: string;
  call_id: string;
  content: string;
  input?: Record<string, unknown>;
  output: string;
}

export interface Machine {
  daemon_id: string;
  workspace_id: string;
  device_info: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MachineToken {
  id: string;
  name: string;
  last_used_at: string | null;
  created_at: string;
}

export interface EmailAttachment {
  key: string;
  filename: string;
  size: number;
  contentType: string;
}

export interface Email {
  id: string;
  agent_id: string;
  from_email: string;
  to_email: string;
  subject: string;
  r2_key: string;
  is_whitelisted: boolean;
  forwarded: boolean;
  message_id: string;
  in_reply_to: string;
  references: string;
  html_body: string;
  attachments: EmailAttachment[];
  status: string;
  direction: EmailDirection;
  created_at: string;
}

export interface AgentEmailAccount {
  id: string;
  agent_id: string;
  workspace_id: string;
  email_address: string;
  display_name: string;
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: number;
  poll_interval_seconds: number;
  last_synced_at: string | null;
  status: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  id: string;
  conversation_id: string;
  agent_id: string;
  filename: string;
  content_type: string;
  size: number;
  source: string;
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
  email_handle?: string;
}

export interface MeetingSession {
  id: string;
  agent_id: string;
  workspace_id: string;
  title: string;
  meeting_url: string;
  status: string;
  from_email: string | null;
  is_whitelisted: boolean;
  participants: string[];
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  transcript_r2_key: string | null;
  summary: string | null;
  error: string | null;
  worker_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** WebSocket event types — single source of truth for the WS protocol. */
export type WsMessage =
  | { type: "runtime.registered"; daemonId: string; hostname: string; workspaceId: string }
  | { type: "runtime.status"; daemonId: string; workspaceId: string; status: string }
  | { type: "runtime.deleted"; daemonId: string }
  | { type: "task.updated"; taskId: string; agentId: string; status: string }
  | { type: "task.messages"; taskId: string; messages: TaskMessage[] }
  | { type: "email.received"; agentId: string }
  | { type: "artifact.uploaded"; conversationId: string; artifact: Artifact }
  | { type: "followup.dispatched"; conversationId: string; message: Message; task: TaskApi }
  | { type: "followup.created"; conversationId: string; message: Message }
  | { type: "followup.deleted"; conversationId: string; messageId: string }
  | { type: "followup.dispatch_failed"; conversationId: string; messageId: string; error: string }
  | { type: "conversation.message"; conversationId: string; message: Message }
  | { type: "workspace.files"; agentId: string; requestId: string; requestType: "tree" | "read"; result: WorkspaceFileResult }

export interface WorkspaceFileResult {
  entries?: WorkspaceFileEntry[];
  content?: string | null;
  isBinary?: boolean;
  error?: string;
  path: string;
}
