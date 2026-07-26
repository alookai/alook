// Pagination
export const DEFAULT_MESSAGE_PAGE_SIZE = 50
export const MAX_MESSAGE_PAGE_SIZE = 100
export const DEFAULT_MEMBERS_PAGE_SIZE = 100
export const MAX_MEMBERS_PAGE_SIZE = 200
export const DEFAULT_AUDIT_LOG_PAGE_SIZE = 50
export const MAX_AUDIT_LOG_PAGE_SIZE = 100
export const DEFAULT_USER_SEARCH_LIMIT = 20

// Length limits — names, descriptions, profile text
export const MAX_SERVER_NAME_LENGTH = 100
export const MAX_SERVER_DESCRIPTION_LENGTH = 2000
export const MAX_CHANNEL_NAME_LENGTH = 100
export const MAX_CHANNEL_TOPIC_LENGTH = 1024
export const MAX_CATEGORY_NAME_LENGTH = 100
export const MAX_FOLDER_NAME_LENGTH = 100
export const MAX_PROFILE_NAME_LENGTH = 100
export const MAX_PROFILE_ABOUT_LENGTH = 1000
// Short by design — this is a status term ("Vibing"), not a bio.
export const MAX_STATUS_TEXT_LENGTH = 60
export const MAX_MESSAGE_CONTENT_LENGTH = 4000
export const MAX_FORUM_TAG_LENGTH = 30
export const MAX_FORUM_TAGS_PER_POST = 5

// Reactions
export const MAX_EMOJI_BYTES = 32

// Attachments / uploads
export const MAX_ATTACHMENTS_PER_MESSAGE = 10
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024 // 25 MB
export const MAX_SERVER_ICON_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
export const ALLOWED_ATTACHMENT_MIME_PREFIXES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "text/",
] as const
export const ALLOWED_ICON_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const

// Client-side crop/zoom picker (server icon, user avatar, bot avatar) — the
// server-side upload handlers still enforce `MAX_SERVER_ICON_SIZE_BYTES` /
// `ALLOWED_ICON_MIME_TYPES` above; these are the pre-cropper picker gates.
export const MAX_ICON_SOURCE_FILE_SIZE_BYTES = 15 * 1024 * 1024 // 15 MB
export const ICON_CROP_OUTPUT_SIZE = 512
export const ICON_CROP_MIN_ZOOM = 1
export const ICON_CROP_MAX_ZOOM = 3
export const ALLOWED_ICON_SOURCE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const

// Search
export const MIN_SEARCH_LENGTH = 2
export const MAX_SEARCH_LENGTH = 200
export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_LIMIT = 100

// Invites
export const MIN_INVITE_MAX_USES = 1
export const MAX_INVITE_MAX_USES = 1000
export const MAX_INVITE_EXPIRY_DAYS = 30
export const MAX_ACTIVE_INVITES_PER_SERVER = 50

// Synthetic id for the uncategorized-channel bucket the server-detail response
// projects channels with no category into. It is NOT a real category row —
// clients must translate it back to `categoryId: null` before any create/move
// API call, or the server 404s ("category not found").
export const UNCATEGORIZED_CATEGORY_ID = "__uncategorized__"

// Previews
export const MESSAGE_PREVIEW_LENGTH = 120

// Inbox / unreads
export const DEFAULT_INBOX_PAGE_SIZE = 100
export const MAX_INBOX_PAGE_SIZE = 200

// Presence — bounding factor is now the ws-do worker's subrequest budget
// (the web route only issues a single bulk request per poll).
export const PRESENCE_MEMBER_CAP = 500

// Banner color — accepts hex (#RRGGBB / #RGB) only
export const BANNER_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

// Typing indicator
// TIMEOUT: how long a received typing.start stays visible before auto-expire
// if no follow-up arrives. Kept generous so a missed heartbeat doesn't blink
// the indicator off mid-burst.
// THROTTLE: how often the local client will re-emit typing.start for the
// same target while the user is still typing. Shorter than TIMEOUT so the
// indicator on other clients gets refreshed with room to spare.
export const TYPING_INDICATOR_TIMEOUT_MS = 8_000
export const TYPING_INDICATOR_THROTTLE_MS = 3_000

// Message deduplication cache
export const MESSAGE_DEDUP_CACHE_MAX = 500
export const MESSAGE_DEDUP_CACHE_TRIM = 400

// Notification setting level values (DB enum). Anchors
// `community_notification_setting.level` (schema `.default("all")`) — the three
// real, persisted levels. `NOTIF_LEVELS` below is the single value↔label source
// derived on top of it.
export const NOTIFICATION_LEVEL_VALUES = ["all", "mentions", "nothing"] as const
export type NotificationLevelValue = typeof NOTIFICATION_LEVEL_VALUES[number]

// Single source of truth for the notification-level value↔label bijection.
// Each row ties the DB `value` to the identity `display` string that flows
// through the UI props + mutations, plus the menu `label`/`hint` shown in the
// dropdowns. EVERY UI options array, the display mapper, and the value
// normaliser derive from this table — no surface may hand-roll its own copy.
// This is what stops the A8 spelling drift ("All messages" vs "All Messages")
// from ever recurring: there is exactly one place a spelling can live.
export const NOTIF_LEVELS = [
  { value: "all", display: "All Messages", label: "Every message", hint: "Notify for every new message" },
  { value: "mentions", display: "Only @mentions", label: "Mentions only", hint: "Notify when someone @s you" },
  { value: "nothing", display: "Nothing", label: "Muted", hint: "No notifications, no badges" },
] as const satisfies readonly { value: NotificationLevelValue; display: string; label: string; hint: string }[]

// The identity display strings ("All Messages" | "Only @mentions" | "Nothing").
export type NotifLevel = typeof NOTIF_LEVELS[number]["display"]

// UI-only sentinel for the CHANNEL notification dropdown: "inherit the server
// default". It is NOT a persisted level — data-wise it means "no channel
// override row". `mutations/notifications.ts` branches on this EXACT string to
// DELETE the override row, so the literal must never drift; route every use
// through this constant.
export const USE_SERVER_DEFAULT = "Use Server Default"

// value ("all"|…) → identity display string. Unknown input passes through
// unchanged (forward-compat with a future level value).
export function notifLevelDisplay(value: string): string {
  return NOTIF_LEVELS.find((l) => l.value === value)?.display ?? value
}

// display string (or an already-normalised value) → DB value. The channel
// sentinel must be intercepted by the caller before reaching here; any other
// unrecognised input falls back to "mentions" (unchanged from the pre-H3
// behaviour — this is intentionally NOT the DB default, so the mechanical
// consolidation doesn't silently alter fall-through semantics).
export function normalizeNotifLevel(input: string): NotificationLevelValue {
  const byDisplay = NOTIF_LEVELS.find((l) => l.display === input)
  if (byDisplay) return byDisplay.value
  const byValue = NOTIF_LEVELS.find((l) => l.value === input)
  if (byValue) return byValue.value
  return "mentions"
}

// Thread/post participant source — how a user joined a thread's or post's
// NOTIFY set (`community_thread_participant.source`). Single value source for
// the literals; `ThreadParticipantSource` (queries/community/thread.ts) derives
// from this via const-assert so the two can never drift.
export const PARTICIPANT_SOURCE = {
  MENTION: "mention",
  SPOKE: "spoke",
  ADDED: "added",
} as const
export type ParticipantSource = typeof PARTICIPANT_SOURCE[keyof typeof PARTICIPANT_SOURCE]

// Mention row kind — an `@`-mention vs a reply to your message
// (`community_mention.kind`). Drives the inbox row label. Single value source
// for the literals; `MentionKind` derives from this via const-assert.
export const MENTION_KIND = {
  MENTION: "mention",
  REPLY: "reply",
} as const
export type MentionKind = typeof MENTION_KIND[keyof typeof MENTION_KIND]

// Cache headers
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
export const CACHE_SHORT = "public, max-age=3600"
// For content served from a URL that stays fixed across re-uploads (user/bot
// avatars overwrite the same R2 key in place) — always revalidate so a
// replace is visible immediately, but pair with an ETag so revalidation is a
// cheap 304 rather than a full re-fetch.
export const CACHE_REVALIDATE = "no-cache, must-revalidate"
