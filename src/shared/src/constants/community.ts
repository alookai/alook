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
export const TYPING_INDICATOR_TIMEOUT_MS = 8_000

// Message deduplication cache
export const MESSAGE_DEDUP_CACHE_MAX = 500
export const MESSAGE_DEDUP_CACHE_TRIM = 400

// Notification levels
export const NOTIF_LEVELS = {
  ALL: "All messages",
  MENTIONS: "Only @mentions",
  NONE: "Nothing",
} as const
export type NotifLevel = typeof NOTIF_LEVELS[keyof typeof NOTIF_LEVELS]

// Notification setting level values (DB enum)
export const NOTIFICATION_LEVEL_VALUES = ["all", "mentions", "nothing"] as const
export type NotificationLevelValue = typeof NOTIFICATION_LEVEL_VALUES[number]

// Cache headers
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
export const CACHE_SHORT = "public, max-age=3600"
