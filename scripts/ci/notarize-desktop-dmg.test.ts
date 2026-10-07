import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { targetSpec } from "./desktop-release-artifacts.mjs"
import { notarizeDesktopDmg, runIfMain } from "./notarize-desktop-dmg.mjs"

const directories: string[] = []
const repository = resolve(import.meta.dirname, "../..")
const workflow = readFileSync(join(repository, ".github/workflows/desktop-release.yml"), "utf8")

function workflowRun(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  const end = workflow.indexOf("      - name:", start + 1)
  const step = workflow.slice(start, end < 0 ? undefined : end)
  const body = step.split("        run: |\n")[1]
  if (!body) throw new Error(`Missing workflow command: ${name}`)
  return body.replace(/^          /gm, "")
}

function fixture(target = "macos-aarch64") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alook-final-dmg-")))
  directories.push(root)
  mkdirSync(join(root, "scripts/ci"), { recursive: true })
  for (const file of ["notarize-desktop-dmg.mjs", "desktop-release-artifacts.mjs", "verify-minisign.mjs"]) {
    cpSync(join(repository, "scripts/ci", file), join(root, "scripts/ci", file))
  }
  const bin = join(root, "bin")
  mkdirSync(bin)
  const source = join(root, "src/desktop/src-tauri/target/offline-target/release")
  const version = "1.2.3"
  for (const asset of targetSpec(target, version)) {
    const file = join(source, asset.source)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `original ${asset.name}`)
  }
  const key = join(root, "offline-key.p8")
  writeFileSync(key, "offline key")
  const log = join(root, "commands.jsonl")
  writeFileSync(join(bin, "xcrun"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OFFLINE_COMMAND_LOG, JSON.stringify(args) + "\\n");
const action = args[0] === "notarytool" ? "submit" : args[1];
if (process.env.OFFLINE_FAILURE === action) {
  console.error(process.env.APPLE_API_KEY + process.env.APPLE_API_ISSUER);
  process.exit(19);
}
if (action === "submit") {
  process.stdout.write(process.env.OFFLINE_REPLY || '{"status":"Accepted"}');
} else if (action === "staple") {
  fs.appendFileSync(args[2], "\\nSTAPLED");
}
`, { mode: 0o755 })
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    TARGET: "offline-target",
    STAGE_TARGET: target,
    VERSION: version,
    RUNNER_TEMP: root,
    GITHUB_ENV: join(root, "github-env"),
    APPLE_API_KEY: "offline-private-key-id",
    APPLE_API_ISSUER: "offline-private-issuer",
    APPLE_API_KEY_PATH: key,
    OFFLINE_COMMAND_LOG: log,
  }
  const stage = join(root, `desktop-release-${target}`)
  const dmg = join(source, targetSpec(target, version).find(asset => asset.source.endsWith(".dmg"))!.source)
  return { root, env, source, stage, dmg, log, version, target }
}

function pipeline(files: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = files.env) {
  return spawnSync("bash", ["-c", `set -euo pipefail\n${workflowRun("Notarize and staple final macOS DMG")}\n${workflowRun("Stage exact release bytes")}`], {
    cwd: files.root,
    env,
    encoding: "utf8",
    timeout: 15_000,
  })
}

function commands(files: ReturnType<typeof fixture>): string[][] {
  return existsSync(files.log)
    ? readFileSync(files.log, "utf8").trim().split("\n").map(line => JSON.parse(line))
    : []
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("actual DMG workflow command boundary", () => {
  it.each(["macos-aarch64", "macos-x86_64"])("stages stapled bytes only after Accepted and validation for %s", target => {
    const files = fixture(target)
    const result = pipeline(files)
    expect(result.status, result.stderr).toBe(0)
    expect(commands(files)).toEqual([
      ["notarytool", "submit", files.dmg, "--key", files.env.APPLE_API_KEY_PATH,
        "--key-id", files.env.APPLE_API_KEY, "--issuer", files.env.APPLE_API_ISSUER,
        "--wait", "--timeout", "15m", "--output-format", "json"],
      ["stapler", "staple", files.dmg],
      ["stapler", "validate", files.dmg],
    ])
    const bytes = readFileSync(files.dmg)
    expect(bytes.toString()).toContain("STAPLED")
    const manifest = JSON.parse(readFileSync(join(files.stage, "manifest.json"), "utf8"))
    const dmg = manifest.files.find((file: { name: string }) => file.name.endsWith(".dmg"))
    expect(dmg.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(readFileSync(join(files.stage, dmg.path))).toEqual(bytes)
  })

  it.each(["submit", "staple", "validate"])("fails closed on %s failure before staging and suppresses credential output", action => {
    const files = fixture()
    const result = pipeline(files, { ...files.env, OFFLINE_FAILURE: action })
    expect(result.status).not.toBe(0)
    expect(existsSync(files.stage)).toBe(false)
    expect(result.stdout + result.stderr).not.toContain(files.env.APPLE_API_KEY)
    expect(result.stdout + result.stderr).not.toContain(files.env.APPLE_API_ISSUER)
    expect(commands(files)).toHaveLength({ submit: 1, staple: 2, validate: 3 }[action as "submit" | "staple" | "validate"])
  })

  it.each(['{"status":"Invalid"}', '{"status":"In Progress"}', "null", "not json"])(
    "does not staple or stage an unaccepted response %s", reply => {
      const files = fixture()
      const result = pipeline(files, { ...files.env, OFFLINE_REPLY: reply })
      expect(result.status).not.toBe(0)
      expect(commands(files)).toHaveLength(1)
      expect(existsSync(files.stage)).toBe(false)
      expect(readFileSync(files.dmg, "utf8")).not.toContain("STAPLED")
    },
  )

  it.each(["APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"])("rejects missing %s before any external command", name => {
    const files = fixture()
    const result = pipeline(files, { ...files.env, [name]: "" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`Missing required macOS notarization input: ${name}`)
    expect(commands(files)).toEqual([])
    expect(existsSync(files.stage)).toBe(false)
  })

  it("rejects a missing final DMG before any submission or stage", () => {
    const files = fixture()
    rmSync(files.dmg)
    const result = pipeline(files)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Final DMG must be a nonempty regular file")
    expect(commands(files)).toEqual([])
    expect(existsSync(files.stage)).toBe(false)
  })

  it("rejects a missing API key file before any submission or stage", () => {
    const files = fixture()
    rmSync(files.env.APPLE_API_KEY_PATH)
    const result = pipeline(files)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Apple API key file must be a nonempty regular file")
    expect(commands(files)).toEqual([])
    expect(existsSync(files.stage)).toBe(false)
  })

  it("runs the instrumented helper through the actual external command contract", () => {
    const files = fixture()
    expect(notarizeDesktopDmg({ target: files.target, version: files.version, sourceRoot: files.source, env: files.env })).toBe(files.dmg)
    expect(commands(files)).toHaveLength(3)
  })

  it.each(["submit", "staple", "validate"])("instrumented helper rejects %s command failure", action => {
    const files = fixture()
    expect(() => notarizeDesktopDmg({
      target: files.target, version: files.version, sourceRoot: files.source,
      env: { ...files.env, OFFLINE_FAILURE: action },
    })).toThrow("failed")
  })

  it.each(['{"status":"Invalid"}', "null", "not json"])("instrumented helper rejects response %s", reply => {
    const files = fixture()
    expect(() => notarizeDesktopDmg({
      target: files.target, version: files.version, sourceRoot: files.source,
      env: { ...files.env, OFFLINE_REPLY: reply },
    })).toThrow()
  })

  it("instrumented helper rejects missing inputs and nonregular files without external calls", () => {
    const files = fixture()
    expect(() => notarizeDesktopDmg({ target: "linux-x86_64", version: files.version, sourceRoot: files.source, env: files.env })).toThrow("macOS")
    expect(() => notarizeDesktopDmg({ target: files.target, version: files.version, sourceRoot: files.source, env: { ...files.env, APPLE_API_KEY: "" } })).toThrow("APPLE_API_KEY")
    rmSync(files.dmg)
    expect(() => notarizeDesktopDmg({ target: files.target, version: files.version, sourceRoot: files.source, env: files.env })).toThrow("regular file")
    mkdirSync(files.dmg)
    expect(() => notarizeDesktopDmg({ target: files.target, version: files.version, sourceRoot: files.source, env: files.env })).toThrow("regular file")
    expect(commands(files)).toEqual([])
  })

  it("runs the CLI entry only for its own path and reports command failures", () => {
    const files = fixture()
    const helper = resolve(import.meta.dirname, "notarize-desktop-dmg.mjs")
    let stdout = ""
    let stderr = ""
    const runtime = {
      env: files.env, exitCode: 0,
      stdout: { write: (text: string) => { stdout += text } },
      stderr: { write: (text: string) => { stderr += text } },
    }
    const argv = ["--target", files.target, "--version", files.version, "--source", files.source]
    expect(runIfMain(pathToFileURL(helper).href, undefined, argv, runtime)).toBe(false)
    expect(runIfMain(pathToFileURL(helper).href, `${helper}.other`, argv, runtime)).toBe(false)
    expect(runIfMain(pathToFileURL(helper).href, helper, argv, runtime)).toBe(true)
    expect(stdout).toContain(files.dmg)
    runtime.env = { ...files.env, OFFLINE_FAILURE: "submit" }
    expect(runIfMain(pathToFileURL(helper).href, helper, argv, runtime)).toBe(true)
    expect(runtime.exitCode).toBe(1)
    expect(stderr).toContain("submission failed")
  })
})
