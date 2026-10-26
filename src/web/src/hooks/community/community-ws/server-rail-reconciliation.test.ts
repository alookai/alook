import { afterEach, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { serverRailMutationKey } from "@/lib/community-db/server-rail"
import { dispatchCommunityWsEvent, communityWsReconnectPolicies } from "./registry"
import { reconcileCommunityWsReconnect } from "./reconnect"
import { reconcileCommunityServerRail } from "./server-rail-reconciliation"

const subscriptions: Array<() => void> = []
afterEach(() => subscriptions.splice(0).forEach((unsubscribe) => unsubscribe()))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function observe(client: QueryClient, key: readonly unknown[], queryFn = vi.fn(async () => ["fresh"])) {
  const observer = new QueryObserver(client, { queryKey: key, queryFn, initialData: ["old"], staleTime: Infinity })
  subscriptions.push(observer.subscribe(() => {}))
  return { observer, queryFn }
}

it("refreshes only the account rail and reference directory, keeping inactive queries stale", async () => {
  const { client, runtime } = await createCommunityQueryOwner()
  const { client: other } = await createCommunityQueryOwner("other")
  const servers = observe(client, communityKeys.servers())
  const folders = observe(client, communityKeys.folders())
  const detail = observe(client, communityKeys.server("unrelated"))
  const foreign = observe(other, communityKeys.folders())
  client.setQueryData(communityKeys.channelRefDirectory(), ["old"])
  await dispatchCommunityWsEvent({ type: "community:server_rail.changed" }, {
    queryClient: client, communityStore: runtime.ui, wsStore: runtime.ws, sub: {}, deliveryMode: "single",
    viewerUserIdRef: { current: "viewer" }, matchesFocus: () => false,
  })
  expect(servers.queryFn).toHaveBeenCalledTimes(1)
  expect(folders.queryFn).toHaveBeenCalledTimes(1)
  expect(detail.queryFn).not.toHaveBeenCalled()
  expect(foreign.queryFn).not.toHaveBeenCalled()
  expect(client.getQueryState(communityKeys.channelRefDirectory())?.isInvalidated).toBe(true)
})

it("cancels a pre-event GET so its late response cannot restore the old order", async () => {
  const { client } = await createCommunityQueryOwner()
  const old = deferred<string[]>()
  let signal: AbortSignal | undefined
  const queryFn = vi.fn().mockImplementationOnce((context) => { signal = context.signal; return old.promise }).mockResolvedValue(["new-order"])
  const { observer } = observe(client, communityKeys.folders(), queryFn)
  const pending = observer.refetch()
  await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
  await reconcileCommunityServerRail(client)
  expect(signal?.aborted).toBe(true)
  old.resolve(["obsolete"])
  await pending
  expect(client.getQueryData(communityKeys.folders())).toEqual(["new-order"])
})

it("waits for native save confirmation and coalesces simultaneous hints", async () => {
  const { client } = await createCommunityQueryOwner()
  const folders = observe(client, communityKeys.folders())
  const commit = deferred<void>()
  const mutation = client.getMutationCache().build(client, { mutationKey: serverRailMutationKey, mutationFn: () => commit.promise })
  const saving = mutation.execute(undefined)
  await vi.waitFor(() => expect(client.isMutating()).toBe(1))
  const hints = Promise.all([reconcileCommunityServerRail(client), reconcileCommunityServerRail(client)])
  await Promise.resolve()
  expect(folders.queryFn).not.toHaveBeenCalled()
  commit.resolve()
  await saving
  await hints
  expect(folders.queryFn).toHaveBeenCalledTimes(1)
  expect(client.getQueryData(communityKeys.folders())).toEqual(["fresh"])
})

it.each(["retired", "new-generation"])("ignores a %s account after its pending save completes", async (change) => {
  const { client, registry } = await createCommunityQueryOwner()
  const folders = observe(client, communityKeys.folders())
  const commit = deferred<void>()
  const mutation = client.getMutationCache().build(client, { mutationKey: serverRailMutationKey, mutationFn: () => commit.promise })
  const saving = mutation.execute(undefined)
  await vi.waitFor(() => expect(client.isMutating()).toBe(1))
  const refresh = reconcileCommunityServerRail(client)
  if (change === "retired") await registry.cleanup()
  else registry.runtime.lifecycle.setState((state) => ({ ...state, generation: state.generation + 1 }))
  commit.resolve()
  await saving
  await refresh
  expect(folders.queryFn).not.toHaveBeenCalled()
})

it("does not refresh a replacement query registered during cancellation", async () => {
  const { client } = await createCommunityQueryOwner()
  observe(client, communityKeys.folders())
  const cancel = client.cancelQueries.bind(client)
  const replacement = vi.fn(async () => ["replacement"])
  vi.spyOn(client, "cancelQueries").mockImplementationOnce(async (filters) => {
    await cancel(filters)
    client.removeQueries({ queryKey: communityKeys.folders(), exact: true })
    observe(client, communityKeys.folders(), replacement)
  })
  await reconcileCommunityServerRail(client)
  expect(replacement).not.toHaveBeenCalled()
})

it("requires a live native account registry", async () => {
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, "invalidateQueries")
  await reconcileCommunityServerRail(client)
  expect(invalidate).not.toHaveBeenCalled()
  client.clear()
})

it("reconciles missed rail hints on reconnect without unrelated server-detail work", async () => {
  const { client } = await createCommunityQueryOwner()
  const folders = observe(client, communityKeys.folders())
  const detail = observe(client, communityKeys.server("unrelated"))
  const summary = await reconcileCommunityWsReconnect(client, 10, { excludePolicies: communityWsReconnectPolicies.filter((policy) => policy !== "server-rail") })
  expect(summary).toMatchObject({ policyCount: 1, successCount: 1, failureCount: 0 })
  expect(folders.queryFn).toHaveBeenCalledTimes(1)
  expect(detail.queryFn).not.toHaveBeenCalled()
})
