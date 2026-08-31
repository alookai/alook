import http from "node:http"
import { STATUS_CODES } from "node:http"

export const ZONE_BACKENDS = Object.freeze({
  main: Object.freeze({ hostname: "127.0.0.1", port: 3001 }),
  blog: Object.freeze({ hostname: "127.0.0.1", port: 3002 }),
})

export const BLOG_ROUTE_PREFIXES = Object.freeze(["/blog", "/og/blog"])

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
} = {}) {
  const server = http.createServer((request, response) => {
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
    const target = targetForRequest(request.url, backends)
    const proxy = http.request({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request, port),
    })

    proxy.on("upgrade", (backendResponse, backendSocket, backendHead) => {
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
    proxy.end()
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, hostname, () => {
          server.off("error", reject)
          resolve(server.address())
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
