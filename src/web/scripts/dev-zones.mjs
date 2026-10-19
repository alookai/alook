import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import net from "node:net"
import { resolve } from "node:path"
import { createPhaseGate, createZoneIngress } from "./dev-zone-ingress.mjs"
import {
  exactWorkerDevArgs,
  LOCAL_WORKER_ENDPOINTS,
  workerDevArgs,
  assertPublicStaticInputs,
  assertPublicStaticWriteSeparation,
  phaseWorkerDefinitions,
  phaseCommandDigest,
  readPhaseFile,
  readPublicStaticManifest,
  validatePhaseCommand,
  writePhaseFile,
} from "./dev-zone-processes.mjs"

const packageManagerCli = process.env.npm_execpath
const workerMode = process.argv.includes("--worker")
const withWsDo = process.argv.includes("--with-ws-do")
const wranglerEntryFlag = process.argv.indexOf("--wrangler-entry")
const wranglerEntry = wranglerEntryFlag === -1 ? undefined : process.argv[wranglerEntryFlag + 1]
if (!packageManagerCli && !wranglerEntry) throw new Error("npm_execpath is required")
if (wranglerEntryFlag !== -1 && (!wranglerEntry || wranglerEntry.startsWith("--"))) {
  throw new Error("--wrangler-entry requires a path")
}
if ((withWsDo || wranglerEntry) && !workerMode) {
  throw new Error("--with-ws-do and --wrangler-entry require --worker")
}

const manifestFlag = process.argv.indexOf("--public-static-manifest")
const ownerFlag = process.argv.indexOf("--public-static-owner-root")
const manifestPath = manifestFlag === -1 ? undefined : process.argv[manifestFlag + 1]
const ownerRoot = ownerFlag === -1 ? undefined : process.argv[ownerFlag + 1]
if ((manifestFlag !== -1 || ownerFlag !== -1) && (!manifestPath || !ownerRoot || !wranglerEntry || !workerMode || !withWsDo)) {
  throw new Error("Public static phases require their manifest, owner root and exact combined worker mode")
}
const manifest = manifestPath ? readPublicStaticManifest(manifestPath, ownerRoot) : undefined
const runtimeRoot = resolve(process.cwd(), "../..")
if (manifest) assertPublicStaticWriteSeparation(manifest, [ownerRoot, resolve(runtimeRoot, "src/web/.wrangler/state"), resolve(runtimeRoot, "src/web/.wrangler/state.e2e-backup"), resolve(runtimeRoot, "src/web/blog/.wrangler/state"), resolve(runtimeRoot, "src/web/e2e-service-logs"), resolve(runtimeRoot, ".wrangler/registry")])
const phaseGate = manifest ? createPhaseGate() : undefined
const expectedExits = new WeakSet()
const phaseChildren = []
let phaseTimer
let phaseBusy = false
let receipt = manifest ? {
  schema: 1, runId: manifest.runId, manifestDigest: manifest.digest,
  sequence: 0, release: manifest.defaultRelease, status: "ready",
} : undefined
const receiptPath = manifest ? resolve(manifest.controlDirectory, "receipt.json") : undefined
if (manifest) {
  mkdirSync(manifest.controlDirectory, { recursive: true, mode: 0o700 })
  if (readPhaseFile(receiptPath)) throw new Error("Public static QA control directory has an unresolved previous owner")
  writePhaseFile(receiptPath, receipt)
}

const registryPath = resolve(process.cwd(), "../../.wrangler/registry")
const childEnv = { ...process.env, WRANGLER_REGISTRY_PATH: registryPath }
const processes = []
let shuttingDown = false
const lifetime = new AbortController()

function assertLive(deadline = Infinity) {
  if (shuttingDown || lifetime.signal.aborted || receipt?.status === "failed") throw new Error("Managed development owner is retired")
  if (Date.now() >= deadline) throw new Error("Managed phase exceeded its original deadline")
}

function spawnBackend(label, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
  })
  processes.push(child)

  child.once("error", (error) => {
    console.error(`${label} failed to start`, error)
    shutdown(1)
  })
  child.once("exit", (code, signal) => {
    if (!shuttingDown && !expectedExits.has(child)) {
      console.error(`${label} exited (${signal ?? code ?? "unknown"})`)
      failPhase(new Error(`${label} exited unexpectedly (${signal ?? code ?? "unknown"})`))
      shutdown(1)
    }
  })

  return child
}

function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveReady, rejectReady) => {
    let socket
    let timer
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      lifetime.signal.removeEventListener("abort", abort)
      socket?.destroy()
      if (error) rejectReady(error)
      else resolveReady()
    }
    const abort = () => finish(new Error("Managed port probe cancelled"))
    function probe() {
      try { assertLive(deadline) } catch (error) { finish(error); return }
      socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => {
        finish()
      })
      socket.setTimeout(Math.max(1, Math.min(1_000, deadline - Date.now())), () => socket.destroy(new Error("Port probe timed out")))
      socket.once("error", () => {
        socket.destroy()
        if (finished) return
        if (lifetime.signal.aborted || Date.now() >= deadline) finish(new Error(`Timed out or cancelled waiting for port ${port}`))
        else timer = setTimeout(probe, 200)
      })
    }
    lifetime.signal.addEventListener("abort", abort, { once: true })
    probe()
  })
}

async function waitForHttpOk(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastResult = "unreachable"

  while (Date.now() < deadline) {
    assertLive(deadline)
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.max(1, Math.min(3_000, deadline - Date.now())))]) })
      await response.body?.cancel()
      assertLive(deadline)
      if (response.ok) return
      lastResult = `HTTP ${response.status}`
    } catch (error) {
      lastResult = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolveRetry) => setTimeout(resolveRetry, 200))
  }

  throw new Error(`Timed out waiting for ${url} (${lastResult})`)
}

const mainWorkerConfigs = withWsDo
  ? ["wrangler.toml", "../ws-do/wrangler.toml", "../queue-worker/wrangler.toml"]
  : ["wrangler.toml"]
const workerCommand = wranglerEntry ? process.execPath : packageManagerCli
const workerArgs = (configPaths, endpoint) => wranglerEntry
  ? exactWorkerDevArgs(wranglerEntry, configPaths, endpoint)
  : workerDevArgs(configPaths, endpoint)

const backends = workerMode
  ? [
      {
        label: "main backend",
        command: workerCommand,
        args: workerArgs(mainWorkerConfigs, LOCAL_WORKER_ENDPOINTS.main),
      },
      {
        label: "Blog backend",
        command: workerCommand,
        args: workerArgs(["blog/wrangler.toml"], LOCAL_WORKER_ENDPOINTS.blog),
      },
    ]
  : [
      {
        label: "main backend",
        command: packageManagerCli,
        args: ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "3001"],
      },
      {
        label: "Blog backend",
        command: packageManagerCli,
        args: ["exec", "next", "dev", "blog", "--hostname", "127.0.0.1", "--port", "3002"],
      },
    ]

const selectedBackends = manifest ? [
  {
    label: "stable WS/queue",
    command: process.execPath,
    args: exactWorkerDevArgs(wranglerEntry, ["../ws-do/wrangler.toml", "../queue-worker/wrangler.toml"], {
      port: 8789, inspectorPort: 9230, persistTo: resolve(runtimeRoot, "src/web/.wrangler/state"),
    }),
  },
  ...phaseWorkerDefinitions(manifest, manifest.defaultRelease, wranglerEntry, runtimeRoot),
] : backends

for (const backend of selectedBackends) {
  const child = spawnBackend(backend.label, backend.command, backend.args)
  if (manifest && backend.label !== "stable WS/queue") phaseChildren.push({ label: backend.label, child })
}

const ingress = createZoneIngress({ phaseGate, wsBackend: manifest ? { hostname: "127.0.0.1", port: 8789 } : undefined })

function failPhase(error) {
  if (!manifest || receipt?.status === "failed") return
  phaseGate.fail(error)
  receipt = { ...receipt, status: "failed", failure: error instanceof Error ? error.message : String(error) }
  writePhaseFile(receiptPath, receipt)
}

async function phaseResponse(port, path, deadline) {
  assertLive(deadline)
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error("Public static phase readiness exceeded its case deadline")
  return fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.min(remaining, 3_000))]),
    headers: { host: "localhost:3000", "x-forwarded-host": "localhost:3000", "x-forwarded-port": "3000", "x-forwarded-proto": "https" },
  })
}

async function verifyRelease(name, deadline) {
  const release = manifest.releases[name]
  let lastError
  while (Date.now() < deadline) {
    try {
      const health = await phaseResponse(3001, "/api/health", deadline)
      const healthBody = await health.text()
      assertLive(deadline)
      if (health.status !== 200 || healthBody !== '{"status":"ok"}') throw new Error("Main phase exact health did not match")
      const blog = await phaseResponse(3002, "/blog", deadline)
      if (blog.status !== 200 || !(blog.headers.get("content-type") ?? "").includes("text/html")) throw new Error("Blog phase document readiness did not match")
      await blog.body?.cancel()
      assertLive(deadline)
      const sw = await phaseResponse(3001, "/sw.js", deadline)
      if (sw.status !== 200 || createHash("sha256").update(Buffer.from(await sw.arrayBuffer())).digest("hex") !== release.swSha256) throw new Error("Served phase SW bytes do not match the bound release")
      assertLive(deadline)
      for (const [zone, buildId] of [["main", release.mainBuildId], ["blog", release.blogBuildId]]) {
        for (const helper of ["_buildManifest.js", "_clientMiddlewareManifest.js", "_ssgManifest.js"]) {
          const path = `${zone === "blog" ? "/blog-static" : ""}/_next/static/${buildId}/${helper}`
          const asset = release.assets.find(value => value.url === path && value.zone === zone)
          if (!asset) throw new Error(`Phase catalogue has no actual helper: ${path}`)
          const response = await phaseResponse(zone === "main" ? 3001 : 3002, path, deadline)
          const body = Buffer.from(await response.arrayBuffer())
          assertLive(deadline)
          if (response.status !== 200 || body.length !== asset.bytes || createHash("sha256").update(body).digest("hex") !== asset.sha256) throw new Error(`Phase helper bytes do not match: ${path}`)
        }
      }
      return
    } catch (error) {
      lastError = error
      assertLive(deadline)
      if (receipt.status === "failed") throw error
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    }
  }
  throw lastError ?? new Error("Public static phase readiness expired")
}

async function stopPhaseChild({ child }) {
  assertLive(receipt.deadline)
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error("Expected phase child was not alive before registered stop")
  expectedExits.add(child)
  await new Promise((resolveStop, rejectStop) => {
    const done = (error) => { clearTimeout(timer); lifetime.signal.removeEventListener("abort", abort); child.removeListener("exit", closed); if (error) rejectStop(error); else resolveStop() }
    const abort = () => done(new Error("Registered child stop cancelled"))
    const closed = () => done()
    const timer = setTimeout(() => done(new Error("Registered phase child did not stop")), Math.max(1, Math.min(5_000, receipt.deadline - Date.now())))
    lifetime.signal.addEventListener("abort", abort, { once: true })
    child.once("exit", closed)
    child.kill("SIGTERM")
  })
}

async function pollPhase() {
  if (phaseBusy || shuttingDown) return
  phaseBusy = true
  try {
    const command = readPhaseFile(resolve(manifest.controlDirectory, "request.json"))
    if (!command || (command.sequence === receipt.sequence && phaseCommandDigest(command) === receipt.commandDigest)) return
    validatePhaseCommand(command, manifest, receipt)
    if (command.action === "release") {
      receipt = { schema: 1, runId: manifest.runId, manifestDigest: manifest.digest, sequence: command.sequence, commandDigest: phaseCommandDigest(command), release: receipt.release, status: "ready" }
      writePhaseFile(receiptPath, receipt)
      return
    }
    assertPublicStaticInputs(manifest)
    validatePhaseCommand(command, manifest, receipt)
    const previous = phaseChildren.splice(0)
    if (previous.length !== 2) throw new Error("Phase owner has no exact Main/Blog child pair")
    receipt = { ...receipt, sequence: command.sequence, caseId: command.caseId, status: "switching", deadline: command.deadline, expectedStops: previous.map(({ label, child }) => ({ label, pid: child.pid })) }
    writePhaseFile(receiptPath, receipt)
    phaseGate.hold()
    await Promise.all(previous.map(stopPhaseChild))
    assertLive(command.deadline)
    for (const definition of phaseWorkerDefinitions(manifest, command.to, wranglerEntry, runtimeRoot)) {
      assertLive(command.deadline)
      phaseChildren.push({ label: definition.label, child: spawnBackend(definition.label, definition.command, definition.args) })
    }
    await verifyRelease(command.to, command.deadline)
    assertLive(command.deadline)
    assertPublicStaticInputs(manifest)
    if (Date.now() >= command.deadline || receipt.status === "failed") throw new Error("Phase transition failed before commit")
    receipt = { schema: 1, runId: manifest.runId, manifestDigest: manifest.digest, commandDigest: phaseCommandDigest(command), sequence: command.sequence, caseId: command.caseId, release: command.to, status: "ready" }
    writePhaseFile(receiptPath, receipt)
    phaseGate.release()
  } catch (error) {
    failPhase(error)
    console.error(error)
    await shutdown(1)
  } finally {
    phaseBusy = false
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  lifetime.abort(new Error("Managed development owner stopped"))
  if (phaseTimer) clearInterval(phaseTimer)
  phaseGate?.fail(new Error("Managed public static phase owner stopped"))
  if (manifest && receipt.status !== "failed") {
    receipt = { ...receipt, status: "stopped" }
    writePhaseFile(receiptPath, receipt)
  }

  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
  try { await ingress.close() } catch (error) { console.error(error); exitCode = 1 }
  process.exitCode = exitCode
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(0))
}

try {
  await Promise.all([waitForPort(3001), waitForPort(3002)])
  assertLive()
  if (manifest) {
    await waitForHttpOk("http://127.0.0.1:8789/health")
    assertLive()
    await verifyRelease(manifest.defaultRelease, Date.now() + 60_000)
    assertLive()
  }
  await ingress.listen()
  assertLive()
  if (manifest) phaseTimer = setInterval(() => { void pollPhase() }, 100)
  if (!workerMode) await waitForHttpOk("http://127.0.0.1:3000/")
  console.log(
    `Alook multi-zone ${workerMode ? "Worker" : "Next"} development ready at http://127.0.0.1:3000`,
  )
} catch (error) {
  console.error(error)
  await shutdown(1)
}
