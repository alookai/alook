import { createDb, queries, readOrStale } from "@alook/shared"
import type {
  CommunityMachineConnectionState,
  ConnectionState,
  WsDurableContext,
} from "./internal"
import {
  broadcastPresence,
  handleClientTypingStart,
  notifyUserDO,
  sendPresenceSnapshot,
} from "./presence-typing"

export async function handleUserFetch(
  context: WsDurableContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/broadcast" && request.method === "POST") {
    const body = await request.text()
    const sent = broadcast(context, body)
    return new Response(JSON.stringify({ sent }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/check-alive") {
    const hasAuthDaemon = context.ctx.getWebSockets().some(ws => {
      const s = ws.deserializeAttachment() as ConnectionState
      return s?.type === "daemon" && s.authenticated
    })
    return new Response(JSON.stringify({ alive: hasAuthDaemon }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/check-user-online") {
    const targetUserId = url.searchParams.get("userId")
    const hasAuthUser = context.ctx.getWebSockets().some(ws => {
      const s = ws.deserializeAttachment() as ConnectionState
      return s?.type === "user" && s.authenticated
    })
    if (hasAuthUser) {
      return new Response(JSON.stringify({ online: true }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    if (targetUserId) {
      const db = createDb(context.env.DB)
      const { value, stale } = await readOrStale<{ isBotResolved: boolean; online: boolean }>(
        async () => {
          const target = await queries.user.getUserInternal(db, targetUserId)
          if (target?.isBot) {
            const online = await queries.communityMachine.isBotOnline(db, targetUserId)
            return { isBotResolved: true, online }
          }
          return { isBotResolved: false, online: false }
        },
        { isBotResolved: false, online: false },
        { route: "ws-do/check-user-online" },
      )
      if (stale) {
        return new Response(JSON.stringify({ online: false, stale: true }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      if (value.isBotResolved) {
        return new Response(JSON.stringify({ online: value.online }), {
          headers: { "Content-Type": "application/json" },
        })
      }
    }
    return new Response(JSON.stringify({ online: false }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  return null
}

export function acceptUserWebSocket(context: WsDurableContext): Response {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)

  context.ctx.acceptWebSocket(server)

  server.serializeAttachment({ type: "user", userId: "", authenticated: false } as ConnectionState)

  context.ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair("ping", "pong")
  )

  return new Response(null, { status: 101, webSocket: client })
}

export async function handleWebSocketMessage(
  context: WsDurableContext,
  ws: WebSocket,
  message: string | ArrayBuffer,
  handleCommunityMachineMessage: (parsed: unknown) => Promise<void>,
): Promise<void> {
  if (typeof message !== "string") return

  let parsed: unknown
  try { parsed = JSON.parse(message) } catch { ws.close(1008, "Invalid JSON"); return }

  const state = ws.deserializeAttachment() as ConnectionState

  if (state?.type === "community-machine") {
    await handleCommunityMachineMessage(parsed)
    return
  }

  const msg = parsed as { type: string; token?: string; machineToken?: string; daemonId?: string }

  if (msg.type === "auth") {
    if (msg.machineToken && msg.daemonId) {
      const authResult = await validateMachineToken(context, msg.machineToken, msg.daemonId)
      if (authResult.kind === "invalid") {
        context.log.warn("daemon websocket auth rejected", { daemonId: msg.daemonId })
        try { ws.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED" })) } catch { }
        ws.close(1008, "Unauthorized")
        return
      }
      if (authResult.kind === "transient") {
        context.log.warn("daemon websocket auth transient failure", { daemonId: msg.daemonId })
        ws.close(1011, "Auth temporarily unavailable")
        return
      }
      ws.serializeAttachment({ type: "daemon", daemonId: msg.daemonId, userId: authResult.userId, authenticated: true } as ConnectionState)
      context.log.info("daemon websocket authenticated", { daemonId: msg.daemonId })
      ws.send(JSON.stringify({ type: "auth.ok" }))

      notifyUserDO(context, authResult.userId, { type: "runtime.status", status: "online", daemonId: msg.daemonId }).catch(() => { })
      return
    }

    if (!msg.token) {
      ws.close(1008, "Unauthorized")
      return
    }
    const identity = await validateToken(context, msg.token)
    if (!identity) {
      context.log.warn("websocket auth failed")
      ws.close(1008, "Unauthorized")
      return
    }
    const { userId, name, discriminator } = identity
    const wasOnline = countAuthenticatedUserConnections(context, userId) > 0
    ws.serializeAttachment({ type: "user", userId, authenticated: true, name, discriminator } as ConnectionState)
    context.log.info("websocket authenticated", { userId })
    ws.send(JSON.stringify({ type: "auth.ok" }))
    if (!wasOnline) {
      broadcastPresence(context, userId, true).catch(() => { })
    }
    sendPresenceSnapshot(context, ws, userId).catch(() => { })
    return
  }

  if (!state.authenticated) {
    ws.close(1008, "Not authenticated")
    return
  }

  if (msg.type === "check_daemon_status" && state.type === "user") {
    const daemonId = await getDaemonIdForUser(context, state.userId)
    if (daemonId) {
      try {
        const daemonDoId = context.env.WS_DO.idFromName("daemon:" + daemonId)
        const daemonStub = context.env.WS_DO.get(daemonDoId)
        const resp = await daemonStub.fetch(new Request("http://internal/check-alive"))
        const { alive } = await resp.json() as { alive: boolean }
        if (alive) {
          ws.send(JSON.stringify({ type: "runtime.status", status: "online", daemonId }))
        }
      } catch {
        context.log.debug("check_daemon_status: failed to reach daemon DO", { daemonId })
      }
    }
    return
  }

  if (state.type === "user" && handleClientTypingStart(context, state, parsed)) return
}

export async function handleWebSocketClose(
  context: WsDurableContext,
  ws: WebSocket,
  handleCommunityMachineClose: (state: CommunityMachineConnectionState) => Promise<void>,
): Promise<void> {
  const state = ws.deserializeAttachment() as ConnectionState
  if (state?.type === "daemon" && state.authenticated) {
    context.log.info("daemon websocket closed", { daemonId: state.daemonId })
    notifyUserDO(context, state.userId, { type: "runtime.status", status: "offline", daemonId: state.daemonId }).catch(() => { })
  }
  if (state?.type === "user" && state.authenticated) {
    const remaining = countAuthenticatedUserConnections(context, state.userId) - 1
    if (remaining <= 0) {
      broadcastPresence(context, state.userId, false).catch(() => { })
    }
  }
  if (state?.type === "community-machine" && state.authenticated) {
    await handleCommunityMachineClose(state)
  }
}

export async function handleWebSocketError(
  context: WsDurableContext,
  ws: WebSocket,
  error: unknown,
): Promise<void> {
  context.log.error("websocket error", { err: error instanceof Error ? error : String(error) })
  try { ws.close(1011, "Internal error") } catch { }
}

function broadcast(context: WsDurableContext, message: string): number {
  let sent = 0
  for (const ws of context.ctx.getWebSockets()) {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state.authenticated) {
      try {
        ws.send(message)
        sent++
      } catch { }
    }
  }
  return sent
}

function countAuthenticatedUserConnections(context: WsDurableContext, userId: string): number {
  let count = 0
  for (const ws of context.ctx.getWebSockets()) {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state?.type === "user" && state.authenticated && state.userId === userId) {
      count++
    }
  }
  return count
}

async function getDaemonIdForUser(context: WsDurableContext, userId: string): Promise<string | null> {
  const db = createDb(context.env.DB)
  const token = await queries.machineToken.getLatestTokenForUser(db, userId)
  return token?.hostname || null
}

async function validateToken(
  context: WsDurableContext,
  token: string,
): Promise<{ userId: string; name: string; discriminator: string } | null> {
  const db = createDb(context.env.DB)
  return queries.session.getValidSessionWithIdentity(db, token)
}

async function validateMachineToken(
  context: WsDurableContext,
  token: string,
  daemonId: string,
): Promise<
  | { kind: "valid"; userId: string }
  | { kind: "invalid" }
  | { kind: "transient" }
> {
  if (!token.startsWith("al_")) return { kind: "invalid" }
  try {
    const db = createDb(context.env.DB)
    const mt = await queries.machineToken.getMachineTokenByToken(db, token)
    if (!mt || mt.status !== "active" || !mt.workspaceId) return { kind: "invalid" }
    const machine = await queries.machine.getMachineByDaemon(db, daemonId, mt.workspaceId)
    if (!machine) return { kind: "invalid" }
    return { kind: "valid", userId: mt.userId }
  } catch (err) {
    context.log.warn("daemon websocket auth lookup threw", { err: String(err) })
    return { kind: "transient" }
  }
}
