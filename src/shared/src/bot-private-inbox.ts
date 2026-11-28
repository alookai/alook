export const BOT_PRIVATE_INBOX_SOURCE_KINDS = ["webhook", "schedule"] as const
export type BotPrivateInboxSourceKind = (typeof BOT_PRIVATE_INBOX_SOURCE_KINDS)[number]

export const BOT_PRIVATE_INBOX_STATUSES = ["pending", "dispatched", "blocked", "ignored", "failed"] as const
export type BotPrivateInboxStatus = (typeof BOT_PRIVATE_INBOX_STATUSES)[number]

export const BOT_PRIVATE_INBOX_DIRECTIONS = ["inbound", "outbound"] as const
export type BotPrivateInboxDirection = (typeof BOT_PRIVATE_INBOX_DIRECTIONS)[number]

export const BOT_PRIVATE_INBOX_RESYNC_MAX_PER_BOT = 50
