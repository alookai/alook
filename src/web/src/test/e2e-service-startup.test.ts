import { EventEmitter } from "node:events"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
    resolveWsUrl: () => { throw new Error("Native startup must not resolve a split WS health URL") },
    SINGLE_RUNTIME: true,
    WEB_URL: "http://localhost:3000",
    WS_URL: "http://localhost:3000",
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

async function startPreparedServices() {
  runtime.prepareServices()
  return runtime.startServices()
}

beforeEach(async () => {
  vi.stubEnv("CI", "")
  vi.stubEnv("ALOOK_E2E_FORCE_FRESH", "")
  await loadRuntime()
  const modules = resolve(transport.root, "src/web/node_modules")
  mkdirSync(modules, { recursive: true })
  if (!existsSync(resolve(modules, "wrangler"))) {
    symlinkSync(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), resolve(modules, "wrangler"), "dir")
  }
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
  it("preserves pre-build state bytes, types and modes after a failed build under umask077", async () => {
    priorState()
    const nested = resolve(stateDir, "nested")
    mkdirSync(nested)
    const linked = resolve(nested, "original-link")
    if (process.platform !== "win32") symlinkSync("../prior-state", linked)
    chmodSync(stateDir, 0o751)
    chmodSync(nested, 0o750)
    chmodSync(priorFile, 0o644)
    const originalModes = {
      file: lstatSync(priorFile).mode & 0o777,
      state: lstatSync(stateDir).mode & 0o777,
      nested: lstatSync(nested).mode & 0o777,
    }
    const seen: unknown[] = []
    transport.spawnSync.mockImplementation((command) => {
      if (command !== "pnpm") return { status: 0, stdout: "", stderr: "" }
      seen.push({
        original: readFileSync(resolve(backupDir, "prior-state"), "utf8"),
        mode: lstatSync(resolve(backupDir, "prior-state")).mode & 0o777,
        restorePending: readLifecycleState(statePath)?.restorePending,
      })
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(priorFile, "mutated by failed build")
      return { status: 1, signal: null, stdout: "", stderr: "" }
    })
    const previousUmask = process.umask(0o077)
    try {
      expect(() => runtime.prepareServices()).toThrow("web worker build failed")
      await runtime.stopServicesAndRestore()
      expect(seen).toEqual([{ original: "original local state", mode: originalModes.file, restorePending: true }])
      expect(readFileSync(priorFile, "utf8")).toBe("original local state")
      expect(lstatSync(priorFile).mode & 0o777).toBe(originalModes.file)
      expect(lstatSync(stateDir).mode & 0o777).toBe(originalModes.state)
      expect(lstatSync(nested).mode & 0o777).toBe(originalModes.nested)
      if (process.platform !== "win32") {
        expect(originalModes).toEqual({ file: 0o644, state: 0o751, nested: 0o750 })
        expect(lstatSync(linked).isSymbolicLink()).toBe(true)
        expect(readlinkSync(linked)).toBe("../prior-state")
      }
      expect(existsSync(backupDir)).toBe(false)
      expect(transport.spawn).not.toHaveBeenCalled()
      writeFileSync(priorFile, "after restored build failure")
      await runtime.stopServicesAndRestore()
      expect(readFileSync(priorFile, "utf8")).toBe("after restored build failure")
    } finally {
      process.umask(previousUmask)
    }
  })

  it("retains the pre-build baseline through preparation and native startup", async () => {
    priorState()
    const previousSpawn = transport.spawnSync.getMockImplementation()!
    transport.spawnSync.mockImplementation((command, args, options) => {
      if (command === "pnpm" && args[1] !== "db:reset") {
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(priorFile, "build-created state")
      }
      return previousSpawn(command, args, options)
    })
    coldHealth()
    runtime.prepareServices()
    expect(readFileSync(resolve(backupDir, "prior-state"), "utf8")).toBe("original local state")
    expect(readLifecycleState(statePath)?.restorePending).toBe(true)
    const starting = runtime.startServices()
    await vi.advanceTimersByTimeAsync(1_000)
    await starting
    expect(readFileSync(resolve(backupDir, "prior-state"), "utf8")).toBe("original local state")
    await runtime.stopServicesAndRestore()
    expect(readFileSync(priorFile, "utf8")).toBe("original local state")
    expect(existsSync(initializedFile)).toBe(false)
  })

  it.each(process.platform === "win32" ? ["directory", "file"] : ["directory", "file", "dangling link"])("rejects an unresolved %s backup before a build without replacing either state", (kind) => {
    priorState()
    if (kind === "directory") {
      mkdirSync(backupDir)
      writeFileSync(resolve(backupDir, "prior-state"), "unresolved original")
    } else if (kind === "file") writeFileSync(backupDir, "unresolved original")
    else symlinkSync("missing-original", backupDir)
    expect(() => runtime.prepareServices()).toThrow("unresolved E2E state backup")
    expect(readFileSync(priorFile, "utf8")).toBe("original local state")
    if (kind === "dangling link") expect(readlinkSync(backupDir)).toBe("missing-original")
    else expect(readFileSync(kind === "directory" ? resolve(backupDir, "prior-state") : backupDir, "utf8")).toBe("unresolved original")
    expect(transport.spawnSync).not.toHaveBeenCalled()
    expect(readLifecycleState(statePath)?.restorePending).toBe(false)
  })

  it.each(process.platform === "win32" ? ["file"] : ["file", "dangling link"])("rejects a %s state root before changing it or building", (kind) => {
    mkdirSync(dirname(stateDir), { recursive: true })
    if (kind === "file") writeFileSync(stateDir, "unexpected state file")
    else symlinkSync("missing-state", stateDir)
    expect(() => runtime.prepareServices()).toThrow("E2E local state must be a directory")
    if (kind === "file") expect(readFileSync(stateDir, "utf8")).toBe("unexpected state file")
    else expect(readlinkSync(stateDir)).toBe("missing-state")
    expect(existsSync(backupDir)).toBe(false)
    expect(transport.spawnSync).not.toHaveBeenCalled()
    expect(readLifecycleState(statePath)?.restorePending).toBe(false)
  })

  it("does not back up build-created state when no local state existed before preparation", async () => {
    const previousSpawn = transport.spawnSync.getMockImplementation()!
    transport.spawnSync.mockImplementation((command, args, options) => {
      if (command === "pnpm" && args[1] !== "db:reset") {
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(priorFile, "build-created state")
      }
      return previousSpawn(command, args, options)
    })
    coldHealth()
    expect(existsSync(stateDir)).toBe(false)
    runtime.prepareServices()
    expect(readFileSync(priorFile, "utf8")).toBe("build-created state")
    expect(readLifecycleState(statePath)?.restorePending).toBe(false)
    const starting = runtime.startServices()
    await vi.advanceTimersByTimeAsync(1_000)
    await starting
    expect(existsSync(backupDir)).toBe(false)
    expect(readLifecycleState(statePath)?.restorePending).toBe(false)
    await runtime.stopServicesAndRestore()
    expect(existsSync(priorFile)).toBe(false)
    expect(existsSync(initializedFile)).toBe(true)
  })

  it("waits for the native graph's exact health before warmup and owns its process group", async () => {
    const web = heldHealth()
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "http://localhost:3000/api/health") return web.promise.then(health)
      return Promise.resolve(health())
    }))

    const starting = startPreparedServices()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.spawn).toHaveBeenCalledTimes(1)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.services.map((service) => service.name)).toEqual(["web-zones"])
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "http://localhost:3000/c")).toBe(false)

    web.release()
    await vi.advanceTimersByTimeAsync(0)
    expect((await starting).map((service) => service.name)).toEqual(["web-zones"])
    expect(transport.spawn).toHaveBeenCalledTimes(1)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("healthy")
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "http://localhost:3000/c")).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /:(8789|8790)\//.test(String(url)))).toBe(false)
    await runtime.stopServicesAndRestore()
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("stopped")
    expect(process.kill).toHaveBeenCalledWith(-children[0].pid, "SIGTERM")
  })

  it("rejects a native graph exit during readiness and never reaches warmup", async () => {
    const web = heldHealth()
    vi.stubGlobal("fetch", vi.fn(() => web.promise.then(health)))

    const starting = startPreparedServices()
    const failed = expect(starting).rejects.toThrow("web-zones exited before readiness (code 1, signal null)")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.spawn).toHaveBeenCalledTimes(1)
    children[0].exitCode = 1
    children[0].emit("close", 1, null)
    await failed

    expect(transport.spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "http://localhost:3000/c")).toBe(false)
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.failure).toMatchObject({ service: "web-zones", kind: "child-close", code: 1 })
    await runtime.stopServicesAndRestore()
    expect(readLifecycleState(resolve(transport.root, "state.json"))?.status).toBe("stopped")
    expect(process.kill).toHaveBeenCalledWith(-children[0].pid, "SIGTERM")
  })

  it("initializes an absent database before the first spawn under default local cold startup", async () => {
    coldHealth()
    const spawnChild = transport.spawn.getMockImplementation()!
    const initializedAtSpawn: boolean[] = []
    transport.spawn.mockImplementation(() => {
      initializedAtSpawn.push(existsSync(initializedFile))
      return spawnChild()
    })

    const starting = startPreparedServices()
    await vi.advanceTimersByTimeAsync(1_000)
    await starting

    expect(resetCalls()).toHaveLength(1)
    expect(resetCalls()[0]).toEqual(["pnpm", ["run", "db:reset"], {
      cwd: transport.root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"],
    }])
    expect(initializedAtSpawn).toEqual([true])
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
    const starting = startPreparedServices()
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

  it("starts an owned native graph even if prior services look healthy and restores local state", async () => {
    priorState()
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(health())))

    const starting = startPreparedServices()
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await starting).map(({ name }) => name)).toEqual(["web-zones"])
    expect(transport.spawn).toHaveBeenCalledTimes(1)
    expect(resetCalls()).toHaveLength(1)
    expect(readFileSync(resolve(backupDir, "prior-state"), "utf8")).toBe("original local state")
    expect(existsSync(priorFile)).toBe(false)
    expect(readLifecycleState(statePath)).toMatchObject({ status: "healthy", restorePending: true, services: [{ name: "web-zones" }] })
    await runtime.stopServicesAndRestore()
    expect(process.kill).toHaveBeenCalledWith(-children[0].pid, "SIGTERM")
    expect(readFileSync(priorFile, "utf8")).toBe("original local state")
    expect(existsSync(backupDir)).toBe(false)
    expect(readLifecycleState(statePath)).toMatchObject({ status: "stopped", restorePending: false })
  })

  it("does not probe or adopt the old split services before initializing the native graph", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url === "http://localhost:8789/health" && children.length === 0
        ? new Response('{"status":"unavailable"}', { status: 503 })
        : health(),
    )))
    const starting = startPreparedServices()
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await starting).map(({ name }) => name)).toEqual(["web-zones"])
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /:(8789|8790)\//.test(String(url)))).toBe(false)
    expect(resetCalls()).toHaveLength(1)
    expect(readFileSync(initializedFile, "utf8")).toBe("initialized")
  })

  it.each([
    ["ALOOK_E2E_FORCE_FRESH", 1],
    ["CI", 1],
  ] as const)("starts fresh under %s even if existing health would match", async (key, count) => {
    vi.stubEnv(key, "1")
    await loadRuntime()
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(health())))
    const spawnChild = transport.spawn.getMockImplementation()!
    const initialProbeCounts: number[] = []
    transport.spawn.mockImplementation(() => {
      initialProbeCounts.push(vi.mocked(fetch).mock.calls.length)
      return spawnChild()
    })

    const starting = startPreparedServices()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await starting).toHaveLength(count)
    expect(initialProbeCounts[0]).toBe(0)
    expect(resetCalls()).toHaveLength(1)
    expect(existsSync(initializedFile)).toBe(true)
    expect(readLifecycleState(statePath)?.restorePending).toBe(false)
  })

  it.each([false, true])("keeps a warmup500 fatal with CI=%s and restores only local prior state", async (ci) => {
    vi.stubEnv("CI", ci ? "1" : "")
    await loadRuntime()
    priorState()
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url === "http://localhost:3000/c/channels/warmup"
        ? new Response("original warmup failure", { status: 500 })
        : health(),
    )))
    const starting = startPreparedServices()
    const failed = starting.then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await failed).toMatchObject({ message: "Route warm-up failed (500 /c/channels/warmup)" })
    expect(resetCalls()).toHaveLength(1)
    expect(transport.spawn).toHaveBeenCalledTimes(1)
    expect(readLifecycleState(statePath)?.restorePending).toBe(!ci)

    const originalAtTermination: boolean[] = []
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("simulated process has stopped"), { code: "ESRCH" })
      originalAtTermination.push(existsSync(priorFile))
      return true
    })
    await runtime.stopServicesAndRestore()
    expect(originalAtTermination).toEqual([false])
    if (!ci) expect(readFileSync(priorFile, "utf8")).toBe("original local state")
    else expect(existsSync(priorFile)).toBe(false)
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
