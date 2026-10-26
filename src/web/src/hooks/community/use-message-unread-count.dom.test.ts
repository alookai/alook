import { createElement, type PropsWithChildren } from "react"
import { expect, it } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { ingestMessages, publishCommunityConversationReadState, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { confirmReadSurface, registerReadSurface, releaseReadSurface, submitReadIntent } from "./read-coordinator"
import { useMessageUnreadCount } from "./use-message-unread-count"

it("projects admitted local progress without changing the frozen entry boundary or confirming the read", async () => {
  const owner = await createCommunityQueryOwner()
  const messages = [2, 5, 9].map(seq => ({ id: `m${seq}`, channelId: "c1", seq, authorId: "peer", type: "chat" as const, content: "Message", createdAt: `2026-10-27T00:00:0${seq}.000Z` }))
  ingestMessages(owner.registry, "c1", messages)
  const entry = Object.freeze({ lastReadSeq: 2 })
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const rendered = renderHook(() => useMessageUnreadCount({ channelId: "c1", viewerUserId: "viewer", messages, entryReadSeq: entry.lastReadSeq, latestSeq: 9, historyStartKnown: false, hasMoreNewer: false, ready: true }), { wrapper })
  await waitFor(() => expect(rendered.result.current).toBe(2))
  const lease = registerReadSurface(owner.client, "viewer", { kind: "timeline", channelId: "c1" }, 2)
  act(() => { expect(submitReadIntent(lease, { kind: "timeline", channelId: "c1", messageId: "m5", seq: 5 })).toBe(true) })
  await waitFor(() => expect(rendered.result.current).toBe(1))
  expect(owner.registry.collections.readStates.get("c1")).toBeUndefined()
  expect(entry.lastReadSeq).toBe(2)
  await act(async () => { publishCommunityConversationReadState(owner.client, { channelId: "c1", lastReadMessageId: "m9", lastReadAt: messages[2]!.createdAt, lastReadSeq: 9 }, 1, { token: captureCommunityLiveSnapshotToken(owner.client) }) })
  await waitFor(() => expect(rendered.result.current).toBe(0))
  confirmReadSurface(lease, 9)
  releaseReadSurface(lease)
  rendered.unmount()
})
