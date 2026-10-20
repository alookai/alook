import { randomUUID } from "node:crypto"
import net from "node:net"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { spawnOwnedProcess, stopOwnedChild } from "./owned-process.mjs"

export { stopOwnedChild } from "./owned-process.mjs"

function port(value, fallback) {
  if (value === undefined || value === "") return fallback
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error("Local observability port must be between 1 and 65535")
  return Number(value)
}

export async function assertPortAvailable(portNumber) {
  await new Promise((resolveReady, reject) => {
    const server = net.createServer()
    server.once("error", () => reject(new Error(`Local observability port ${portNumber} is occupied; the existing process was left running`)))
    server.listen({ host: "127.0.0.1", port: portNumber, exclusive: true }, () => server.close(error => error ? reject(error) : resolveReady()))
  })
}

function launch(command, args, options) {
  const child = spawnOwnedProcess(command, args, options)
  const closed = new Promise(resolveClosed => {
    child.once("error", error => resolveClosed({ error }))
    child.once("exit", (code, signal) => resolveClosed({ code, signal }))
  })
  return { child, closed }
}

async function waitForHealth(origin, runId, owned, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) throw new Error("Local observability receiver exited before readiness")
    try {
      const response = await fetch(origin + "/health", { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) })
      if (response.ok) {
        const health = await response.json()
        if (health.service !== "alook-observability" || health.schema !== 1 || health.runId !== runId) throw new Error("Local observability readiness belongs to another process")
        return
      }
      await response.body?.cancel()
    } catch (error) {
      signal.throwIfAborted()
      if (error.message === "Local observability readiness belongs to another process") throw error
    }
    await delay(100, undefined, { signal })
  }
  throw new Error("Local observability receiver did not become ready")
}

export async function startManagedCollector({ root, packageManager = process.env.npm_execpath, env = process.env, signal, onExit = () => {}, stdio = "inherit", readinessMs = 60_000 }) {
  if (!packageManager) throw new Error("npm_execpath is required to start local observability")
  const httpPort = port(env.ALOOK_OBSERVABILITY_PORT, 4318)
  const inspectorPort = env.ALOOK_OBSERVABILITY_INSPECTOR_PORT === "0" || !env.ALOOK_OBSERVABILITY_INSPECTOR_PORT ? 0 : port(env.ALOOK_OBSERVABILITY_INSPECTOR_PORT, 0)
  await assertPortAvailable(httpPort)
  if (inspectorPort) await assertPortAvailable(inspectorPort)
  const lifetime = new AbortController()
  const owned = new Set()
  let stopping
  async function stop() {
    if (stopping) return stopping
    lifetime.abort(new Error("Local observability owner stopped"))
    signal?.removeEventListener("abort", abort)
    stopping = Promise.all([...owned].map(ownedProcess => stopOwnedChild(ownedProcess.child))).then(() => {})
    return stopping
  }
  const abort = () => { void stop() }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) { await stop(); signal.throwIfAborted() }
  const runId = randomUUID()
  const persist = resolve(root, env.ALOOK_OBSERVABILITY_PERSIST_TO || "src/observability/.wrangler/state")
  const childEnv = { ...env, WRANGLER_REGISTRY_PATH: resolve(root, ".wrangler/registry") }
  const command = args => {
    lifetime.signal.throwIfAborted()
    const process = launch(packageManager, ["--filter", "@alook/observability", "exec", "wrangler", ...args], { cwd: root, env: childEnv, stdio })
    owned.add(process)
    return process
  }
  try {
    const migration = command(["d1", "migrations", "apply", "alook-observability-local", "--local", "--persist-to", persist])
    const migrated = await migration.closed
    owned.delete(migration)
    lifetime.signal.throwIfAborted()
    if (migrated.error || migrated.code !== 0) throw new Error("Local observability migrations failed", { cause: migrated.error })
    const receiver = command(["dev", "--local", "--ip", "127.0.0.1", "--port", String(httpPort), "--inspector-port", String(inspectorPort), "--persist-to", persist, "--var", "LOCAL_RUN_ID:" + runId])
    void receiver.closed.then(result => {
      if (!lifetime.signal.aborted) onExit(result)
    })
    const origin = `http://127.0.0.1:${httpPort}`
    await Promise.race([
      waitForHealth(origin, runId, receiver, lifetime.signal, readinessMs),
      receiver.closed.then(() => { throw new Error("Local observability receiver exited before readiness") }),
    ])
    lifetime.signal.throwIfAborted()
    console.log(`Alook local observations: ${origin}`)
    return { origin, env: { NEXT_PUBLIC_FARO_OTLP_ENDPOINT: origin }, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
