import type { IncomingMessage, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"

type ServerRow = { id: string; name: string; version: number }
type MessageRow = { id: string; channelId: string; seq: number; text: string }
type AccountState = { servers: ServerRow[]; messages: MessageRow[] }
type FreshnessReason = "reconnect" | "gap" | "unknown"
type WsEvent =
  | { type: "upsert"; account: string; servers: ServerRow[]; messages: MessageRow[] }
  | { type: "revoke"; account: string; serverId: string; channelIds: string[] }
  | { type: "freshness"; account: string; reason: FreshnessReason }
type DevServer = {
  middlewares: {
    use: (handler: (
      request: IncomingMessage,
      response: ServerResponse,
      next: () => void,
    ) => void | Promise<void>) => void
  }
  ws: { send: (payload: unknown) => void }
}

const initialState = (): Record<string, AccountState> => ({
  alpha: {
    servers: [
      { id: "s-alpha", name: "Alpha", version: 1 },
      { id: "s-second", name: "Second", version: 1 },
    ],
    messages: Array.from({ length: 6 }, (_, index) => ({
      id: `m-alpha-${index + 1}`,
      channelId: "c-alpha",
      seq: index + 1,
      text: `alpha message ${index + 1}`,
    })),
  },
  beta: {
    servers: [{ id: "s-beta", name: "Beta", version: 1 }],
    messages: Array.from({ length: 4 }, (_, index) => ({
      id: `m-beta-${index + 1}`,
      channelId: "c-beta",
      seq: index + 1,
      text: `beta message ${index + 1}`,
    })),
  },
})

function json(response: ServerResponse, value: unknown, status = 200) {
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

function upsert<T extends { id: string }>(rows: T[], incoming: T[]) {
  const next = new Map(rows.map((row) => [row.id, row]))
  for (const row of incoming) next.set(row.id, row)
  return [...next.values()]
}

export function createSpikeApiPlugin() {
  let state = initialState()
  let requests: Array<Record<string, unknown>> = []
  return {
    name: "tanstack-official-composition-api",
    configureServer(server: DevServer) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/spike-api/")) return next()
        const url = new URL(request.url, "http://spike.local")
        requests.push({ method: request.method, path: url.pathname, search: url.search })

        if (request.method === "POST" && url.pathname === "/spike-api/control/reset") {
          state = initialState()
          requests = []
          return json(response, { ok: true })
        }
        if (request.method === "GET" && url.pathname === "/spike-api/control/requests") {
          return json(response, { requests })
        }
        if (request.method === "POST" && url.pathname === "/spike-api/control/mutate") {
          const payload = await body(request) as { account: string; server: ServerRow }
          const account = state[payload.account]
          if (!account) return json(response, { error: "unknown account" }, 404)
          account.servers = upsert(account.servers, [payload.server])
          return json(response, { ok: true })
        }
        if (request.method === "POST" && url.pathname === "/spike-api/control/freshness-burst") {
          const payload = await body(request) as { account: string; server: ServerRow }
          const account = state[payload.account]
          if (!account) return json(response, { error: "unknown account" }, 404)
          account.servers = upsert(account.servers, [payload.server])
          const reasons: FreshnessReason[] = ["reconnect", "gap", "unknown"]
          for (const reason of reasons) {
            const event: WsEvent = { type: "freshness", account: payload.account, reason }
            server.ws.send({ type: "custom", event: "spike:ws", data: event })
          }
          return json(response, { ok: true, reasons })
        }
        if (request.method === "POST" && url.pathname === "/spike-api/control/ws") {
          const event = await body(request) as WsEvent
          const account = state[event.account]
          if (!account) return json(response, { error: "unknown account" }, 404)
          if (event.type === "upsert") {
            account.servers = upsert(account.servers, event.servers)
            account.messages = upsert(account.messages, event.messages)
          } else if (event.type === "revoke") {
            account.servers = account.servers.filter((row) => row.id !== event.serverId)
            account.messages = account.messages.filter((row) => !event.channelIds.includes(row.channelId))
          }
          server.ws.send({ type: "custom", event: "spike:ws", data: event })
          return json(response, { ok: true, event })
        }

        const serverMatch = url.pathname.match(/^\/spike-api\/accounts\/([^/]+)\/servers$/)
        if (request.method === "GET" && serverMatch) {
          const account = state[decodeURIComponent(serverMatch[1]!)]
          return account ? json(response, { rows: account.servers }) : json(response, { error: "unknown account" }, 404)
        }

        const messageMatch = url.pathname.match(/^\/spike-api\/accounts\/([^/]+)\/channels\/([^/]+)\/messages$/)
        if (request.method === "GET" && messageMatch) {
          const account = state[decodeURIComponent(messageMatch[1]!)]
          if (!account) return json(response, { error: "unknown account" }, 404)
          const channelId = decodeURIComponent(messageMatch[2]!)
          const offset = Number(url.searchParams.get("offset") ?? 0)
          const limit = Number(url.searchParams.get("limit") ?? account.messages.length)
          const rows = account.messages
            .filter((row) => row.channelId === channelId)
            .sort((left, right) => right.seq - left.seq || right.id.localeCompare(left.id))
            .slice(offset, offset + limit)
          return json(response, { rows })
        }

        return json(response, { error: "not found" }, 404)
      })
    },
  }
}

const config = {
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [createSpikeApiPlugin()],
  optimizeDeps: {
    exclude: ["@tanstack/browser-db-sqlite-persistence"],
  },
  server: { strictPort: true },
}

export default config
