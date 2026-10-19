import http from "node:http"
import { STATUS_CODES } from "node:http"

export const ZONE_BACKENDS = Object.freeze({
  main: Object.freeze({ hostname: "127.0.0.1", port: 3001 }),
  blog: Object.freeze({ hostname: "127.0.0.1", port: 3002 }),
})

export const BLOG_ROUTE_PREFIXES = Object.freeze(["/blog", "/og/blog", "/guides"])

export function selectZone(pathname) {
  return BLOG_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ? "blog"
    : "main"
}

function targetForRequest(requestUrl, backends) {
  const pathname = new URL(requestUrl ?? "/", "http://dev.alook.local").pathname
  return backends[selectZone(pathname)]
}

function forwardedHeaders(request, publicPort) {
  const headers = { ...request.headers }
  const publicHost = request.headers.host ?? `127.0.0.1:${publicPort}`

  headers.host = publicHost
  headers["x-forwarded-host"] = publicHost
  headers["x-forwarded-port"] = String(publicPort)
  // The local ingress emulates Cloudflare's HTTPS edge. OpenNext treats an
  // explicit HTTP forwarding protocol as a canonical HTTPS redirect, which
  // would otherwise loop back to the same local URL.
  headers["x-forwarded-proto"] = "https"

  return headers
}

function writeUpgradeResponse(socket, response) {
  const statusCode = response.statusCode ?? 101
  const statusMessage = response.statusMessage ?? STATUS_CODES[statusCode] ?? ""
  const headers = response.rawHeaders
    .reduce((lines, value, index, values) => {
      if (index % 2 === 0) lines.push(`${value}: ${values[index + 1]}`)
      return lines
    }, [])
    .join("\r\n")

  socket.write(`HTTP/${response.httpVersion} ${statusCode} ${statusMessage}\r\n${headers}\r\n\r\n`)
}

export function createZoneIngress({
  hostname = "127.0.0.1",
  port = 3000,
  backends = ZONE_BACKENDS,
  phaseGate,
  wsBackend,
} = {}) {
  const upgrades = createUpgradeSocketOwner()
  let closing = false
  let pendingListen
  const server = http.createServer(async (request, response) => {
    if (phaseGate) {
      try { await phaseGate.ready() } catch {
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
        response.end("Managed release transition failed")
        return
      }
    }
    if (request.destroyed || response.destroyed) return
    const target = targetForRequest(request.url, backends)
    const proxy = http.request({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request, port),
    })

    proxy.on("response", (backendResponse) => {
      response.writeHead(
        backendResponse.statusCode ?? 502,
        backendResponse.statusMessage,
        backendResponse.headers,
      )
      backendResponse.pipe(response)
    })
    proxy.on("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      }
      response.end(`Development backend unavailable: ${error.message}`)
    })
    request.pipe(proxy)
  })

  server.on("upgrade", (request, socket, head) => {
    if (closing) { socket.destroy(); return }
    upgrades.own(socket)
    const pathname = new URL(request.url ?? "/", "http://dev.alook.local").pathname
    const target = wsBackend && (pathname === "/api/ws" || pathname.startsWith("/api/ws/"))
      ? wsBackend : targetForRequest(request.url, backends)
    const proxy = http.request({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request, port),
    })

    proxy.on("upgrade", (backendResponse, backendSocket, backendHead) => {
      if (closing) { backendSocket.destroy(); socket.destroy(); return }
      upgrades.own(socket, backendSocket)
      writeUpgradeResponse(socket, backendResponse)
      if (backendHead.length > 0) socket.write(backendHead)
      if (head.length > 0) backendSocket.write(head)
      backendSocket.pipe(socket)
      socket.pipe(backendSocket)
    })
    proxy.on("response", (backendResponse) => {
      writeUpgradeResponse(socket, backendResponse)
      backendResponse.pipe(socket)
    })
    proxy.on("error", () => socket.destroy())
    socket.on("error", () => proxy.destroy())
    socket.once("close", () => proxy.destroy())
    proxy.end()
  })

  return {
    server,
    listen() {
      if (closing || pendingListen) return Promise.reject(new Error("Development ingress is closed or already starting"))
      pendingListen = new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, hostname, () => {
          server.off("error", reject)
          if (closing) {
            server.close(() => reject(new Error("Development ingress retired during startup")))
            return
          }
          resolve(server.address())
        })
      })
      return pendingListen
    },
    async close() {
      closing = true
      const results = await Promise.allSettled([
        upgrades.close(),
        (async () => {
          await pendingListen?.catch(() => {})
          if (!server.listening) return
          await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
        })(),
      ])
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, "Development ingress cleanup failed")
    },
  }
}

export function createUpgradeSocketOwner() {
  const pairs = new Set()
  const pending = new Set()
  let closing = false
  const closed = socket => socket.closed ? Promise.resolve() : new Promise(resolve => socket.once("close", resolve))
  return {
    own(client, backend = client) {
      if (closing) { client.destroy(); backend.destroy(); throw new Error("Upgrade socket owner is closed") }
      let retired = false
      const pair = { retire: () => {
        if (retired) return
        retired = true
        pairs.delete(pair)
        client.destroy()
        backend.destroy()
      } }
      const complete = Promise.all([closed(client), closed(backend)])
      pending.add(complete)
      void complete.then(() => pending.delete(complete))
      for (const socket of [client, backend]) {
        socket.on("error", pair.retire)
        socket.once("close", pair.retire)
      }
      pairs.add(pair)
      return pair.retire
    },
    async close() {
      closing = true
      for (const pair of [...pairs]) pair.retire()
      let timer
      try {
        await Promise.race([
          Promise.all([...pending]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned upgraded sockets did not close")), 5_000) }),
        ])
      } finally { if (timer) clearTimeout(timer) }
    },
  }
}

export function createPhaseGate() {
  let pending
  let release
  let reject
  let failure
  return {
    hold() {
      if (pending || failure) throw new Error("Managed release gate is already held or failed")
      pending = new Promise((resolve, rejectPromise) => { release = resolve; reject = rejectPromise })
      pending.catch(() => {})
    },
    ready() {
      return failure ? Promise.reject(failure) : pending ?? Promise.resolve()
    },
    release() {
      release?.()
      pending = undefined
      release = undefined
      reject = undefined
    },
    fail(error) {
      failure = error
      reject?.(error)
      pending = undefined
    },
  }
}
