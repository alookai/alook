import { spawn, execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { chromium } from "@playwright/test"
import sharp from "sharp"

const captureRoot = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(captureRoot, "..")
const repositoryRoot = path.resolve(webRoot, "../..")
const stories = ["share-agents", "teamwork", "companion", "context", "phone", "existing-setup"]
const require = createRequire(import.meta.url)

export const captures = [
  ...[{ width: 1206, height: 2622 }, { width: 1320, height: 2868 }].flatMap(({ width, height }) =>
    stories.map((story, index) => ({ width, height, url: `/?story=${index + 1}${width === 1320 ? "&large=1" : ""}`, filename: `phone-${width}x${height}/${String(index + 1).padStart(2, "0")}-${story}.jpg` }))),
  { width: 2064, height: 2752, url: "/?kind=tablet", filename: "tablet-2064x2752/01-share-agents.jpg" },
  { width: 2007, height: 2853, url: "/?kind=duo", filename: "duo-2007x2853/06-existing-setup.jpg" },
]

export async function captureInputHashes() {
  const files = ["capture.mjs", "next.config.ts", "postcss.config.mjs", "tsconfig.json"].map(file => path.join(captureRoot, file))
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(filename)
      else if (/\.(tsx?|css|mjs)$/.test(filename)) files.push(filename)
    }
  }
  await walk(path.join(captureRoot, "app"))
  await walk(path.join(captureRoot, "captures"))
  files.push(path.join(repositoryRoot, "pnpm-lock.yaml"), path.join(webRoot, "src/app/globals.css"), path.join(webRoot, "src/app/fonts.ts"), path.join(webRoot, "src/app/favicon.ico"), path.join(webRoot, "public/alook.svg"))
  for (const name of ["landing-interactive-shell.tsx", "landing-interactive-shell-data.ts", "landing-interactive-shell.module.css", "landing-shell-motion.tsx", "landing-shell-motion-timeline.ts", "landing-shell-motion.module.css", "landing-profile-content.tsx", "landing-human-avatars.ts", "landing-demo-copy.ts"]) files.push(path.join(webRoot, "src/components/home", name))
  for (const name of ["caveat-latin", "dm-sans-latin", "dm-mono-latin-400", "instrument-serif-latin-400", "instrument-serif-latin-400-italic", "literata-latin", "vt323-latin-400"]) files.push(path.join(webRoot, "src/app/fonts", `${name}.woff2`))
  for (const color of ["red", "purple", "teal", "blue", "orange"]) files.push(path.join(captureRoot, "assets", `face-${color}.svg`))
  for (const name of ["lin", "alex", "nina", "priya", "sam"]) files.push(path.join(webRoot, "public/landing/people", `${name}.webp`))
  return Object.fromEntries(await Promise.all(files.sort().map(async filename => [path.relative(repositoryRoot, filename), createHash("sha256").update(await readFile(filename)).digest("hex")])))
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

export async function stopCaptureProcess(child) {
  if (!child?.pid) return
  const target = process.platform === "win32" ? child.pid : -child.pid
  const exists = () => { try { process.kill(target, 0); return true } catch { return false } }
  if (!exists()) return
  try { process.kill(target, "SIGTERM") } catch { return }
  const deadline = Date.now() + 3000
  while (exists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  if (exists()) {
    try { process.kill(target, "SIGKILL") } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit")
}

async function startCaptureApp({ signal } = {}) {
  signal?.throwIfAborted()
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", captureRoot, "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: webRoot, detached: process.platform !== "win32", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""
  let spawnError
  child.on("error", error => { spawnError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data.toString()).slice(-12000) })
  let closing
  const close = () => closing ??= (async () => { signal?.removeEventListener("abort", abort); await stopCaptureProcess(child) })()
  const abort = () => { void close() }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Capture app exited: ${logs}`)
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(2000) })
        if (response.ok) return { origin, close }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`Capture app did not become ready: ${logs}`)
  } catch (error) { await close(); throw error }
}

async function render(browser, origin, capture) {
  const context = await browser.newContext({ viewport: { width: capture.width, height: capture.height }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC" })
  try {
    const errors = []
    context.setDefaultTimeout(30000)
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      errors.push(`External request: ${route.request().url()}`)
      return route.abort()
    })
    const page = await context.newPage()
    await page.clock.install({ time: new Date("2026-10-25T00:00:00Z") })
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", request => errors.push(`Failed resource: ${request.url()}`))
    page.on("response", response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`) })
    const response = await page.goto(`${origin}${capture.url}`, { waitUntil: "networkidle", timeout: 120000 })
    if (!response?.ok()) throw new Error(`Artwork page failed: ${errors.join("\n")}`)
    await page.locator("#capture-poster").waitFor()
    const surfaces = []
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
      await frame.locator('[data-capture-ready="true"]').waitFor({ timeout: 120000 })
      const scene = await frame.locator("[data-capture-surface]").getAttribute("data-capture-surface")
      if (scene === "workspace" && await frame.evaluate(() => innerWidth < 640)) {
        await frame.getByTestId("community-channel-row-demo-general").click()
        await frame.locator('[data-community-mobile-surface="detail"]').waitFor({ state: "visible" })
      }
      if (scene === "workspace") {
        await frame.locator('[data-message-list-content][data-initial-position-phase="revealed"][aria-hidden="false"]').waitFor({ state: "visible" })
        await frame.locator('[data-message-list-skeleton]').waitFor({ state: "hidden" })
        await frame.getByTestId("community-message-scroller").evaluate(element => element.scrollTo({ top: 0, behavior: "instant" }))
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await frame.locator('[data-message-row-key]').first().waitFor({ state: "visible" })
      }
      const measured = await frame.evaluate(async () => {
        await document.fonts.ready
        await Promise.all([...document.images].map(image => image.decode()))
        return { width: innerWidth, height: innerHeight, rootFontSize: getComputedStyle(document.documentElement).fontSize, sharedShell: !!document.querySelector('[data-slot="community-shell-root"]'), messageRows: document.querySelectorAll('[data-message-row-key]').length, positioningSkeletons: document.querySelectorAll('[data-message-list-skeleton]').length }
      })
      if (measured.rootFontSize !== "16px") throw new Error(`Unexpected App root type: ${measured.rootFontSize}`)
      if (scene === "workspace" && !measured.sharedShell) throw new Error("Shared Web shell did not render")
      surfaces.push({ scene, ...measured })
    }
    if (!surfaces.length) throw new Error("No real component surface rendered")
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())) })
    const bytes = await page.locator("#capture-poster").screenshot({ type: "jpeg", quality: 80, scale: "css", animations: "disabled" })
    if (errors.length) throw new Error(errors.join("\n"))
    return { bytes, surfaces }
  } finally { await context.close() }
}

export async function captureArtwork({ output = path.join(repositoryRoot, "assets/app-store"), overview = false, signal } = {}) {
  signal?.throwIfAborted()
  const app = await startCaptureApp({ signal })
  let browser
  const abort = () => { void browser?.close().catch(() => {}) }
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" })
    signal?.throwIfAborted()
    signal?.addEventListener("abort", abort, { once: true })
    const outputs = []
    for (const capture of captures) {
      signal?.throwIfAborted()
      const { bytes, surfaces } = await render(browser, app.origin, capture)
      const metadata = await sharp(bytes).metadata()
      if (metadata.format !== "jpeg" || metadata.width !== capture.width || metadata.height !== capture.height || metadata.channels !== 3 || metadata.hasAlpha || metadata.space !== "srgb") throw new Error(`Invalid RGB JPEG: ${capture.filename}`)
      const filename = path.join(output, capture.filename)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, bytes)
      outputs.push({ path: capture.filename, width: metadata.width, height: metadata.height, sha256: createHash("sha256").update(bytes).digest("hex"), surfaces })
    }
    if (overview) {
      const tiles = await Promise.all(outputs.slice(0, 6).map(async (entry, index) => ({ input: await sharp(path.join(output, entry.path)).resize(368, 800).toBuffer(), left: 28 + (index % 3) * 391, top: 28 + Math.floor(index / 3) * 823 })))
      const bytes = await sharp({ create: { width: 1206, height: 1679, channels: 3, background: "#f3e6d4" } }).composite(tiles).jpeg({ quality: 80 }).toBuffer()
      await writeFile(path.join(output, "overview.jpg"), bytes)
      outputs.push({ path: "overview.jpg", width: 1206, height: 1679, sha256: createHash("sha256").update(bytes).digest("hex"), surfaces: [] })
    }
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    const manifest = { renderer: browser.version(), encoding: "RGB JPEG quality 80", clock: "2026-10-25T00:00:00Z", locale: "en-US", timezone: "UTC", repositoryHead: stdout.trim(), inputs: await captureInputHashes(), outputs }
    await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } finally {
    signal?.removeEventListener("abort", abort)
    try { await browser?.close() } finally { await app.close() }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--overview") options.overview = true
    else if (args[index] === "--output" && args[index + 1] && !args[index + 1].startsWith("--")) options.output = path.resolve(args[++index])
    else throw new Error("Usage: pnpm app-store:capture [--output directory] [--overview]")
  }
  const controller = new AbortController()
  const interrupt = () => {
    process.exitCode = 1
    controller.abort(new Error("App Store capture interrupted"))
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    const manifest = await captureArtwork({ ...options, signal: controller.signal })
    process.stdout.write(`Captured ${manifest.outputs.length} App Store artwork images with Chrome ${manifest.renderer}\n`)
    return manifest
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1 })
