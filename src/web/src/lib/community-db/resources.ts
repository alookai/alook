import { hasVirtualProps } from "@tanstack/react-db"
import { CommunityMessageResourceSchema, CommunityResourceProfileSchema, communityMessageProfileIds, type CommunityMessageResource, type CommunityResourceProfile } from "@alook/shared"
import type { z } from "zod"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityDbRegistry } from "./collections"
import { messageSchema as canonicalMessageSchema, profileSchema as canonicalProfileSchema, type MessageRow, type ProfileRow } from "./schema"
import { communityRowData } from "./write"

const messageSchema = CommunityMessageResourceSchema.strip()
const profileSchema = CommunityResourceProfileSchema.strip()
type Resources = { messages: CommunityMessageResource[]; profiles: CommunityResourceProfile[] }
type ResourceRead = { messages: readonly unknown[]; profiles: readonly unknown[]; additionalProfiles: readonly string[]; value: Resources }
type ResourceReads = {
  messages: WeakMap<object, CommunityMessageResource | null>
  profiles: WeakMap<object, CommunityResourceProfile | null>
  canonicalMessages: WeakMap<object, MessageRow | null>
  canonicalProfiles: WeakMap<object, ProfileRow | null>
  messageScopes: WeakMap<readonly unknown[], Map<string, number[]>>
  windows: WeakMap<object, ResourceRead>
}
const resourceReads = new WeakMap<CommunityDbRegistry, ResourceReads>()

function readsFor(registry: CommunityDbRegistry) {
  let reads = resourceReads.get(registry)
  if (!reads) {
    reads = { messages: new WeakMap(), profiles: new WeakMap(), canonicalMessages: new WeakMap(), canonicalProfiles: new WeakMap(), messageScopes: new WeakMap(), windows: new WeakMap() }
    resourceReads.set(registry, reads)
  }
  return reads
}

function readResource<T extends object>(schema: z.ZodType<T>, cache: WeakMap<object, T | null>, row: unknown, canonicalSource = false): T | undefined {
  const immutable = row !== null && typeof row === "object" && (canonicalSource || hasVirtualProps(row))
  if (immutable && cache.has(row)) return cache.get(row) ?? undefined
  const parsed = schema.safeParse(communityRowData(row))
  const value = parsed.success ? parsed.data : undefined
  if (immutable) cache.set(row, value ?? null)
  return value
}

function profileRow(registry: CommunityDbRegistry, id: string): unknown {
  if (registry.collections.profiles.status === "ready") return registry.collections.profiles.get(id)
  const rows = registry.queryClient.getQueryData<CommunityResourceProfile[]>(communityKeys.communityDbCollection(registry.scopeId, "profiles"))
  const row = Array.isArray(rows) ? rows.find(row => row?.id === id) : undefined
  return readResource(canonicalProfileSchema, readsFor(registry).canonicalProfiles, row, true)
}

function sameRows(left: readonly unknown[], right: readonly unknown[]) {
  return left.length === right.length && left.every((row, index) => row === right[index])
}

export function canonicalMessageResource(registry: CommunityDbRegistry, row: unknown) {
  return readResource(messageSchema, readsFor(registry).messages, row)
}

export function canonicalChannelMessages(registry: CommunityDbRegistry, channelId: string): MessageRow[] {
  if (!registry.runtime.lifecycle.get().active) return []
  const data = registry.queryClient.getQueryData<unknown[]>(communityKeys.communityDbCollection(registry.scopeId, "messages"))
  if (data !== undefined && !Array.isArray(data)) return []
  const rows = data ?? [...registry.collections.messages.values()]
  const reads = readsFor(registry)
  let scopes = reads.messageScopes.get(rows)
  if (!scopes) {
    scopes = new Map()
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (!row || typeof row !== "object" || !("channelId" in row) || typeof row.channelId !== "string") continue
      const positions = scopes.get(row.channelId) ?? []
      positions.push(index)
      scopes.set(row.channelId, positions)
    }
    reads.messageScopes.set(rows, scopes)
  }
  return (scopes.get(channelId) ?? []).flatMap(index => {
    const row = readResource(canonicalMessageSchema, reads.canonicalMessages, rows[index], true)
    return row ? [row] : []
  })
}

export function canonicalMessageResources(registry: CommunityDbRegistry, messages: readonly unknown[], window: object = messages, additionalProfiles: readonly string[] = []): Resources | undefined {
  if (!registry.runtime.lifecycle.get().active) return
  const reads = readsFor(registry)
  const previous = reads.windows.get(window)
  if (previous && sameRows(messages, previous.messages) && sameRows(additionalProfiles, previous.additionalProfiles)
    && previous.value.profiles.every((profile, index) => profileRow(registry, profile.id) === previous.profiles[index])) return previous.value
  const parsed = messages.map(row => readResource(messageSchema, reads.messages, row))
  if (parsed.some(row => !row)) return
  const resources = parsed as CommunityMessageResource[]
  const ids = [...new Set([...communityMessageProfileIds(resources), ...additionalProfiles])]
  const profileRows = ids.map(id => profileRow(registry, id))
  const profiles = profileRows.map(row => readResource(profileSchema, reads.profiles, row, true))
  if (profiles.some(row => !row)) return
  const value = { messages: resources, profiles: profiles as CommunityResourceProfile[] }
  if ([...messages, ...profileRows].every(row => row !== null && typeof row === "object" && hasVirtualProps(row))) {
    reads.windows.set(window, { messages: [...messages], profiles: profileRows, additionalProfiles: [...additionalProfiles], value })
  }
  return value
}
