"use client"

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { createStore } from "@tanstack/store"
import { useQueryClient, QueryObserver, type QueryClient } from "@tanstack/react-query"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { useCommunityViewSource } from "./use-community-view-source"
import { isAbortError } from "@/lib/errors"
import { normalizeCommunityHref, type CommunityCommittedFrame } from "@/lib/community/community-route"
import { useCommunityRouteFrame, type NativeNotificationConversationConsumer, type CommunityNavigationController } from "@/contexts/community/route-frame"
import { isDesktop, isMobile } from "@alook/shared"
import {
  dismissDesktopSystemNotification,
  dismissDesktopSystemNotificationConversation,
  listenDesktopSystemNotificationActivations,
  takeDesktopSystemNotificationActivation,
} from "@/lib/community/desktop-system-notification"
import {
  systemNotificationHref,
  type DesktopSystemNotificationActivation,
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
  try { const value = await client.query({ ...options, select: undefined }); original(); return value }
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
  for (const { target, revision } of queue.pending(platform, viewerUserId)) {
    const key = ["community", "native-conversation-dismiss", platform, viewerUserId, conversationKey(target)]
    if (client.getMutationCache().findAll({ mutationKey: key, status: "pending" }).length) continue
    void nativeCommand(client, key, original, async () => {
      await dismissNativeSystemNotificationConversation(platform, viewerUserId, target)
      original()
      queue.complete(platform, viewerUserId, target, revision)
    }).catch(() => undefined).finally(() => {
      try { original() } catch { return }
      if (queue.pending(platform, viewerUserId).some((entry) => conversationKey(entry.target) === conversationKey(target) && entry.revision !== revision)) {
        drainNativeSystemNotificationConversationDismissals(platform, viewerUserId, queue, client, original)
      }
    })
  }
}

export function useNativeSystemNotificationConversationDismissal(
  viewerUserId: string,
  target: NativeSystemNotificationConversation,
  ready: boolean,
) {
  const client = useQueryClient()
  const { frame, navigation, notificationConsumer: notificationConsumerRef } = useCommunityRouteFrame()
  const current = useRef({ frame, navigation })
  useLayoutEffect(() => { current.current = { frame, navigation } }, [frame, navigation])
  const source = useCommunityViewSource(`native-conversation-dismiss:${viewerUserId}:${target.channelId}`, ready)
  const captureIntent = navigation.captureIntent
  const kind = target.kind
  const channelId = target.channelId
  const serverId = target.kind === "server" ? target.serverId : undefined
  useEffect(() => {
    if (!ready || (!isDesktop() && !isMobile())) return
    const platform = isDesktop() ? "desktop" : "mobile"
    const dismissalTarget: NativeSystemNotificationConversation = kind === "server"
      ? { kind, serverId: serverId!, channelId } : { kind, channelId }
    const queue = createNativeSystemNotificationConversationDismissalQueue({
      getItem: (storageKey) => window.localStorage.getItem(storageKey),
      setItem: (storageKey, value) => window.localStorage.setItem(storageKey, value),
      removeItem: (storageKey) => window.localStorage.removeItem(storageKey),
    })
    const original = source.capture()
    const intent = captureIntent()
    const consumer: NativeNotificationConversationConsumer = {
      matches: (viewer, targetId) => {
        try { original() } catch { return false }
        const route = current.current
        return viewer === viewerUserId && targetId === channelId && intent()
          && document.visibilityState === "visible" && !route.navigation.navigationPending
          && route.frame.pathname === systemNotificationHref(dismissalTarget)
          && normalizeCommunityHref(route.navigation.publishedHref).pathname === route.frame.pathname
      },
      requestDismiss: () => {
        if (!consumer.matches(viewerUserId, channelId)) return
        queue.queue(platform, viewerUserId, dismissalTarget)
        drainNativeSystemNotificationConversationDismissals(platform, viewerUserId, queue, client, original)
      },
    }
    const actual = current.current
    if (notificationConsumerRef && !actual.navigation.navigationPending
      && actual.frame.pathname === systemNotificationHref(dismissalTarget)
      && normalizeCommunityHref(actual.navigation.publishedHref).pathname === actual.frame.pathname) {
      notificationConsumerRef.current = consumer
    }
    consumer.requestDismiss()
    const onVisible = () => { if (document.visibilityState === "visible") consumer.requestDismiss() }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      if (notificationConsumerRef?.current === consumer) notificationConsumerRef.current = null
    }
  }, [channelId, client, kind, ready, serverId, source, viewerUserId, notificationConsumerRef,
    frame.pathname, navigation.publishedHref, navigation.navigationPending, captureIntent])
}

function dismissPendingNativeSystemNotification(
  platform: "desktop" | "mobile",
  viewerUserId: string,
  pathname: string,
  dismissal: ReturnType<typeof createNativeSystemNotificationDismissalQueue>,
  dismiss: (notificationId: string) => Promise<void>,
  client: QueryClient,
  original: OriginalView,
) {
  const notificationId = dismissal.peek(platform, viewerUserId, pathname)
  if (!notificationId) return
  const key = ["community", "native-notification-dismiss", platform, viewerUserId, pathname, notificationId]
  if (client.getMutationCache().findAll({ mutationKey: key, status: "pending" }).length) return
  void nativeCommand(client, key, original, async () => {
    await dismiss(notificationId)
    original()
    dismissal.complete(platform, viewerUserId, pathname, notificationId)
  }).catch(() => undefined)
}

export type DesktopSystemNotificationActivationDeps = {
  listen: (ready: () => void) => Promise<() => void>
  take: () => Promise<DesktopSystemNotificationActivation | null>
  queueDismiss: (notificationId: string, href: string) => void
  navigate: (href: string) => void
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
                const href = systemNotificationHref(activation.target);
                try {
                    deps.queueDismiss(activation.notificationId, href);
                }
                catch { }
                if (!protocol.get().disposed)
                    deps.navigate(href);
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

export function useNativeSystemNotifications(
  viewerUserId: string,
  frame: CommunityCommittedFrame,
  navigation: CommunityNavigationController,
  notificationConsumer: RefObject<NativeNotificationConversationConsumer | null>,
) {
  const currentRoute = useRef({ frame, navigation })
  const committedDismissal = useRef<() => void>(() => undefined)
  useLayoutEffect(() => { currentRoute.current = { frame, navigation } }, [frame, navigation])
  const client = useQueryClient()
  const source = useCommunityViewSource(`native-notifications:${viewerUserId}`)
  useEffect(() => {
    const original = source.capture()
    original()
    const presentationWindow = window as Window & { alookNativeNotificationPresentationV1?: (identity: unknown) => boolean }
    const presentation = (identity: unknown) => {
      try { original() } catch { return false }
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false
      const value = identity as Record<string, unknown>
      return Object.keys(value).length === 2 && typeof value.viewerUserId === "string"
        && typeof value.targetId === "string" && value.viewerUserId === viewerUserId
        && notificationConsumer.current?.matches(value.viewerUserId, value.targetId) === true
    }
    presentationWindow.alookNativeNotificationPresentationV1 = presentation
    const requestCurrentDismissal = () => { try { original() } catch { return }; notificationConsumer.current?.requestDismiss() }
    const key = (...parts: readonly unknown[]) => ["community", "native-notifications", viewerUserId, ...parts]
    const dismissal = createNativeSystemNotificationDismissalQueue({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      now: () => Date.now(),
    })
    const conversationDismissals = createNativeSystemNotificationConversationDismissalQueue({
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
    })
    const dismissPending = () => {
      try { original() } catch { return }
      const { frame: actualFrame, navigation: currentNavigation } = currentRoute.current
      if (currentNavigation.navigationPending
        || normalizeCommunityHref(currentNavigation.publishedHref).href !== actualFrame.href) return
      const platform = isDesktop() ? "desktop" : isMobile() ? "mobile" : null
      if (!platform) return
      dismissPendingNativeSystemNotification(platform, viewerUserId, actualFrame.pathname,
        dismissal, platform === "desktop" ? dismissDesktopSystemNotification : dismissMobileSystemNotification,
        client, original)
    }
    committedDismissal.current = dismissPending
    const releaseDismissal = () => {
      if (presentationWindow.alookNativeNotificationPresentationV1 === presentation) delete presentationWindow.alookNativeNotificationPresentationV1
      if (committedDismissal.current === dismissPending) committedDismissal.current = () => undefined
    }

    if (isDesktop()) {
      const drainConversations = () => drainNativeSystemNotificationConversationDismissals(
        "desktop",
        viewerUserId,
        conversationDismissals, client, original,
      )
      dismissPending()
      drainConversations()
      window.addEventListener("focus", dismissPending)
      window.addEventListener("focus", drainConversations)
      window.addEventListener("focus", requestCurrentDismissal)
      window.addEventListener("online", drainConversations)
      const browserDeps: DesktopSystemNotificationActivationDeps = {
        listen: (wake) => listenDesktopSystemNotificationActivations(() => { requestCurrentDismissal(); wake() }),
        take: () => nativeCommand(client, key("desktop", "take"), original, takeDesktopSystemNotificationActivation),
        queueDismiss: (notificationId, href) => {
          original(); dismissal.queue("desktop", viewerUserId, notificationId, href)
        },
        navigate: (href) => { original(); currentRoute.current.navigation.pushImmediate(href); dismissPending() },
      }
      const controller = createDesktopSystemNotificationActivationController(browserDeps)
      void controller.connect().catch(() => controller.dispose())
      return () => {
        window.removeEventListener("focus", dismissPending)
        window.removeEventListener("focus", drainConversations)
        window.removeEventListener("focus", requestCurrentDismissal)
        window.removeEventListener("online", drainConversations)
        controller.dispose()
        releaseDismissal()
      }
    }

    if (!isMobile()) return releaseDismissal

    resumeMobileSystemNotificationRegistration()
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
      queueDismiss: (notificationId, href) => {
        original(); dismissal.queue("mobile", viewerUserId, notificationId, href)
      },
      navigate: (href) => { original(); currentRoute.current.navigation.pushImmediate(href); dismissPending() },
    })
    let disposed = false
    let unlisten: (() => void) | undefined

    const synchronize = () => {
      requestCurrentDismissal()
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
      releaseDismissal()
    }
  }, [viewerUserId, client, source, notificationConsumer])
  useEffect(() => { committedDismissal.current() }, [frame.href, navigation.publishedHref, navigation.navigationPending])
}
