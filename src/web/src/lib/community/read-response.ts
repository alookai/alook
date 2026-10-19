import {
  COMMUNITY_CONTRACT_HEADER, communityReadSchemas, communityMessagePreviewFromLegacy,
  CommunityMessagePostedSchema, CommunityMessageReadSchema, CommunityConversationEntryReadSchema,
  type CommunityContract,
} from "@alook/shared"

export function communityReadTarget(path: string, method = "GET") {
  if (method.toUpperCase() === "POST") {
    const matched = /^\/api\/community\/channels\/([^/?]+)\/messages(?:\?|$)/.exec(path)
    return matched ? { channelId: decodeURIComponent(matched[1]), resource: "posted" } : null
  }
  if (method.toUpperCase() === "PUT") {
    const matched = /^\/api\/community\/channels\/([^/?]+)\/read(?:\?|$)/.exec(path)
    return matched ? { channelId: decodeURIComponent(matched[1]), resource: "read" } : null
  }
  if (method.toUpperCase() !== "GET") return null
  const single = /^\/api\/community\/messages\/([^/?]+)(?:\?|$)/.exec(path)
  if (single && !["search", "batch", "tags"].includes(single[1])) return { channelId: "", messageId: decodeURIComponent(single[1]), resource: "message" }
  const matched = /^\/api\/community\/channels\/([^/?]+)(?:\/(messages|read-state|members|threads))?(?:\?|$)/.exec(path)
  if (!matched) return null
  const resource = matched[2] ?? "metadata"
  return { channelId: decodeURIComponent(matched[1]), resource: resource === "messages" && new URL(path, "https://alook.invalid").searchParams.has("entry") ? "entry" : resource }
}

export function decodeCommunityReadResponse(path: string, method: string | undefined, response: Response, value: unknown, requestedContract: CommunityContract = 2): unknown {
  const target = communityReadTarget(path, method)
  if (!target) return value
  if (target.resource === "entry" && (requestedContract !== 3 || new URL(path, "https://alook.invalid").searchParams.get("entry") !== "1")) throw new Error("Community entry protocol confirmation mismatch")
  const bodyVersion = typeof value === "object" && value !== null && "contractVersion" in value ? value.contractVersion : undefined
  const headerVersion = response.headers.get(COMMUNITY_CONTRACT_HEADER)
  if (headerVersion === null && bodyVersion === undefined) {
    if (requestedContract === 3) throw new Error("Community read protocol confirmation mismatch")
    if (target.resource === "messages") {
      const legacy = value as { messages?: unknown[] }
      if (!Array.isArray(legacy.messages)) throw new Error("Community message resource missing")
      return { ...legacy, messages: legacy.messages.map((message) => {
        return { ...communityMessagePreviewFromLegacy(message, target.channelId), resourceComplete: false }
      }) }
    }
    if (target.resource === "message") {
      if (typeof value !== "object" || value === null || !("channelId" in value) || typeof value.channelId !== "string") throw new Error("Community message scope missing")
      return { ...communityMessagePreviewFromLegacy(value, value.channelId), resourceComplete: false }
    }
    if (target.resource === "metadata" && typeof value === "object" && value !== null) {
      const { readContractVersion: _version, accessDecision: _access, ...legacy } = value as Record<string, unknown>
      return legacy
    }
    return value
  }
  if ((requestedContract !== 2 && requestedContract !== 3) || headerVersion !== String(requestedContract) || bodyVersion !== requestedContract) throw new Error("Community read protocol confirmation mismatch")
  const schemas = communityReadSchemas(requestedContract)
  const assertScope = (channelId: string) => {
    if (channelId !== target.channelId) throw new Error("Community read resource scope mismatch")
  }
  if (target.resource === "entry") {
    const data = CommunityConversationEntryReadSchema.parse(value)
    assertScope(data.channelId)
    return { ...data, messages: data.messages.map((message) => ({ ...message, resourceComplete: true })) }
  }
  if (target.resource === "message") {
    if (requestedContract !== 3) throw new Error("Community message protocol confirmation mismatch")
    const data = CommunityMessageReadSchema.parse(value)
    if (data.channelId !== data.message.channelId || data.message.id !== target.messageId) throw new Error("Community message resource scope mismatch")
    return { ...data.message, resourceComplete: true }
  }
  if (target.resource === "metadata") {
    const data = schemas.channel.parse(value)
    assertScope(data.channelId); assertScope(data.channel.id); assertScope(data.access.channelId)
    return { ...data.channel, resourceComplete: true, accessDecision: data.access }
  }
  if (target.resource === "posted") {
    if (requestedContract !== 3) throw new Error("Community posted protocol confirmation mismatch")
    const data = CommunityMessagePostedSchema.parse(value)
    assertScope(data.channelId); assertScope(data.message.channelId)
    return { message: { ...data.message, resourceComplete: true }, deduped: data.deduped, ...(data.threadId ? { threadId: data.threadId } : {}) }
  }
  if (target.resource === "messages") {
    const data = schemas.messages.parse(value)
    assertScope(data.channelId); assertScope(data.surfaceReceipt.channelId)
    for (const message of data.messages) assertScope(message.channelId)
    return { messages: data.messages.map((message) => requestedContract === 3
      ? { ...message, resourceComplete: true }
      : { ...communityMessagePreviewFromLegacy(message, target.channelId), resourceComplete: false }),
      olderCursor: data.page.olderCursor ?? undefined, newerCursor: data.page.newerCursor ?? undefined,
      hasMoreOlder: data.page.hasMoreOlder, hasMoreNewer: data.page.hasMoreNewer, latestSeq: data.page.latestSeq,
      surfaceReceipt: data.surfaceReceipt }
  }
  if (target.resource === "read-state") {
    const data = schemas.readState.parse(value)
    assertScope(data.channelId); assertScope(data.readState.channelId)
    return data.readState
  }
  if (target.resource === "read") {
    const data = schemas.readAdvance.parse(value)
    assertScope(data.channelId)
    return { changed: data.changed, targetSeq: data.targetSeq, revision: data.revision }
  }
  if (target.resource === "threads") {
    const data = schemas.threads.parse(value)
    assertScope(data.channelId); assertScope(data.channel.id)
    const children = new Set(data.threads.map((thread) => thread.id))
    for (const thread of data.threads) if (thread.parentChannelId !== target.channelId || thread.serverId !== data.channel.serverId) throw new Error("Thread resource scope mismatch")
    for (const message of data.included.messages) if (message.channelId !== target.channelId && !children.has(message.channelId)) throw new Error("Included message scope mismatch")
    const profiles = new Set(data.included.profiles.map((profile) => profile.id))
    const openerIds = new Set(data.threads.flatMap((thread) => thread.parentMessageId ? [thread.parentMessageId] : []))
    if (data.included.tags.some((row) => !openerIds.has(row.messageId))) throw new Error("Included tag scope mismatch")
    if (data.included.participantCounts.some((row) => !children.has(row.channelId))) throw new Error("Participant count scope mismatch")
    for (const member of data.included.members) {
      if (!children.has(member.channelId) || member.relation !== "notify") throw new Error("Included member scope mismatch")
      if (!profiles.has(member.userId)) throw new Error("Included member profile missing")
    }
    return data
  }
  if (target.resource === "members") {
    const data = schemas.members.parse(value)
    assertScope(data.channelId)
    const requested = new URL(path, "https://alook.invalid").searchParams.get("relation")
    if (requested !== data.relation) throw new Error("Community member relation mismatch")
    const profiles = new Set(data.profiles.map((profile) => profile.id))
    for (const member of data.members) {
      assertScope(member.channelId)
      if (member.relation !== data.relation) throw new Error("Community member resource relation mismatch")
      if (!profiles.has(member.userId)) throw new Error("Community member profile missing")
    }
    return data
  }
}
