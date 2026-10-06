import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

export function prepareIosDevelopmentPlist(plistPath) {
  if (!existsSync(plistPath)) return false
  const tool = "/usr/libexec/PlistBuddy"
  const result = spawnSync(tool, ["-c", "Print :WKAppBoundDomains", plistPath], { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (/Does Not Exist/.test(result.stderr)) return false
    throw new Error(result.stderr || "Could not inspect iOS development plist")
  }
  const removal = spawnSync(tool, ["-c", "Delete :WKAppBoundDomains", plistPath], { encoding: "utf8" })
  if (removal.error) throw removal.error
  if (removal.status !== 0) throw new Error(removal.stderr || "Could not remove release App-Bound domains")
  return true
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const desktopRoot = fileURLToPath(new URL("../", import.meta.url))
  prepareIosDevelopmentPlist(resolve(desktopRoot, "src-tauri/gen/apple/alook-desktop_iOS/Info.plist"))
  const result = spawnSync("pnpm", ["tauri", "ios", "dev", ...process.argv.slice(2)], {
    cwd: desktopRoot,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
