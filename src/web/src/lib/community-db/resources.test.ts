import { describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry } from "./collections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { messageResourceFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { getCanonicalCommunityMessageResources, getCanonicalCommunityMessages } from "./sync"
import { writeCommunityCollectionRows } from "./write"

function observePayload(field: "content" | "name") {
  type Observation = { descriptor: PropertyDescriptor; reads: number; getter: () => unknown }
  const observed = new Map<object, Observation>()
  return {
    add(rows: Iterable<unknown>) {
      for (const row of rows) {
        if (!row || typeof row !== "object") throw new Error("Payload observation requires an actual row")
        if (observed.has(row)) continue
        const descriptor = Object.getOwnPropertyDescriptor(row, field)
        if (!descriptor?.configurable || !("value" in descriptor)) throw new Error("Payload is not an ordinary configurable field")
        const keys = Object.keys(row)
        const observation: Observation = { descriptor, reads: 0, getter: () => { observation.reads += 1; return descriptor.value as unknown } }
        observed.set(row, observation)
        Object.defineProperty(row, field, { configurable: descriptor.configurable, enumerable: descriptor.enumerable, get: observation.getter })
        expect(Object.keys(row)).toEqual(keys)
      }
    },
    reset() { for (const observation of observed.values()) observation.reads = 0 },
    counts(target: object) {
      const targetObservation = observed.get(target)
      if (!targetObservation) throw new Error("Target payload was not observed")
      let total = 0
      for (const [row, observation] of observed) {
        if (Object.getOwnPropertyDescriptor(row, field)?.get !== observation.getter) throw new Error("Payload observation was replaced")
        total += observation.reads
      }
      return { target: targetObservation.reads, unrelated: total - targetObservation.reads }
    },
    restore() {
      const errors: unknown[] = []
      for (const [row, observation] of observed) {
        try {
          Object.defineProperty(row, field, observation.descriptor)
          expect(Object.getOwnPropertyDescriptor(row, field)).toEqual(observation.descriptor)
        } catch (error) { errors.push(error) }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, "Payload descriptor restoration failed")
    },
  }
}

describe("canonical message resource reads", () => {
  it("validates the canonical schema before admitting profiles from a pre-ready snapshot", async () => {
    const client = new QueryClient()
    const registry = createCommunityDbRegistry(client, "viewer")
    try {
      const key = communityKeys.communityDbCollection("viewer", "profiles")
      const profile = profileResourceFixture()
      client.setQueryData(key, [{ ...profile, unknownBusinessField: true }])
      expect(getCanonicalCommunityMessageResources(client, [messageResourceFixture()])).toBeUndefined()
      client.setQueryData(key, [profile])
      expect(getCanonicalCommunityMessageResources(client, [messageResourceFixture()])?.profiles).toEqual([profile])
    } finally {
      const errors: unknown[] = []
      try { await registry.cleanup() } catch (error) { errors.push(error) }
      try { client.clear() } catch (error) { errors.push(error) }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, "Resource owner cleanup failed")
    }
  })

  it("reads and validates only the requested channel across accepted snapshot changes", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const messages = Array.from({ length: 1000 }, (_, index) => messageResourceFixture({ id: `outside-${index}`, channelId: "other" }))
    messages.push(messageResourceFixture())
    await writeCommunityCollectionRows(registry, "messages", messages, row => row.id)
    const key = communityKeys.communityDbCollection("viewer", "messages")
    const accepted = client.getQueryData<ReturnType<typeof messageResourceFixture>[]>(key)!
    const target = accepted.find(row => row.id === "m1")!
    const payload = observePayload("content")
    try {
      payload.add(accepted)
      const first = getCanonicalCommunityMessages(client, "c1")
      const firstReads = payload.counts(target)
      expect(firstReads).toEqual({ target: 1, unrelated: 0 })
      expect(first).toEqual([messageResourceFixture()])
      payload.reset()
      const same = getCanonicalCommunityMessages(client, "c1")
      const sameReads = payload.counts(target)
      expect(sameReads).toEqual({ target: 0, unrelated: 0 })
      expect(same).toEqual(first)
      await writeCommunityCollectionRows(registry, "messages", [...messages, messageResourceFixture({ id: "another", channelId: "other" })], row => row.id)
      const grown = client.getQueryData<ReturnType<typeof messageResourceFixture>[]>(key)!
      payload.add(grown)
      expect(grown.find(row => row.id === "m1")).toBe(target)
      payload.reset()
      const afterGrowth = getCanonicalCommunityMessages(client, "c1")
      const growthReads = payload.counts(target)
      expect(growthReads).toEqual({ target: 0, unrelated: 0 })
      expect(afterGrowth).toEqual([messageResourceFixture()])
    } finally { payload.restore() }
  })

  it("keeps coverage on accepted rows while a real optimistic message transaction is pending", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const message = messageResourceFixture()
    await writeCommunityCollectionRows(registry, "messages", [message], row => row.id)
    let release!: () => void
    const pending = new Promise<void>(done => { release = done })
    const transaction = registry.dbClient.createTransaction({ mutationFn: () => pending })
    transaction.mutate(() => registry.collections.messages.update(message.id, row => { row.content = "Optimistic" }))
    try {
      expect(registry.collections.messages.get(message.id)?.content).toBe("Optimistic")
      expect(getCanonicalCommunityMessages(client, "c1")[0]?.content).toBe(message.content)
      await writeCommunityCollectionRows(registry, "messages", [{ ...message, content: "Confirmed" }], row => row.id)
      expect(getCanonicalCommunityMessages(client, "c1")[0]?.content).toBe("Confirmed")
    } finally {
      release()
      await transaction.when("settled")
    }
  })

  it("limits profile validation to the message graph as unrelated profiles grow", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const profiles = Array.from({ length: 1000 }, (_, index) => profileResourceFixture({ id: `unrelated-${index}` }))
    profiles.push(profileResourceFixture({ id: "author" }))
    await writeCommunityCollectionRows(registry, "profiles", profiles, row => row.id)
    await writeCommunityCollectionRows(registry, "messages", [messageResourceFixture({ authorId: "author" })], row => row.id)
    const author = registry.collections.profiles.get("author")!
    const payload = observePayload("name")
    try {
      const actualProfiles = [...registry.collections.profiles.values()]
      expect(actualProfiles.find(row => row.id === "author")).toBe(author)
      payload.add(actualProfiles)
      const first = getCanonicalCommunityMessageResources(client, [registry.collections.messages.get("m1")], {})
      const firstReads = payload.counts(author)
      expect(firstReads).toEqual({ target: 1, unrelated: 0 })
      expect(first).toEqual({ messages: [messageResourceFixture({ authorId: "author" })], profiles: [profileResourceFixture({ id: "author" })] })
      await writeCommunityCollectionRows(registry, "profiles", [...profiles, profileResourceFixture({ id: "another-unrelated" })], row => row.id)
      const grownProfiles = [...registry.collections.profiles.values()]
      payload.add(grownProfiles)
      expect(registry.collections.profiles.get("author")).toBe(author)
      payload.reset()
      const afterGrowth = getCanonicalCommunityMessageResources(client, [registry.collections.messages.get("m1")], {})
      const growthReads = payload.counts(author)
      expect(growthReads).toEqual({ target: 0, unrelated: 0 })
      expect(afterGrowth).toEqual({ messages: [messageResourceFixture({ authorId: "author" })], profiles: [profileResourceFixture({ id: "author" })] })
    } finally { payload.restore() }
  })

  it("reuses one window graph and does not parse unrelated account profiles", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const profiles = Array.from({ length: 1000 }, (_, index) => profileResourceFixture({ id: `unrelated-${index}` }))
    profiles.push(profileResourceFixture({ id: "author" }))
    await writeCommunityCollectionRows(registry, "profiles", profiles, row => row.id)
    await writeCommunityCollectionRows(registry, "messages", [messageResourceFixture({ authorId: "author" })], row => row.id)
    const window = {}
    const rows = () => [registry.collections.messages.get("m1")]
    const author = registry.collections.profiles.get("author")!
    const payload = observePayload("name")
    try {
      const actualProfiles = [...registry.collections.profiles.values()]
      expect(actualProfiles.find(row => row.id === "author")).toBe(author)
      payload.add(actualProfiles)
      const first = getCanonicalCommunityMessageResources(client, rows(), window)
      const firstReads = payload.counts(author)
      expect(firstReads).toEqual({ target: 1, unrelated: 0 })
      expect(first).toEqual({ messages: [messageResourceFixture({ authorId: "author" })], profiles: [profileResourceFixture({ id: "author" })] })
      payload.reset()
      const same = getCanonicalCommunityMessageResources(client, rows(), window)
      const sameReads = payload.counts(author)
      expect(sameReads).toEqual({ target: 0, unrelated: 0 })
      expect(same).toBe(first)
      await writeCommunityCollectionRows(registry, "profiles", [...profiles, profileResourceFixture({ id: "another-unrelated" })], row => row.id)
      payload.add(registry.collections.profiles.values())
      expect(registry.collections.profiles.get("author")).toBe(author)
      payload.reset()
      const afterGrowth = getCanonicalCommunityMessageResources(client, rows(), window)
      const growthReads = payload.counts(author)
      expect(growthReads).toEqual({ target: 0, unrelated: 0 })
      expect(afterGrowth).toBe(first)
    } finally { payload.restore() }
  })

  it("rechecks the actual message and profile dependencies, including deletion", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const profile = profileResourceFixture({ id: "author" })
    const message = messageResourceFixture({ authorId: profile.id })
    await writeCommunityCollectionRows(registry, "profiles", [profile], row => row.id)
    await writeCommunityCollectionRows(registry, "messages", [message], row => row.id)
    const window = {}
    const read = () => getCanonicalCommunityMessageResources(client, [registry.collections.messages.get(message.id)], window)
    const first = read()
    await writeCommunityCollectionRows(registry, "profiles", [{ ...profile, name: "Updated" }], row => row.id)
    expect(read()).not.toBe(first)
    expect(read()?.profiles[0]?.name).toBe("Updated")
    await writeCommunityCollectionRows(registry, "messages", [{ ...message, content: "Edited" }], row => row.id)
    expect(read()?.messages[0]?.content).toBe("Edited")
    await writeCommunityCollectionRows(registry, "profiles", [], row => row.id)
    expect(read()).toBeUndefined()
    await writeCommunityCollectionRows(registry, "profiles", [profile], row => row.id)
    expect(read()?.profiles[0]?.name).toBe(profile.name)
    await writeCommunityCollectionRows(registry, "messages", [], row => row.id)
    expect(read()).toBeUndefined()
  })

  it("keeps malformed and missing profiles incomplete while allowing an empty graph", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const message = messageResourceFixture({ authorId: "missing" })
    expect(getCanonicalCommunityMessageResources(client, [message], {})).toBeUndefined()
    expect(getCanonicalCommunityMessageResources(client, [{ id: "partial" }], {})).toBeUndefined()
    expect(getCanonicalCommunityMessageResources(client, [], {})).toEqual({ messages: [], profiles: [] })
    const profile = profileResourceFixture({ id: "missing" })
    await writeCommunityCollectionRows(registry, "profiles", [profile], row => row.id)
    expect(getCanonicalCommunityMessageResources(client, [message], {})?.profiles).toEqual([profile])
    expect(getCanonicalCommunityMessageResources(client, [message], {})).toEqual({ messages: [messageResourceFixture({ authorId: "missing" })], profiles: [profileResourceFixture({ id: "missing" })] })
    expect(getCanonicalCommunityMessageResources(client, [{ ...message, content: { invalid: true } }], {})).toBeUndefined()
    registry.runtime.lifecycle.setState(state => ({ active: false, generation: state.generation + 1 }))
    expect(getCanonicalCommunityMessageResources(client, [message], {})).toBeUndefined()
  })
})
