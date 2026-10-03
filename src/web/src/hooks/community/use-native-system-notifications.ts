"use client"

import { useEffect } from "react"
import { createStore } from "@tanstack/store"
import { useQueryClient, QueryObserver, type QueryClient } from "@tanstack/react-query"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { useCommunityViewSource } from "./use-community-view-source"
import { isAbortError } from "@/lib/errors"
import { isDesktop, isMobile } from "@alook/shared"
import {
  dismissDesktopSystemNotification,
  dismissDesktopSystemNotificationConversation,
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
  dismissMobileSystemNotificationConversation,
  listenMobileSystemNotificationSignals,
  postMobileSystemNotificationRegistration,
  requestMobileSystemNotificationPermission,
  resumeMobileSystemNotificationRegistration,
  revalidateMobileSystemNotificationActivation,
  snapshotMobileSystemNotificationRegistration,
  takeMobileSystemNotificationActivation,
} from "@/lib/community/mobile-system-notification"
import {
  createNativeSystemNotificationConversationDismissalQueue,
  createNativeSystemNotificationDismissalQueue,
  type NativeSystemNotificationConversation,
  type NativeSystemNotificationPlatform,
} from "@/lib/community/native-system-notification-dismissal"

type OriginalView = (() => void) & { signal: AbortSignal }
const nativeRetryDelays = [1_000, 5_000, 30_000, 60_000] as const
function nativeCommand<T>(client: QueryClient, key: readonly unknown[], original: OriginalView, load: () => Promise<T>, retry = false) {
  original()
  return client.getMutationCache().build<T, Error, void, unknown>(client, { mutationKey: key, gcTime: 0,
    scope: { id: JSON.stringify(key) },
    retry: (count, error) => retry && !isAbortError(error) && !original.signal.aborted && count < nativeRetryDelays.length,
    retryDelay: (count) => nativeRetryDelays[Math.min(count, nativeRetryDelays.length - 1)]!,
    mutationFn: async () => { original(); const result = await load(); original(); return result },
  }).execute(undefined)
}
async function nativeRead<T>(client: QueryClient, key: readonly unknown[], original: OriginalView, load: (options: { signal: AbortSignal; assertActive: () => void }) => Promise<T>, retry = false) {
  original()
  const token = captureCommunityLiveSnapshotToken(client)
  const options = { queryKey: key, gcTime: 0, staleTime: 0,
    retry: (count: number, error: Error) => retry && !isAbortError(error) && count < nativeRetryDelays.length,
    retryDelay: (count: number) => nativeRetryDelays[Math.min(count, nativeRetryDelays.length - 1)]!,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const assertActive = () => assertCommunityLiveSnapshotTokenCurrent(client, token, signal)
      assertActive()
      const value = await load({ signal, assertActive })
      assertActive()
      return value
    },
  }
  const observer = new QueryObserver(client, { ...options, enabled: false })
  const release = observer.subscribe(() => undefined)
  original.signal.addEventListener("abort", release, { once: true })
  try { const value = await client.fetchQuery(options); original(); return value }
  finally { original.signal.removeEventListener("abort", release); release() }
}

function conversationKey(target: NativeSystemNotificationConversation) {
  return target.kind === "dm"
    ? `dm:${target.channelId}`
    : `server:${target.serverId}:${target.channelId}`
}

function dismissNativeSystemNotificationConversation(
  platform: NativeSystemNotificationPlatform,
  viewerUserId: string,
  target: NativeSystemNotificationConversation,
) {
  if (platform === "desktop") {
    return dismissDesktopSystemNotificationConversation(viewerUserId, target)
  }
  return dismissMobileSystemNotificationConversation(viewerUserId, target.channelId)
}

function drainNativeSystemNotificationConversationDismissals(
  platform: NativeSystemNotificationPlatform,
  viewerUserId: string,
  queue: ReturnType<typeof createNativeSystemNotificationConversationDismissalQueue>,
  client: QueryClient,
  original: OriginalView,
) {
  for (const target of queue.pending(platform, viewerUserId)) {
    const key = ["community", "native-conversation-dismiss", platform, viewerUserId, conversationKey(target)]
    if (client.getMutationCache().findAll({ mutationKey: key, status: "pending" }).length) continue
    void nativeCommand(client, key, original, async () => {
      await dismissNativeSystemNotificationConversation(platform, viewerUserId, target)
      original()
      queue.complete(platform, viewerUserId, target)
    }).catch(() => undefined)
  }
}

export function useNativeSystemNotificationConversationDismissal(
  viewerUserId: string,
  target: NativeSystemNotificationConversation,
  ready: boolean,
) {
  const client = useQueryClient()
  const source = useCommunityViewSource(`native-conversation-dismiss:${viewerUserId}:${target.channelId}`, ready)
  const kind = target.kind
  const channelId = target.channelId
  const serverId = target.kind === "server" ? target.serverId : undefined
  useEffect(() => {
    if (!ready || (!isDesktop() && !isMobile())) return
    const platform = isDesktop() ? "desktop" : "mobile"
    const dismissalTarget: NativeSystemNotificationConversation = kind === "server"
      ? { kind, serverId: serverId!, channelId }
      : { kind, channelId }
    const queue = createNativeSystemNotificationConversationDismissalQueue({
      getItem: (storageKey) => window.localStorage.getItem(storageKey),
      setItem: (storageKey, value) => window.localStorage.setItem(storageKey, value),
      removeItem: (storageKey) => window.localStorage.removeItem(storageKey),
    })
    queue.queue(platform, viewerUserId, dismissalTarget)
    drainNativeSystemNotificationConversationDismissals(platform, viewerUserId, queue, client, source.capture())
  }, [channelId, client, kind, ready, serverId, source, viewerUserId])
}

function dismissPendingNativeSystemNotification(
  platform: "desktop" | "mobile",
  pathname: string,
  dismissal: ReturnType<typeof createNativeSystemNotificationDismissalQueue>,
  dismiss: (notificationId: string) => Promise<void>,
  client: QueryClient,
  original: OriginalView,
) {
  const notificationId = dismissal.peek(platform, pathname)
  if (!notificationId) return
  const key = ["community", "native-notification-dismiss", platform, pathname, notificationId]
  if (client.getMutationCache().findAll({ mutationKey: key, status: "pending" }).length) return
  void nativeCommand(client, key, original, async () => {
    await dismiss(notificationId)
    original()
    dismissal.complete(platform, pathname, notificationId)
  }).catch(() => undefined)
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
    const protocol = createStore({ disposed: false,
        draining: null as Promise<void> | null });
    function removeIntent() {
        try {
            deps.removeItem(INBOX_INTENT_KEY);
        }
        catch {
            return;
        }
    }
    function readIntent(): InboxIntent | null {
        let raw: string | null;
        try {
            raw = deps.getItem(INBOX_INTENT_KEY);
        }
        catch {
            return null;
        }
        if (raw === null)
            return null;
        try {
            const value = JSON.parse(raw) as Partial<InboxIntent>;
            if (value.version !== INBOX_INTENT_VERSION
                || typeof value.expiresAt !== "number"
                || !Number.isFinite(value.expiresAt)
                || value.expiresAt <= deps.now()
                || typeof value.navigationStarted !== "boolean"
                || Object.keys(value).some((key) => !["version", "expiresAt", "navigationStarted"].includes(key))) {
                removeIntent();
                return null;
            }
            return value as InboxIntent;
        }
        catch {
            removeIntent();
            return null;
        }
    }
    function writeIntent(intent: InboxIntent) {
        try {
            deps.setItem(INBOX_INTENT_KEY, JSON.stringify(intent));
            return true;
        }
        catch {
            return false;
        }
    }
    function queueIntent() {
        if (readIntent())
            return true;
        return writeIntent({
            version: INBOX_INTENT_VERSION,
            expiresAt: deps.now() + INBOX_INTENT_TTL_MS,
            navigationStarted: false,
        });
    }
    function consume() {
        if (protocol.get().draining)
            return protocol.get().draining;
        const draining = Promise.resolve().then(async () => {
                const attempts = Math.max(1, deps.pollAttempts ?? INBOX_POLL_ATTEMPTS);
                for (let attempt = 0; attempt < attempts; attempt += 1) {
                    if (protocol.get().disposed || !readIntent())
                        return;
                    const trigger = deps.findTrigger();
                    if (trigger) {
                        if (protocol.get().disposed)
                            return;
                        trigger.click();
                        removeIntent();
                        return;
                    }
                    if (attempt + 1 < attempts)
                        await deps.wait();
                }
                if (protocol.get().disposed)
                    return;
                const intent = readIntent();
                if (!intent || intent.navigationStarted)
                    return;
                if (!writeIntent({ ...intent, navigationStarted: true }))
                    return;
                deps.navigateToCommunity();
            }).finally(() => {
                protocol.setState(state => ({ ...state, draining: null }));
            });
        protocol.setState(state => ({ ...state, draining }));
        return protocol.get().draining;
    }
    return {
        async open() {
            if (protocol.get().disposed || !queueIntent())
                return;
            await consume();
        },
        async resume() {
            if (protocol.get().disposed || !readIntent())
                return;
            await consume();
        },
        dispose() {
            protocol.setState(state => ({ ...state, disposed: true }));
        },
    };
}

export function createDesktopSystemNotificationActivationController(
  deps: DesktopSystemNotificationActivationDeps,
) {
    const protocol = createStore({ disposed: false,
        draining: false, rerun: false, unlisten: undefined as (() => void) | undefined });
    async function drain() {
        if (protocol.get().disposed)
            return;
        if (protocol.get().draining) {
            protocol.setState(state => ({ ...state, rerun: true }));
            return;
        }
        protocol.setState(state => ({ ...state, draining: true }));
        try {
            do {
                protocol.setState(state => ({ ...state, rerun: false }));
                const activation = await deps.take().catch(() => null);
                if (!activation || protocol.get().disposed)
                    continue;
                const validation = await deps.revalidate(activation).catch(() => "retryable" as const);
                if (protocol.get().disposed)
                    continue;
                if (validation === "allowed") {
                    const href = systemNotificationHref(activation.target);
                    try {
                        deps.queueDismiss(activation.notificationId, href);
                    }
                    catch { }
                    if (!protocol.get().disposed)
                        deps.navigate(href);
                }
                else {
                    if (validation === "retryable") {
                        await deps.retryActivation(activation.notificationId).catch(() => undefined);
                        if (protocol.get().disposed)
                            continue;
                    }
                    await deps.openInbox();
                }
            } while (protocol.get().rerun && !protocol.get().disposed);
        }
        finally {
            protocol.setState(state => ({ ...state, draining: false }));
        }
    }
    return {
        async connect() {
            const stop = await deps.listen(() => { void drain().catch(() => undefined); });
            if (protocol.get().disposed) {
                stop();
                return;
            }
            protocol.setState(state => ({ ...state, unlisten: stop }));
            await drain();
        },
        dispose() {
            if (protocol.get().disposed)
                return;
            protocol.setState(state => ({ ...state, disposed: true }));
            protocol.get().unlisten?.();
            protocol.setState(state => ({ ...state, unlisten: undefined }));
        },
    };
}

export function useNativeSystemNotifications(viewerUserId: string) {
  const client = useQueryClient()
  const source = useCommunityViewSource(`native-notifications:${viewerUserId}`)
  useEffect(() => {
    const original = source.capture()
    original()
    const key = (...parts: readonly unknown[]) => ["community", "native-notifications", viewerUserId, ...parts]
    const dismissal = createNativeSystemNotificationDismissalQueue({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      now: () => Date.now(),
    })
    const pathname = new URL(window.location.href).pathname
    const conversationDismissals = createNativeSystemNotificationConversationDismissalQueue({
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
    })
    const inbox = createDesktopSystemNotificationInboxOpener({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      findTrigger: () => { original(); return document.querySelector<HTMLButtonElement>(
        'button[aria-label="Inbox"], button[aria-label="Open Inbox"]',
      ) },
      navigateToCommunity: () => { original(); window.location.assign(new URL("/c", window.location.href).href) },
      wait: () => new Promise<void>((resolve) => window.setTimeout(resolve, 50)),
      now: () => Date.now(),
    })

    if (isDesktop()) {
      const drainConversations = () => drainNativeSystemNotificationConversationDismissals(
        "desktop",
        viewerUserId,
        conversationDismissals, client, original,
      )
      const dismissPending = () => dismissPendingNativeSystemNotification(
        "desktop",
        pathname,
        dismissal,
        dismissDesktopSystemNotification, client, original,
      )
      dismissPending()
      drainConversations()
      window.addEventListener("focus", dismissPending)
      window.addEventListener("focus", drainConversations)
      window.addEventListener("online", drainConversations)
      const browserDeps: DesktopSystemNotificationActivationDeps = {
        listen: listenDesktopSystemNotificationActivations,
        take: () => nativeCommand(client, key("desktop", "take"), original, takeDesktopSystemNotificationActivation),
        revalidate: ({ target }) => nativeRead(client, key("desktop", "target", target), original, (options) => revalidateDesktopSystemNotificationTarget(target, fetch, options)),
        retryActivation: (id) => nativeCommand(client, key("desktop", "retry", id), original, () => retryDesktopSystemNotificationActivation(id)),
        queueDismiss: (notificationId, href) => {
          original(); dismissal.queue("desktop", notificationId, href)
        },
        navigate: (href) => { original(); window.location.assign(href) },
        openInbox: () => { original(); return inbox.open() },
      }
      const controller = createDesktopSystemNotificationActivationController(browserDeps)
      void inbox.resume().catch(() => undefined)
      void controller.connect().catch(() => controller.dispose())
      return () => {
        window.removeEventListener("focus", dismissPending)
        window.removeEventListener("focus", drainConversations)
        window.removeEventListener("online", drainConversations)
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
      dismissMobileSystemNotification, client, original,
    )
    dismissPending()

    const registration = createMobileSystemNotificationRegistrationController({
      checkPermission: () => nativeRead(client, key("mobile", "permission"), original, () => checkMobileSystemNotificationPermission(), true),
      requestPermission: () => nativeCommand(client, key("mobile", "request-permission"), original, requestMobileSystemNotificationPermission),
      snapshot: () => nativeRead(client, key("mobile", "registration"), original, () => snapshotMobileSystemNotificationRegistration(), true),
      register: (snapshot) => nativeCommand(client, key("mobile", "register"), original, () => postMobileSystemNotificationRegistration(snapshot, fetch, { signal: original.signal, assertActive: original }), true),
      acknowledge: (token) => nativeCommand(client, key("mobile", "acknowledge"), original, () => acknowledgeMobileSystemNotificationRegistration(token), true),
      unregister: (id) => nativeCommand(client, key("mobile", "unregister", id), original, () => deleteMobileSystemNotificationRegistration(id, fetch, { signal: original.signal, assertActive: original }), true),
      retryDelaysMs: [],
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (handle) => window.clearTimeout(handle as number),
    })
    const activation = createMobileSystemNotificationActivationController({
      take: () => nativeCommand(client, key("mobile", "take"), original, takeMobileSystemNotificationActivation),
      revalidate: (activation) => nativeRead(client, key("mobile", "target", activation.targetId, activation.messageId), original, (options) => revalidateMobileSystemNotificationActivation(activation, fetch, options)),
      queueDismiss: (notificationId, href) => {
        original(); dismissal.queue("mobile", notificationId, href)
      },
      navigate: (href) => { original(); window.location.assign(href) },
      openInbox: () => { original(); return inbox.open() },
    })
    let disposed = false
    let unlisten: (() => void) | undefined

    const synchronize = () => {
      dismissPending()
      drainNativeSystemNotificationConversationDismissals("mobile", viewerUserId, conversationDismissals, client, original)
      void registration.sync().catch(() => undefined)
      void activation.drain().catch(() => undefined)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") synchronize()
    }
    window.addEventListener("online", synchronize)
    document.addEventListener("visibilitychange", onVisibilityChange)

    void inbox.resume().catch(() => undefined)
    drainNativeSystemNotificationConversationDismissals("mobile", viewerUserId, conversationDismissals, client, original)
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
  }, [viewerUserId, client, source])
}
