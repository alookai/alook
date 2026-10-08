import {
  COMMUNITY_CONTRACT_HEADER, CommunityChannelReadSchema, CommunityMessagesReadSchema,
  CommunityReadStateReadSchema, CommunityMembersReadSchema, CommunityThreadsReadSchema, CommunityReadAdvanceSchema,
  normalizeCommunityMessageResource,
} from "@alook/shared"

export function communityReadTarget(path: string, method = "GET") {
  if (method.toUpperCase() === "PUT") {
    const matched = /^\/api\/community\/channels\/([^/?]+)\/read(?:\?|$)/.exec(path)
    return matched ? { channelId: decodeURIComponent(matched[1]), resource: "read" } : null
  }
  if (method.toUpperCase() !== "GET") return null
  const matched = /^\/api\/community\/channels\/([^/?]+)(?:\/(messages|read-state|members|threads))?(?:\?|$)/.exec(path)
  return matched ? { channelId: decodeURIComponent(matched[1]), resource: matched[2] ?? "metadata" } : null
}

export function decodeCommunityReadResponse(path: string, method: string | undefined, response: Response, value: unknown): unknown {
  const target = communityReadTarget(path, method)
  if (!target) return value
  const bodyVersion = typeof value === "object" && value !== null && "contractVersion" in value ? value.contractVersion : undefined
  const headerVersion = response.headers.get(COMMUNITY_CONTRACT_HEADER)
  if (headerVersion !== "2" && bodyVersion !== 2) {
    if (target.resource === "messages") {
      const legacy = value as { messages?: unknown[] }
      if (!Array.isArray(legacy.messages)) throw new Error("Community message resource missing")
      return { ...legacy, messages: legacy.messages.map((message) => {
        const normalized = normalizeCommunityMessageResource(message, target.channelId)
        return { ...normalized, clientNonce: normalized.clientNonce ?? undefined }
      }) }
    }
    if (target.resource === "metadata" && typeof value === "object" && value !== null) {
      const { readContractVersion: _version, accessDecision: _access, ...legacy } = value as Record<string, unknown>
      return legacy
    }
    return value
  }
  if (headerVersion !== "2" || bodyVersion !== 2) throw new Error("Community read protocol confirmation mismatch")
  const assertScope = (channelId: string) => {
    if (channelId !== target.channelId) throw new Error("Community read resource scope mismatch")
  }
  if (target.resource === "metadata") {
    const data = CommunityChannelReadSchema.parse(value)
    assertScope(data.channelId); assertScope(data.channel.id); assertScope(data.access.channelId)
    return { ...data.channel, readContractVersion: 2, accessDecision: data.access }
  }
  if (target.resource === "messages") {
    const data = CommunityMessagesReadSchema.parse(value)
    assertScope(data.channelId); assertScope(data.surfaceReceipt.channelId)
    for (const message of data.messages) assertScope(message.channelId)
    return { messages: data.messages.map((message) => ({ ...message, clientNonce: message.clientNonce ?? undefined })),
      olderCursor: data.page.olderCursor ?? undefined, newerCursor: data.page.newerCursor ?? undefined,
      hasMoreOlder: data.page.hasMoreOlder, hasMoreNewer: data.page.hasMoreNewer, latestSeq: data.page.latestSeq,
      surfaceReceipt: data.surfaceReceipt }
  }
  if (target.resource === "read-state") {
    const data = CommunityReadStateReadSchema.parse(value)
    assertScope(data.channelId); assertScope(data.readState.channelId)
    return data.readState
  }
  if (target.resource === "read") {
    const data = CommunityReadAdvanceSchema.parse(value)
    assertScope(data.channelId)
    return { changed: data.changed, targetSeq: data.targetSeq, revision: data.revision }
  }
  if (target.resource === "threads") {
    const data = CommunityThreadsReadSchema.parse(value)
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
    const data = CommunityMembersReadSchema.parse(value)
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
