import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { chromium } from "@playwright/test"
import sharp from "sharp"

const directory = path.dirname(fileURLToPath(import.meta.url))
const captureRoot = path.dirname(directory)
const webRoot = path.dirname(captureRoot)
const repositoryRoot = path.resolve(webRoot, "../..")
const source = JSON.parse(readFileSync(path.join(directory, "source.json"), "utf8"))
const colors = ["blue", "teal", "purple", "red"]
const resources = new Map([
  ["/artwork.css", { file: path.join(directory, "artwork.css"), type: "text/css; charset=utf-8" }],
  ["/noise.svg", { file: path.join(directory, "noise.svg"), type: "image/svg+xml" }],
  ["/alook.svg", { file: path.join(webRoot, "public/alook.svg"), type: "image/svg+xml" }],
  ["/fonts/caveat.woff2", { file: path.join(webRoot, "src/app/fonts/caveat-latin.woff2"), type: "font/woff2" }],
  ["/fonts/dm-sans.woff2", { file: path.join(webRoot, "src/app/fonts/dm-sans-latin.woff2"), type: "font/woff2" }],
  ...colors.map(color => [`/faces/face-${color}.svg`, { file: path.join(captureRoot, "assets", `face-${color}.svg`), type: "image/svg+xml" }]),
])

export const creativeCaptures = source.assets

export function selectCreatives(asset = "all") {
  if (asset === "all") return creativeCaptures
  const capture = creativeCaptures.find(capture => capture.asset === asset)
  if (!capture) throw new Error("Invalid creative asset: use all, header or search")
  return [capture]
}

export function creativeDocument(asset = "header") {
  if (asset === "all") throw new Error("A document requires header or search")
  const capture = selectCreatives(asset)[0]
  const faces = asset === "header" ? ["teal", "purple", "blue", "red"] : colors
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alook creative artwork</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/artwork.css"></head><body><div id="capture-creative" style="width:${capture.width}px;height:${capture.height}px"><section class="canvas ${asset}-art" style="transform:scale(${capture.width / capture.logicalWidth})" role="img" aria-label="Alook ${asset} artwork">
<div class="brand" data-creative-critical="brand"><img src="/alook.svg" alt="" data-creative-critical="logo">Alook</div>
<h2 class="headline" data-creative-critical="headline"><span>Multi-Agent</span> <span class="accent">Collaboration</span></h2><p class="subline" data-creative-critical="subline">for Team and Friends</p>
${faces.map(color => `<img class="face face-${color}" src="/faces/face-${color}.svg" alt="" data-creative-critical="face-${color}">`).join("")}</section></div></body></html>`
}

export async function creativeInputHashes() {
  const files = new Set(["capture.mjs", "artwork.css", "noise.svg", "source.json"].map(file => path.join(directory, file)))
  for (const resource of resources.values()) files.add(resource.file)
  files.add(path.join(repositoryRoot, "package.json"))
  files.add(path.join(repositoryRoot, "pnpm-lock.yaml"))
  return Object.fromEntries(await Promise.all([...files].sort().map(async file => [path.relative(repositoryRoot, file).split(path.sep).join("/"), createHash("sha256").update(await readFile(file)).digest("hex")])))
}

export async function startCreativeServer() {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (request.method !== "GET") { response.writeHead(405); response.end("Method not allowed"); return }
      if (url.pathname === "/") {
        let document
        try { document = creativeDocument(url.searchParams.get("asset") ?? "header") } catch { response.writeHead(400); response.end("Unknown creative asset"); return }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(document); return
      }
      const resource = resources.get(url.pathname)
      if (!resource) { response.writeHead(404); response.end("Not found"); return }
      const bytes = await readFile(resource.file)
      response.writeHead(200, { "Content-Type": resource.type }); response.end(bytes)
    })().catch(() => { if (!response.destroyed && !response.writableEnded) { response.writeHead(500); response.end("Creative resource unavailable") } })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
  })
  const address = server.address()
  let closing
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closing ??= new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }),
  }
}

async function renderCreative(browser, origin, capture) {
  const context = await browser.newContext({ viewport: { width: capture.width, height: capture.height }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC" })
  try {
    const errors = [], requests = new Set()
    context.setDefaultTimeout(30000)
    await context.route("**/*", route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) { requests.add(url.pathname); return route.continue() }
      errors.push(`External request: ${url.href}`); return route.abort()
    })
    const page = await context.newPage()
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", request => errors.push(`Failed resource: ${request.url()}`))
    page.on("response", response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`) })
    const response = await page.goto(`${origin}/?asset=${capture.asset}`, { waitUntil: "networkidle" })
    if (!response?.ok()) throw new Error(`Creative page failed: ${errors.join("\n")}`)
    const measured = await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map(image => image.decode()))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const canvas = document.querySelector("#capture-creative").getBoundingClientRect()
      return {
        width: canvas.width, height: canvas.height,
        fontsLoaded: document.fonts.check("700 146px Brand") && document.fonts.check("1000 62px Sans"),
        images: [...document.images].map(image => ({ path: new URL(image.currentSrc).pathname, width: image.naturalWidth, height: image.naturalHeight })),
        criticalBounds: [...document.querySelectorAll("[data-creative-critical]")].map(element => { const rect = element.getBoundingClientRect(); return { name: element.getAttribute("data-creative-critical"), x: rect.x - canvas.x, y: rect.y - canvas.y, width: rect.width, height: rect.height } }),
      }
    })
    if (!measured.fontsLoaded || measured.width !== capture.width || measured.height !== capture.height || measured.images.length !== 5 || measured.criticalBounds.length !== 8) throw new Error("Incomplete creative layout or fonts")
    const safe = capture.safeArea
    for (const rect of measured.criticalBounds) {
      if (rect.x < safe.x - .1 || rect.y < safe.y - .1 || rect.x + rect.width > safe.x + safe.width + .1 || rect.y + rect.height > safe.y + safe.height + .1) throw new Error(`Creative subject outside safe area: ${rect.name}`)
    }
    const screenshot = await page.locator("#capture-creative").screenshot({ type: "png", scale: "css", animations: "disabled" })
    if (errors.length) throw new Error(errors.join("\n"))
    const bytes = await sharp(screenshot).removeAlpha().toColourspace("srgb").png({ compressionLevel: 9 }).toBuffer()
    return { bytes, measured, resources: [...requests].sort() }
  } finally { await context.close() }
}

export async function captureCreatives({ output = path.join(repositoryRoot, "assets/app-store/creative"), asset = "all", signal } = {}) {
  const selected = selectCreatives(asset)
  signal?.throwIfAborted()
  const server = await startCreativeServer()
  let browser
  const interrupt = () => { void browser?.close().catch(() => {}) }
  signal?.addEventListener("abort", interrupt, { once: true })
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true })
    signal?.throwIfAborted()
    const outputs = []
    for (const capture of selected) {
      signal?.throwIfAborted()
      const rendered = await renderCreative(browser, server.origin, capture)
      const metadata = await sharp(rendered.bytes).metadata()
      if (metadata.format !== "png" || metadata.width !== capture.width || metadata.height !== capture.height || metadata.channels !== 3 || metadata.hasAlpha || metadata.space !== "srgb") throw new Error(`Invalid RGB PNG: ${capture.filename}`)
      await mkdir(output, { recursive: true })
      await writeFile(path.join(output, capture.filename), rendered.bytes)
      outputs.push({ path: capture.filename, asset: capture.asset, width: capture.width, height: capture.height, sha256: createHash("sha256").update(rendered.bytes).digest("hex"), safeArea: capture.safeArea, ...rendered.measured, resources: rendered.resources })
    }
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    const manifest = { renderer: browser.version(), encoding: "RGB PNG", locale: "en-US", timezone: "UTC", repositoryHead: stdout.trim(), approvedPrototypeSha256: source.approvedPrototypeSha256, inputs: await creativeInputHashes(), outputs }
    await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } catch (error) { signal?.throwIfAborted(); throw error }
  finally { signal?.removeEventListener("abort", interrupt); try { await browser?.close() } finally { await server.close() } }
}

export async function main(args = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--asset" && args[index + 1] && !args[index + 1].startsWith("--")) options.asset = args[++index]
    else if (args[index] === "--output" && args[index + 1] && !args[index + 1].startsWith("--")) options.output = path.resolve(args[++index])
    else throw new Error("Usage: pnpm app-store:creative [--asset all|header|search] [--output directory]")
  }
  const controller = new AbortController()
  const interrupt = () => { process.exitCode = 1; controller.abort(new Error("Creative capture interrupted")) }
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt)
  try {
    const manifest = await captureCreatives({ ...options, signal: controller.signal })
    process.stdout.write(`Captured ${manifest.outputs.length} App Store creative images with Chrome ${manifest.renderer}\n`)
    return manifest
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt) }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1 })
