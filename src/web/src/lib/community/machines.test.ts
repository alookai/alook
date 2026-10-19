import { describe, expect, it } from "vitest"
import { CancelledError } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { captureMachinesPublication, publishMachines } from "./machines"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import type { MachinesResponse } from "@/hooks/community/use-machines"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

const machine = {
  id: "m1", hostname: "host", displayName: "Machine", platform: "darwin", arch: "arm64",
  osRelease: "24", daemonVersion: "0.1", status: "offline" as const, lastSeenAt: null,
  availableRuntimes: [], createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z",
}

describe("machine native Query publication", () => {
  it("cancels an already decoded late API result before applying WS data", async () => {
    const { client } = await createCommunityQueryOwner()
    const key = communityKeys.machines()
    client.setQueryData<MachinesResponse>(key, { machines: [machine] })
    const decoded = deferred<MachinesResponse>()
    let signal!: AbortSignal
    const request = client.query({ queryKey: key, staleTime: 0, queryFn: async (context) => {
      signal = context.signal
      return decoded.promise
    } }).catch((error: unknown) => error)
    const original = captureMachinesPublication(client)
    decoded.resolve({ machines: [{ ...machine, displayName: "Old decoded API" }] })
    await publishMachines(client, original, (current) => ({
      ...current, machines: [{ ...machine, status: "online", displayName: "WS" }],
    }))
    expect((await request) instanceof CancelledError).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(client.getQueryData<MachinesResponse>(key)?.machines[0]).toMatchObject({ status: "online", displayName: "WS" })
  })

  it("preserves consecutive publication order and permits a later full quota read", async () => {
    const { client } = await createCommunityQueryOwner()
    const key = communityKeys.machines()
    client.setQueryData<MachinesResponse>(key, { machines: [machine] })
    const decoded = deferred<MachinesResponse>()
    const old = client.query({ queryKey: key, staleTime: 0, queryFn: () => decoded.promise }).catch((error: unknown) => error)
    const first = publishMachines(client, captureMachinesPublication(client), (current) => ({ ...current, machines: [{ ...machine, displayName: "First" }] }))
    await Promise.resolve()
    await Promise.resolve()
    const second = publishMachines(client, captureMachinesPublication(client), (current) => ({ ...current, machines: current!.machines.map((row) => ({ ...row, displayName: row.displayName + " Second" })) }))
    await Promise.all([first, second])
    expect(client.getQueryData<MachinesResponse>(key)?.machines[0].displayName).toBe("First Second")
    decoded.resolve({ machines: [machine] })
    expect((await old) instanceof CancelledError).toBe(true)
    const complete: MachinesResponse = {
      machines: [{ ...machine, displayName: "First Second", quota: [{ scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "codex" }, capability: "supported", runtimeState: "healthy", snapshot: { status: "pending" } }] }],
      machineCapacity: { plan: { id: "house", displayName: "House" }, isFounder: true, limit: 10, ownedCount: 1, onlineCount: 0 },
    }
    await client.query({ queryKey: key, staleTime: 0, queryFn: async () => complete })
    expect(client.getQueryData(key)).toEqual(complete)
  })

  it("does not publish into a replacement Query with the same key", async () => {
    const { client } = await createCommunityQueryOwner()
    const key = communityKeys.machines()
    client.setQueryData(key, { machines: [machine] })
    const original = captureMachinesPublication(client)
    const write = publishMachines(client, original, () => ({ machines: [] }))
    client.removeQueries({ queryKey: key, exact: true })
    const replacement = { machines: [{ ...machine, id: "replacement" }] }
    client.setQueryData(key, replacement)
    expect(await write).toBe(false)
    expect(client.getQueryData(key)).toEqual(replacement)
  })

  it("rejects publication after the original account retires", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const original = captureMachinesPublication(client)
    const write = publishMachines(client, original, () => ({ machines: [machine] }))
    retireCommunityAccount(registry)
    await expect(write).rejects.toMatchObject({ name: "AbortError" })
    expect(client.getQueryData(communityKeys.machines())).toBeUndefined()
  })
})
