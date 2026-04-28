import { existsSync } from "node:fs"
import { execSync } from "node:child_process"

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
  try {
    const result = execSync("npx playwright install --dry-run chromium 2>&1", { encoding: "utf8" })
    const match = result.match(/browser binaries.*?:\s*(.+)/i)
    if (match) {
      const dir = match[1].trim()
      const chromePaths = [
        `${dir}/chrome-linux/chrome`,
        `${dir}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
        `${dir}/chrome-win/chrome.exe`,
      ]
      for (const p of chromePaths) {
        if (existsSync(p)) return p
      }
    }
  } catch { /* not installed */ }
  return null
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
