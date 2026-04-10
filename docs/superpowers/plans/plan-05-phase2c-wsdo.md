# Phase 2c — WS-DO (WebSocket Durable Objects)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans

**Goal:** Build the notification-only WebSocket service using Cloudflare Durable Objects.

**Strategy:** Copy from spec-plans, adapt per migration docs: session-only token validation, user channels only.

**Depends on:** Phase 1 (shared library must be complete)

**Can run in parallel with:** Phase 2a, Phase 2b

---

### Task 1: Worker entry point

**Files:**
- Modify: `src/ws-do/src/index.ts` (replace placeholder)

- [ ] Adapt from spec-plans (`temp/spec-plans/src/ws-do/src/index.ts`). Simplify per migration docs (03-ws-do.md):

**Remove:** Agent channel broadcast routes (`/broadcast/:agentId`), agent channel WebSocket (`?agentId=xxx`)
**Keep:** User channel broadcast (`/broadcast/user/:userId`), user channel WebSocket (`?userId=xxx`)

```typescript
export { WebSocketDurableObject } from "./ws-durable"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Broadcast to user channel: POST /broadcast/user/:userId
    const userBroadcast = url.pathname.match(/^\/broadcast\/user\/(.+)$/)
    if (userBroadcast && request.method === "POST") {
      const userId = userBroadcast[1]
      const doId = env.WS_DO.idFromName("user:" + userId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/broadcast", {
        method: "POST",
        body: request.body,
      }))
    }

    // WebSocket connect to user channel: GET /?userId=xxx
    const userId = url.searchParams.get("userId")
    if (!userId) {
      return new Response("userId required", { status: 400 })
    }
    const doId = env.WS_DO.idFromName("user:" + userId)
    const stub = env.WS_DO.get(doId)
    return stub.fetch(request)
  },
}
```

- [ ] Commit

```bash
git add src/ws-do/src/index.ts
git commit -m "feat(ws-do): worker entry point (user channels only)"
```

---

### Task 2: Durable Object

**Files:**
- Create: `src/ws-do/src/ws-durable.ts`

- [ ] Adapt from spec-plans (`temp/spec-plans/src/ws-do/src/ws-durable.ts`). Changes per migration docs:

**Remove:** Runtime token (`alook_tk_*`) validation — WS-DO only handles browser sessions
**Change:** Token validation to use `queries.session.getValidSession` from `@alook/shared` instead of raw D1

```typescript
import { DurableObject } from "cloudflare:workers"
import { createDb, queries } from "@alook/shared"

interface ConnectionState {
  userId: string
  authenticated: boolean
}

export class WebSocketDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const body = await request.text()
      this.broadcast(body)
      return new Response("ok")
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server)

    const preAuthUserId = request.headers.get("X-Authenticated-User")
    const state: ConnectionState = preAuthUserId
      ? { userId: preAuthUserId, authenticated: true }
      : { userId: "", authenticated: false }
    server.serializeAttachment(state)

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    )

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return

    let parsed: unknown
    try { parsed = JSON.parse(message) } catch { ws.close(1008, "Invalid JSON"); return }

    const state = ws.deserializeAttachment() as ConnectionState
    const msg = parsed as { type: string; token?: string }

    if (msg.type === "auth") {
      const userId = await this.validateToken(msg.token!)
      if (!userId) { ws.close(1008, "Unauthorized"); return }
      ws.serializeAttachment({ userId, authenticated: true } as ConnectionState)
      ws.send(JSON.stringify({ type: "auth.ok" }))
      return
    }

    if (!state.authenticated) {
      ws.close(1008, "Not authenticated")
    }
  }

  async webSocketClose(): Promise<void> {}

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WS error:", error)
    try { ws.close(1011, "Internal error") } catch {}
  }

  private broadcast(message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnectionState
      if (state.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      }
    }
  }

  private async validateToken(token: string): Promise<string | null> {
    // Session tokens only (browser auth via Better Auth)
    const db = createDb(this.env.DB)
    return queries.session.getValidSession(db, token)
  }
}
```

- [ ] Commit

```bash
git add src/ws-do/src/ws-durable.ts
git commit -m "feat(ws-do): durable object with session-only auth"
```

**Exit criteria:** WS-DO compiles. Worker routes to user channel DOs. Durable Object handles WebSocket upgrade, auth, and broadcast. Session-only token validation via shared queries.
