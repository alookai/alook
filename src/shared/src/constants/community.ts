// Pagination
export const DEFAULT_MESSAGE_PAGE_SIZE = 50
export const MAX_MESSAGE_PAGE_SIZE = 100

// Validation limits
export const MAX_SERVER_NAME_LENGTH = 100
export const MAX_EMOJI_BYTES = 32

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

// Cache headers
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
export const CACHE_SHORT = "public, max-age=3600"
