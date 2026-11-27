import { NOTIFICATION_UUID_RE } from "./system-notification-route"

export type NativeSystemNotificationPlatform = "desktop" | "mobile"

export type NativeSystemNotificationConversation =
  | { kind: "server"; serverId: string; channelId: string }
  | { kind: "dm"; channelId: string }

type PendingDismissal = {
  version: 3
  platform: NativeSystemNotificationPlatform
  viewerUserId: string
  notificationId: string
  pathname: string
  targetId?: string
  expiresAt: number
}

export type NativeSystemNotificationDismissalDeps = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  now: () => number
}

const KEY = "alook:native-system-notification:pending-dismissal"
const VERSION = 3
const MAX_PENDING_DISMISSALS = 16
const TTL_MS = 2 * 60 * 1000
const UUID = NOTIFICATION_UUID_RE
const SAFE_ID = "[A-Za-z0-9_-]{1,128}"
const ROUTE = new RegExp(`^/c/(?:me/${SAFE_ID}|channels/${SAFE_ID}/${SAFE_ID}|messages/${SAFE_ID})$`)
const CHANNEL_ROUTE = new RegExp(`^/c/(?:me/(${SAFE_ID})|channels/${SAFE_ID}/(${SAFE_ID}))$`)
const FIELDS = new Set(["version", "platform", "viewerUserId", "notificationId", "pathname", "targetId", "expiresAt"])
const CONVERSATION_KEY = "alook:native-system-notification:conversation-dismissals"
const CONVERSATION_VERSION = 2 as const
const MAX_CONVERSATION_DISMISSALS = 64

type PendingConversationDismissal = {
  version: 2
  revision: string
  platform: NativeSystemNotificationPlatform
  viewerUserId: string
  target: NativeSystemNotificationConversation
}

function validSafeId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${SAFE_ID}$`).test(value)
}

function validConversation(value: unknown): value is NativeSystemNotificationConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  if (target.kind === "dm") {
    return Object.keys(target).length === 2 && validSafeId(target.channelId)
  }
  return target.kind === "server"
    && Object.keys(target).length === 3
    && validSafeId(target.serverId)
    && validSafeId(target.channelId)
}

function sameConversation(
  left: NativeSystemNotificationConversation,
  right: NativeSystemNotificationConversation,
) {
  return left.kind === right.kind
    && left.channelId === right.channelId
    && (left.kind === "dm" || (right.kind === "server" && left.serverId === right.serverId))
}

export function createNativeSystemNotificationConversationDismissalQueue(
  deps: Pick<NativeSystemNotificationDismissalDeps, "getItem" | "setItem" | "removeItem"> & { revision?: () => string },
) {
  function remove() {
    try { deps.removeItem(CONVERSATION_KEY) } catch {}
  }

  const revision = deps.revision ?? (() => crypto.randomUUID())

  function read(): PendingConversationDismissal[] {
    let raw: string | null
    try { raw = deps.getItem(CONVERSATION_KEY) } catch { return [] }
    if (raw === null) return []
    try {
      const values = JSON.parse(raw) as unknown
      if (!Array.isArray(values) || values.length > MAX_CONVERSATION_DISMISSALS) throw new Error()
      const valid = values.every((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false
        const entry = value as Record<string, unknown>
        return (Object.keys(entry).length === 5 && entry.version === CONVERSATION_VERSION
            && typeof entry.revision === "string" && UUID.test(entry.revision))
          && (entry.platform === "desktop" || entry.platform === "mobile")
          && validSafeId(entry.viewerUserId)
          && validConversation(entry.target)
      })
      if (!valid) throw new Error()
      return values as PendingConversationDismissal[]
    } catch {
      remove()
      return []
    }
  }

  function write(values: PendingConversationDismissal[]) {
    try {
      if (values.length === 0) deps.removeItem(CONVERSATION_KEY)
      else deps.setItem(CONVERSATION_KEY, JSON.stringify(values))
      return true
    } catch {
      return false
    }
  }

  return {
    queue(
      platform: NativeSystemNotificationPlatform,
      viewerUserId: string,
      target: NativeSystemNotificationConversation,
    ) {
      if (!validSafeId(viewerUserId) || !validConversation(target)) return false
      const values = read()
      return write([...values.filter((entry) => !(entry.platform === platform
        && entry.viewerUserId === viewerUserId && sameConversation(entry.target, target))),
        { version: CONVERSATION_VERSION, platform, viewerUserId, target, revision: revision() }]
        .slice(-MAX_CONVERSATION_DISMISSALS))
    },
    pending(platform: NativeSystemNotificationPlatform, viewerUserId: string) {
      if (!validSafeId(viewerUserId)) return []
      return read()
        .filter((entry) => entry.platform === platform && entry.viewerUserId === viewerUserId)
        .map((entry) => ({ target: entry.target, revision: entry.revision }))
    },
    complete(
      platform: NativeSystemNotificationPlatform,
      viewerUserId: string,
      target: NativeSystemNotificationConversation,
      revision: string,
    ) {
      const values = read()
      const next = values.filter((entry) => !(entry.platform === platform
        && entry.viewerUserId === viewerUserId
        && sameConversation(entry.target, target) && entry.revision === revision))
      return next.length !== values.length && write(next)
    },
  }
}

function pathnameChannelId(pathname: string): string | null {
  const match = CHANNEL_ROUTE.exec(pathname)
  return match ? (match[1] ?? match[2] ?? null) : null
}

function matchesDismissalDestination(entry: PendingDismissal, pathname: string): boolean {
  if (entry.pathname === pathname) return true
  if (entry.targetId === undefined) return false
  return pathnameChannelId(pathname) === entry.targetId
}

export function createNativeSystemNotificationDismissalQueue(
  deps: NativeSystemNotificationDismissalDeps,
) {
  function remove() {
    try {
      deps.removeItem(KEY)
    } catch {
      return
    }
  }

  function write(entries: PendingDismissal[]): boolean {
    try {
      if (entries.length === 0) deps.removeItem(KEY)
      else deps.setItem(KEY, JSON.stringify(entries))
      return true
    } catch {
      return false
    }
  }

  function isValidEntry(value: unknown, now: number): value is PendingDismissal {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const entry = value as Partial<PendingDismissal>
    if (
      entry.version !== VERSION
      || (entry.platform !== "desktop" && entry.platform !== "mobile")
      || !validSafeId(entry.viewerUserId)
      || typeof entry.notificationId !== "string"
      || !UUID.test(entry.notificationId)
      || typeof entry.pathname !== "string"
      || !ROUTE.test(entry.pathname)
      || (entry.targetId !== undefined && !validSafeId(entry.targetId))
      || typeof entry.expiresAt !== "number"
      || !Number.isFinite(entry.expiresAt)
      || entry.expiresAt <= now
      || Object.keys(entry).some((key) => !FIELDS.has(key))
    ) {
      return false
    }
    return true
  }

  function read(): PendingDismissal[] {
    let raw: string | null
    try {
      raw = deps.getItem(KEY)
    } catch {
      return []
    }
    if (raw === null) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed) || parsed.length > MAX_PENDING_DISMISSALS) {
        remove()
        return []
      }
      const now = deps.now()
      const valid = parsed.filter((item): item is PendingDismissal => isValidEntry(item, now))
      if (valid.length !== parsed.length) write(valid)
      return valid
    } catch {
      remove()
      return []
    }
  }

  return {
    queue(
      platform: NativeSystemNotificationPlatform,
      viewerUserId: string,
      notificationId: string,
      pathname: string,
      targetId?: string,
    ) {
      if (
        !validSafeId(viewerUserId)
        || !UUID.test(notificationId)
        || !ROUTE.test(pathname)
        || (targetId !== undefined && !validSafeId(targetId))
      ) return false
      const normalizedId = notificationId.toLowerCase()
      const resolvedTargetId = targetId ?? pathnameChannelId(pathname) ?? undefined
      const entry: PendingDismissal = {
        version: VERSION,
        platform,
        viewerUserId,
        notificationId: normalizedId,
        pathname,
        ...(resolvedTargetId ? { targetId: resolvedTargetId } : {}),
        expiresAt: deps.now() + TTL_MS,
      }
      const current = read().filter((item) => item.notificationId !== normalizedId)
      return write([...current, entry].slice(-MAX_PENDING_DISMISSALS))
    },
    peek(platform: NativeSystemNotificationPlatform, viewerUserId: string, pathname: string) {
      const entries = read()
      const match = entries.find(
        (entry) =>
          entry.platform === platform
          && entry.viewerUserId === viewerUserId
          && matchesDismissalDestination(entry, pathname),
      )
      return match?.notificationId ?? null
    },
    complete(
      platform: NativeSystemNotificationPlatform,
      viewerUserId: string,
      pathname: string,
      notificationId: string,
    ) {
      const normalizedId = notificationId.toLowerCase()
      const entries = read()
      const next = entries.filter(
        (entry) => !(
          entry.platform === platform
          && entry.viewerUserId === viewerUserId
          && entry.notificationId === normalizedId
          && matchesDismissalDestination(entry, pathname)
        ),
      )
      if (next.length === entries.length) return false
      return write(next)
    },
  }
}
