import type { InboxRowTarget } from "./inbox-read-reservation"

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

export type UnreadPresentationExclusion = {
  channelId: string
  throughSeq?: number
}

export function reservedUnreadExclusion(
  target: InboxRowTarget | null,
  domain: "channels" | "dms",
): UnreadPresentationExclusion | null {
  if (!target || target.kind === "mention") return null
  if (domain === "dms") {
    return target.kind === "dm"
      ? {
          channelId: target.channelId,
          ...(target.reservedThroughSeq !== undefined
            ? { throughSeq: target.reservedThroughSeq }
            : {}),
        }
      : null
  }
  if (target.kind === "channel-direct") {
    return {
      channelId: target.channelId,
      ...(target.reservedThroughSeq !== undefined
        ? { throughSeq: target.reservedThroughSeq }
        : {}),
    }
  }
  if (target.kind === "thread") {
    return {
      channelId: target.childChannelId,
      ...(target.reservedThroughSeq !== undefined
        ? { throughSeq: target.reservedThroughSeq }
        : {}),
    }
  }
  return null
}

export function isInboxTargetReserved(
  target: InboxRowTarget | null,
  candidate: InboxRowTarget | null,
) {
  return !!target
    && !!candidate
    && target.identity === candidate.identity
    && target.fingerprint === candidate.fingerprint
}
