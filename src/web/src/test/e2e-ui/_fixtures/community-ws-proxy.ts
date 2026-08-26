import type { BrowserContext, WebSocketRoute } from "@playwright/test"

export type CapturedCommunityFrame = {
  type: string
  operationId?: string
  operationDigest?: string
  events?: CapturedCommunityFrame[]
  channelId?: string
  parentChannelId?: string
  messageId?: string
  message?: { id?: string; seq?: number; content?: string }
  [key: string]: unknown
}

type FrameDecision = (
  frame: CapturedCommunityFrame,
) => "drop" | "duplicate" | "forward" | "hold"

export type CapturedConnectionFrame = {
  connectionId: number
  direction: "client-to-server" | "server-to-client"
  type: "auth" | "auth.ok" | "connection.ping" | "connection.pong" | "raw.ping" | "raw.pong"
  nonce?: string
  at: number
}

type ConnectionFrameDecision = (
  frame: CapturedConnectionFrame,
) => "drop" | "forward" | "hold"

type HeldCommunityFrame = {
  client: WebSocketRoute
  frame: CapturedCommunityFrame
  message: string | Buffer
}

type HeldConnectionFrame = {
  client: WebSocketRoute
  frame: CapturedConnectionFrame
  message: string | Buffer
}

export type CommunityWsProxy = {
  frames: CapturedCommunityFrame[]
  connectionFrames: CapturedConnectionFrame[]
  connectionCount: () => number
  heldCount: () => number
  heldConnectionCount: () => number
  releaseHeld: (predicate?: (frame: CapturedCommunityFrame) => boolean) => number
  releaseHeldConnections: (predicate?: (frame: CapturedConnectionFrame) => boolean) => number
  replay: (frame: CapturedCommunityFrame) => void
  sendConnectionFrame: (frame: { type: "connection.pong" | "auth.ok"; nonce?: string }) => void
  disconnect: () => Promise<void>
}

export type CommunityWsProxyOptions = {
  decide?: FrameDecision
  decideConnectionFrame?: ConnectionFrameDecision
}

function parseCommunityFrame(message: string | Buffer): CapturedCommunityFrame | null {
  try {
    const value = JSON.parse(message.toString()) as unknown
    if (
      typeof value !== "object"
      || value === null
      || !("type" in value)
      || typeof value.type !== "string"
      || !value.type.startsWith("community:")
    ) return null
    return value as CapturedCommunityFrame
  } catch {
    return null
  }
}

function parseConnectionFrame(
  message: string | Buffer,
  direction: CapturedConnectionFrame["direction"],
  connectionId: number,
): CapturedConnectionFrame | null {
  const raw = message.toString()
  if (raw === "ping" || raw === "pong") {
    return {
      connectionId,
      direction,
      type: raw === "ping" ? "raw.ping" : "raw.pong",
      at: Date.now(),
    }
  }
  try {
    const value = JSON.parse(raw) as { type?: unknown; nonce?: unknown }
    if (
      value.type !== "auth"
      && value.type !== "auth.ok"
      && value.type !== "connection.ping"
      && value.type !== "connection.pong"
    ) return null
    return {
      connectionId,
      direction,
      type: value.type,
      ...(typeof value.nonce === "string" ? { nonce: value.nonce } : {}),
      at: Date.now(),
    }
  } catch {
    return null
  }
}

export async function proxyCommunityWebSockets(
  context: BrowserContext,
  options: CommunityWsProxyOptions = {},
): Promise<CommunityWsProxy> {
  const frames: CapturedCommunityFrame[] = []
  const held: HeldCommunityFrame[] = []
  const connectionFrames: CapturedConnectionFrame[] = []
  const heldConnectionFrames: HeldConnectionFrame[] = []
  const payloads = new WeakMap<CapturedCommunityFrame, string | Buffer>()
  let activeClient: WebSocketRoute | undefined
  let activeConnectionId: number | undefined
  let connectionCount = 0
  await context.routeWebSocket(/.*/, (client: WebSocketRoute) => {
    connectionCount += 1
    const connectionId = connectionCount
    activeClient = client
    activeConnectionId = connectionId
    const server = client.connectToServer()
    client.onMessage((message) => {
      const connectionFrame = parseConnectionFrame(message, "client-to-server", connectionId)
      if (connectionFrame) connectionFrames.push(connectionFrame)
      server.send(message)
    })
    server.onMessage((message) => {
      const connectionFrame = parseConnectionFrame(message, "server-to-client", connectionId)
      if (connectionFrame) {
        connectionFrames.push(connectionFrame)
        const decision = options.decideConnectionFrame?.(connectionFrame) ?? "forward"
        if (decision === "drop") return
        if (decision === "hold") {
          heldConnectionFrames.push({ client, frame: connectionFrame, message })
          return
        }
      }
      const frame = parseCommunityFrame(message)
      if (frame) {
        frames.push(frame)
        payloads.set(frame, message)
        const decision = options.decide?.(frame) ?? "forward"
        if (decision === "drop") return
        if (decision === "hold") {
          held.push({ client, frame, message })
          return
        }
        client.send(message)
        if (decision === "duplicate") client.send(message)
        return
      }
      client.send(message)
    })
  })
  return {
    frames,
    connectionFrames,
    connectionCount: () => connectionCount,
    heldCount: () => held.length,
    heldConnectionCount: () => heldConnectionFrames.length,
    releaseHeld: (predicate = () => true) => {
      let released = 0
      for (let index = 0; index < held.length;) {
        const item = held[index]!
        if (!predicate(item.frame)) {
          index += 1
          continue
        }
        held.splice(index, 1)
        item.client.send(item.message)
        released += 1
      }
      return released
    },
    releaseHeldConnections: (predicate = () => true) => {
      let released = 0
      for (let index = 0; index < heldConnectionFrames.length;) {
        const item = heldConnectionFrames[index]!
        if (!predicate(item.frame)) {
          index += 1
          continue
        }
        heldConnectionFrames.splice(index, 1)
        item.client.send(item.message)
        released += 1
      }
      return released
    },
    replay: (frame) => {
      const message = payloads.get(frame)
      if (!message || !activeClient) throw new Error("community frame is not replayable")
      activeClient.send(message)
    },
    sendConnectionFrame: (frame) => {
      if (!activeClient || activeConnectionId === undefined) {
        throw new Error("connection frame target missing")
      }
      connectionFrames.push({
        connectionId: activeConnectionId,
        direction: "server-to-client",
        type: frame.type,
        ...(typeof frame.nonce === "string" ? { nonce: frame.nonce } : {}),
        at: Date.now(),
      })
      activeClient.send(JSON.stringify(frame))
    },
    /* istanbul ignore next -- retained offline/reconnect Chromium journey */
    disconnect: async () => {
      /* istanbul ignore next -- retained offline/reconnect Chromium journey */
      if (!activeClient) return
      /* istanbul ignore next -- retained offline/reconnect Chromium journey */
      const client = activeClient
      /* istanbul ignore next -- retained offline/reconnect Chromium journey */
      activeClient = undefined
      activeConnectionId = undefined
      /* istanbul ignore next -- retained offline/reconnect Chromium journey */
      await client.close({ code: 1012, reason: "test transport offline" })
    },
  }
}

export function communityFrameEvents(frame: CapturedCommunityFrame): CapturedCommunityFrame[] {
  return frame.type === "community:events.batch" && Array.isArray(frame.events)
    ? frame.events
    : [frame]
}
