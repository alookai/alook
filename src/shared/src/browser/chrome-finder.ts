import { existsSync, readdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
}

export function findChrome(): string | null {
  const platform = process.platform
  const candidates = CHROME_PATHS[platform] ?? []

  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  if (platform === "linux") {
    try {
      const result = execSync("which google-chrome || which chromium", { encoding: "utf8" }).trim()
      if (result) return result
    } catch { /* not found */ }
  }

  return findPlaywrightChromium()
}

function findPlaywrightChromium(): string | null {
  const cached = findCachedPlaywrightChromium()
  if (cached) return cached

  try {
    const result = execSync("npx playwright install --dry-run chromium 2>&1", { encoding: "utf8" })
    const match = result.match(/(?:browser binaries|Install location).*?:\s*(.+)/i)
    if (match) {
      const dir = match[1].trim()
      for (const p of getPlaywrightChromiumCandidates(dir)) {
        if (existsSync(p)) return p
      }
    }
  } catch { /* not installed */ }
  return null
}

function findCachedPlaywrightChromium(): string | null {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean) as string[]

  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root, { encoding: "utf8" })
    } catch {
      continue
    }

    for (const entry of entries.filter((item) => item.startsWith("chromium-")).sort().reverse()) {
      for (const p of getPlaywrightChromiumCandidates(join(root, entry))) {
        if (existsSync(p)) return p
      }
    }
  }

  return null
}

function getPlaywrightChromiumCandidates(dir: string): string[] {
  return [
    join(dir, "chrome-linux64", "chrome"),
    join(dir, "chrome-linux", "chrome"),
    join(dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
    join(dir, "chrome-win", "chrome.exe"),
  ]
}

export function ensureChrome(): string {
  const existing = findChrome()
  if (existing) return existing

  execSync("npx playwright install chromium", {
    stdio: "inherit",
    timeout: 120_000,
  })

  const installed = findChrome()
  if (!installed) throw new Error("Failed to install Chromium via Playwright")
  return installed
}

export function hasChromeInstalled(): boolean {
  return findChrome() !== null
}
