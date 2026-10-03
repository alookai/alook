import { createCommunityQueryOwner, seedCommunityMessageWindow } from "@/test/community-query-owner"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestMessages } from "@/lib/community-db/sync"
import { getCommunityRuntime } from "@/stores/community/runtime"
import type { CanonicalMessage, MessageScope } from "@/lib/community/message-stream"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useDmMessages, useMessages } from "./use-messages"
import { getMessageOverlay } from "@/stores/community/message-stream"

function dispatchLive(client: QueryClient, scope: MessageScope, event: { type: "wsMessage"; message: CanonicalMessage }) {
  const registry = getCommunityDbRegistry(client)
  if (!registry) throw new Error("Missing original message fixture owner")
  ingestMessages(registry, scope.id, [event.message])
  registry.runtime.messageStream.actions.dispatch(scope, event)
}

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()

})

function wrapperFor(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

async function renderChannelMessages(
  lastReadMessageId: string | null | undefined,
  seedTail?: { id: string; seq: number }[],
  originalClient?: QueryClient,
) {
  const queryClient = originalClient ?? (await createCommunityQueryOwner()).client
  if (seedTail) {
    seedCommunityMessageWindow(queryClient, communityKeys.channelMessages("ch_new"), {
      pages: [{
        messages: seedTail,
        hasMore: false,
        latestSeq: seedTail.at(-1)?.seq ?? 0,
      }],
      pageParams: [{ mode: "newest" }],
    })
  }
  let rendered!: ReturnType<typeof renderHook<ReturnType<typeof useMessages>, unknown>>
  await act(async () => { rendered = renderHook(
    () => useMessages("ch_new", { serverId: "s1", lastReadMessageId }),
    { wrapper: wrapperFor(queryClient) },
  ) })
  return rendered
}

async function renderDmMessages(seedTail: { id: string; seq: number }[], originalClient?: QueryClient) {
  const queryClient = originalClient ?? (await createCommunityQueryOwner()).client
  seedCommunityMessageWindow(queryClient, communityKeys.dmMessages("dm_new"), {
    pages: [{
      messages: seedTail,
      hasMore: false,
      latestSeq: seedTail.at(-1)?.seq ?? 0,
    }],
    pageParams: [{ mode: "newest" }],
  })
  let rendered!: ReturnType<typeof renderHook<ReturnType<typeof useDmMessages>, unknown>>
  await act(async () => { rendered = renderHook(
    () => useDmMessages("dm_new", { lastReadMessageId: undefined }),
    { wrapper: wrapperFor(queryClient) },
  ) })
  return rendered
}

describe("useMessages — isLoading while the anchor snapshot is unresolved", () => {
  it("reports isLoading: true even though the underlying query is disabled", async () => {
    const rendered = await renderChannelMessages(undefined)

    expect(rendered.result.current.isLoading).toBe(true)
    expect(rendered.result.current.messages).toEqual([])
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("reports isLoading: true while the now-enabled query's first fetch is in flight", async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const rendered = await renderChannelMessages(null)

    expect(rendered.result.current.isLoading).toBe(true)
  })
})

describe("useMessages — instant channel switch", () => {
  it("paints a warm cache without waiting on the anchor", async () => {
    const rendered = await renderChannelMessages(undefined, [
      { id: "m_1", seq: 1 },
      { id: "m_2", seq: 2 },
    ])

    expect(rendered.result.current.isLoading).toBe(false)
    expect(rendered.result.current.messages).toHaveLength(2)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("keeps the skeleton on a cold cache with the anchor unresolved", async () => {
    const rendered = await renderChannelMessages(undefined)

    expect(rendered.result.current.isLoading).toBe(true)
    expect(rendered.result.current.messages).toEqual([])
  })

  it("keeps latestSeq owned by the base snapshot when the overlay has a higher seq", async () => {
    const { client: queryClient } = await createCommunityQueryOwner()
    dispatchLive(queryClient,
      { kind: "channel", id: "ch_new", serverId: "s1" },
      {
        type: "wsMessage",
        message: {
          id: "m_live",
          seq: 99,
          type: "chat",
          authorId: "u1",
          authorName: "Alice",
          content: "live",
          createdAt: "2026-08-06T00:00:00.000Z",
        },
      },
    )
    const rendered = await renderChannelMessages(undefined, [{ id: "m_base", seq: 5 }], queryClient)

    expect(rendered.result.current.messages).toHaveLength(2)
    expect(rendered.result.current.latestSeq).toBe(5)
  })

  it("keeps the real server scope through baseChanged so removeServer clears it", async () => {
    const messageScope = { kind: "channel" as const, id: "ch_new", serverId: "s1" }
    const { client: queryClient } = await createCommunityQueryOwner()
    dispatchLive(queryClient, messageScope, {
      type: "wsMessage",
      message: {
        id: "m_live",
        seq: 9,
        type: "chat",
        authorId: "u1",
        authorName: "Alice",
        content: "live",
        createdAt: "2026-08-06T00:00:00.000Z",
      },
    })

    await renderChannelMessages(undefined, [{ id: "m_base", seq: 5 }], queryClient)
    expect([...getCommunityRuntime(queryClient).messageStream.get().entries.values()][0]?.scope.serverId).toBe("s1")

    act(() => getCommunityRuntime(queryClient).messageStream.actions.removeServer("s1"))
    expect(getCommunityRuntime(queryClient).messageStream.get().entries.size).toBe(0)
    expect(getMessageOverlay(queryClient, messageScope).liveById.size).toBe(0)
  })
})

describe("useDmMessages — base plus overlay", () => {
  it("materializes a higher live fallback while latestSeq remains base-owned", async () => {
    const { client: queryClient } = await createCommunityQueryOwner()
    dispatchLive(queryClient,
      { kind: "dm", id: "dm_new" },
      {
        type: "wsMessage",
        message: {
          id: "m_live",
          seq: 99,
          type: "chat",
          authorId: "u1",
          authorName: "Alice",
          content: "live",
          createdAt: "2026-08-06T00:00:00.000Z",
        },
      },
    )
    const rendered = await renderDmMessages([{ id: "m_base", seq: 5 }], queryClient)

    expect(rendered.result.current.messages).toHaveLength(2)
    expect(rendered.result.current.latestSeq).toBe(5)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
