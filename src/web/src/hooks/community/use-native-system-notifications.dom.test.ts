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
  peek: vi.fn(),
  ack: vi.fn(async () => undefined),
  clearViewer: vi.fn(async () => undefined),
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
  mobilePeek: vi.fn(),
  mobileAckActivation: vi.fn(async () => undefined),
  mobileClearViewer: vi.fn(async () => undefined),
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
    peekDesktopSystemNotificationActivation: hookMocks.peek,
    ackDesktopSystemNotificationActivation: hookMocks.ack,
    clearDesktopSystemNotificationsForViewer: hookMocks.clearViewer,
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
    peekMobileSystemNotificationActivation: hookMocks.mobilePeek,
    ackMobileSystemNotificationActivation: hookMocks.mobileAckActivation,
    clearMobileSystemNotificationsForViewer: hookMocks.mobileClearViewer,
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
  viewerUserId: "viewer",
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
function useNotifications() { return useNativeSystemNotifications("viewer", route.frame, route.navigation, consumer) }
function presentation(identity:unknown) {
  return (window as Window & {alookNativeNotificationPresentationV1?:(value:unknown)=>boolean}).alookNativeNotificationPresentationV1?.(identity)
}
beforeEach(()=>{
  vi.resetAllMocks()
  hookMocks.desktop=true;hookMocks.mobile=false;consumer.current=null;intentRevision=0
  setRoute("/c/channels/server_1/channel_1")
  hookMocks.listen.mockResolvedValue(vi.fn());hookMocks.peek.mockResolvedValue(null)
  hookMocks.ack.mockResolvedValue(undefined);hookMocks.clearViewer.mockResolvedValue(undefined)
  hookMocks.dismiss.mockResolvedValue(undefined);hookMocks.dismissConversation.mockResolvedValue(undefined)
  hookMocks.mobileListen.mockResolvedValue(vi.fn());hookMocks.mobilePeek.mockResolvedValue(null)
  hookMocks.mobileAckActivation.mockResolvedValue(undefined);hookMocks.mobileClearViewer.mockResolvedValue(undefined)
  hookMocks.mobileCheck.mockResolvedValue("denied");hookMocks.mobileDismiss.mockResolvedValue(undefined)
  hookMocks.mobileDismissConversation.mockResolvedValue(undefined)
  vi.spyOn(document,"visibilityState","get").mockReturnValue("visible")
})
afterEach(()=>{window.localStorage.clear();window.sessionStorage.clear();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs()})
describe("notification activation",()=>{
  it.each(["web", "desktop", "mobile"] as const)("pauses cached %s effects until this document confirms the account", async platform => {
    hookMocks.desktop = platform === "desktop"
    hookMocks.mobile = platform === "mobile"
    const owner = await createCommunityQueryOwner()
    let viewer: string | undefined
    owner.registry.bindAuthentication(() => viewer, async () => {})
    const wrapped = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider,
      { client: owner.client, registry: owner.registry, retainOwner: true }, createElement(wrapper, null, children))
    const rendered = renderOwnedHook(() => {
      useNotifications()
      useNativeSystemNotificationConversationDismissal("viewer", target, true)
    }, { wrapper: wrapped })
    expect(presentation({ viewerUserId: "viewer", targetId: "channel_1" })).toBeUndefined()
    for (const call of [hookMocks.listen, hookMocks.peek, hookMocks.mobileListen, hookMocks.mobileCheck, hookMocks.mobilePeek, hookMocks.dismissConversation, hookMocks.mobileDismissConversation]) expect(call).not.toHaveBeenCalled()
    act(() => { viewer = "viewer"; owner.registry.confirmAuthentication() })
    await waitFor(() => expect(presentation({ viewerUserId: "viewer", targetId: "channel_1" })).toBe(platform !== "web"))
    if (platform === "desktop") await waitFor(() => expect(hookMocks.peek).toHaveBeenCalledOnce())
    if (platform === "mobile") await waitFor(() => expect(hookMocks.mobilePeek).toHaveBeenCalledOnce())
    rendered.unmount()
  })
  it("retains the same confirmed native owner during a later network failure", async () => {
    const owner = await createCommunityQueryOwner()
    let viewer: string | undefined = "viewer"
    owner.registry.bindAuthentication(() => viewer, async () => {})
    owner.registry.confirmAuthentication()
    let wake!: () => void
    hookMocks.listen.mockImplementation(async callback => { wake = callback; return () => undefined })
    const wrapped = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider,
      { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const rendered = renderOwnedHook(useNotifications, { wrapper: wrapped })
    await waitFor(() => expect(hookMocks.peek).toHaveBeenCalledOnce())
    act(() => { viewer = undefined; wake() })
    await waitFor(() => expect(hookMocks.peek).toHaveBeenCalledTimes(2))
    expect(hookMocks.listen).toHaveBeenCalledOnce()
    rendered.unmount()
  })
  it.each([null, "other"])("rejects delayed native activation after the SDK reports %s", async nextViewer => {
    const owner = await createCommunityQueryOwner()
    let viewer: string | null = "viewer"
    owner.registry.bindAuthentication(() => viewer, async () => {})
    owner.registry.confirmAuthentication()
    let release!: (value: DesktopSystemNotificationActivation) => void
    hookMocks.peek.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const wrapped = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider,
      { client: owner.client, registry: owner.registry, retainOwner: true }, children)
    const rendered = renderOwnedHook(useNotifications, { wrapper: wrapped })
    await waitFor(() => expect(hookMocks.peek).toHaveBeenCalledOnce())
    await act(async () => { viewer = nextViewer; release(activation) })
    expect(route.navigation.pushImmediate).not.toHaveBeenCalled()
    expect(window.sessionStorage.length).toBe(0)
    expect(hookMocks.dismiss).not.toHaveBeenCalled()
    expect(hookMocks.ack).not.toHaveBeenCalled()
    expect(presentation({ viewerUserId: "viewer", targetId: "channel_1" })).toBe(false)
    rendered.unmount()
  })
  it("queues and navigates immediately without starting a HTTP precheck and acknowledges after navigation",async()=>{
    const fetch=vi.fn(()=>new Promise<Response>(()=>undefined));vi.stubGlobal("fetch",fetch)
    const calls:string[]=[]
    const controller=createDesktopSystemNotificationActivationController({
      listen:async()=>()=>undefined,peek:async()=>activation,
      ack:async(id)=>{calls.push(`ack:${id}`)},
      expectedViewerUserId:"viewer",
      queueDismiss:()=>calls.push("queue"),navigate:(href)=>calls.push(href),
    })
    await controller.connect()
    expect(calls).toEqual(["queue","/c/channels/server_1/channel_1",`ack:${activation.notificationId}`])
    expect(fetch).not.toHaveBeenCalled()
    controller.dispose()
  })
  it("discards and acknowledges cross-account desktop activations without navigating", async () => {
    setRoute("/c/me/friends")
    hookMocks.peek
      .mockResolvedValueOnce({ ...activation, viewerUserId: "other_viewer" })
      .mockResolvedValueOnce(null)
    const rendered = renderHook(useNotifications, { wrapper })
    await waitFor(() => expect(hookMocks.ack).toHaveBeenCalledExactlyOnceWith(activation.notificationId))
    expect(route.navigation.pushImmediate).not.toHaveBeenCalled()
    expect(hookMocks.dismiss).not.toHaveBeenCalled()
    rendered.unmount()
  })
  it("coalesces signals and retires a delayed peek",async()=>{
    let wake!:()=>void;let release!:(value:DesktopSystemNotificationActivation|null)=>void
    const pending=new Promise<DesktopSystemNotificationActivation|null>(resolve=>{release=resolve})
    const peek=vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(null)
    const navigate=vi.fn()
    const controller=createDesktopSystemNotificationActivationController({listen:async cb=>{wake=cb;return()=>undefined},peek,queueDismiss:vi.fn(),navigate})
    const connection=controller.connect();await waitFor(()=>expect(peek).toHaveBeenCalledOnce())
    wake();release(activation);await connection
    expect(peek).toHaveBeenCalledTimes(2);expect(navigate).toHaveBeenCalledOnce()
    controller.dispose();wake();expect(peek).toHaveBeenCalledTimes(2)
  })
  it("uses the actual route commit to consume the clicked ID",async()=>{
    setRoute("/c/me/friends")
    hookMocks.peek.mockResolvedValueOnce(activation).mockResolvedValueOnce(null)
    const rendered=renderHook(useNotifications,{wrapper})
    await waitFor(()=>expect(route.navigation.pushImmediate).toHaveBeenCalledWith("/c/channels/server_1/channel_1"))
    await waitFor(()=>expect(hookMocks.ack).toHaveBeenCalledExactlyOnceWith(activation.notificationId))
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
    const clicked = { notificationId: activation.notificationId, messageId: "message_1", targetId: "channel_1", viewerUserId: "viewer" }
    hookMocks.mobilePeek.mockResolvedValueOnce(clicked).mockResolvedValueOnce(null)
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
    await waitFor(() => expect(hookMocks.mobileAckActivation).toHaveBeenCalledExactlyOnceWith(clicked.notificationId))
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
    const clicked = { notificationId: activation.notificationId, messageId: "message_1", targetId: "channel_1", viewerUserId: "viewer" }
    let release!: (value: typeof clicked) => void
    hookMocks.mobilePeek.mockReturnValueOnce(new Promise<typeof clicked>(resolve => { release = resolve }))
    const rendered = renderHook(useNotifications, { wrapper })
    await waitFor(() => expect(hookMocks.mobilePeek).toHaveBeenCalledOnce())
    rendered.unmount()
    await act(async () => { release(clicked) })
    expect(route.navigation.pushImmediate).not.toHaveBeenCalled()
    expect(window.sessionStorage.length).toBe(0)
    expect(hookMocks.mobileDismiss).not.toHaveBeenCalled()
    expect(hookMocks.mobileAckActivation).not.toHaveBeenCalled()
  })
  it.each(["dm", "channel"] as const)("navigates a cached mobile %s directly and clears only after route commit", async kind => {
    hookMocks.desktop = false
    hookMocks.mobile = true
    setRoute("/c/me/friends")
    const owner = await createCommunityQueryOwner()
    await seedConversationEntry(owner.client, kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture())
    const clicked = { notificationId: activation.notificationId, messageId: "m1", targetId: "c1", viewerUserId: "viewer" }
    hookMocks.mobilePeek.mockResolvedValueOnce(clicked).mockResolvedValueOnce(null)
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
    const clicked = { notificationId: activation.notificationId, messageId: "m1", targetId: "c1", viewerUserId: "viewer" }
    hookMocks.mobilePeek.mockResolvedValueOnce(clicked).mockResolvedValueOnce(null)
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
  it.each(["desktop", "mobile", "web"])("can dismiss a confirmed Inbox conversation from %s without navigating", async platform => {
    hookMocks.desktop = platform === "desktop"
    hookMocks.mobile = platform === "mobile"
    setRoute("/c/me")
    const rendered = renderHook(() => useNotifications(), { wrapper })
    act(() => {
      rendered.result.current("another_viewer", target)
      rendered.result.current("viewer", target)
    })
    if (platform === "desktop") await waitFor(() => expect(hookMocks.dismissConversation).toHaveBeenCalledExactlyOnceWith("viewer", target))
    else expect(hookMocks.dismissConversation).not.toHaveBeenCalled()
    if (platform === "mobile") await waitFor(() => expect(hookMocks.mobileDismissConversation).toHaveBeenCalledExactlyOnceWith("viewer", target.channelId))
    else expect(hookMocks.mobileDismissConversation).not.toHaveBeenCalled()
    await waitFor(() => expect(window.localStorage.length).toBe(0))
    expect(route.navigation.pushImmediate).not.toHaveBeenCalled()
    rendered.unmount()
  })
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
      peek: hookMocks.peek.mock.calls.length,
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
    hookMocks.mobilePeek.mockResolvedValue(null)
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

  it("retries transient mobile signal listener failures with backoff and cleans up on unmount", async () => {
    vi.useFakeTimers()
    hookMocks.desktop = false
    hookMocks.mobile = true
    const stop = vi.fn()
    hookMocks.mobileListen
      .mockRejectedValueOnce(new Error("bridge_not_ready"))
      .mockResolvedValueOnce(stop)
    hookMocks.mobileCheck.mockResolvedValue("denied")
    hookMocks.mobilePeek.mockResolvedValue(null)
    const owner = await createCommunityQueryOwner("viewer_1")
    const wrapped = ({ children }: PropsWithChildren) => createElement(
      CommunityTestProvider,
      { client: owner.client, registry: owner.registry, userId: "viewer_1", retainOwner: true },
      children,
    )
    const rendered = renderOwnedHook(
      () => useNativeSystemNotifications("viewer_1", route.frame, route.navigation, consumer),
      { wrapper: wrapped },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(hookMocks.mobileListen).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(hookMocks.mobileListen).toHaveBeenCalledTimes(2)
    rendered.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("dismisses and suppresses an embedded split parent surface alongside a child thread", async () => {
    setRoute("/c/channels/server_1/thread_1")
    const parentTarget = { kind: "server" as const, serverId: "server_1", channelId: "parent_1" }
    const threadTarget = { kind: "server" as const, serverId: "server_1", channelId: "thread_1" }
    const rendered = renderHook(() => {
      useNotifications()
      useNativeSystemNotificationConversationDismissal("viewer", threadTarget, true)
      useNativeSystemNotificationConversationDismissal("viewer", parentTarget, true, { embedded: true })
    }, { wrapper })

    await waitFor(() => expect(hookMocks.dismissConversation).toHaveBeenCalledWith("viewer", threadTarget))
    await waitFor(() => expect(hookMocks.dismissConversation).toHaveBeenCalledWith("viewer", parentTarget))
    expect(presentation({ viewerUserId: "viewer", targetId: "thread_1" })).toBe(true)
    expect(presentation({ viewerUserId: "viewer", targetId: "parent_1" })).toBe(true)
    rendered.unmount()
  })

})
