import { describe, expect, it, onTestFinished, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createCommunityDbRegistry, getCommunityDbRegistry } from "@/lib/community-db/collections"
import { retireCommunityQueryOwners } from "./community-owner-cleanup"

async function createOwner(accountId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, accountId)
  const retireOriginal = registry.cleanup
  const clearOriginal = client.clear.bind(client)
  onTestFinished(clearOriginal)
  onTestFinished(retireOriginal)
  await registry.preload()
  const key = ["owner-cleanup-witness", accountId]
  client.setQueryData(key, { accountId })
  const mutation = client.getMutationCache().build(client, { mutationKey: key })
  expect(client.getQueryData(key)).toEqual({ accountId })
  expect(client.getMutationCache().getAll()).toContain(mutation)
  return { client, registry, key }
}

function expectRetired(owner: Awaited<ReturnType<typeof createOwner>>) {
  expect(getCommunityDbRegistry(owner.client)).toBeNull()
  expect(owner.registry.runtime.lifecycle.get().active).toBe(false)
  expect(owner.client.getQueryCache().getAll()).toHaveLength(0)
  expect(owner.client.getMutationCache().getAll()).toHaveLength(0)
}

describe("community test owner cleanup", () => {
  it("retires every real owner and cancels its pending retirement timer", async () => {
    const a = await createOwner("normal-a")
    const b = await createOwner("normal-b")
    const owners = new Set([a.registry, b.registry])
    let timerRan = false
    const timers = new Set([setTimeout(() => { timerRan = true }, 0)])

    await retireCommunityQueryOwners(owners, { timers })

    expectRetired(a)
    expectRetired(b)
    expect(owners.size).toBe(0)
    expect(timers.size).toBe(0)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(timerRan).toBe(false)
  })

  it("waits for a registry before clearing its client or retiring the next owner", async () => {
    const a = await createOwner("ordered-a")
    const b = await createOwner("ordered-b")
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const retireOriginal = a.registry.cleanup
    const replacement = vi.spyOn(a.registry, "cleanup").mockImplementation(async () => {
      enter()
      await gate
      await retireOriginal()
    })
    const retiring = retireCommunityQueryOwners(new Set([a.registry, b.registry]))
    try {
      await entered
      expect(a.client.getQueryData(a.key)).toEqual({ accountId: "ordered-a" })
      expect(getCommunityDbRegistry(b.client)).toBe(b.registry)
      expect(b.registry.runtime.lifecycle.get().active).toBe(true)
      release()
      await retiring
      expectRetired(a)
      expectRetired(b)
    } finally {
      release()
      replacement.mockRestore()
      await retiring
    }
  })

  it("preserves a completed cleanup's original error and still clears both clients", async () => {
    const a = await createOwner("completed-error-a")
    const b = await createOwner("completed-error-b")
    const owners = new Set([a.registry, b.registry])
    const failure = new Error("completed registry cleanup failed")
    const retireOriginal = a.registry.cleanup
    const replacement = vi.spyOn(a.registry, "cleanup").mockImplementation(async () => {
      await retireOriginal()
      throw failure
    })
    try {
      await expect(retireCommunityQueryOwners(owners)).rejects.toBe(failure)
      expectRetired(a)
      expectRetired(b)
      expect(owners.size).toBe(0)
    } finally {
      replacement.mockRestore()
    }
  })

  it("reports an early cleanup rejection without claiming that registry was released", async () => {
    const a = await createOwner("early-error-a")
    const b = await createOwner("early-error-b")
    const owners = new Set([a.registry, b.registry])
    const failure = new Error("registry cleanup rejected before release")
    const replacement = vi.spyOn(a.registry, "cleanup").mockRejectedValue(failure)
    try {
      await expect(retireCommunityQueryOwners(owners)).rejects.toBe(failure)
      expect(getCommunityDbRegistry(a.client)).toBe(a.registry)
      expect(a.registry.runtime.lifecycle.get().active).toBe(true)
      expect(a.client.getQueryCache().getAll()).toHaveLength(0)
      expect(a.client.getMutationCache().getAll()).toHaveLength(0)
      expectRetired(b)
      expect(owners.size).toBe(0)
      await retireCommunityQueryOwners(owners)
      expect(getCommunityDbRegistry(a.client)).toBe(a.registry)
    } finally {
      replacement.mockRestore()
    }
  })

  it("retains the original cleanup and clear errors before rescue while retiring the next owner", async () => {
    const a = await createOwner("compound-error-a")
    const b = await createOwner("compound-error-b")
    const owners = new Set([a.registry, b.registry])
    const cleanupFailure = new Error("registry cleanup completed with an error")
    const clearFailure = new Error("client clear failed before removing its cache")
    const retireOriginal = a.registry.cleanup
    const cleanupReplacement = vi.spyOn(a.registry, "cleanup").mockImplementation(async () => {
      await retireOriginal()
      throw cleanupFailure
    })
    const clearReplacement = vi.spyOn(a.client, "clear").mockImplementation(() => { throw clearFailure })
    try {
      const failure = await retireCommunityQueryOwners(owners).then(() => undefined, error => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.errors).toHaveLength(2)
      expect(failure.errors[0]).toBe(cleanupFailure)
      expect(failure.errors[1]).toBe(clearFailure)
      expect(getCommunityDbRegistry(a.client)).toBeNull()
      expect(a.registry.runtime.lifecycle.get().active).toBe(false)
      expect(a.client.getQueryData(a.key)).toEqual({ accountId: "compound-error-a" })
      expect(a.client.getMutationCache().getAll()).toHaveLength(1)
      expectRetired(b)
      expect(owners.size).toBe(0)
    } finally {
      cleanupReplacement.mockRestore()
      clearReplacement.mockRestore()
    }
  })

  it("preserves a lone clear error and does not skip the next owner's release", async () => {
    const a = await createOwner("clear-error-a")
    const b = await createOwner("clear-error-b")
    const owners = new Set([a.registry, b.registry])
    const failure = new Error("client clear failed")
    const replacement = vi.spyOn(a.client, "clear").mockImplementation(() => { throw failure })
    try {
      await expect(retireCommunityQueryOwners(owners)).rejects.toBe(failure)
      expect(getCommunityDbRegistry(a.client)).toBeNull()
      expect(a.client.getQueryData(a.key)).toEqual({ accountId: "clear-error-a" })
      expectRetired(b)
      expect(owners.size).toBe(0)
    } finally {
      replacement.mockRestore()
    }
  })
})
