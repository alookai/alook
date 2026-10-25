import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chromium } from "@playwright/test"
import sharp from "sharp"

const captureRoot = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(captureRoot, "..")
const repositoryRoot = path.resolve(webRoot, "../..")
const stories = ["share-agents", "teamwork", "companion", "context", "phone", "existing-setup"]

export const captures = [
  ...[{ width: 1206, height: 2622 }, { width: 1320, height: 2868 }].flatMap(({ width, height }) =>
    stories.map((story, index) => ({
      width, height,
      url: `/index.html?clean&slide=${index + 1}${width === 1320 ? "&large" : ""}`,
      filename: `phone-${width}x${height}/${String(index + 1).padStart(2, "0")}-${story}.jpg`,
    })),
  ),
  { width: 2064, height: 2752, url: "/tablet.html?clean", filename: "tablet-2064x2752/01-share-agents.jpg" },
  { width: 2007, height: 2853, url: "/duo.html?clean", filename: "duo-2007x2853/06-existing-setup.jpg" },
]

export const inputs = {
  "/index.html": path.join(captureRoot, "index.html"),
  "/tablet.html": path.join(captureRoot, "tablet.html"),
  "/duo.html": path.join(captureRoot, "duo.html"),
  "/alook.svg": path.join(webRoot, "public/alook.svg"),
  "/caveat.woff2": path.join(webRoot, "src/app/fonts/caveat-latin.woff2"),
  "/dm-sans.woff2": path.join(webRoot, "src/app/fonts/dm-sans-latin.woff2"),
  ...Object.fromEntries(["identity", "profile", "continuity"].map(name =>
    [`/${name}.webp`, path.join(webRoot, `public/landing/posters/${name}.webp`)])),
  ...Object.fromEntries(["demo-phone.png", "demo-desktop.png", "duo-open-demo.jpg", "duo-closed-demo.jpg", ...["red", "purple", "teal", "blue", "orange"].map(color => `face-${color}.svg`)].map(name =>
    [`/${name}`, path.join(captureRoot, "assets", name)])),
}

const contentTypes = {
  ".html": "text/html; charset=utf-8", ".png": "image/png", ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
}

export async function startArtworkServer() {
  const files = new Map(await Promise.all(Object.entries(inputs).map(async ([url, filename]) =>
    [url, { bytes: await readFile(filename), type: contentTypes[path.extname(filename)] }],
  )))
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    const file = files.get(url.pathname === "/" ? "/index.html" : url.pathname)
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end()
    } else if (request.method !== "GET" || !file) {
      response.writeHead(404).end("Not found")
    } else {
      response.writeHead(200, { "Content-Type": file.type, "Cache-Control": "no-store" }).end(file.bytes)
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    inputHashes: Object.fromEntries([...files].map(([url, file]) => [url, createHash("sha256").update(file.bytes).digest("hex")])),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

async function render(browser, origin, capture) {
  const context = await browser.newContext({
    viewport: { width: capture.width, height: capture.height },
    deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "block",
  })
  try {
    const errors = []
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      errors.push(`External request: ${route.request().url()}`)
      return route.abort()
    })
    const page = await context.newPage()
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", request => errors.push(`Failed resource: ${request.url()}`))
    page.on("response", response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`) })
    await page.goto(`${origin}${capture.url}`, { waitUntil: "networkidle" })
    await page.evaluate(async () => {
      await Promise.all([document.fonts.load("700 94px Caveat"), document.fonts.load("1000 137px DMSans")])
      await document.fonts.ready
      if (!document.fonts.check("700 94px Caveat") || !document.fonts.check("1000 137px DMSans")) throw new Error("Artwork fonts did not load")
      await Promise.all([...document.images].map(image => image.decode()))
      if ([...document.images].some(image => !image.complete || image.naturalWidth === 0)) throw new Error("Artwork image did not load")
    })
    const jpeg = await page.locator("body").screenshot({ type: "jpeg", quality: 80, scale: "css", animations: "disabled" })
    if (errors.length) throw new Error(errors.join("\n"))
    return jpeg
  } finally {
    await context.close()
  }
}

export async function captureArtwork({ output = path.join(repositoryRoot, "assets/app-store"), overview = false, signal } = {}) {
  signal?.throwIfAborted()
  const app = await startArtworkServer()
  let browser
  const abort = () => { void browser.close().catch(() => {}) }
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" })
    signal?.throwIfAborted()
    signal?.addEventListener("abort", abort, { once: true })
    const definitions = overview ? [...captures, { width: 1206, height: 1679, url: "/index.html?clean&board", filename: "overview.jpg" }] : captures
    const outputs = []
    for (const capture of definitions) {
      signal?.throwIfAborted()
      const bytes = await render(browser, app.origin, capture)
      const metadata = await sharp(bytes).metadata()
      if (metadata.format !== "jpeg" || metadata.width !== capture.width || metadata.height !== capture.height || metadata.channels !== 3 || metadata.hasAlpha || metadata.space !== "srgb") {
        throw new Error(`Invalid RGB JPEG output: ${capture.filename}`)
      }
      const filename = path.join(output, capture.filename)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, bytes)
      outputs.push({ path: capture.filename, width: metadata.width, height: metadata.height, sha256: createHash("sha256").update(bytes).digest("hex") })
    }
    const manifest = { renderer: browser.version(), encoding: "RGB JPEG quality 80", inputs: app.inputHashes, outputs }
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
  const interrupt = () => controller.abort(new Error("App Store capture interrupted"))
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
