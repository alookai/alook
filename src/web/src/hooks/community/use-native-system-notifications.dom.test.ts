import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useLayoutEffect, type PropsWithChildren } from "react"
import { act, waitFor, renderHook as renderOwnedHook } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { renderCommunityHook as renderHook } from "@/test/community-owner-harness"
import {
  createDesktopSystemNotificationActivationController,
  useNativeSystemNotificationConversationDismissal,
  useNativeSystemNotifications,
} from "./use-native-system-notifications"
import type { DesktopSystemNotificationActivation } from "@/lib/community/system-notification-route"
import { createNativeSystemNotificationDismissalQueue } from "@/lib/community/native-system-notification-dismissal"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"


const hookMocks = vi.hoisted(() => ({
  desktop: true,
  mobile: false,
  listen: vi.fn(),
  take: vi.fn(),
  retryActivation: vi.fn(async () => undefined),
  dismiss: vi.fn(async () => undefined),
  dismissConversation: vi.fn(async () => undefined),
  revalidate: vi.fn(),
  mobileListen: vi.fn(),
  mobileCheck: vi.fn(),
  mobileRequest: vi.fn(),
  mobileSnapshot: vi.fn(),
  mobilePost: vi.fn(),
  mobileAck: vi.fn(),
  mobileDelete: vi.fn(),
  mobileTake: vi.fn(),
  mobileDismiss: vi.fn(async () => undefined),
  mobileDismissConversation: vi.fn(async () => undefined),
  mobileRevalidate: vi.fn(),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    isDesktop: () => hookMocks.desktop,
    isMobile: () => hookMocks.mobile,
  }
})
vi.mock("@/lib/community/desktop-system-notification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/desktop-system-notification")>(
    "@/lib/community/desktop-system-notification",
  )
  return {
    ...actual,
    listenDesktopSystemNotificationActivations: hookMocks.listen,
    takeDesktopSystemNotificationActivation: hookMocks.take,
    retryDesktopSystemNotificationActivation: hookMocks.retryActivation,
    dismissDesktopSystemNotification: hookMocks.dismiss,
    dismissDesktopSystemNotificationConversation: hookMocks.dismissConversation,
  }
})
vi.mock("@/lib/community/system-notification-route", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/system-notification-route")>(
    "@/lib/community/system-notification-route",
  )
  return { ...actual, revalidateDesktopSystemNotificationTarget: hookMocks.revalidate }
})
vi.mock("@/lib/community/mobile-system-notification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/mobile-system-notification")>(
    "@/lib/community/mobile-system-notification",
  )
  return {
    ...actual,
    listenMobileSystemNotificationSignals: hookMocks.mobileListen,
    checkMobileSystemNotificationPermission: hookMocks.mobileCheck,
    requestMobileSystemNotificationPermission: hookMocks.mobileRequest,
    snapshotMobileSystemNotificationRegistration: hookMocks.mobileSnapshot,
    postMobileSystemNotificationRegistration: hookMocks.mobilePost,
    acknowledgeMobileSystemNotificationRegistration: hookMocks.mobileAck,
    deleteMobileSystemNotificationRegistration: hookMocks.mobileDelete,
    takeMobileSystemNotificationActivation: hookMocks.mobileTake,
    dismissMobileSystemNotification: hookMocks.mobileDismiss,
    dismissMobileSystemNotificationConversation: hookMocks.mobileDismissConversation,
    revalidateMobileSystemNotificationActivation: hookMocks.mobileRevalidate,
  }
})

import { normalizeCommunityHref } from "@/lib/community/community-route"
import { CommunityRouteContext, type NativeNotificationConversationConsumer } from "@/components/community/shell/community-route-context"
import type { CommunityNavigationController } from "@/components/community/shell/use-community-navigation-controller"
const activation: DesktopSystemNotificationActivation = {
  notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
  target: { kind: "server", serverId: "server_1", channelId: "channel_1", messageId: "message_1", seq: 4 },
}
const target = { kind: "server" as const, serverId: "server_1", channelId: "channel_1" }
const consumer = { current: null as NativeNotificationConversationConsumer | null }
let intentRevision = 0
let route: { frame: ReturnType<typeof normalizeCommunityHref> & {revision:number}; navigation: CommunityNavigationController; breakpoint: "desktop"; notificationConsumer: typeof consumer }
function setRoute(href: string, pending = false) {
  route = { breakpoint:"desktop", notificationConsumer:consumer, frame:{...normalizeCommunityHref(href),revision:intentRevision}, navigation:{
    publishedHref:href, navigationPending:pending, pendingHref:pending ? href : null,
    captureIntent:()=>{const revision=intentRevision;return ()=>revision===intentRevision},
    push:vi.fn(), pushImmediate:vi.fn(()=>{intentRevision++}), replace:vi.fn(), resolveAndPush:vi.fn(), cancelPendingNavigation:vi.fn(),
  }}
}
const wrapper = ({children}:PropsWithChildren) => createElement(CommunityRouteContext,{value:route},children)
function useNotifications() { useNativeSystemNotifications("viewer", route.frame, route.navigation, consumer) }
function presentation(identity:unknown) {
  return (window as Window & {alookNativeNotificationPresentationV1?:(value:unknown)=>boolean}).alookNativeNotificationPresentationV1?.(identity)
}
beforeEach(()=>{
  vi.resetAllMocks()
  hookMocks.desktop=true;hookMocks.mobile=false;consumer.current=null;intentRevision=0
  setRoute("/c/channels/server_1/channel_1")
  hookMocks.listen.mockResolvedValue(vi.fn());hookMocks.take.mockResolvedValue(null)
  hookMocks.dismiss.mockResolvedValue(undefined);hookMocks.dismissConversation.mockResolvedValue(undefined)
  hookMocks.mobileListen.mockResolvedValue(vi.fn());hookMocks.mobileTake.mockResolvedValue(null)
  hookMocks.mobileCheck.mockResolvedValue("denied");hookMocks.mobileDismiss.mockResolvedValue(undefined)
  hookMocks.mobileDismissConversation.mockResolvedValue(undefined)
  vi.spyOn(document,"visibilityState","get").mockReturnValue("visible")
})
afterEach(()=>{window.localStorage.clear();window.sessionStorage.clear();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs()})
describe("notification activation",()=>{
  it("queues and navigates immediately without starting a HTTP precheck",async()=>{
    const fetch=vi.fn(()=>new Promise<Response>(()=>undefined));vi.stubGlobal("fetch",fetch)
    const calls:string[]=[]
    const controller=createDesktopSystemNotificationActivationController({
      listen:async()=>()=>undefined,take:async()=>activation,
      queueDismiss:()=>calls.push("queue"),navigate:(href)=>calls.push(href),
    })
    await controller.connect()
    expect(calls).toEqual(["queue","/c/channels/server_1/channel_1"])
    expect(fetch).not.toHaveBeenCalled()
    controller.dispose()
  })
  it("coalesces signals and retires a delayed take",async()=>{
    let wake!:()=>void;let release!:(value:DesktopSystemNotificationActivation|null)=>void
    const pending=new Promise<DesktopSystemNotificationActivation|null>(resolve=>{release=resolve})
    const take=vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(null)
    const navigate=vi.fn()
    const controller=createDesktopSystemNotificationActivationController({listen:async cb=>{wake=cb;return()=>undefined},take,queueDismiss:vi.fn(),navigate})
    const connection=controller.connect();await waitFor(()=>expect(take).toHaveBeenCalledOnce())
    wake();release(activation);await connection
    expect(take).toHaveBeenCalledTimes(2);expect(navigate).toHaveBeenCalledOnce()
    controller.dispose();wake();expect(take).toHaveBeenCalledTimes(2)
  })
  it("uses the actual route commit to consume the clicked ID",async()=>{
    setRoute("/c/me/friends")
    hookMocks.take.mockResolvedValueOnce(activation)
    const rendered=renderHook(useNotifications,{wrapper})
    await waitFor(()=>expect(route.navigation.pushImmediate).toHaveBeenCalledWith("/c/channels/server_1/channel_1"))
    expect(hookMocks.dismiss).not.toHaveBeenCalled()
    setRoute("/c/me/friends",true);rendered.rerender()
    expect(hookMocks.dismiss).not.toHaveBeenCalled()
    setRoute("/c/channels/server_1/channel_1");rendered.rerender()
    await waitFor(()=>expect(hookMocks.dismiss).toHaveBeenCalledExactlyOnceWith(activation.notificationId))
    await waitFor(()=>expect(window.sessionStorage.length).toBe(0));rendered.unmount()
  })
  it("queues a mobile activation before navigating and dismisses only its committed target", async () => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    setRoute("/c/me/friends")
    const clicked = { notificationId: activation.notificationId, messageId: "message_1", targetId: "channel_1" }
    hookMocks.mobileTake.mockResolvedValueOnce(clicked)
    const fetch = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal("fetch", fetch)
    const queue = createNativeSystemNotificationDismissalQueue({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
      now: () => Date.now(),
    })
    let queuedAtNavigation: string | null = null
    vi.mocked(route.navigation.pushImmediate).mockImplementation((href) => {
      queuedAtNavigation = queue.peek("mobile", "viewer", href)
      intentRevision++
    })
    const rendered = renderHook(useNotifications, { wrapper })
    await waitFor(() => expect(route.navigation.pushImmediate).toHaveBeenCalledExactlyOnceWith("/c/messages/message_1"))
    expect(queuedAtNavigation).toBe(clicked.notificationId)
    expect(queue.peek("mobile", "viewer", "/c/messages/message_1")).toBe(clicked.notificationId)
    expect(hookMocks.mobileRevalidate).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()
    setRoute("/c/messages/message_1", true)
    rendered.rerender()
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()
    setRoute("/c/messages/other_message")
    rendered.rerender()
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()
    expect(queue.peek("mobile", "viewer", "/c/messages/message_1")).toBe(clicked.notificationId)
    setRoute("/c/messages/message_1")
    rendered.rerender()
    await waitFor(() => expect(hookMocks.mobileDismiss).toHaveBeenCalledExactlyOnceWith(clicked.notificationId))
    await waitFor(() => expect(window.sessionStorage.length).toBe(0))
    rendered.unmount()
  })
  it("discards a delayed mobile activation after the hook retires", async () => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    setRoute("/c/me/friends")
    const clicked = { notificationId: activation.notificationId, messageId: "message_1", targetId: "channel_1" }
    let release!: (value: typeof clicked) => void
    hookMocks.mobileTake.mockReturnValueOnce(new Promise<typeof clicked>(resolve => { release = resolve }))
    const rendered = renderHook(useNotifications, { wrapper })
    await waitFor(() => expect(hookMocks.mobileTake).toHaveBeenCalledOnce())
    rendered.unmount()
    await act(async () => { release(clicked) })
    expect(route.navigation.pushImmediate).not.toHaveBeenCalled()
    expect(window.sessionStorage.length).toBe(0)
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()
  })
  it.each(["dm", "channel"] as const)("navigates a cached mobile %s directly and clears only after route commit", async kind => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    setRoute("/c/me/friends")
    const owner = await createCommunityQueryOwner()
    await seedConversationEntry(owner.client, kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture())
    const clicked = { notificationId: activation.notificationId, messageId: "m1", targetId: "c1" }
    hookMocks.mobileTake.mockResolvedValueOnce(clicked)
    const wrapped = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider,
      { client: owner.client, registry: owner.registry, retainOwner: true }, createElement(wrapper, null, children))
    const rendered = renderOwnedHook(useNotifications, { wrapper: wrapped })
    const href = kind === "dm" ? "/c/me/c1" : "/c/channels/s1/c1"
    await waitFor(() => expect(route.navigation.pushImmediate).toHaveBeenCalledExactlyOnceWith(href))
    expect(hookMocks.mobileRevalidate).not.toHaveBeenCalled()
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()
    setRoute(href)
    rendered.rerender()
    await waitFor(() => expect(hookMocks.mobileDismiss).toHaveBeenCalledExactlyOnceWith(clicked.notificationId))
    rendered.unmount()
  })
  it.each(["dm with server", "server without server"] as const)("resolves a cached %s through the ordinary message page", async combination => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    setRoute("/c/me/friends")
    const owner = await createCommunityQueryOwner()
    await seedConversationEntry(owner.client, combination === "dm with server" ? dmConversationEntryFixture() : conversationEntryFixture())
    const channel = owner.registry.collections.channels.get("c1")!
    await writeCommunityCollectionRows(owner.registry, "channels", [{ ...channel, serverId: combination === "dm with server" ? "s1" : null }], row => row.id)
    const clicked = { notificationId: activation.notificationId, messageId: "m1", targetId: "c1" }
    hookMocks.mobileTake.mockResolvedValueOnce(clicked)
    const fetch = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal("fetch", fetch)
    const wrapped = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider,
      { client: owner.client, registry: owner.registry, retainOwner: true }, createElement(wrapper, null, children))
    const rendered = renderOwnedHook(useNotifications, { wrapper: wrapped })
    await waitFor(() => expect(route.navigation.pushImmediate).toHaveBeenCalledExactlyOnceWith("/c/messages/m1"))
    expect(fetch).not.toHaveBeenCalled()
    expect(hookMocks.mobileRevalidate).not.toHaveBeenCalled()
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()
    setRoute("/c/messages/m1")
    rendered.rerender()
    await waitFor(() => expect(hookMocks.mobileDismiss).toHaveBeenCalledExactlyOnceWith(clicked.notificationId))
    rendered.unmount()
  })
})
describe("current native conversation",()=>{
  function useCurrent(ready=true) {useNotifications();useNativeSystemNotificationConversationDismissal("viewer",target,ready)}
  it("consumes an arrival after the initial ready dismissal has finished",async()=>{
    let wake!:()=>void;hookMocks.listen.mockImplementation(async cb=>{wake=cb;return()=>undefined})
    const rendered=renderHook(()=>useCurrent(),{wrapper})
    await waitFor(()=>expect(hookMocks.dismissConversation).toHaveBeenCalledOnce())
    await waitFor(()=>expect(window.localStorage.length).toBe(0))
    act(()=>wake());await waitFor(()=>expect(hookMocks.dismissConversation).toHaveBeenCalledTimes(2))
    rendered.unmount()
  })
  it("retains and drains a newer demand received during cleanup",async()=>{
    let wake!:()=>void;let done!:()=>void
    hookMocks.listen.mockImplementation(async cb=>{wake=cb;return()=>undefined})
    hookMocks.dismissConversation.mockImplementationOnce(()=>new Promise<void>(resolve=>{done=resolve}))
    const rendered=renderHook(()=>useCurrent(),{wrapper})
    await waitFor(()=>expect(hookMocks.dismissConversation).toHaveBeenCalledOnce())
    act(()=>wake());expect(hookMocks.dismissConversation).toHaveBeenCalledOnce()
    await act(async()=>done())
    await waitFor(()=>expect(hookMocks.dismissConversation).toHaveBeenCalledTimes(2))
    await waitFor(()=>expect(window.localStorage.length).toBe(0));rendered.unmount()
  })
  it("keeps a failed revision until a new wake and has no retry timer",async()=>{
    vi.stubEnv("NODE_ENV", "development");vi.stubEnv("NEXT_PUBLIC_ALOOK_NOTIFICATION_DIAGNOSTICS", "208")
    const log=vi.spyOn(console,"info").mockImplementation(()=>undefined)
    let wake!:()=>void;hookMocks.listen.mockImplementation(async cb=>{wake=cb;return()=>undefined})
    hookMocks.dismissConversation.mockRejectedValueOnce(new Error("native unavailable"))
    const rendered=renderHook(()=>useCurrent(),{wrapper})
    await waitFor(()=>expect(hookMocks.dismissConversation).toHaveBeenCalledOnce())
    await act(async()=>{await Promise.resolve()});expect(window.localStorage.length).toBe(1)
    const events=()=>log.mock.calls.map(([,raw])=>JSON.parse(raw as string))
    const retained=events().find(event=>event.stage==="queue.retained")
    expect(retained.data).toMatchObject({viewerUserId:"viewer",target,sourceRetired:false})
    const pending=JSON.parse(window.localStorage.getItem("alook:native-system-notification:conversation-dismissals")!)
    expect(retained.data.revision).toBe(pending[0].revision)
    expect(events().find(event=>event.stage==="ready.matches").data).toMatchObject({matches:true,intentCurrent:true,navigationPending:false,visibility:"visible"})
    act(()=>wake());await waitFor(()=>expect(hookMocks.dismissConversation).toHaveBeenCalledTimes(2))
    await waitFor(()=>expect(window.localStorage.length).toBe(0))
    expect(events().filter(event=>event.stage==="queue.complete")).toHaveLength(1)
    expect(events().find(event=>event.stage==="queue.complete").data.completed).toBe(true)
    rendered.unmount()
  })
  it("authorizes presentation synchronously without queue or native side effects",async()=>{
    const rendered=renderHook(()=>useCurrent(),{wrapper})
    await waitFor(()=>expect(window.localStorage.length).toBe(0))
    const calls=hookMocks.dismissConversation.mock.calls.length
    expect(presentation({viewerUserId:"viewer",targetId:"channel_1"})).toBe(true)
    expect(presentation({viewerUserId:"other",targetId:"channel_1"})).toBe(false)
    expect(presentation({viewerUserId:"viewer",targetId:"channel_2"})).toBe(false)
    expect(presentation({viewerUserId:"viewer",targetId:"channel_1",extra:true})).toBe(false)
    expect(hookMocks.dismissConversation).toHaveBeenCalledTimes(calls)
    expect(window.localStorage.length).toBe(0)
    intentRevision++
    expect(presentation({viewerUserId:"viewer",targetId:"channel_1"})).toBe(false)
    rendered.unmount();expect(presentation({viewerUserId:"viewer",targetId:"channel_1"})).toBeUndefined()
  })
  it("rejects presentation after readiness retires and before passive consumer cleanup", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("NEXT_PUBLIC_ALOOK_NOTIFICATION_DIAGNOSTICS", "208")
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const identity = { viewerUserId: "viewer", targetId: "channel_1" }
    const probes: { consumerPresent: boolean; authorized: boolean | undefined }[] = []
    const nativeCalls = () => ({
      take: hookMocks.take.mock.calls.length,
      dismiss: hookMocks.dismiss.mock.calls.length,
      conversation: hookMocks.dismissConversation.mock.calls.length,
    })
    const rendered = renderHook(({ ready }) => {
      useCurrent(ready)
      useLayoutEffect(() => {
        if (!ready) {
          probes.push({
            consumerPresent: consumer.current !== null,
            authorized: presentation(identity),
          })
        }
      }, [ready])
    }, { wrapper, initialProps: { ready: true } })
    await waitFor(() => expect(hookMocks.dismissConversation).toHaveBeenCalledOnce())
    await waitFor(() => expect(window.localStorage.length).toBe(0))
    expect(presentation(identity)).toBe(true)
    const before = nativeCalls()

    rendered.rerender({ ready: false })

    expect(probes).toEqual([{ consumerPresent: true, authorized: false }])
    const retired = log.mock.calls
      .filter(([prefix]) => prefix === "ALOOK208")
      .map(([, raw]) => JSON.parse(raw as string))
      .filter((event) => event.stage === "ready.retired")
    expect(retired).toHaveLength(1)
    expect(retired[0].data).toEqual({ viewerUserId: "viewer", dismissalTarget: target })
    expect(nativeCalls()).toEqual(before)
    expect(window.localStorage.length).toBe(0)
    expect(consumer.current).toBeNull()
    expect(presentation(identity)).toBe(false)
    rendered.unmount()
    expect(presentation(identity)).toBeUndefined()
  })
  it.each(["not ready","hidden","pending elsewhere","parent split"])("does not consume %s",async state=>{
    vi.stubEnv("NODE_ENV", "development");vi.stubEnv("NEXT_PUBLIC_ALOOK_NOTIFICATION_DIAGNOSTICS", "208")
    vi.spyOn(console,"info").mockImplementation(()=>undefined)
    if(state==="hidden") vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden")
    if(state==="pending elsewhere") setRoute("/c/channels/server_1/channel_1",true)
    if(state==="parent split") setRoute("/c/channels/server_1/channel_2")
    const rendered=renderHook(()=>useCurrent(state!=="not ready"),{wrapper})
    expect(presentation({viewerUserId:"viewer",targetId:"channel_1"})).toBe(false)
    expect(hookMocks.dismissConversation).not.toHaveBeenCalled();rendered.unmount()
  })
  it("consumes a ready mobile DM with the same single signal listener",async()=>{
    hookMocks.desktop=false;hookMocks.mobile=true;setRoute("/c/me/dm_1")
    let wake!:()=>void;hookMocks.mobileListen.mockImplementation(async cb=>{wake=cb;return()=>undefined})
    const rendered=renderHook(()=>{useNotifications();useNativeSystemNotificationConversationDismissal("viewer",{kind:"dm",channelId:"dm_1"},true)},{wrapper})
    await waitFor(()=>expect(hookMocks.mobileDismissConversation).toHaveBeenCalledExactlyOnceWith("viewer","dm_1"))
    await waitFor(()=>expect(window.localStorage.length).toBe(0))
    act(()=>wake());await waitFor(()=>expect(hookMocks.mobileDismissConversation).toHaveBeenCalledTimes(2))
    expect(hookMocks.mobileListen).toHaveBeenCalledOnce();rendered.unmount()
  })
  it("retries Native registration at one second and cancels later retry IO on retirement", async () => {
    vi.useFakeTimers()
    hookMocks.desktop = false
    hookMocks.mobile = true
    const stop = vi.fn()
    hookMocks.mobileListen.mockResolvedValue(stop)
    hookMocks.mobileCheck.mockRejectedValue(new Error("offline"))
    hookMocks.mobileTake.mockResolvedValue(null)
    const owner = await createCommunityQueryOwner("viewer_1")
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: "viewer_1", retainOwner: true }, children)
    const rendered = renderOwnedHook(() => useNativeSystemNotifications("viewer_1", route.frame, route.navigation, consumer), { wrapper })
    const key = ["community", "native-notifications", "viewer_1", "mobile", "permission"]
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(hookMocks.mobileCheck).toHaveBeenCalledOnce()
    expect(owner.client.getQueryState(key)).toMatchObject({ fetchStatus: "fetching", fetchFailureCount: 1 })
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(hookMocks.mobileCheck).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(hookMocks.mobileCheck).toHaveBeenCalledTimes(2)
    expect(owner.client.getQueryState(key)).toMatchObject({ fetchStatus: "fetching", fetchFailureCount: 2 })
    rendered.unmount()
    expect(owner.client.getQueryState(key)?.fetchStatus).toBe("idle")
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(hookMocks.mobileCheck).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledOnce()
  })

})
