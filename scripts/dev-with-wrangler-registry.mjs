import { resolve } from "node:path"
import { startManagedCollector, stopOwnedChild } from "../src/observability/scripts/managed.mjs"
import { spawnOwnedProcess } from "../src/observability/scripts/owned-process.mjs"

const [registryPath, command, ...args] = process.argv.slice(2)
const packageManagerCli = process.env.npm_execpath

if (!registryPath || !command || !packageManagerCli) {
  throw new Error("usage: dev-with-wrangler-registry <registry-path> <command> [...args]")
}

const lifetime = new AbortController()
let child
let collector
let stopping
async function shutdown(code = 0) {
  if (stopping) return stopping
  lifetime.abort(new Error("Managed development command stopped"))
  process.exitCode = code
  stopping = Promise.all([collector?.stop(), child ? stopOwnedChild(child) : undefined])
  return stopping
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void shutdown(0) })
}

try {
  if (command === "next" && args[0] === "dev") {
    collector = await startManagedCollector({ root: resolve(process.cwd(), "../.."), packageManager: packageManagerCli, signal: lifetime.signal, onExit: () => { void shutdown(1) } })
  }
  lifetime.signal.throwIfAborted()
  child = spawnOwnedProcess(packageManagerCli, ["exec", command, ...args], {
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env, ...collector?.env, WRANGLER_REGISTRY_PATH: resolve(process.cwd(), registryPath) },
  })
  child.once("error", error => { console.error(error); void shutdown(1) })
  child.once("exit", code => { void shutdown(code ?? 1) })
} catch (error) {
  if (!lifetime.signal.aborted) console.error(error)
  await shutdown(lifetime.signal.aborted ? 0 : 1)
}
