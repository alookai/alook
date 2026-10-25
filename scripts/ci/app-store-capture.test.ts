import { createHash } from "node:crypto"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer, Server } from "node:http"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import sharp from "sharp"
import { describe, expect, it, vi } from "vitest"
import { captures, captureArtwork, inputs, main, startArtworkServer } from "../../src/web/app-store-capture/capture.mjs"

const root = resolve(import.meta.dirname, "../..")
const captureRoot = resolve(root, "src/web/app-store-capture")
const { chromium } = createRequire(resolve(root, "src/web/package.json"))("@playwright/test")

describe("approved App Store artwork", () => {
  it("preserves every visual input from the approved source manifest", async () => {
    const approved = JSON.parse(await readFile(resolve(captureRoot, "approved-manifest.json"), "utf8"))
    expect(approved.input_files).toHaveLength(15)
    expect(approved.approved_outputs).toHaveLength(13)
    for (const source of approved.input_files) {
      const url = source.file.replace("prototype", "")
      const bytes = await readFile(inputs[url])
      expect(bytes.length, source.file).toBe(source.bytes)
      expect(createHash("sha256").update(bytes).digest("hex"), source.file).toBe(source.sha256)
    }
    const duo = JSON.parse(await readFile(resolve(captureRoot, "duo-manifest.json"), "utf8"))
    const refinement = JSON.parse(await readFile(resolve(captureRoot, "duo-refinement.json"), "utf8"))
    expect(duo.inputs).toHaveLength(11)
    expect(duo.approved_prior_13_images_changed).toBe(false)
    const originalTemplate = duo.inputs.find(source => source.file === "prototype/duo.html")
    expect(refinement.previous_template).toMatchObject({ bytes: originalTemplate.bytes, sha256: originalTemplate.sha256 })
    expect(refinement.current_template.file).toBe("duo.html")
    for (const source of duo.inputs) {
      const bytes = await readFile(inputs[source.file.replace("prototype", "")])
      const expected = source.file === "prototype/duo.html" ? refinement.current_template : source
      expect(bytes.length, source.file).toBe(expected.bytes)
      expect(createHash("sha256").update(bytes).digest("hex"), source.file).toBe(expected.sha256)
      if (source.pixels) {
        const metadata = await sharp(bytes).metadata()
        expect([metadata.width, metadata.height], source.file).toEqual(source.pixels)
      }
    }
  })

  it("maps twelve phone images, the complete tablet scene and the separate Duo composition", async () => {
    expect(captures).toHaveLength(14)
    expect(new Set(captures.map(capture => capture.filename)).size).toBe(14)
    expect(captures.filter(capture => capture.width === 1206 && capture.height === 2622)).toHaveLength(6)
    expect(captures.filter(capture => capture.width === 1320 && capture.height === 2868)).toHaveLength(6)
    expect(captures[12]).toMatchObject({ width: 2064, height: 2752, url: "/tablet.html?clean" })
    expect(captures[13]).toMatchObject({ width: 2007, height: 2853, url: "/duo.html?clean" })
    expect(captures.every(capture => capture.url.includes("clean"))).toBe(true)
    const readme = await readFile(resolve(captureRoot, "README.md"), "utf8")
    for (const capture of captures) expect(readme).toContain(capture.filename)
    const tablet = await readFile(inputs["/tablet.html"], "utf8")
    expect(tablet).toContain('src="demo-desktop.png"')
    expect(tablet).toContain("object-fit:contain")
    const desktop = await sharp(inputs["/demo-desktop.png"]).metadata()
    expect([desktop.width, desktop.height]).toEqual([2880, 1800])
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
    expect(packageJson.scripts["app-store:capture"]).toBe("node src/web/app-store-capture/capture.mjs")
    const webPackage = JSON.parse(await readFile(resolve(root, "src/web/package.json"), "utf8"))
    expect(webPackage.scripts.lint).toContain("app-store-capture/")
    const lintProject = JSON.parse(await readFile(resolve(root, "src/web/tsconfig.eslint.json"), "utf8"))
    expect(lintProject.include).toContain("app-store-capture/**/*.mjs")
  })

  it("ships the declared RGB JPEGs bound to the generated manifest", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "assets/app-store/manifest.json"), "utf8"))
    expect(manifest.outputs.filter(output => output.path !== "overview.jpg").map(output => output.path)).toEqual(captures.map(capture => capture.filename))
    const overview = manifest.outputs.find(output => output.path === "overview.jpg")
    if (overview) expect(overview).toMatchObject({ width: 1206, height: 1679 })
    for (const capture of captures) {
      const bytes = await readFile(resolve(root, "assets/app-store", capture.filename))
      const metadata = await sharp(bytes).metadata()
      expect(metadata).toMatchObject({ format: "jpeg", width: capture.width, height: capture.height, channels: 3, hasAlpha: false, space: "srgb" })
      expect(manifest.outputs.find(output => output.path === capture.filename).sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    }
    for (const [url, file] of Object.entries(inputs)) {
      expect(manifest.inputs[url]).toBe(createHash("sha256").update(await readFile(file)).digest("hex"))
    }
  })

  it("serves only declared local inputs and releases its loopback port", async () => {
    const app = await startArtworkServer()
    try {
      const response = await fetch(`${app.origin}/tablet.html?clean`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(await readFile(inputs["/tablet.html"], "utf8"))
      expect((await fetch(`${app.origin}/caveat.woff2`)).headers.get("content-type")).toBe("font/woff2")
      const duoImage = await fetch(`${app.origin}/duo-open-demo.jpg`)
      expect(duoImage.headers.get("content-type")).toBe("image/jpeg")
      expect(Buffer.from(await duoImage.arrayBuffer())).toEqual(await readFile(inputs["/duo-open-demo.jpg"]))
      expect((await fetch(`${app.origin}/missing.png`)).status).toBe(404)
      expect((await fetch(`${app.origin}/%2e%2e/package.json`)).status).toBe(404)
    } finally {
      await app.close()
    }
    await expect(fetch(app.origin)).rejects.toThrow()
  })

  it("closes the owned server when Chrome launch fails and keeps unrelated services", async () => {
    const unrelated = createServer((_request, response) => response.end("unrelated"))
    unrelated.listen(0, "127.0.0.1")
    await once(unrelated, "listening")
    const address = unrelated.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    const unrelatedUrl = `http://127.0.0.1:${address.port}`
    const listen = vi.spyOn(Server.prototype, "listen")
    vi.spyOn(chromium, "launch").mockRejectedValueOnce(new Error("controlled Chrome launch failure"))
    try {
      await expect(captureArtwork()).rejects.toThrow("controlled Chrome launch failure")
      expect(listen.mock.contexts).toHaveLength(1)
      expect((listen.mock.contexts[0] as Server).listening).toBe(false)
      expect(await (await fetch(unrelatedUrl)).text()).toBe("unrelated")
    } finally {
      vi.restoreAllMocks()
      unrelated.closeAllConnections()
      await new Promise<void>((resolve, reject) => unrelated.close(error => error ? reject(error) : resolve()))
    }
  })

  it("rejects invalid CLI arguments and an already cancelled run before launching resources", async () => {
    await expect(main(["--unknown"])).rejects.toThrow("Usage:")
    await expect(main(["--output"])).rejects.toThrow("Usage:")
    const launch = vi.spyOn(chromium, "launch")
    try {
      await expect(captureArtwork({ signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled")
      expect(launch).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })
})
