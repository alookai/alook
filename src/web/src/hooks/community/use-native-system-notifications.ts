"use client"

import { useEffect } from "react"
import { isDesktop, isMobile } from "@alook/shared"
import {
  dismissDesktopSystemNotification,
  listenDesktopSystemNotificationActivations,
  retryDesktopSystemNotificationActivation,
  takeDesktopSystemNotificationActivation,
} from "@/lib/community/desktop-system-notification"
import {
  revalidateDesktopSystemNotificationTarget,
  systemNotificationHref,
  type DesktopSystemNotificationActivation,
  type DesktopSystemNotificationTargetValidation,
} from "@/lib/community/system-notification-route"
import {
  acknowledgeMobileSystemNotificationRegistration,
  checkMobileSystemNotificationPermission,
  createMobileSystemNotificationActivationController,
  createMobileSystemNotificationRegistrationController,
  deleteMobileSystemNotificationRegistration,
  dismissMobileSystemNotification,
  listenMobileSystemNotificationSignals,
  postMobileSystemNotificationRegistration,
  requestMobileSystemNotificationPermission,
  resumeMobileSystemNotificationRegistration,
  revalidateMobileSystemNotificationActivation,
  snapshotMobileSystemNotificationRegistration,
  takeMobileSystemNotificationActivation,
} from "@/lib/community/mobile-system-notification"
import { createNativeSystemNotificationDismissalQueue } from "@/lib/community/native-system-notification-dismissal"

const activeNativeDismissals = new Set<string>()

function dismissPendingNativeSystemNotification(
  platform: "desktop" | "mobile",
  pathname: string,
  dismissal: ReturnType<typeof createNativeSystemNotificationDismissalQueue>,
  dismiss: (notificationId: string) => Promise<void>,
) {
  const notificationId = dismissal.peek(platform, pathname)
  if (!notificationId) return
  const key = `${platform}:${pathname}:${notificationId}`
  if (activeNativeDismissals.has(key)) return
  activeNativeDismissals.add(key)
  void dismiss(notificationId)
    .then(() => { dismissal.complete(platform, pathname, notificationId) })
    .catch(() => undefined)
    .finally(() => { activeNativeDismissals.delete(key) })
}

export type DesktopSystemNotificationActivationDeps = {
  listen: (ready: () => void) => Promise<() => void>
  take: () => Promise<DesktopSystemNotificationActivation | null>
  revalidate: (
    activation: DesktopSystemNotificationActivation,
  ) => Promise<DesktopSystemNotificationTargetValidation>
  retryActivation: (notificationId: string) => Promise<void>
  queueDismiss: (notificationId: string, href: string) => void
  navigate: (href: string) => void
  openInbox: () => Promise<void> | void
}

type InboxIntent = {
  version: 1
  expiresAt: number
  navigationStarted: boolean
}

export type DesktopSystemNotificationInboxDeps = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  findTrigger: () => { click: () => void } | null
  navigateToCommunity: () => void
  wait: () => Promise<void>
  now: () => number
  pollAttempts?: number
}

const INBOX_INTENT_KEY = "alook:desktop-system-notification:inbox-intent"
const INBOX_INTENT_VERSION = 1
const INBOX_INTENT_TTL_MS = 5 * 60 * 1000
const INBOX_POLL_ATTEMPTS = 40

export function createDesktopSystemNotificationInboxOpener(
  deps: DesktopSystemNotificationInboxDeps,
) {
  let disposed = false
  let draining: Promise<void> | null = null

  function removeIntent() {
    try {
      deps.removeItem(INBOX_INTENT_KEY)
    } catch {
      return
    }
  }

  function readIntent(): InboxIntent | null {
    let raw: string | null
    try {
      raw = deps.getItem(INBOX_INTENT_KEY)
    } catch {
      return null
    }
    if (raw === null) return null
    try {
      const value = JSON.parse(raw) as Partial<InboxIntent>
      if (
        value.version !== INBOX_INTENT_VERSION
        || typeof value.expiresAt !== "number"
        || !Number.isFinite(value.expiresAt)
        || value.expiresAt <= deps.now()
        || typeof value.navigationStarted !== "boolean"
        || Object.keys(value).some((key) => !["version", "expiresAt", "navigationStarted"].includes(key))
      ) {
        removeIntent()
        return null
      }
      return value as InboxIntent
    } catch {
      removeIntent()
      return null
    }
  }

  function writeIntent(intent: InboxIntent) {
    try {
      deps.setItem(INBOX_INTENT_KEY, JSON.stringify(intent))
      return true
    } catch {
      return false
    }
  }

  function queueIntent() {
    if (readIntent()) return true
    return writeIntent({
      version: INBOX_INTENT_VERSION,
      expiresAt: deps.now() + INBOX_INTENT_TTL_MS,
      navigationStarted: false,
    })
  }

  function consume() {
    if (draining) return draining
    draining = (async () => {
      const attempts = Math.max(1, deps.pollAttempts ?? INBOX_POLL_ATTEMPTS)
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (disposed || !readIntent()) return
        const trigger = deps.findTrigger()
        if (trigger) {
          if (disposed) return
          trigger.click()
          removeIntent()
          return
        }
        if (attempt + 1 < attempts) await deps.wait()
      }
      if (disposed) return
      const intent = readIntent()
      if (!intent || intent.navigationStarted) return
      if (!writeIntent({ ...intent, navigationStarted: true })) return
      deps.navigateToCommunity()
    })().finally(() => {
      draining = null
    })
    return draining
  }

  return {
    async open() {
      if (disposed || !queueIntent()) return
      await consume()
    },
    async resume() {
      if (disposed || !readIntent()) return
      await consume()
    },
    dispose() {
      disposed = true
    },
  }
}

export function createDesktopSystemNotificationActivationController(
  deps: DesktopSystemNotificationActivationDeps,
) {
  let disposed = false
  let draining = false
  let rerun = false
  let unlisten: (() => void) | undefined

  async function drain() {
    if (disposed) return
    if (draining) {
      rerun = true
      return
    }
    draining = true
    try {
      do {
        rerun = false
        const activation = await deps.take().catch(() => null)
        if (!activation || disposed) continue
        const validation = await deps.revalidate(activation).catch(() => "retryable" as const)
        if (disposed) continue
        if (validation === "allowed") {
          const href = systemNotificationHref(activation.target)
          try {
            deps.queueDismiss(activation.notificationId, href)
          } catch {}
          if (!disposed) deps.navigate(href)
        } else {
          if (validation === "retryable") {
            await deps.retryActivation(activation.notificationId).catch(() => undefined)
            if (disposed) continue
          }
          await deps.openInbox()
        }
      } while (rerun && !disposed)
    } finally {
      draining = false
    }
  }

  return {
    async connect() {
      const stop = await deps.listen(() => { void drain() })
      if (disposed) {
        stop()
        return
      }
      unlisten = stop
      await drain()
    },
    dispose() {
      if (disposed) return
      disposed = true
      unlisten?.()
      unlisten = undefined
    },
  }
}

export function useNativeSystemNotifications(viewerUserId: string) {
  useEffect(() => {
    const dismissal = createNativeSystemNotificationDismissalQueue({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      now: () => Date.now(),
    })
    const pathname = new URL(window.location.href).pathname
    const inbox = createDesktopSystemNotificationInboxOpener({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      findTrigger: () => document.querySelector<HTMLButtonElement>(
        'button[aria-label="Inbox"], button[aria-label="Open Inbox"]',
      ),
      navigateToCommunity: () => window.location.assign(new URL("/c", window.location.href).href),
      wait: () => new Promise<void>((resolve) => window.setTimeout(resolve, 50)),
      now: () => Date.now(),
    })

    if (isDesktop()) {
      const dismissPending = () => dismissPendingNativeSystemNotification(
        "desktop",
        pathname,
        dismissal,
        dismissDesktopSystemNotification,
      )
      dismissPending()
      window.addEventListener("focus", dismissPending)
      const browserDeps: DesktopSystemNotificationActivationDeps = {
        listen: listenDesktopSystemNotificationActivations,
        take: takeDesktopSystemNotificationActivation,
        revalidate: ({ target }) => revalidateDesktopSystemNotificationTarget(target),
        retryActivation: retryDesktopSystemNotificationActivation,
        queueDismiss: (notificationId, href) => {
          dismissal.queue("desktop", notificationId, href)
        },
        navigate: (href) => window.location.assign(href),
        openInbox: () => inbox.open(),
      }
      const controller = createDesktopSystemNotificationActivationController(browserDeps)
      void inbox.resume()
      void controller.connect().catch(() => controller.dispose())
      return () => {
        window.removeEventListener("focus", dismissPending)
        controller.dispose()
        inbox.dispose()
      }
    }

    if (!isMobile()) {
      inbox.dispose()
      return
    }

    resumeMobileSystemNotificationRegistration()
    const dismissPending = () => dismissPendingNativeSystemNotification(
      "mobile",
      pathname,
      dismissal,
      dismissMobileSystemNotification,
    )
    dismissPending()

    const registration = createMobileSystemNotificationRegistrationController({
      checkPermission: checkMobileSystemNotificationPermission,
      requestPermission: requestMobileSystemNotificationPermission,
      snapshot: snapshotMobileSystemNotificationRegistration,
      register: postMobileSystemNotificationRegistration,
      acknowledge: acknowledgeMobileSystemNotificationRegistration,
      unregister: deleteMobileSystemNotificationRegistration,
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (handle) => window.clearTimeout(handle as number),
    })
    const activation = createMobileSystemNotificationActivationController({
      take: takeMobileSystemNotificationActivation,
      revalidate: revalidateMobileSystemNotificationActivation,
      queueDismiss: (notificationId, href) => {
        dismissal.queue("mobile", notificationId, href)
      },
      navigate: (href) => window.location.assign(href),
      openInbox: () => inbox.open(),
    })
    let disposed = false
    let unlisten: (() => void) | undefined

    const synchronize = () => {
      dismissPending()
      void registration.sync()
      void activation.drain()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") synchronize()
    }
    window.addEventListener("online", synchronize)
    document.addEventListener("visibilitychange", onVisibilityChange)

    void inbox.resume()
    void (async () => {
      try {
        const stop = await listenMobileSystemNotificationSignals(synchronize)
        if (disposed) stop()
        else unlisten = stop
      } catch {
        unlisten = undefined
      }
      if (disposed) return
      await Promise.all([registration.sync(true), activation.drain()])
    })()

    return () => {
      disposed = true
      window.removeEventListener("online", synchronize)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      unlisten?.()
      registration.dispose()
      activation.dispose()
      inbox.dispose()
    }
  }, [viewerUserId])
}
