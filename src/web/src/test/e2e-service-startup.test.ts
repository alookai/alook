import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), root: "" }))

vi.mock("child_process", () => ({ spawn: transport.spawn, spawnSync: transport.spawnSync }))
vi.mock("./e2e-ui/_setup/paths", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  transport.root = fs.mkdtempSync(path.resolve(os.tmpdir(), "alook-service-startup-"))
  return {
    REPO_ROOT: transport.root,
    SERVICE_LOG_DIR: path.resolve(transport.root, "logs"),
    SERVICE_STATE_PATH: path.resolve(transport.root, "state.json"),
    WEB_URL: "http://localhost:3000",
    WS_URL: "http://localhost:8789",
    QUEUE_URL: "http://localhost:8790",
  }
})

vi.stubEnv("CI", "")
vi.stubEnv("ALOOK_E2E_FORCE_FRESH", "1")
const { startServices, stopServicesAndRestore, stopHealthSupervisor } = await import("./e2e-ui/_setup/services")
const { createLifecycleState, readLifecycleState, writeLifecycleState } = await import("./e2e-ui/_setup/service-lifecycle")

type SimulatedChild = EventEmitter & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null }
const children: SimulatedChild[] = []
const health = () => new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } })

function heldHealth() {
  let release!: () => void
  const promise = new Promise<void>((resolveResponse) => { release = resolveResponse })
  return { promise, release }
}

beforeEach(() => {
  children.length = 0
  transport.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 2_000_000_000 + children.length, exitCode: null, signalCode: null })
    children.push(child)
    return child
  })
  transport.spawnSync.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" })
  writeLifecycleState(resolve(transport.root, "state.json"), createLifecycleState())
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("simulated process has stopped"), { code: "ESRCH" })
    return true
  })
  vi.useFakeTimers()
})

afterEach(async () => {
  stopHealthSupervisor()
  await stopServicesAndRestore()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(() => {
  rmSync(transport.root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe("normal UI service startup", () => {
  it("waits for each exact health before launching the next shared-state runtime", async () => {
    const web = heldHealth(), ws = heldHealth()
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "http://localhost:3000/api/health") return web.promise.then(health)
      if (url === "http://localhost:8789/health") return ws.promise.then(health)
      return Promise.resolve(health())
    }))

    const starting = startServices()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.spawn).toHaveBeenCalledTimes(1)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.services.map((service) => service.name)).toEqual(["web"])

    web.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.spawn).toHaveBeenCalledTimes(2)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.services.map((service) => service.name)).toEqual(["web", "ws-do"])

    ws.release()
    await vi.advanceTimersByTimeAsync(0)
    expect((await starting).map((service) => service.name)).toEqual(["web", "ws-do", "queue-worker"])
    expect(transport.spawn).toHaveBeenCalledTimes(3)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("healthy")
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "http://localhost:8790/health")).toBe(true)
    await stopServicesAndRestore()
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("stopped")
    expect(process.kill).toHaveBeenCalledWith(-children[0].pid, "SIGTERM")
  })

  it("rejects an exit during readiness and never launches later services", async () => {
    const ws = heldHealth()
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "http://localhost:8789/health" ? ws.promise.then(health) : Promise.resolve(health())))

    const starting = startServices()
    const failed = expect(starting).rejects.toThrow("ws-do exited before readiness (code 1, signal null)")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.spawn).toHaveBeenCalledTimes(2)
    children[1].exitCode = 1
    children[1].emit("close", 1, null)
    await failed

    expect(transport.spawn).toHaveBeenCalledTimes(2)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.failure).toMatchObject({ service: "ws-do", kind: "child-close", code: 1 })
    await stopServicesAndRestore()
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("stopped")
    expect(process.kill).toHaveBeenCalledWith(-children[1].pid, "SIGTERM")
  })
})
