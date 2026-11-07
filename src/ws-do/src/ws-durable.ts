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
import { notifyUserDO } from "./ws-durable/presence-typing"
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

  /** Preserve start/stop delivery order independently for each user and scope. */
  private typingFanoutChains = new Map<string, Promise<void>>()

  private static readonly TYPING_DEDUP_MS = 8_000

  private static readonly SUBREQUEST_BATCH_SIZE = 40

  private domainContext(): WsDurableContext {
    return {
      ctx: this.ctx,
      env: this.env,
      log,
      typingDedup: this.typingDedup,
      typingFanoutChains: this.typingFanoutChains,
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
        ws,
        parsed,
        {
          fanOutMachineUpdated: (userId, machineId) =>
            fanOutMachineUpdated(this.domainContext(), userId, machineId),
          notifyUser: (userId, payload) => this.notifyUserDO(userId, payload),
        },
      ),
    )
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try { ws.close(code, reason) } catch { }
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

}
