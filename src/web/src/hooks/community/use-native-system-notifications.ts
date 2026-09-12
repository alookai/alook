"use client"

import { useEffect } from "react"
import { isDesktop } from "@alook/shared"
import {
  listenDesktopSystemNotificationActivations,
  takeDesktopSystemNotificationActivation,
} from "@/lib/community/desktop-system-notification"
import {
  desktopSystemNotificationHref,
  revalidateDesktopSystemNotificationTarget,
  type DesktopSystemNotificationActivation,
} from "@/lib/community/system-notification-route"

export type DesktopSystemNotificationActivationDeps = {
  listen: (ready: () => void) => Promise<() => void>
  take: () => Promise<DesktopSystemNotificationActivation | null>
  revalidate: (activation: DesktopSystemNotificationActivation) => Promise<boolean>
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
        const allowed = await deps.revalidate(activation).catch(() => false)
        if (disposed) continue
        if (allowed) deps.navigate(desktopSystemNotificationHref(activation.target))
        else await deps.openInbox()
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

export function useNativeSystemNotifications() {
  useEffect(() => {
    if (!isDesktop()) return
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
    const browserDeps: DesktopSystemNotificationActivationDeps = {
      listen: listenDesktopSystemNotificationActivations,
      take: takeDesktopSystemNotificationActivation,
      revalidate: ({ target }) => revalidateDesktopSystemNotificationTarget(target),
      navigate: (href) => window.location.assign(href),
      openInbox: () => inbox.open(),
    }
    const controller = createDesktopSystemNotificationActivationController(browserDeps)
    void inbox.resume()
    void controller.connect().catch(() => controller.dispose())
    return () => {
      controller.dispose()
      inbox.dispose()
    }
  }, [])
}
