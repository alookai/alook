import { DurableObject } from "cloudflare:workers"
import {
  preflightCommunityConnectionState,
  withCommunityDeliveryProgress,
} from "../ws-durable/community-delivery-state"
import {
  COMMUNITY_DELIVERY_PROGRESS_LIMIT,
  type UserConnectionState,
} from "../ws-durable/internal"

export interface AttachmentProbeEnv {
  ATTACHMENT_PROBE: DurableObjectNamespace<CommunityDeliveryAttachmentProbe>
}

function operationId(index: number): string {
  return `message:${index.toString(36).padStart(43, "0")}`
}

function operationDigest(index: number): string {
  return index.toString(16).padStart(64, "0")
}

export function buildMaxCommunityConnectionState(): UserConnectionState {
  let state: UserConnectionState = {
    type: "user",
    userId: "u".repeat(64),
    targetUserId: "t".repeat(64),
    authenticated: true,
    name: "n".repeat(128),
    discriminator: "1234",
    communityEventsBatchV1: true,
  }
  for (let index = 0; index < COMMUNITY_DELIVERY_PROGRESS_LIMIT; index += 1) {
    state = withCommunityDeliveryProgress(state, {
      operationId: operationId(index),
      operationDigest: operationDigest(index),
      mode: index % 2 === 0 ? "batch" : "legacy",
      nextFrameIndex: 1,
      frameCount: 1,
    })
  }
  const preflight = preflightCommunityConnectionState(state)
  if (!preflight.ok) throw new Error(`max attachment state failed preflight: ${preflight.reason}`)
  return state
}

export function appendSixtyFifthOperation(state: UserConnectionState): UserConnectionState {
  const next = withCommunityDeliveryProgress(state, {
    operationId: operationId(COMMUNITY_DELIVERY_PROGRESS_LIMIT),
    operationDigest: operationDigest(COMMUNITY_DELIVERY_PROGRESS_LIMIT),
    mode: "batch",
    nextFrameIndex: 1,
    frameCount: 1,
  })
  const preflight = preflightCommunityConnectionState(next)
  if (!preflight.ok) throw new Error(`65th attachment state failed preflight: ${preflight.reason}`)
  return next
}

export class CommunityDeliveryAttachmentProbe extends DurableObject<AttachmentProbeEnv> {
  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(buildMaxCommunityConnectionState())
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "read") {
      ws.send(JSON.stringify(ws.deserializeAttachment()))
      return
    }
    if (message === "append-65th") {
      const state = ws.deserializeAttachment() as UserConnectionState
      const next = appendSixtyFifthOperation(state)
      ws.serializeAttachment(next)
      ws.send(JSON.stringify(next))
      return
    }
    ws.close(1008, "Unknown probe command")
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 })
  },
}
