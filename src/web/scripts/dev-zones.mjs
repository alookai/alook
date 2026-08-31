import { spawn } from "node:child_process"
import net from "node:net"
import { resolve } from "node:path"
import { createZoneIngress } from "./dev-zone-ingress.mjs"
import { LOCAL_WORKER_ENDPOINTS, workerDevArgs } from "./dev-zone-processes.mjs"

const packageManagerCli = process.env.npm_execpath
if (!packageManagerCli) throw new Error("npm_execpath is required")

const workerMode = process.argv.includes("--worker")
const registryPath = resolve(process.cwd(), "../../.wrangler/registry")
const childEnv = { ...process.env, WRANGLER_REGISTRY_PATH: registryPath }
const processes = []
let shuttingDown = false

function spawnBackend(label, args) {
  const child = spawn(packageManagerCli, args, {
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
    if (!shuttingDown) {
      console.error(`${label} exited (${signal ?? code ?? "unknown"})`)
      shutdown(code ?? 1)
    }
  })

  return child
}

function waitForPort(port, timeoutMs = 60_000) {
  const startedAt = Date.now()

  return new Promise((resolveReady, rejectReady) => {
    function probe() {
      const socket = net.createConnection({ host: "127.0.0.1", port })
      socket.once("connect", () => {
        socket.destroy()
        resolveReady()
      })
      socket.once("error", () => {
        socket.destroy()
        if (Date.now() - startedAt >= timeoutMs) {
          rejectReady(new Error(`Timed out waiting for port ${port}`))
          return
        }
        setTimeout(probe, 200)
      })
    }

    probe()
  })
}

const backendArgs = workerMode
  ? [
      workerDevArgs("wrangler.toml", LOCAL_WORKER_ENDPOINTS.main),
      workerDevArgs("blog/wrangler.toml", LOCAL_WORKER_ENDPOINTS.blog),
    ]
  : [
      ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "3001"],
      ["exec", "next", "dev", "blog", "--hostname", "127.0.0.1", "--port", "3002"],
    ]

spawnBackend("main backend", backendArgs[0])
spawnBackend("Blog backend", backendArgs[1])

const ingress = createZoneIngress()

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
  if (ingress.server.listening) await ingress.close().catch(() => {})
  process.exitCode = exitCode
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(0))
}

try {
  await Promise.all([waitForPort(3001), waitForPort(3002)])
  await ingress.listen()
  console.log(
    `Alook multi-zone ${workerMode ? "Worker" : "Next"} development ready at http://127.0.0.1:3000`,
  )
} catch (error) {
  console.error(error)
  await shutdown(1)
}
