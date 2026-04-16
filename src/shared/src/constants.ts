export const AgentStatus = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  ERROR: "error",
} as const;

export type AgentStatusType = (typeof AgentStatus)[keyof typeof AgentStatus];

export const RuntimeStatus = {
  ONLINE: "online",
  OFFLINE: "offline",
  ERROR: "error",
} as const;

export type RuntimeStatusType =
  (typeof RuntimeStatus)[keyof typeof RuntimeStatus];

export const TaskStatus = {
  QUEUED: "queued",
  DISPATCHED: "dispatched",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type TaskStatusType = (typeof TaskStatus)[keyof typeof TaskStatus];

export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export type MessageRoleType = (typeof MessageRole)[keyof typeof MessageRole];

// Timing constants
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3_000;
export const OFFLINE_THRESHOLD_MS = Number(process.env.OFFLINE_THRESHOLD_MS) || 9_000;
export const EVENT_POLL_INTERVAL_MS = Number(process.env.EVENT_POLL_INTERVAL_MS) || 2_000;
export const AGENT_HANDLE_MIN_LENGTH = 4;

// Local dev URLs (used for service-binding fallbacks)
export const DEV_WEB_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000";
export const DEV_WS_DO_URL = process.env.DEV_WS_DO_URL || "http://localhost:8789";
export const DEV_EMAIL_WORKER_URL = process.env.DEV_EMAIL_WORKER_URL || "http://localhost:8787";
