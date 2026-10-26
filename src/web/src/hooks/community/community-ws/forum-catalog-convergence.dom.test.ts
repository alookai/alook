import { afterEach, expect, it, vi } from "vitest"
import { QueryObserver } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { runCommunityWsProjectionTransaction } from "./projection-transaction"
import { handleChildChannelUpdate } from "./structure-tree-events"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
async function setup(pending = false, tags = ["archived"]) {
  const owner = await createCommunityQueryOwner("catalog-convergence")
  const key = communityKeys.forumTags("forum_1")
  owner.runtime.ui.actions.subscribe({ channelId: "forum_1" })
  let resolve!: (value: { tags: string[] }) => void
  const held = new Promise<{ tags: string[] }>(done => { resolve = done })
  const read = vi.fn(async () => ({ tags }))
  if (pending) read.mockImplementationOnce(() => held)
  else owner.client.setQueryData(key, { tags: [] })
  const observer = new QueryObserver(owner.client, { queryKey: key, queryFn: read, staleTime: Infinity })
  cleanups.push(observer.subscribe(() => {}))
  return { ...owner, key, resolve, read }
}
it("refreshes a warm empty catalog on a live archive", async () => {
  const owner = await setup()
  runCommunityWsProjectionTransaction(owner.client, projection => handleChildChannelUpdate({ type: "community:channel.child_update", parentChannelId: "forum_1", channelId: "post_1", changes: { tags: ["archived"] } }, { queryClient: owner.client, projection } as Parameters<typeof handleChildChannelUpdate>[1]))
  await vi.waitFor(() => expect(owner.client.getQueryData(owner.key)).toEqual({ tags: ["archived"] }))
})
it.each([
  { name: "archive", before: [], after: ["archived"] },
  { name: "unarchive", before: ["archived"], after: [] },
])("refreshes a pending initial catalog on live $name", async ({ before, after }) => {
  const owner = await setup(true, after)
  runCommunityWsProjectionTransaction(owner.client, projection => handleChildChannelUpdate({ type: "community:channel.child_update", parentChannelId: "forum_1", channelId: "post_1", changes: { tags: after } }, { queryClient: owner.client, projection } as Parameters<typeof handleChildChannelUpdate>[1]))
  owner.resolve({ tags: before })
  await vi.waitFor(() => expect(owner.client.getQueryData(owner.key)).toEqual({ tags: after }))
  expect(owner.read).toHaveBeenCalledTimes(2)
})
it("does not restart a removed catalog after a live archive", async () => {
  const owner = await setup(true)
  runCommunityWsProjectionTransaction(owner.client, projection => handleChildChannelUpdate({ type: "community:channel.child_update", parentChannelId: "forum_1", channelId: "post_1", changes: { tags: ["archived"] } }, { queryClient: owner.client, projection } as Parameters<typeof handleChildChannelUpdate>[1]))
  owner.client.removeQueries({ queryKey: owner.key, exact: true })
  owner.resolve({ tags: [] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(owner.read).toHaveBeenCalledTimes(1)
  expect(owner.client.getQueryState(owner.key)).toBeUndefined()
})
