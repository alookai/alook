import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { forceNativeGroup, spawnNativeProcess, stopNativeChild } from "./process-group.mjs"

const owners = new WeakMap()
const entry = fileURLToPath(import.meta.url)

export function spawnOwnedProcess(command, args, options = {}) {
  const output = options.stdio === "ignore" ? "ignore" : "inherit"
  const child = spawn(process.execPath, [entry, command, ...args], {
    ...options, detached: process.platform !== "win32", stdio: ["ignore", output, output, "ipc"],
  })
  const owner = { nativePid: undefined, stopping: undefined, closed: undefined }
  owner.closed = new Promise(resolveClosed => {
    child.once("error", error => resolveClosed({ error }))
    child.once("exit", (code, signal) => resolveClosed({ code, signal }))
  })
  child.on("message", message => {
    if (message?.type === "spawned" && Number.isSafeInteger(message.pid) && message.pid > 0) owner.nativePid = message.pid
    if (message?.type === "retired" && message.pid === owner.nativePid) owner.nativePid = undefined
  })
  owners.set(child, owner)
  return child
}

export function stopOwnedChild(child, platform = process.platform) {
  const owner = owners.get(child)
  if (!owner) return stopNativeChild(child, platform)
  if (owner.stopping) return owner.stopping
  owner.stopping = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (owner.nativePid) await forceNativeGroup(owner.nativePid, platform)
      owner.nativePid = undefined
      return
    }
    if (child.connected) {
      try { child.send({ type: "stop" }, () => {}) } catch {}
    }
    await Promise.race([owner.closed, delay(4000, undefined, { ref: false })])
    if (owner.nativePid) await forceNativeGroup(owner.nativePid, platform)
    owner.nativePid = undefined
    if (child.exitCode === null && child.signalCode === null) {
      await stopNativeChild(child, platform)
    }
  })()
  return owner.stopping
}

export async function runOwnedProcess({ command, args = [], runtime = process, cwd = process.cwd(), env = process.env, stdio = "inherit" } = {}) {
  if (!command) throw new Error("An owned native command is required")
  let native
  let stopping
  let complete
  const done = new Promise(resolveDone => { complete = resolveDone })
  const retired = () => { void stop(0) }
  const message = value => { if (value?.type === "stop") void stop(0) }
  async function stop(code) {
    if (stopping) return stopping
    stopping = (async () => {
      if (native) await stopNativeChild(native.child)
      if (native?.child.pid && runtime.connected) {
        await new Promise(resolveSent => {
          try { runtime.send({ type: "retired", pid: native.child.pid }, resolveSent) } catch { resolveSent() }
        })
      }
      runtime.removeListener("disconnect", retired)
      runtime.removeListener("message", message)
      runtime.removeListener("SIGINT", retired)
      runtime.removeListener("SIGTERM", retired)
      runtime.exitCode = code
      if (runtime.connected) runtime.disconnect()
      complete({ code })
    })()
    return stopping
  }
  runtime.once("disconnect", retired)
  runtime.on("message", message)
  runtime.once("SIGINT", retired)
  runtime.once("SIGTERM", retired)
  if (!runtime.connected) { await stop(0); return done }
  native = spawnNativeProcess(command, args, { cwd, env, stdio })
  if (native.child.pid && runtime.connected) {
    try { runtime.send({ type: "spawned", pid: native.child.pid }, error => { if (error) void stop(0) }) } catch { await stop(0) }
  }
  void native.closed.then(result => { if (!stopping) void stop(result.error ? 1 : result.code ?? 1) })
  return done
}

if (process.argv[1] && resolve(process.argv[1]) === entry) await runOwnedProcess({ command: process.argv[2], args: process.argv.slice(3) })
