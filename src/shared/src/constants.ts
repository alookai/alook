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
  SUPERSEDED: "superseded",
} as const;

export const TERMINAL_TASK_STATUSES: readonly TaskStatusType[] = [
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.SUPERSEDED,
] as const;

export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export type TaskStatusType = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TASK_TYPES = {
  USER_DM_MESSAGE: "user_dm_message",
  EMAIL_NOTIFICATION: "email_notification",
  CALENDAR_EVENT: "calendar_event",
  ISSUE_EVENT: "issue_event",
  KILL_TASK: "kill_task",
} as const;

export type TaskType = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];

export const IssueStatus = {
  TODO: "todo",
  IN_PROGRESS: "in_progress",
  REVIEW: "review",
  DONE: "done",
  CLOSED: "closed",
  CANCELED: "canceled",
  FAILED: "failed",
} as const;

export type IssueStatusType = (typeof IssueStatus)[keyof typeof IssueStatus];

export const ACTIVE_ISSUE_STATUSES: readonly IssueStatusType[] = [
  IssueStatus.TODO,
  IssueStatus.IN_PROGRESS,
  IssueStatus.REVIEW,
] as const;

export const TERMINAL_ISSUE_STATUSES: readonly IssueStatusType[] = [
  IssueStatus.DONE,
  IssueStatus.CLOSED,
  IssueStatus.CANCELED,
  IssueStatus.FAILED,
] as const;

export function isTerminalIssueStatus(status: string): boolean {
  return (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(status);
}

export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  EVENT: "event",
} as const;

export type MessageRoleType = (typeof MessageRole)[keyof typeof MessageRole];

// Timing constants
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3_000;
export const OFFLINE_THRESHOLD_MS = Number(process.env.OFFLINE_THRESHOLD_MS) || 30_000;
// Heartbeat must be strictly less than the offline threshold — the DO alarm
// refreshes last_seen_at every HEARTBEAT_MS, and the row is only offline once
// no refresh has landed in OFFLINE_THRESHOLD_MS. A 2× ratio absorbs one missed
// beat without flapping the chip to offline.
export const COMMUNITY_MACHINE_HEARTBEAT_MS = 30_000;
export const COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS = 90_000;
export const COMMUNITY_MACHINE_PAIR_TOKEN_TTL_MS = 15 * 60_000;
export const EVENT_POLL_INTERVAL_MS = Number(process.env.EVENT_POLL_INTERVAL_MS) || 2_000;
export const AGENT_HANDLE_MIN_LENGTH = 4;
export const MAX_TASKS_PER_TRACE = 256;

export const MeetingStatus = {
  PENDING: "pending",
  SCHEDULED: "scheduled",
  JOINING: "joining",
  RECORDING: "recording",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type MeetingStatusType = (typeof MeetingStatus)[keyof typeof MeetingStatus];

export const TERMINAL_MEETING_STATUSES: readonly MeetingStatusType[] = [
  MeetingStatus.COMPLETED,
  MeetingStatus.FAILED,
] as const;

// ── Community bots ───────────────────────────────────────────────────────────

// Anti-abuse floor. NOT a UX cap — per-server pollution is prevented by
// explicit-add-per-server (no fan-out). Bump if abuse patterns change; do not
// repurpose as a UX signal.
export const COMMUNITY_BOT_LIMIT_PER_OWNER = 20;
// Display-line-fit at 375 px mobile width.
export const COMMUNITY_BOT_NAME_MIN = 1;
export const COMMUNITY_BOT_NAME_MAX = 32;
// Prompt-size sanity; system prompts embed this verbatim.
export const COMMUNITY_BOT_DESCRIPTION_MAX = 1024;
// HTTP URL bounds.
export const COMMUNITY_BOT_IMAGE_URL_MAX = 2048;
// Synthetic email — bots never sign in (no session mint), but Better-Auth
// requires a unique email on the user row. `bots.alook.local` is a reserved
// non-routable local domain.
export const COMMUNITY_BOT_EMAIL_DOMAIN = "bots.alook.local";
export const COMMUNITY_BOT_EMAIL_PREFIX = "bot-";
/**
 * Single source of truth for constructing a bot's synthetic email.
 * Always lowercased before insert — Better-Auth lowercases inputs and the
 * underlying `user.email` unique index is case-sensitive at the DB layer.
 */
export function communityBotSyntheticEmail(userId: string): string {
  return `${COMMUNITY_BOT_EMAIL_PREFIX}${userId}@${COMMUNITY_BOT_EMAIL_DOMAIN}`.toLowerCase();
}

/**
 * Synthetic friendship id used for owner ↔ own-bot rows in `listFriends`.
 * Bots never have a real `communityFriendship` row with their owner — they
 * ARE the owner's friend by construction. The `self-bot:` prefix flags the
 * row as synthetic so UI code (e.g. remove-friend, block) can skip it.
 *
 * Lives here (not in the db/queries layer) so client-side components can
 * import it without pulling drizzle-orm into the browser bundle.
 */
export const SELF_BOT_FRIENDSHIP_PREFIX = "self-bot:";
export function isSelfBotFriendship(id: string): boolean {
  return id.startsWith(SELF_BOT_FRIENDSHIP_PREFIX);
}

// Dev mode auth (shared between web frontend and @alook/app CLI)
export const DEV_PASSWORD = "dev-password-000";

// Local dev URLs (used for service-binding fallbacks)
export const DEV_WEB_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000";
export const DEV_WS_DO_URL = process.env.DEV_WS_DO_URL || "http://localhost:8789";
export const DEV_EMAIL_WORKER_URL = process.env.DEV_EMAIL_WORKER_URL || "http://localhost:8787";
