import { spawnSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { parseArgs, resolveSourcePath, targetSpec } from "./desktop-release-artifacts.mjs"

function regularFile(path, label) {
  try {
    const stat = lstatSync(path)
    if (stat.isFile() && stat.size > 0) return
  } catch {
    throw new Error(`${label} must be a nonempty regular file`)
  }
  throw new Error(`${label} must be a nonempty regular file`)
}

function xcrun(args, label, env) {
  const result = spawnSync("xcrun", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 16 * 60 * 1000,
  })
  if (result.error || result.status !== 0) throw new Error(`${label} failed`)
  return result.stdout
}

export function notarizeDesktopDmg({ target, version, sourceRoot, env = process.env }) {
  if (target !== "macos-aarch64" && target !== "macos-x86_64") {
    throw new Error("DMG notarization requires a macOS release target")
  }
  const dmg = targetSpec(target, version).find(asset => asset.source.endsWith(".dmg"))
  const path = resolveSourcePath(sourceRoot, dmg.source)
  regularFile(path, "Final DMG")
  for (const name of ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"]) {
    if (!env[name]?.trim()) throw new Error(`Missing required macOS notarization input: ${name}`)
  }
  regularFile(env.APPLE_API_KEY_PATH, "Apple API key file")
  const output = xcrun([
    "notarytool", "submit", path,
    "--key", env.APPLE_API_KEY_PATH,
    "--key-id", env.APPLE_API_KEY,
    "--issuer", env.APPLE_API_ISSUER,
    "--wait", "--timeout", "15m", "--output-format", "json",
  ], "Final DMG notarization submission", env)
  let result
  try {
    result = JSON.parse(output)
  } catch {
    throw new Error("Final DMG notarization returned invalid JSON")
  }
  if (result?.status !== "Accepted") throw new Error("Final DMG notarization was not Accepted")
  xcrun(["stapler", "staple", path], "Final DMG stapling", env)
  xcrun(["stapler", "validate", path], "Final DMG ticket validation", env)
  return path
}

export function main(argv = process.argv.slice(2), runtime = process) {
  const args = parseArgs(["notarize", ...argv])
  const path = notarizeDesktopDmg({ target: args.target, version: args.version, sourceRoot: args.source, env: runtime.env })
  runtime.stdout.write(`Final DMG notarized, stapled and validated: ${path}\n`)
}

export function runIfMain(metaUrl, argvPath = process.argv[1], argv = process.argv.slice(2), runtime = process) {
  if (!argvPath || metaUrl !== pathToFileURL(argvPath).href) return false
  try {
    main(argv, runtime)
  } catch (error) {
    runtime.stderr.write(`${error.message}\n`)
    runtime.exitCode = 1
  }
  return true
}

runIfMain(import.meta.url)
