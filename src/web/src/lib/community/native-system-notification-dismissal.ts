export type NativeSystemNotificationPlatform = "desktop" | "mobile"

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
