import type { PageManager } from "../src/index"
import { boundedBytes } from "../src/upload"

interface DriverEnv { MANAGER: Service<PageManager> }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return new Response("loopback_only", { status: 403 })
    const parts = url.pathname.split("/").filter(Boolean)
    if (request.method === "POST" && parts.length === 1 && parts[0] === "pages") return env.MANAGER.create(request)
    if (parts.length >= 2 && parts[0] === "pages" && /^[a-f0-9-]{36}$/.test(parts[1])) {
      const id = parts[1]
      if (parts.length === 2) {
        if (request.method === "GET") return env.MANAGER.get(id)
        if (request.method === "PUT") return env.MANAGER.update(id, request)
        if (request.method === "DELETE") return env.MANAGER.destroy(id)
      }
      if (parts.length === 3 && request.method === "POST") {
        if (parts[2] === "recover") return env.MANAGER.recover(id)
        if (parts[2] === "limits") {
          try {
            const limits: unknown = JSON.parse(new TextDecoder().decode(await boundedBytes(request.body, 1024)))
            return env.MANAGER.configure(id, limits)
          } catch { return Response.json({ error: "invalid_limits" }, { status: 400 }) }
        }
      }
    }
    return new Response("not_found", { status: 404 })
  },
} satisfies ExportedHandler<DriverEnv>
