import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chromium } from "@playwright/test"

const captureRoot = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(captureRoot, "..")
const repositoryRoot = path.resolve(webRoot, "../..")
const assetsRoot = path.join(repositoryRoot, "assets")
const readmeAssetsRoot = path.join(assetsRoot, "readme")

const featureCaptures = [
  ["#capture-identity", "one-identity.png"],
  ["#capture-memory", "memory.png"],
  ["#capture-reach", "reach.png"],
  ["#capture-local", "local-first.png"],
  ["#capture-collaboration", "collaboration.png"],
]

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Could not allocate a README capture port"))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForApp(url, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`README capture app exited with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`README capture app did not become ready at ${url}`)
}

async function stopApp(child) {
  if (child.exitCode !== null || !child.pid) return
  const signalTarget = process.platform === "win32" ? child.pid : -child.pid
  try {
    process.kill(signalTarget, "SIGTERM")
  } catch {
    return
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ])
  if (child.exitCode === null) {
    try {
      process.kill(signalTarget, "SIGKILL")
    } catch {
      return
    }
  }
}

async function openCapturePage(browser, url, options) {
  const context = await browser.newContext({
    colorScheme: "light",
    ...options,
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  return { context, page }
}

async function captureReadmeApp(browser, url) {
  const overview = await openCapturePage(browser, url, {
    viewport: { width: 1182, height: 797 },
    deviceScaleFactor: 2,
  })
  await overview.page.locator("#capture-overview").screenshot({
    path: path.join(readmeAssetsRoot, "overview.png"),
    omitBackground: true,
    scale: "device",
  })
  await overview.context.close()

  const features = await openCapturePage(browser, url, {
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  })
  for (const [selector, filename] of featureCaptures) {
    await features.page.locator(selector).screenshot({
      path: path.join(readmeAssetsRoot, filename),
      omitBackground: true,
      scale: "device",
    })
  }
  await features.context.close()
}

async function captureBanner(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 500 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  })
  const page = await context.newPage()
  const bannerSource = path.join(assetsRoot, "social-preview/readme-banner.html")
  await page.goto(pathToFileURL(bannerSource).href, { waitUntil: "networkidle" })
  await page.evaluate(() => document.fonts.ready)
  await page.locator(".card").screenshot({
    path: path.join(readmeAssetsRoot, "banner.png"),
    omitBackground: true,
    scale: "device",
  })
  await context.close()
}

async function main() {
  const pnpm = process.env.npm_execpath
  if (!pnpm) throw new Error("Run this generator through pnpm readme:capture")

  await mkdir(readmeAssetsRoot, { recursive: true })
  const port = await availablePort()
  const url = `http://127.0.0.1:${port}`
  const child = spawn(
    pnpm,
    ["exec", "next", "dev", captureRoot, "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: webRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "inherit",
    },
  )

  const stopForSignal = async () => {
    await stopApp(child)
    process.exit(1)
  }
  process.once("SIGINT", stopForSignal)
  process.once("SIGTERM", stopForSignal)

  try {
    await waitForApp(url, child)
    const browser = await chromium.launch({ headless: true, channel: "chrome" })
    try {
      await captureReadmeApp(browser, url)
      await captureBanner(browser)
    } finally {
      await browser.close()
    }
    process.stdout.write(`README assets captured from ${url}\n`)
  } finally {
    process.removeListener("SIGINT", stopForSignal)
    process.removeListener("SIGTERM", stopForSignal)
    await stopApp(child)
  }
}

await main()
