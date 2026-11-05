import { readFile } from "node:fs/promises"
import { once } from "node:events"
import { createServer, Server } from "node:http"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import sharp from "sharp"
import { JSDOM } from "jsdom"
import { build } from "esbuild"
import { describe, expect, it, vi } from "vitest"
import { creativeCaptures, selectCreatives, startCreativeServer, captureCreatives, main } from "../../../app-store-capture/creative/capture.mjs"
import { assertArtworkHash, assertArtworkProvenance } from "../../../../../scripts/ci/artwork-manifest"

const root = resolve(import.meta.dirname, "../../../../..")
const { chromium } = createRequire(resolve(root, "src/web/package.json"))("@playwright/test")

async function close(server: Server) {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

describe("App Store creative PNG capture", () => {
  it("selects the two approved canvases together or independently", () => {
    expect(selectCreatives()).toEqual(creativeCaptures)
    expect(creativeCaptures.map(({ asset, width, height, filename }) => ({ asset, width, height, filename }))).toEqual([
      { asset: "header", width: 3840, height: 1646, filename: "alook-header-3840x1646.png" },
      { asset: "search", width: 1920, height: 1280, filename: "alook-search-1920x1280.png" },
    ])
    for (const asset of ["header", "search"]) expect(selectCreatives(asset).map(capture => capture.asset)).toEqual([asset])
    expect(() => selectCreatives("unknown")).toThrow("Invalid creative asset")
  })

  it("serves the local document and only declared resources, then closes its own listener", async () => {
    const unrelated = createServer((_request, response) => response.end("unrelated"))
    let server: Awaited<ReturnType<typeof startCreativeServer>> | undefined
    try {
      unrelated.listen(0, "127.0.0.1")
      await once(unrelated, "listening")
      const address = unrelated.address()
      if (!address || typeof address === "string") throw new Error("Missing fixture address")
      server = await startCreativeServer()
      const declared = new Set<string>()
      for (const asset of ["header", "search"]) {
        const response = await fetch(`${server.origin}/?asset=${asset}`)
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        const document = new JSDOM(await response.text(), { url: server.origin })
        try {
          const dom = document.window.document
          const subjects = dom.querySelectorAll('[role="img"]')
          expect(subjects).toHaveLength(1)
          expect(subjects[0].getAttribute("aria-label")).toBe(`Alook ${asset} artwork`)
          expect(subjects[0].querySelector("h2")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Multi-Agent Collaboration")
          expect(subjects[0].querySelector("p")?.textContent).toBe("for Team and Friends")
          const imagePaths = [...subjects[0].querySelectorAll("img")].map(image => new URL(image.src).pathname)
          expect(imagePaths.sort()).toEqual(["/alook.svg", "/faces/face-blue.svg", "/faces/face-purple.svg", "/faces/face-red.svg", "/faces/face-teal.svg"])
          for (const pathname of imagePaths) declared.add(pathname)
          const stylesheets = [...dom.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
          expect(stylesheets.map(link => new URL(link.href).pathname)).toEqual(["/artwork.css"])
          for (const stylesheet of stylesheets) {
            const url = new URL(stylesheet.href)
            expect(url.origin).toBe(server.origin)
            declared.add(url.pathname)
            const styleResponse = await fetch(url)
            expect(styleResponse.status).toBe(200)
            const compiled = await build({
              stdin: { contents: await styleResponse.text(), loader: "css" },
              bundle: true, external: ["*"], write: false, metafile: true,
            })
            expect(compiled.outputFiles).toHaveLength(1)
            const outputs = Object.values(compiled.metafile.outputs)
            expect(outputs).toHaveLength(1)
            for (const dependency of outputs[0].imports) {
              expect(dependency.kind).toBe("url-token")
              const resource = new URL(dependency.path, stylesheet.href)
              expect(resource.origin).toBe(server.origin)
              declared.add(resource.pathname)
            }
          }
        } finally { document.window.close() }
      }
      const expected = [
        ["/artwork.css", "text/css", "src/web/app-store-capture/creative/artwork.css"],
        ["/noise.svg", "image/svg+xml", "src/web/app-store-capture/creative/noise.svg"],
        ["/alook.svg", "image/svg+xml", "src/web/public/alook.svg"],
        ["/fonts/caveat.woff2", "font/woff2", "src/web/src/app/fonts/caveat-latin.woff2"],
        ["/fonts/dm-sans.woff2", "font/woff2", "src/web/src/app/fonts/dm-sans-latin.woff2"],
        ...["blue", "teal", "purple", "red"].map(color => [`/faces/face-${color}.svg`, "image/svg+xml", `src/web/app-store-capture/assets/face-${color}.svg`]),
      ]
      expect(declared).toEqual(new Set(expected.map(([pathname]) => pathname)))
      for (const [pathname, type, file] of expected) {
        const response = await fetch(`${server.origin}${pathname}`)
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain(type)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(resolve(root, file)))
      }
      for (const pathname of ["/unknown", "/../package.json", "/%2e%2e/AGENTS.md", "/faces/face-orange.svg"]) expect((await fetch(`${server.origin}${pathname}`)).status).toBe(404)
      expect((await fetch(`${server.origin}/?asset=invalid`)).status).toBe(400)
      expect((await fetch(server.origin, { method: "POST" })).status).toBe(405)
      await server.close()
      await server.close()
      await expect(fetch(server.origin)).rejects.toThrow()
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("unrelated")
    } finally {
      try { await server?.close() }
      finally { await close(unrelated) }
    }
  })

  it("rejects invalid selection and pre-aborted work before resource launch", async () => {
    const launch = vi.spyOn(chromium, "launch")
    const listen = vi.spyOn(Server.prototype, "listen")
    try {
      await expect(captureCreatives({ asset: "bad" })).rejects.toThrow("Invalid creative asset")
      await expect(captureCreatives({ signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled")
      for (const args of [["--unknown"], ["--asset"], ["--output"]]) await expect(main(args)).rejects.toThrow("Usage:")
      await expect(main(["--asset", "bad"])).rejects.toThrow("Invalid creative asset")
      expect(launch).not.toHaveBeenCalled()
      expect(listen).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks() }
  })

  it("closes its real server when Chrome cannot launch", async () => {
    vi.spyOn(chromium, "launch").mockRejectedValue(new Error("Chrome unavailable"))
    const listen = vi.spyOn(Server.prototype, "listen")
    try {
      await expect(captureCreatives()).rejects.toThrow("Chrome unavailable")
      expect(listen).toHaveBeenCalledTimes(1)
      expect(listen.mock.contexts.every(server => server.address() === null)).toBe(true)
    } finally { vi.restoreAllMocks() }
  })

  it("ships two RGB PNGs with actual resources, safe geometry and source hashes", async () => {
    const directory = resolve(root, "assets/app-store/creative")
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"))
    const source = JSON.parse(await readFile(resolve(root, "src/web/app-store-capture/creative/source.json"), "utf8"))
    expect(manifest.approvedPrototypeSha256).toBe(source.approvedPrototypeSha256)
    expect(manifest.encoding).toBe("RGB PNG")
    expect(manifest.renderer).toMatch(/^\d+\./)
    expect(manifest.repositoryHead).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.outputs.map(output => output.path)).toEqual(creativeCaptures.map(capture => capture.filename))
    assertArtworkProvenance(manifest, creativeCaptures.map(capture => capture.filename))
    for (const capture of creativeCaptures) {
      const bytes = await readFile(resolve(directory, capture.filename))
      expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: capture.width, height: capture.height, channels: 3, hasAlpha: false, space: "srgb" })
      const output = manifest.outputs.find(output => output.asset === capture.asset)
      assertArtworkHash(bytes, output.sha256)
      expect(output.fontsLoaded).toBe(true)
      expect(output.images).toHaveLength(5)
      expect(output.criticalBounds).toHaveLength(8)
      expect(output.resources).toEqual(expect.arrayContaining(["/artwork.css", "/noise.svg", "/alook.svg", "/fonts/caveat.woff2", "/fonts/dm-sans.woff2"]))
      expect(output.resources).not.toContain("/faces/face-orange.svg")
      expect(output.safeArea).toEqual(capture.safeArea)
      for (const rect of output.criticalBounds) {
        expect(rect.x).toBeGreaterThanOrEqual(capture.safeArea.x - .1)
        expect(rect.y).toBeGreaterThanOrEqual(capture.safeArea.y - .1)
        expect(rect.x + rect.width).toBeLessThanOrEqual(capture.safeArea.x + capture.safeArea.width + .1)
        expect(rect.y + rect.height).toBeLessThanOrEqual(capture.safeArea.y + capture.safeArea.height + .1)
      }
    }
  })
})
