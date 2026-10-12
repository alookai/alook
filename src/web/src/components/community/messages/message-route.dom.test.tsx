import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type PropsWithChildren } from "react"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityRouteContext } from "../shell/community-route-context"
import type { CommunityNavigationController } from "../shell/use-community-navigation-controller"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"
import { MessageRoute } from "./message-route"
const api = vi.hoisted(()=>({read:vi.fn()}))
vi.mock("@/lib/community/account-cache-lifecycle", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/community/account-cache-lifecycle")>(),
  apiFetchCommunity: async (path:string, options:{assertActive?:()=>void}) => {
    options.assertActive?.()
    try { const result=await api.read(path); options.assertActive?.();return result }
    catch(error){options.assertActive?.();throw error}
  },
}))
vi.mock("../shell/community-pending-frame",()=>({CommunityPendingFrame:()=>createElement("div",{role:"status"},"Loading")}))
let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
let revision=0
let href="/c/messages/message_1"
let navigation:CommunityNavigationController
const openInbox=vi.fn()
beforeEach(async()=>{
  owner=await createCommunityQueryOwner("viewer")
  vi.clearAllMocks();api.read.mockReset();revision=0;href="/c/messages/message_1"
  navigation={publishedHref:href,navigationPending:false,pendingHref:null,
    captureIntent:()=>{const original=revision;return()=>original===revision},
    push:vi.fn(),pushImmediate:vi.fn(),replace:vi.fn(()=>{revision++}),resolveAndPush:vi.fn(),cancelPendingNavigation:vi.fn()}
})
const wrapper=({children}:PropsWithChildren)=>createElement(CommunityTestProvider,{client:owner.client,registry:owner.registry,userId:"viewer",retainOwner:true},
  createElement(CommunityRouteContext,{value:{breakpoint:"desktop",ownerDeleteRouteScope:undefined,frame:{...normalizeCommunityHref(href),revision},navigation,openInbox}},children))
describe("ordinary message page",()=>{
  it.each(["dm","text","forum","thread"])("resolves a %s through the permission door then replaces with its bare conversation URL",async type=>{
    api.read.mockResolvedValueOnce({id:"message_1",channelId:"actual_channel"})
      .mockResolvedValueOnce({id:"actual_channel",type,serverId:type==="dm"?null:"actual_server",archived:false})
    render(<MessageRoute messageId="message_1"/>,{wrapper})
    await waitFor(()=>expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(type==="dm"?"/c/me/actual_channel":"/c/channels/actual_server/actual_channel"))
    expect(api.read.mock.calls.map(([path])=>path)).toEqual(["/api/community/messages/message_1","/api/community/channels/actual_channel"])
  })
  it("does not use a cached canonical message as permission proof",async()=>{
    owner.client.setQueryData(communityKeys.message("message_1"),{id:"message_1",channelId:"cached_channel"})
    api.read.mockRejectedValueOnce(new ApiError("Denied",403))
    render(<MessageRoute messageId="message_1"/>,{wrapper})
    await screen.findByRole("alert")
    expect(navigation.replace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button",{name:"Open Inbox"}))
    expect(openInbox).toHaveBeenCalledOnce()
    expect(api.read).toHaveBeenCalledExactlyOnceWith("/api/community/messages/message_1")
  })
  it.each(["archived","denied","wrong channel"])("shows the normal unavailable state for %s metadata",async reason=>{
    api.read.mockResolvedValueOnce({id:"message_1",channelId:"channel_1"}).mockResolvedValueOnce({
      id:reason==="wrong channel"?"other":"channel_1",type:"text",serverId:"server_1",
      archived:reason==="archived",accessDecision:{canRead:reason!=="denied"},
    })
    render(<MessageRoute messageId="message_1"/>,{wrapper})
    expect(await screen.findByRole("alert")).toHaveTextContent("This conversation is unavailable")
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(screen.queryByRole("button",{name:"Retry"})).toBeNull()
  })
  it("does not start a resolver for a retained leaf or a pending checkpoint",()=>{
    href="/c/me/friends";navigation.publishedHref=href;navigation.navigationPending=true
    render(<MessageRoute messageId="message_1"/>,{wrapper})
    expect(api.read).not.toHaveBeenCalled();expect(screen.getByRole("status")).toBeVisible()
  })
  it("retries a failed ordinary network read from the visible Retry action",async()=>{
    api.read.mockRejectedValue(new TypeError("Network unavailable"))
    render(<MessageRoute messageId="message_1"/>,{wrapper})
    expect(await screen.findByRole("alert", {}, {timeout:4000})).toHaveTextContent("Could not open this conversation")
    expect(api.read).toHaveBeenCalledTimes(2)
    expect(navigation.replace).not.toHaveBeenCalled()
    api.read.mockResolvedValueOnce({id:"message_1",channelId:"channel_1"})
      .mockResolvedValueOnce({id:"channel_1",type:"dm",serverId:null,archived:false})
    fireEvent.click(screen.getByRole("button",{name:"Retry"}))
    await waitFor(()=>expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("/c/me/channel_1"))
    expect(api.read.mock.calls.map(([path])=>path)).toEqual([
      "/api/community/messages/message_1", "/api/community/messages/message_1",
      "/api/community/messages/message_1", "/api/community/channels/channel_1",
    ])
  })
  it("ignores a delayed message after a newer navigation before capturing a channel token",async()=>{
    let release!:(value:unknown)=>void
    api.read.mockReturnValueOnce(new Promise(resolve=>{release=resolve}))
    render(<MessageRoute messageId="message_1"/>,{wrapper})
    await waitFor(()=>expect(api.read).toHaveBeenCalledOnce())
    revision++
    await act(async()=>release({id:"message_1",channelId:"channel_1"}))
    expect(api.read).toHaveBeenCalledOnce();expect(navigation.replace).not.toHaveBeenCalled()
  })
  it("ignores delayed channel authorization after the originating account retires",async()=>{
    let release!:(value:unknown)=>void
    api.read.mockResolvedValueOnce({id:"message_1",channelId:"channel_1"})
      .mockReturnValueOnce(new Promise(resolve=>{release=resolve}))
    render(<MessageRoute messageId="message_1"/>,{wrapper})
    await waitFor(()=>expect(api.read).toHaveBeenCalledTimes(2))
    act(()=>owner.registry.runtime.lifecycle.setState(state=>({active:false,generation:state.generation+1})))
    await act(async()=>release({id:"channel_1",type:"text",serverId:"server_1"}))
    expect(navigation.replace).not.toHaveBeenCalled()
  })
})
