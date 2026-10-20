import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

export function spawnNativeProcess(command, args, options) {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" })
  return { child, closed: closed(child) }
}

function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise(resolveClosed => {
    child.once("error", error => resolveClosed({ error }))
    child.once("exit", (code, signal) => resolveClosed({ code, signal }))
  })
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal) } catch (error) { if (error.code !== "ESRCH") throw error }
}

export async function forceNativeGroup(pid, platform = process.platform) {
  if (platform === "win32") {
    const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    await closed(child)
  } else signalGroup(pid, "SIGKILL")
}

export async function stopNativeChild(child, platform = process.platform) {
  if (!child.pid) return
  if (platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) await forceNativeGroup(child.pid, platform)
    return
  }
  const completion = closed(child)
  signalGroup(child.pid, "SIGTERM")
  await Promise.race([completion, delay(1500, undefined, { ref: false })])
  await forceNativeGroup(child.pid, platform)
  await completion
}
