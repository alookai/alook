type OriginalView = (() => void) & { signal: AbortSignal }

export type ReactionArgs = {
  assertActive?: OriginalView
  serverId?: string
  channelId?: string
  dmId?: string
  messageId: string
  emoji: string
  userId: string
  currentMe?: boolean
  skipDefaultCache?: boolean
  syncReactionState?: (me: boolean) => void
  onError?: (error: unknown) => void
}

export type PinMessageArgs = { channelId: string; messageId: string; assertActive?: OriginalView }
export type MarkMessageArgs = { channelId: string; messageId: string; assertActive?: OriginalView }
export type UnmarkMessageArgs = { messageId: string; assertActive?: OriginalView }
