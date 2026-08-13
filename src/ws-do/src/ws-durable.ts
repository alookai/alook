import { DurableObject } from "cloudflare:workers"
import { createLogger } from "@alook/shared"
import type { WsDurableContext } from "./ws-durable/internal"
import {
  acceptUserWebSocket,
  handleUserFetch,
  handleWebSocketClose,
  handleWebSocketError,
  handleWebSocketMessage,
} from "./ws-durable/user-auth"
import {
  broadcastPresence,
  broadcastToAudience,
  fanOutTyping,
  fanOutTypingStop,
  getPresenceAudience,
  notifyUserDO,
  sendPresenceSnapshot,
} from "./ws-durable/presence-typing"
import {
  acceptCommunityMachineWebSocket,
  handleMachineControlFetch,
} from "./ws-durable/machine-control"
import {
  handleCommunityMachineClose,
  handleMachineAlarm,
} from "./ws-durable/machine-lifecycle"
import { handleCommunityMachineMessage } from "./ws-durable/machine-frames"
import { recordPendingRestarts } from "./ws-durable/machine-restart"
import {
  clearRuntimeErrorOverlay,
  fanOutMachineUpdated,
} from "./ws-durable/machine-ready"

const log = createLogger({ service: "ws-do" })

export class WebSocketDurableObject extends DurableObject<Env> {
  /**
   * Ephemeral typing dedup: channelId -> userId -> last timestamp.
   * Lost on DO eviction — acceptable, gracefully degraded (typing just re-fires).
   */
  private typingDedup = new Map<string, Map<string, number>>()

  /** Typing dedup window: 8 seconds */
  private static readonly TYPING_DEDUP_MS = 8_000

  private static readonly SUBREQUEST_BATCH_SIZE = 40

  private domainContext(): WsDurableContext {
    return {
      ctx: this.ctx,
      env: this.env,
      log,
      typingDedup: this.typingDedup,
      typingDedupMs: WebSocketDurableObject.TYPING_DEDUP_MS,
      subrequestBatchSize: WebSocketDurableObject.SUBREQUEST_BATCH_SIZE,
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    const userResponse = await handleUserFetch(this.domainContext(), request, url)
    if (userResponse) return userResponse

    const machineResponse = await handleMachineControlFetch(
      this.domainContext(),
      request,
      url,
      {
        recordPendingRestarts: (body) => recordPendingRestarts(this.domainContext(), body),
        clearRuntimeErrorOverlay: () => clearRuntimeErrorOverlay(this.domainContext()),
        fanOutMachineUpdated: (userId, machineId) =>
          fanOutMachineUpdated(this.domainContext(), userId, machineId),
      },
    )
    if (machineResponse) return machineResponse

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }

    // Community-machine connections carry `Authorization: Bearer cmk_...`.
    // The router named this DO from `sha256(bearer).slice(0,32)` without
    // hitting D1; the DO is the source of truth and runs the ONE D1 lookup
    // by full 64-hex hash on first accept, then caches identity in
    // ctx.storage for the rest of the connection's life.
    const authHeader = request.headers.get("Authorization")
    if (authHeader?.startsWith("Bearer cmk_")) {
      return acceptCommunityMachineWebSocket(this.domainContext(), authHeader.slice(7).trim())
    }

    return acceptUserWebSocket(
      this.domainContext(),
      url.searchParams.get("userId") ?? undefined,
    )
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await handleWebSocketMessage(
      this.domainContext(),
      ws,
      message,
      (parsed) => handleCommunityMachineMessage(
        this.domainContext(),
        parsed,
        {
          fanOutMachineUpdated: (userId, machineId) =>
            fanOutMachineUpdated(this.domainContext(), userId, machineId),
          notifyUser: (userId, payload) => this.notifyUserDO(userId, payload),
        },
      ),
    )
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await handleWebSocketClose(
      this.domainContext(),
      ws,
      (state) => handleCommunityMachineClose(this.domainContext(), state, ws),
    )
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await handleWebSocketError(this.domainContext(), ws, error)
  }

  async alarm(): Promise<void> {
    await handleMachineAlarm(this.domainContext())
  }

  private async notifyUserDO(userId: string, payload: unknown): Promise<void> {
    await notifyUserDO(this.domainContext(), userId, payload)
  }

  private async fanOutTyping(
    senderUserId: string,
    channelId?: string,
    event?: string
  ): Promise<void> {
    await fanOutTyping(this.domainContext(), senderUserId, channelId, event)
  }

  /**
   * Fan out an explicit `community:typing.stop` for a channel scope to its
   * recipients. Mirrors `fanOutTyping` but never traverses a dedup cache — a
   * stop must always land or the pill dangles until the client's 8s expiry.
   * A DM is a channel now; recipients are its relation='access' members.
   */
  private async fanOutTypingStop(
    senderUserId: string,
    channelId: string,
  ): Promise<void> {
    await fanOutTypingStop(this.domainContext(), senderUserId, channelId)
  }

  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    await broadcastPresence(this.domainContext(), userId, online)
  }

  /**
   * Fan a payload out to `userId`'s presence audience (co-members ∪ friends),
   * batched to stay under the subrequest limit. Factored out of
   * `broadcastPresence` so other per-audience events (e.g.
   * `community:bot.activity`) share the same batched-fetch loop.
   */
  private async broadcastToAudience(userId: string, payload: unknown): Promise<void> {
    await broadcastToAudience(this.domainContext(), userId, payload)
  }

  /**
   * Who should learn about `userId`'s online/offline flips: server
   * co-members AND accepted friends — where "friends" (`getFriendUserIds`)
   * already includes the owner↔own-bot implicit friendship (see
   * `queries/community/friendship.ts`), so a fresh bot with zero servers
   * still reaches its owner with no `isBot` branch needed here. Friends are
   * also the common case that a co-members-only audience misses entirely —
   * two people can be friends without ever sharing a server, which is the
   * whole point of a friends list. Deduped so a friend who's also a
   * co-member gets one fetch, not two.
   */
  private async getPresenceAudience(userId: string): Promise<string[]> {
    return getPresenceAudience(this.domainContext(), userId)
  }

  private async sendPresenceSnapshot(ws: WebSocket, userId: string): Promise<void> {
    await sendPresenceSnapshot(this.domainContext(), ws, userId)
  }
}
