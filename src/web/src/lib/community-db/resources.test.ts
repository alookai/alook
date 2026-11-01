import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry } from "./collections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { messageResourceFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { getCanonicalCommunityMessageResources, getCanonicalCommunityMessages } from "./sync"
import { messageSchema, profileSchema } from "./schema"
import { writeCommunityCollectionRows } from "./write"

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
    } finally { await registry.cleanup(); client.clear() }
  })

  it("reads and validates only the requested channel across accepted snapshot changes", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const messages = Array.from({ length: 1000 }, (_, index) => messageResourceFixture({ id: `outside-${index}`, channelId: "other" }))
    messages.push(messageResourceFixture())
    await writeCommunityCollectionRows(registry, "messages", messages, row => row.id)
    const parse = vi.spyOn(messageSchema, "safeParse")
    try {
      const first = getCanonicalCommunityMessages(client, "c1")
      expect(parse).toHaveBeenCalledTimes(1)
      expect(first.map(row => row.id)).toEqual(["m1"])
      parse.mockClear()
      expect(getCanonicalCommunityMessages(client, "c1")).toEqual(first)
      await writeCommunityCollectionRows(registry, "messages", [...messages, messageResourceFixture({ id: "another", channelId: "other" })], row => row.id)
      expect(getCanonicalCommunityMessages(client, "c1")).toEqual(first)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
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
    const parse = vi.spyOn(profileSchema, "safeParse")
    try {
      expect(getCanonicalCommunityMessageResources(client, [registry.collections.messages.get("m1")], {})?.profiles).toHaveLength(1)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
  })

  it("reuses one window graph and does not parse unrelated account profiles", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const profiles = Array.from({ length: 1000 }, (_, index) => profileResourceFixture({ id: `unrelated-${index}` }))
    profiles.push(profileResourceFixture({ id: "author" }))
    await writeCommunityCollectionRows(registry, "profiles", profiles, row => row.id)
    await writeCommunityCollectionRows(registry, "messages", [messageResourceFixture({ authorId: "author" })], row => row.id)
    const window = {}
    const rows = () => [registry.collections.messages.get("m1")]
    const parse = vi.spyOn(profileSchema, "safeParse")
    try {
      const first = getCanonicalCommunityMessageResources(client, rows(), window)
      expect(first?.profiles.map(row => row.id)).toEqual(["author"])
      expect(getCanonicalCommunityMessageResources(client, rows(), window)).toBe(first)
      await writeCommunityCollectionRows(registry, "profiles", [...profiles, profileResourceFixture({ id: "another-unrelated" })], row => row.id)
      expect(getCanonicalCommunityMessageResources(client, rows(), window)).toBe(first)
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
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
    registry.runtime.lifecycle.setState(state => ({ active: false, generation: state.generation + 1 }))
    expect(getCanonicalCommunityMessageResources(client, [message], {})).toBeUndefined()
  })
})
