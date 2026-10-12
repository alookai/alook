import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
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
vi.stubEnv("ALOOK_E2E_FORCE_FRESH", "")
let runtime = await import("./e2e-ui/_setup/services")
const { createLifecycleState, readLifecycleState, writeLifecycleState } = await import("./e2e-ui/_setup/service-lifecycle")

const statePath = resolve(transport.root, "state.json")
const stateDir = resolve(transport.root, "src/web/.wrangler/state")
const backupDir = `${stateDir}.e2e-backup`
const priorFile = resolve(stateDir, "prior-state")
const initializedFile = resolve(stateDir, "initialized-state")

type SimulatedChild = EventEmitter & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null }
const children: SimulatedChild[] = []
const health = () => new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } })

function heldHealth() {
  let release!: () => void
  const promise = new Promise<void>((resolveResponse) => { release = resolveResponse })
  return { promise, release }
}

async function loadRuntime() {
  vi.resetModules()
  runtime = await import("./e2e-ui/_setup/services")
}

function priorState() {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(priorFile, "original local state")
}

function coldHealth() {
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
    url.endsWith("/health") && children.length === 0
      ? new Response('{"status":"unavailable"}', { status: 503 })
      : health(),
  )))
}

function resetCalls() {
  return transport.spawnSync.mock.calls.filter(([command, args]) => command === "pnpm" && args[1] === "db:reset")
}

beforeEach(async () => {
  vi.stubEnv("CI", "")
  vi.stubEnv("ALOOK_E2E_FORCE_FRESH", "")
  await loadRuntime()
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
  children.length = 0
  transport.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 2_000_000_000 + children.length, exitCode: null, signalCode: null })
    children.push(child)
    return child
  })
  transport.spawnSync.mockReset().mockImplementation((command, args) => {
    if (command === "pnpm" && args[1] === "db:reset") {
      rmSync(stateDir, { recursive: true, force: true })
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(initializedFile, "initialized")
    }
    return { status: 0, stdout: "", stderr: "" }
  })
  writeLifecycleState(statePath, createLifecycleState())
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("simulated process has stopped"), { code: "ESRCH" })
    return true
  })
  vi.useFakeTimers()
})

afterEach(async () => {
  runtime.stopHealthSupervisor()
  await runtime.stopServicesAndRestore()
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
    vi.stubEnv("ALOOK_E2E_FORCE_FRESH", "1")
    await loadRuntime()
    const web = heldHealth(), ws = heldHealth()
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "http://localhost:3000/api/health") return web.promise.then(health)
      if (url === "http://localhost:8789/health") return ws.promise.then(health)
      return Promise.resolve(health())
    }))

    const starting = runtime.startServices()
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
    await runtime.stopServicesAndRestore()
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("stopped")
    expect(process.kill).toHaveBeenCalledWith(-children[0].pid, "SIGTERM")
  })

  it("rejects an exit during readiness and never launches later services", async () => {
    vi.stubEnv("ALOOK_E2E_FORCE_FRESH", "1")
    await loadRuntime()
    const ws = heldHealth()
    vi.stubGlobal("fetch", vi.fn((url: string) => url === "http://localhost:8789/health" ? ws.promise.then(health) : Promise.resolve(health())))

    const starting = runtime.startServices()
    const failed = expect(starting).rejects.toThrow("ws-do exited before readiness (code 1, signal null)")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.spawn).toHaveBeenCalledTimes(2)
    children[1].exitCode = 1
    children[1].emit("close", 1, null)
    await failed

    expect(transport.spawn).toHaveBeenCalledTimes(2)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.failure).toMatchObject({ service: "ws-do", kind: "child-close", code: 1 })
    await runtime.stopServicesAndRestore()
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("stopped")
    expect(process.kill).toHaveBeenCalledWith(-children[1].pid, "SIGTERM")
  })

  it("initializes an absent database before the first spawn under default local cold startup", async () => {
    coldHealth()
    const spawnChild = transport.spawn.getMockImplementation()!
    const initializedAtSpawn: boolean[] = []
    transport.spawn.mockImplementation(() => {
      initializedAtSpawn.push(existsSync(initializedFile))
      return spawnChild()
    })

    const starting = runtime.startServices()
    await vi.advanceTimersByTimeAsync(1_000)
    await starting

    expect(resetCalls()).toHaveLength(1)
    expect(resetCalls()[0]).toEqual(["pnpm", ["run", "db:reset"], {
      cwd: transport.root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"],
    }])
    expect(initializedAtSpawn).toEqual([true, true, true])
    expect(readLifecycleState(statePath)?.restorePending).toBe(false)
    expect(existsSync(backupDir)).toBe(false)
  })

  it("backs up prior state and persists restoration before a failed reset, then restores once", async () => {
    priorState()
    coldHealth()
    const observed: Array<{ backup: string; restorePending: boolean | undefined }> = []
    transport.spawnSync.mockImplementation((command, args) => {
      if (command !== "pnpm" || args[1] !== "db:reset") return { status: 0, stdout: "", stderr: "" }
      observed.push({
        backup: readFileSync(resolve(backupDir, "prior-state"), "utf8"),
        restorePending: readLifecycleState(statePath)?.restorePending,
      })
      rmSync(stateDir, { recursive: true, force: true })
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(initializedFile, "partial reset")
      return { status: 1, signal: null, stdout: "", stderr: "migration failed\n" }
    })
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const starting = runtime.startServices()
    const failed = starting.then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await failed).toMatchObject({ message: "db:reset failed (exit 1, signal null)" })

    expect(observed).toEqual([{ backup: "original local state", restorePending: true }])
    expect(stderr).toHaveBeenCalledWith("migration failed\n")
    expect(transport.spawn).not.toHaveBeenCalled()
    await runtime.stopServicesAndRestore()
    expect(readFileSync(priorFile, "utf8")).toBe("original local state")
    expect(existsSync(initializedFile)).toBe(false)
    expect(existsSync(backupDir)).toBe(false)
    expect(readLifecycleState(statePath)).toMatchObject({ status: "stopped", restorePending: false })
    writeFileSync(priorFile, "after first restore")
    await runtime.stopServicesAndRestore()
    expect(readFileSync(priorFile, "utf8")).toBe("after first restore")
    expect(resetCalls()).toHaveLength(1)
  })

  it("reuses all exact healthy services once without owning processes or changing prior state", async () => {
    priorState()
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(health())))

    expect(await runtime.startServices()).toEqual([])
    for (const url of ["http://localhost:3000/api/health", "http://localhost:8789/health", "http://localhost:8790/health"]) {
      expect(vi.mocked(fetch).mock.calls.filter(([called]) => called === url)).toHaveLength(1)
    }
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(transport.spawnSync).not.toHaveBeenCalled()
    expect(existsSync(backupDir)).toBe(false)
    expect(readLifecycleState(statePath)).toMatchObject({ status: "healthy", restorePending: false, services: [] })
    await runtime.stopServicesAndRestore()
    expect(process.kill).not.toHaveBeenCalled()
    expect(readFileSync(priorFile, "utf8")).toBe("original local state")
  })

  it("initializes all services when only part of the required health batch matches", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url === "http://localhost:8789/health" && children.length === 0
        ? new Response('{"status":"unavailable"}', { status: 503 })
        : health(),
    )))
    const starting = runtime.startServices()
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await starting).map(({ name }) => name)).toEqual(["web", "ws-do", "queue-worker"])
    expect(resetCalls()).toHaveLength(1)
    expect(readFileSync(initializedFile, "utf8")).toBe("initialized")
  })

  it.each([
    ["ALOOK_E2E_FORCE_FRESH", 3],
    ["CI", 1],
  ] as const)("starts fresh under %s even if existing health would match", async (key, count) => {
    if (key === "CI") {
      const modules = resolve(transport.root, "src/web/node_modules")
      mkdirSync(modules, { recursive: true })
      symlinkSync(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), resolve(modules, "wrangler"), "dir")
    }
    vi.stubEnv(key, "1")
    await loadRuntime()
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(health())))
    const spawnChild = transport.spawn.getMockImplementation()!
    const initialProbeCounts: number[] = []
    transport.spawn.mockImplementation(() => {
      initialProbeCounts.push(vi.mocked(fetch).mock.calls.length)
      return spawnChild()
    })

    const starting = runtime.startServices()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await starting).toHaveLength(count)
    expect(initialProbeCounts[0]).toBe(0)
    expect(resetCalls()).toHaveLength(1)
    expect(existsSync(initializedFile)).toBe(true)
    expect(readLifecycleState(statePath)?.restorePending).toBe(false)
  })

  it.each([false, true])("keeps a warmup500 fatal with reuse=%s and preserves the correct state owner", async (reuse) => {
    priorState()
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url === "http://localhost:3000/c/channels/warmup"
        ? new Response("original warmup failure", { status: 500 })
        : !reuse && url.endsWith("/health") && children.length === 0
          ? new Response('{"status":"unavailable"}', { status: 503 })
          : health(),
    )))
    const starting = runtime.startServices()
    const failed = starting.then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await failed).toMatchObject({ message: "Route warm-up failed (500 /c/channels/warmup)" })
    expect(resetCalls()).toHaveLength(reuse ? 0 : 1)
    expect(transport.spawn).toHaveBeenCalledTimes(reuse ? 0 : 3)
    expect(readLifecycleState(statePath)?.restorePending).toBe(!reuse)

    const originalAtTermination: boolean[] = []
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("simulated process has stopped"), { code: "ESRCH" })
      originalAtTermination.push(existsSync(priorFile))
      return true
    })
    await runtime.stopServicesAndRestore()
    expect(originalAtTermination).toEqual(reuse ? [] : [false, false, false])
    expect(readFileSync(priorFile, "utf8")).toBe("original local state")
    expect(existsSync(backupDir)).toBe(false)
    expect(readLifecycleState(statePath)).toMatchObject({ status: "stopped", restorePending: false })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "http://localhost:3000/c/channels/warmup")).toHaveLength(1)
  })

  it("rejects an uninitialized lifecycle before changing the database or spawning", async () => {
    priorState()
    coldHealth()
    rmSync(statePath)
    const starting = runtime.startServices()
    const failed = starting.then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await failed).toMatchObject({ message: "service lifecycle state was not initialized" })

    expect(resetCalls()).toHaveLength(0)
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(existsSync(backupDir)).toBe(false)
    expect(readFileSync(priorFile, "utf8")).toBe("original local state")
  })
})
