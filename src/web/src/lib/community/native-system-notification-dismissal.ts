export type NativeSystemNotificationPlatform = "desktop" | "mobile"

export type NativeSystemNotificationConversation =
  | { kind: "server"; serverId: string; channelId: string }
  | { kind: "dm"; channelId: string }

type PendingDismissal = {
  version: 1
  platform: NativeSystemNotificationPlatform
  notificationId: string
  pathname: string
  expiresAt: number
}

export type NativeSystemNotificationDismissalDeps = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  now: () => number
}

const KEY = "alook:native-system-notification:pending-dismissal"
const VERSION = 1
const TTL_MS = 2 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_ID = "[A-Za-z0-9_-]{1,128}"
const ROUTE = new RegExp(`^/c/(?:me/${SAFE_ID}|channels/${SAFE_ID}/${SAFE_ID})$`)
const FIELDS = new Set(["version", "platform", "notificationId", "pathname", "expiresAt"])
const CONVERSATION_KEY = "alook:native-system-notification:conversation-dismissals"
const CONVERSATION_VERSION = 1 as const
const MAX_CONVERSATION_DISMISSALS = 64

type PendingConversationDismissal = {
  version: 1
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
  deps: Pick<NativeSystemNotificationDismissalDeps, "getItem" | "setItem" | "removeItem">,
) {
  function remove() {
    try { deps.removeItem(CONVERSATION_KEY) } catch {}
  }

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
        return Object.keys(entry).length === 4
          && entry.version === CONVERSATION_VERSION
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
      if (values.some((entry) => entry.platform === platform
        && entry.viewerUserId === viewerUserId
        && sameConversation(entry.target, target))) return true
      return write([...values, { version: CONVERSATION_VERSION, platform, viewerUserId, target }]
        .slice(-MAX_CONVERSATION_DISMISSALS))
    },
    pending(platform: NativeSystemNotificationPlatform, viewerUserId: string) {
      if (!validSafeId(viewerUserId)) return []
      return read()
        .filter((entry) => entry.platform === platform && entry.viewerUserId === viewerUserId)
        .map((entry) => entry.target)
    },
    complete(
      platform: NativeSystemNotificationPlatform,
      viewerUserId: string,
      target: NativeSystemNotificationConversation,
    ) {
      const values = read()
      const next = values.filter((entry) => !(entry.platform === platform
        && entry.viewerUserId === viewerUserId
        && sameConversation(entry.target, target)))
      return next.length !== values.length && write(next)
    },
  }
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

  function read(): PendingDismissal | null {
    let raw: string | null
    try {
      raw = deps.getItem(KEY)
    } catch {
      return null
    }
    if (raw === null) return null
    try {
      const value = JSON.parse(raw) as Partial<PendingDismissal>
      if (
        value.version !== VERSION
        || (value.platform !== "desktop" && value.platform !== "mobile")
        || typeof value.notificationId !== "string"
        || !UUID.test(value.notificationId)
        || typeof value.pathname !== "string"
        || !ROUTE.test(value.pathname)
        || typeof value.expiresAt !== "number"
        || !Number.isFinite(value.expiresAt)
        || value.expiresAt <= deps.now()
        || Object.keys(value).some((key) => !FIELDS.has(key))
      ) {
        remove()
        return null
      }
      return value as PendingDismissal
    } catch {
      remove()
      return null
    }
  }

  return {
    queue(
      platform: NativeSystemNotificationPlatform,
      notificationId: string,
      pathname: string,
    ) {
      if (!UUID.test(notificationId) || !ROUTE.test(pathname)) return false
      const value: PendingDismissal = {
        version: VERSION,
        platform,
        notificationId,
        pathname,
        expiresAt: deps.now() + TTL_MS,
      }
      try {
        deps.setItem(KEY, JSON.stringify(value))
        return true
      } catch {
        return false
      }
    },
    peek(platform: NativeSystemNotificationPlatform, pathname: string) {
      const value = read()
      if (!value || value.platform !== platform || value.pathname !== pathname) return null
      return value.notificationId
    },
    complete(
      platform: NativeSystemNotificationPlatform,
      pathname: string,
      notificationId: string,
    ) {
      const value = read()
      if (
        !value
        || value.platform !== platform
        || value.pathname !== pathname
        || value.notificationId !== notificationId
      ) return false
      remove()
      return true
    },
  }
}
