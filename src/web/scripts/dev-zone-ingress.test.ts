import http from "node:http"
import net from "node:net"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  BLOG_ROUTE_PREFIXES,
  createZoneIngress,
  selectZone,
} from "./dev-zone-ingress.mjs"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )
  return (server.address() as AddressInfo).port
}

describe("development zone selection", () => {
  it("matches the approved Cloudflare route prefixes exactly", () => {
    expect(BLOG_ROUTE_PREFIXES).toEqual(["/blog", "/og/blog"])
    expect([
      "/blog",
      "/blog/post?draft=1",
      "/blog-static/_next/app.js",
      "/blogger",
      "/og/blog/post",
    ].map(selectZone)).toEqual(["blog", "blog", "blog", "blog", "blog"])
    expect(["/", "/Blog", "/og/Blog", "/api/blog", "/_next/app.js"].map(selectZone)).toEqual([
      "main",
      "main",
      "main",
      "main",
      "main",
    ])
  })

  it("preserves HTTP behavior while dispatching to the selected backend", async () => {
    const makeBackend = (zone: string) =>
      http.createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk) => chunks.push(chunk))
        request.on("end", () => {
          response.writeHead(zone === "blog" ? 206 : 201, {
            location: `/${zone}-location`,
            "set-cookie": [`zone=${zone}; Path=/`, "shared=yes; Path=/"],
            "x-backend": zone,
          })
          response.end(
            JSON.stringify({
              body: Buffer.concat(chunks).toString(),
              host: request.headers.host,
              method: request.method,
              range: request.headers.range,
              url: request.url,
              forwardedHost: request.headers["x-forwarded-host"],
              forwardedProto: request.headers["x-forwarded-proto"],
            }),
          )
        })
      })

    const mainPort = await listen(makeBackend("main"))
    const blogPort = await listen(makeBackend("blog"))
    const ingress = createZoneIngress({
      port: 0,
      backends: {
        main: { hostname: "127.0.0.1", port: mainPort },
        blog: { hostname: "127.0.0.1", port: blogPort },
      },
    })
    await ingress.listen()
    closers.push(() => ingress.close())
    const ingressPort = (ingress.server.address() as AddressInfo).port

    const response = await fetch(`http://127.0.0.1:${ingressPort}/blog/post?q=1`, {
      method: "POST",
      headers: { range: "bytes=2-4" },
      body: "payload",
      redirect: "manual",
    })

    expect(response.status).toBe(206)
    expect(response.headers.get("location")).toBe("/blog-location")
    expect(response.headers.getSetCookie()).toEqual([
      "zone=blog; Path=/",
      "shared=yes; Path=/",
    ])
    expect(await response.json()).toEqual({
      body: "payload",
      host: `127.0.0.1:${ingressPort}`,
      method: "POST",
      range: "bytes=2-4",
      url: "/blog/post?q=1",
      forwardedHost: `127.0.0.1:${ingressPort}`,
      forwardedProto: "https",
    })
  })

  it("forwards upgrade frames to the selected backend", async () => {
    const main = http.createServer()
    main.on("upgrade", (_request, socket, head) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n")
      if (head.length > 0) socket.write(head)
      socket.pipe(socket)
    })
    const mainPort = await listen(main)
    const blogPort = await listen(http.createServer())
    const ingress = createZoneIngress({
      port: 0,
      backends: {
        main: { hostname: "127.0.0.1", port: mainPort },
        blog: { hostname: "127.0.0.1", port: blogPort },
      },
    })
    await ingress.listen()
    closers.push(() => ingress.close())
    const ingressPort = (ingress.server.address() as AddressInfo).port

    const result = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: ingressPort })
      let received = ""
      socket.setTimeout(2_000, () => reject(new Error("upgrade timed out")))
      socket.on("connect", () => {
        socket.write(
          `GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:${ingressPort}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nping`,
        )
      })
      socket.on("data", (chunk) => {
        received += chunk.toString()
        if (received.includes("ping")) {
          socket.end()
          resolve(received)
        }
      })
      socket.on("error", reject)
    })

    expect(result).toContain("101 Switching Protocols")
    expect(result).toContain("ping")
  })
})
