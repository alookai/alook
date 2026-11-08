export type UnreadPresentationInput = {
  accountUnread: boolean
  reserved?: boolean
  active?: boolean
  muted?: boolean
}

export type UnreadPresentationDecision = {
  accountUnread: boolean
  reserved: boolean
  active: boolean
  muted: boolean
  effectiveUnread: boolean
  emphasize: boolean
  showDot: boolean
  state: "idle" | "unread" | "active" | "muted" | "reserved"
}

export function selectUnreadPresentation({
  accountUnread,
  reserved = false,
  active = false,
  muted = false,
}: UnreadPresentationInput): UnreadPresentationDecision {
  const effectiveUnread = accountUnread && !reserved
  return {
    accountUnread,
    reserved,
    active,
    muted,
    effectiveUnread,
    emphasize: effectiveUnread && !active && !muted,
    showDot: effectiveUnread && !active && !muted,
    state: reserved && accountUnread
      ? "reserved"
      : active
        ? "active"
        : muted
          ? "muted"
          : effectiveUnread
            ? "unread"
            : "idle",
  }
}
