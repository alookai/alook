import { afterEach, describe, expect, it, vi } from "vitest"
import { useLayoutEffect, type PropsWithChildren } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import type { MessageWindowData } from "@/lib/community/message-window"
import { currentConversationReadState } from "@/lib/community/conversation-entry"
import { useDmMessages } from "./use-messages"
import { reconcileWindow } from "./community-ws/reconnect-messages"

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function wireOwner() {
  const owner = await createCommunityQueryOwner()
  const base = dmConversationEntryFixture()
  const messages = Array.from({ length: 255 }, (_, index) => ({ ...base.messages[0], id: `m${index + 1}`, seq: index + 1,
    content: `Message ${index + 1}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
  }))
  const read = { ...base.readState, lastReadMessageId: "m240", lastReadSeq: 240, lastReadAt: messages[239].createdAt }
  const entry = { ...base, channel: { ...base.channel, messageCount: 240, lastMessageAt: messages[239].createdAt },
    messages: messages.slice(214, 240), readState: read, readStateRevision: 121,
    selection: { reason: "read_pointer" as const, anchorMessageId: "m240" },
    page: { olderCursor: `${messages[214].createdAt}|m215`, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 240 },
  }
  const requests: Array<{ query: string; version: string | null }> = []
  let catchUp = false
  let legacyPages = false
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
    if (url.pathname !== "/api/community/channels/c1/messages") throw new Error(`Unexpected wire request ${url.pathname}`)
    const version = new Headers(input instanceof Request ? input.headers : options?.headers).get(COMMUNITY_CONTRACT_HEADER)
    requests.push({ query: url.search, version })
    if (url.searchParams.has("entry")) return new Response(JSON.stringify(entry), {
      headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION), "content-type": "application/json" },
    })
    const cursor = url.searchParams.get("cursor")
    const since = url.searchParams.get("since")
    const before = cursor ? Number(cursor.split("|").at(-1)!.slice(1)) : 215
    const selected = cursor ? messages.slice(Math.max(0, before - 51), before - 1)
      : since ? messages.slice(240, catchUp ? 255 : 240) : messages.slice(214, 240)
    const last = selected.at(-1)
    const page = { olderCursor: selected[0] && selected[0].seq > 1 ? `${selected[0].createdAt}|${selected[0].id}` : null,
      newerCursor: catchUp && !since ? `${messages[239].createdAt}|m240` : null,
      hasMoreOlder: !!selected[0] && selected[0].seq > 1, hasMoreNewer: catchUp && !since,
      latestSeq: catchUp ? 255 : last ? Math.max(240, last.seq) : 240,
    }
    const responseVersion = legacyPages ? "2" : version
    return new Response(JSON.stringify({ contractVersion: Number(responseVersion), channelId: "c1",
      profiles: base.profiles, messages: responseVersion === String(BUSINESS_SCHEMA_VERSION) ? selected : selected.map(message => ({ ...message, authorAvatar: "P" })),
      page, surfaceReceipt: base.surfaceReceipt,
    }), { headers: { [COMMUNITY_CONTRACT_HEADER]: responseVersion ?? "", "content-type": "application/json" } })
  }))
  let latest!: ReturnType<typeof useDmMessages>
  function Probe() {
    const feed = useDmMessages("c1", { viewerUserId: "viewer" })
    useLayoutEffect(() => { latest = feed })
    return <div data-testid="projected-rows">{feed.messages.map(message => <span key={message.id}>{message.id}</span>)}</div>
  }
  function Providers({ children }: PropsWithChildren) {
    return <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
  }
  const app = (active = true) => <Providers>{active ? <Probe /> : <div data-testid="away" />}</Providers>
  const view = render(app())
  await waitFor(() => expect(latest.messages).toHaveLength(26))
  const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m240" })
  return { ...owner, view, key, requests, get latest() { return latest }, app,
    enableCatchUp: () => { catchUp = true }, forceLegacyPages: () => { legacyPages = true },
  }
}

describe("complete message windows through the real HTTP decoder", () => {
  it("retains three older pages and admits the same DM on ordinary remount", async () => {
    const h = await wireOwner()
    try {
      for (let page = 1; page <= 3; page++) {
        const request = h.latest.fetchOlder()
        expect(request.accepted).toBe(true)
        if (!request.accepted) throw new Error("Older request rejected")
        await act(async () => { expect((await request.completed).status).toBe("success") })
        await waitFor(() => expect(h.latest.messages).toHaveLength(26 + page * 50))
      }
      const cached = h.client.getQueryData<MessageWindowData>(h.key)!
      expect(cached.pages).toHaveLength(4)
      const complete = [...h.registry.collections.messages.values()].length
      h.view.rerender(h.app(false))
      h.view.rerender(h.app())
      try {
        await waitFor(() => expect(h.latest.initialPositionKnown).toBe(true))
        expect(h.latest.messages).toHaveLength(176)
      } finally {
        console.info("wire-remount", { completeBefore: complete, cachedPages: cached.pages.length,
          finalRows: h.latest.messages.length, initialPositionKnown: h.latest.initialPositionKnown,
          entryCanRead: h.latest.entryCanRead, positionDataState: h.latest.positionDataState, requests: h.requests })
      }
      expect(complete).toBe(176)
      expect(h.client.getQueryData<MessageWindowData>(h.key)?.pages).toHaveLength(4)
      expect(currentConversationReadState(h.client, "c1")?.lastReadSeq).toBe(240)
      expect(h.requests.filter(request => request.query.includes("cursor="))).toHaveLength(3)
      for (const request of h.requests.filter(request => !request.query.includes("entry="))) expect(request.version).toBe(String(BUSINESS_SCHEMA_VERSION))
    } finally { h.view.unmount(); h.client.clear() }
  })

  it("rejects a downgraded page without publishing partial rows or retiring the valid window", async () => {
    const h = await wireOwner()
    try {
      h.forceLegacyPages()
      const request = h.latest.fetchOlder()
      expect(request.accepted).toBe(true)
      if (!request.accepted) throw new Error("Older request rejected")
      await act(async () => { expect((await request.completed).status).toBe("error") })
      expect(h.latest.messages).toHaveLength(26)
      expect(h.client.getQueryData<MessageWindowData>(h.key)?.pages).toHaveLength(1)
      expect(h.registry.collections.messages.get("m165")).toBeUndefined()
      expect(h.registry.collections.messages.get("m240")).toBeDefined()
      expect(currentConversationReadState(h.client, "c1")?.lastReadSeq).toBe(240)
    } finally { h.view.unmount(); h.client.clear() }
  })

  it("keeps reconciled new resources qualified for a later remount without advancing reads", async () => {
    const h = await wireOwner()
    try {
      h.enableCatchUp()
      await act(async () => { await reconcileWindow(h.client, { kind: "dm", scopeId: "c1" }, h.key, 255) })
      await waitFor(() => expect(h.latest.messages).toHaveLength(41))
      h.view.rerender(h.app(false))
      h.view.rerender(h.app())
      await waitFor(() => expect(h.latest.initialPositionKnown).toBe(true))
      expect(h.latest.messages).toHaveLength(41)
      expect(h.registry.collections.messages.get("m255")).toBeDefined()
      expect(currentConversationReadState(h.client, "c1")?.lastReadSeq).toBe(240)
      expect(h.requests.some(request => request.query.includes("since=") && request.version === String(BUSINESS_SCHEMA_VERSION))).toBe(true)
    } finally { h.view.unmount(); h.client.clear() }
  })
})
