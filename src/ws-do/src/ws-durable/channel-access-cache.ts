import type { CommunityWsEvent } from "@alook/shared"

export type CachedReadableChannel = {
  serverId: string | null
  parentChannelId: string | null
  expiresAt: number
}

const DEFAULT_ACCESS_CACHE_TTL_MS = 30_000
const DEFAULT_MAX_CHANNELS_PER_USER = 512

export class ChannelAccessCache {
  private readonly byUser = new Map<string, Map<string, CachedReadableChannel>>()
  private readonly ttlMs: number
  private readonly maxPerUser: number

  constructor(options: { ttlMs?: number; maxPerUser?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_ACCESS_CACHE_TTL_MS
    this.maxPerUser = options.maxPerUser ?? DEFAULT_MAX_CHANNELS_PER_USER
  }

  getReadable(
    userId: string,
    channelId: string,
    now = Date.now(),
  ): { serverId: string | null; parentChannelId: string | null } | undefined {
    const userCache = this.byUser.get(userId)
    if (!userCache) return undefined
    const entry = userCache.get(channelId)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      userCache.delete(channelId)
      if (userCache.size === 0) this.byUser.delete(userId)
      return undefined
    }
    return { serverId: entry.serverId, parentChannelId: entry.parentChannelId }
  }

  setReadable(
    userId: string,
    rows: ReadonlyArray<{ id: string; serverId: string | null; parentChannelId: string | null }>,
    now = Date.now(),
  ): void {
    if (rows.length === 0) return
    let userCache = this.byUser.get(userId)
    if (!userCache) {
      userCache = new Map()
      this.byUser.set(userId, userCache)
    }
    const expiresAt = now + this.ttlMs
    for (const row of rows) {
      if (userCache.has(row.id)) userCache.delete(row.id)
      userCache.set(row.id, {
        serverId: row.serverId,
        parentChannelId: row.parentChannelId,
        expiresAt,
      })
    }
    while (userCache.size > this.maxPerUser) {
      const oldestKey = userCache.keys().next().value
      if (oldestKey === undefined) break
      userCache.delete(oldestKey)
    }
  }

  invalidateChannel(userId: string, channelId: string): void {
    const userCache = this.byUser.get(userId)
    if (!userCache) return
    userCache.delete(channelId)
    for (const [id, entry] of userCache) {
      if (entry.parentChannelId === channelId) userCache.delete(id)
    }
    if (userCache.size === 0) this.byUser.delete(userId)
  }

  invalidateServer(userId: string, serverId: string): void {
    const userCache = this.byUser.get(userId)
    if (!userCache) return
    for (const [id, entry] of userCache) {
      if (entry.serverId === serverId) userCache.delete(id)
    }
    if (userCache.size === 0) this.byUser.delete(userId)
  }

  invalidateDms(userId: string): void {
    const userCache = this.byUser.get(userId)
    if (!userCache) return
    for (const [id, entry] of userCache) {
      if (entry.serverId === null) userCache.delete(id)
    }
    if (userCache.size === 0) this.byUser.delete(userId)
  }

  invalidateForControlEvent(userId: string, event: CommunityWsEvent): void {
    switch (event.type) {
      case "community:channel.membership.change":
        if (event.userId === userId && (event.relation === "access" || !event.present)) {
          this.invalidateChannel(userId, event.channelId)
        }
        return
      case "community:channel.update":
      case "community:channel.delete":
        this.invalidateChannel(userId, event.channelId)
        return
      case "community:member.leave":
        if (event.userId === userId) {
          this.invalidateServer(userId, event.serverId)
        }
        return
      case "community:category.update":
      case "community:category.delete":
      case "community:server.delete":
        this.invalidateServer(userId, event.serverId)
        return
      case "community:friend.block":
      case "community:friend.remove":
        this.invalidateDms(userId)
        return
      default:
        return
    }
  }

  clearUser(userId: string): void {
    this.byUser.delete(userId)
  }
}
