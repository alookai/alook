import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import sharp from "sharp"
import { describe, expect, it, vi } from "vitest"
import { captures, captureArtwork, captureInputHashes, main, stopCaptureProcess } from "../../src/web/app-store-capture/capture.mjs"

const root = resolve(import.meta.dirname, "../..")
const captureRoot = resolve(root, "src/web/app-store-capture")
const { chromium } = createRequire(resolve(root, "src/web/package.json"))("@playwright/test")

describe("component-rendered App Store artwork", () => {
  it("maps fourteen RGB artwork canvases outside the production router", async () => {
    expect(captures).toHaveLength(14)
    expect(new Set(captures.map(capture => capture.filename)).size).toBe(14)
    expect(captures.filter(capture => capture.width === 1206 && capture.height === 2622)).toHaveLength(6)
    expect(captures.filter(capture => capture.width === 1320 && capture.height === 2868)).toHaveLength(6)
    expect(captures[12]).toMatchObject({ width: 2064, height: 2752, url: "/?kind=tablet" })
    expect(captures[13]).toMatchObject({ width: 2007, height: 2853, url: "/?kind=duo" })
    expect(existsSync(resolve(captureRoot, "app/page.tsx"))).toBe(true)
    expect(existsSync(resolve(root, "src/web/src/app/app-store-capture/page.tsx"))).toBe(false)
    const readme = await readFile(resolve(captureRoot, "README.md"), "utf8")
    for (const capture of captures) expect(readme).toContain(capture.filename)
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
    expect(packageJson.scripts["app-store:capture"]).toBe("node src/web/app-store-capture/capture.mjs")
  })

  it("renders shared Web components with the same homepage fixtures and normal root type", async () => {
    const surface = await readFile(resolve(captureRoot, "captures/surface.tsx"), "utf8")
    for (const component of ["LandingInteractiveShell", "LandingShellMotion", "LandingProfileContent", "Message", "Composer"]) expect(surface).toContain(`<${component}`)
    expect(surface).toContain('from "@/components/home/landing-interactive-shell-data"')
    expect(surface).toContain("DEMO_MESSAGES[\"demo-general\"]")
    expect(surface).toContain("CONTINUITY_WORK_MESSAGES[")
    expect(surface).not.toContain("previewRoot")
    const styles = await readFile(resolve(captureRoot, "app/globals.css"), "utf8")
    expect(styles).toContain('@import "../../src/app/globals.css"')
    expect(styles).toContain("font-size: 16px")
    const poster = await readFile(resolve(captureRoot, "captures/poster.tsx"), "utf8")
    expect(poster).toContain("<iframe")
    expect(poster).not.toContain("dangerouslySetInnerHTML")
    for (const oldInput of ["demo-phone.png", "demo-desktop.png", "duo-open-demo.jpg", "duo-closed-demo.jpg", "identity.webp", "profile.webp", "continuity.webp"]) expect(poster).not.toContain(oldInput)
    const lintProject = JSON.parse(await readFile(resolve(root, "src/web/tsconfig.eslint.json"), "utf8"))
    expect(lintProject.include).toContain("app-store-capture/**/*")
  })

  it("ships actual component viewports and JPEGs bound to the current direct source inputs", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "assets/app-store/manifest.json"), "utf8"))
    expect(manifest).toMatchObject({ clock: "2026-10-25T00:00:00Z", locale: "en-US", timezone: "UTC" })
    expect(manifest.outputs.filter(output => output.path !== "overview.jpg").map(output => output.path)).toEqual(captures.map(capture => capture.filename))
    for (const capture of captures) {
      const bytes = await readFile(resolve(root, "assets/app-store", capture.filename))
      const metadata = await sharp(bytes).metadata()
      expect(metadata).toMatchObject({ format: "jpeg", width: capture.width, height: capture.height, channels: 3, hasAlpha: false, space: "srgb" })
      const output = manifest.outputs.find(output => output.path === capture.filename)
      expect(output.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
      expect(output.surfaces.length).toBeGreaterThan(0)
      for (const surface of output.surfaces) {
        expect(surface.rootFontSize).toBe("16px")
        if (surface.scene === "workspace") {
          expect(surface.sharedShell).toBe(true)
          expect(surface.messageRows).toBeGreaterThan(0)
          expect(surface.positioningSkeletons).toBe(0)
        }
      }
    }
    const duo = manifest.outputs.find(output => output.path.startsWith("duo-"))
    expect(duo.surfaces.map(surface => [surface.width, surface.height])).toEqual([[951, 669], [466, 678]])
    expect(manifest.inputs).toEqual(await captureInputHashes())
  })

  it("keeps the original source-package manifests as history rather than live screenshot inputs", async () => {
    const approved = JSON.parse(await readFile(resolve(captureRoot, "approved-manifest.json"), "utf8"))
    const duo = JSON.parse(await readFile(resolve(captureRoot, "duo-manifest.json"), "utf8"))
    expect(approved.input_files).toHaveLength(15)
    expect(approved.approved_outputs).toHaveLength(13)
    expect(duo.inputs).toHaveLength(11)
    expect(duo.output.pixels).toEqual([2007, 2853])
    const inputs = Object.keys(await captureInputHashes())
    expect(inputs).toContain("src/web/src/components/home/landing-interactive-shell-data.ts")
    expect(inputs.some(input => /demo-(phone|desktop)\.png|duo-(open|closed)-demo\.jpg|\.html$/.test(input))).toBe(false)
  })

  it("stops its owned process group and leaves an unrelated listener alive", async () => {
    const unrelated = createServer((_request, response) => response.end("unrelated"))
    unrelated.listen(0, "127.0.0.1")
    await once(unrelated, "listening")
    const address = unrelated.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    const owned = spawn(process.execPath, ["-e", "const s=require('node:http').createServer((q,r)=>r.end('owned'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    try {
      const [line] = await once(owned.stdout, "data")
      const port = Number(line.toString().trim())
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("owned")
      await stopCaptureProcess(owned)
      await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("unrelated")
    } finally {
      await stopCaptureProcess(owned)
      unrelated.closeAllConnections()
      await new Promise<void>((resolve, reject) => unrelated.close(error => error ? reject(error) : resolve()))
    }
  })

  it("rejects invalid CLI arguments and cancellation before launching resources", async () => {
    await expect(main(["--unknown"])).rejects.toThrow("Usage:")
    await expect(main(["--output"])).rejects.toThrow("Usage:")
    const launch = vi.spyOn(chromium, "launch")
    try {
      await expect(captureArtwork({ signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled")
      expect(launch).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks() }
  })
})
