import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  backupState,
  cleanupFailedSetup,
  hasRecoveryArtifact,
  prepareServiceLifecycle,
  readPriorServiceManifest,
  recoveryArtifact,
  restoreState,
  startServices,
  type LifecycleDependencies,
  type ManagedService,
  type PriorServiceManifest,
  type RestorePolicy,
  type ServiceLifecycleDecision,
  type StartServicesDependencies,
  type StatePaths,
} from "./e2e-ui/_setup/services"

const temporaryRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporaryStatePaths(): StatePaths {
  const root = mkdtempSync(resolve(tmpdir(), "alook-e2e-lifecycle-"))
  temporaryRoots.push(root)
  return {
    stateDir: resolve(root, "state"),
    backupDir: resolve(root, "state.e2e-backup"),
    absentMarker: resolve(root, "state.e2e-absent"),
    manifestPath: resolve(root, "manifest.json"),
  }
}

function prior(overrides: Partial<PriorServiceManifest> = {}): PriorServiceManifest {
  return {
    servicePids: [101, 202],
    restoreState: false,
    restorePolicy: "none",
    ...overrides,
  }
}

function decision(overrides: Partial<ServiceLifecycleDecision> = {}): ServiceLifecycleDecision {
  return {
    mode: "fresh",
    ci: false,
    singleRuntime: false,
    restoreState: true,
    restorePolicy: "restore-backup",
    ...overrides,
  }
}

function lifecycleDependencies(options: {
  health?: [boolean, boolean]
  artifactHint?: boolean
  artifact?: "none" | "backup" | "absent"
  backupPolicy?: Exclude<RestorePolicy, "none">
  events?: string[]
} = {}): LifecycleDependencies {
  const events = options.events ?? []
  const health = [...(options.health ?? [false, false])]
  return {
    probeHealth: vi.fn(async () => {
      const value = health.shift() ?? false
      events.push(`probe:${value}`)
      return value
    }),
    hasRecoveryArtifact: vi.fn(() => {
      events.push("artifact-hint")
      return options.artifactHint ?? false
    }),
    recoveryArtifact: vi.fn(() => {
      events.push("artifact-read")
      return options.artifact ?? "none"
    }),
    stopOwnedAndWait: vi.fn(async (pids) => {
      events.push(`stop:${pids.join(",")}`)
    }),
    assertPortsFree: vi.fn(() => {
      events.push("ports-free")
    }),
    restoreState: vi.fn(() => {
      events.push("restore")
    }),
    backupState: vi.fn(() => {
      events.push("backup")
      return options.backupPolicy ?? "restore-backup"
    }),
    resetDb: vi.fn(() => {
      events.push("reset")
    }),
  }
}

describe("E2E service lifecycle decision", () => {
  it("reuses only when both local health probes pass and no recovery is pending", async () => {
    const events: string[] = []
    const dependencies = lifecycleDependencies({ health: [true, true], events })

    await expect(prepareServiceLifecycle(prior(), { ci: false }, dependencies)).resolves.toEqual({
      mode: "reuse",
      ci: false,
      singleRuntime: false,
      restoreState: false,
      restorePolicy: "none",
    })
    expect(events).toEqual(["probe:true", "probe:true", "artifact-hint"])
    expect(dependencies.stopOwnedAndWait).not.toHaveBeenCalled()
    expect(dependencies.backupState).not.toHaveBeenCalled()
    expect(dependencies.resetDb).not.toHaveBeenCalled()
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ] as const)("uses one fresh decision for local health %s/%s", async (web, ws) => {
    const events: string[] = []
    const dependencies = lifecycleDependencies({ health: [web, ws], events })

    await expect(prepareServiceLifecycle(prior(), { ci: false }, dependencies)).resolves.toEqual({
      mode: "fresh",
      ci: false,
      singleRuntime: false,
      restoreState: true,
      restorePolicy: "restore-backup",
    })
    expect(events).toEqual([
      `probe:${web}`,
      `probe:${ws}`,
      "artifact-hint",
      "stop:101,202",
      "ports-free",
      "artifact-read",
      "backup",
      "reset",
    ])
    expect(dependencies.probeHealth).toHaveBeenCalledTimes(2)
  })

  it("recovers a prior artifact before publishing the next snapshot", async () => {
    const events: string[] = []
    const dependencies = lifecycleDependencies({
      health: [true, true],
      artifactHint: true,
      artifact: "backup",
      backupPolicy: "remove-created-state",
      events,
    })

    const result = await prepareServiceLifecycle(
      prior({ restoreState: true, restorePolicy: "restore-backup" }),
      { ci: false },
      dependencies,
    )

    expect(result.restorePolicy).toBe("remove-created-state")
    expect(events).toEqual([
      "probe:true",
      "probe:true",
      "stop:101,202",
      "ports-free",
      "artifact-read",
      "restore",
      "backup",
      "reset",
    ])
  })

  it("hard-fails an expected restore with no durable artifact", async () => {
    const dependencies = lifecycleDependencies({ health: [false, false] })

    await expect(prepareServiceLifecycle(
      prior({ restoreState: true, restorePolicy: "restore-backup" }),
      { ci: false },
      dependencies,
    )).rejects.toThrow("requires restore")
    expect(dependencies.stopOwnedAndWait).toHaveBeenCalledWith([101, 202])
    expect(dependencies.backupState).not.toHaveBeenCalled()
    expect(dependencies.resetDb).not.toHaveBeenCalled()
  })

  it("hard-fails a manifest policy that contradicts its durable artifact", async () => {
    const dependencies = lifecycleDependencies({
      health: [false, false],
      artifact: "absent",
    })

    await expect(prepareServiceLifecycle(
      prior({ restoreState: true, restorePolicy: "restore-backup" }),
      { ci: false },
      dependencies,
    )).rejects.toThrow("contradicts absent artifact")
    expect(dependencies.restoreState).not.toHaveBeenCalled()
    expect(dependencies.backupState).not.toHaveBeenCalled()
  })

  it("hard-fails an unowned occupied port before recovery, backup, or reset", async () => {
    const dependencies = lifecycleDependencies({ health: [true, false], artifactHint: true })
    vi.mocked(dependencies.assertPortsFree).mockImplementation(() => {
      throw new Error("unowned port")
    })

    await expect(prepareServiceLifecycle(prior(), { ci: false }, dependencies))
      .rejects.toThrow("unowned port")
    expect(dependencies.recoveryArtifact).not.toHaveBeenCalled()
    expect(dependencies.backupState).not.toHaveBeenCalled()
    expect(dependencies.resetDb).not.toHaveBeenCalled()
  })

  it("does not reset when snapshot publication fails", async () => {
    const dependencies = lifecycleDependencies({ health: [false, false] })
    vi.mocked(dependencies.backupState).mockImplementation(() => {
      throw new Error("snapshot failed")
    })

    await expect(prepareServiceLifecycle(prior(), { ci: false }, dependencies))
      .rejects.toThrow("snapshot failed")
    expect(dependencies.resetDb).not.toHaveBeenCalled()
    expect(dependencies.restoreState).not.toHaveBeenCalled()
  })

  it("restores the published snapshot when reset fails", async () => {
    const events: string[] = []
    const dependencies = lifecycleDependencies({ health: [false, false], events })
    vi.mocked(dependencies.resetDb).mockImplementation(() => {
      events.push("reset-failed")
      throw new Error("reset failed")
    })

    await expect(prepareServiceLifecycle(prior(), { ci: false }, dependencies))
      .rejects.toThrow("reset failed")
    expect(events.slice(-3)).toEqual(["backup", "reset-failed", "restore"])
  })

  it("reports both reset and rollback failures", async () => {
    const dependencies = lifecycleDependencies({ health: [false, false] })
    vi.mocked(dependencies.resetDb).mockImplementation(() => {
      throw new Error("reset failed")
    })
    vi.mocked(dependencies.restoreState).mockImplementation(() => {
      throw new Error("restore failed")
    })

    await expect(prepareServiceLifecycle(prior(), { ci: false }, dependencies))
      .rejects.toThrow("state restore also failed")
  })

  it("keeps CI fresh without local probes or restore artifacts", async () => {
    const dependencies = lifecycleDependencies()

    await expect(prepareServiceLifecycle(prior(), { ci: true }, dependencies)).resolves.toEqual({
      mode: "fresh",
      ci: true,
      singleRuntime: true,
      restoreState: false,
      restorePolicy: "none",
    })
    expect(dependencies.probeHealth).not.toHaveBeenCalled()
    expect(dependencies.backupState).not.toHaveBeenCalled()
    expect(dependencies.resetDb).toHaveBeenCalledOnce()
  })
})

describe("E2E setup failure cleanup", () => {
  it("stops owned services before restoring local state", async () => {
    const events: string[] = []
    const dependencies = lifecycleDependencies({ events })

    await cleanupFailedSetup(decision(), [303, 404], dependencies)

    expect(events).toEqual(["stop:303,404", "ports-free", "restore"])
  })

  it("stops CI-owned services without attempting a local restore", async () => {
    const events: string[] = []
    const dependencies = lifecycleDependencies({ events })

    await cleanupFailedSetup(
      decision({ ci: true, singleRuntime: true, restoreState: false, restorePolicy: "none" }),
      [505],
      dependencies,
    )

    expect(events).toEqual(["stop:505", "ports-free"])
  })

  it("does nothing for failed setup while reusing external services", async () => {
    const dependencies = lifecycleDependencies()
    await cleanupFailedSetup(
      decision({ mode: "reuse", restoreState: false, restorePolicy: "none" }),
      [],
      dependencies,
    )
    expect(dependencies.stopOwnedAndWait).not.toHaveBeenCalled()
    expect(dependencies.restoreState).not.toHaveBeenCalled()
  })
})

describe("E2E service start consumes the lifecycle decision", () => {
  function managedService(name: string, pid: number): ManagedService {
    return {
      name,
      healthUrl: `http://${name}.test/health`,
      proc: { pid } as ManagedService["proc"],
    }
  }

  function startDependencies(events: string[]): StartServicesDependencies {
    return {
      clearLogs: vi.fn(() => events.push("clear-logs")),
      definitions: vi.fn(() => [
        { name: "web", args: [], healthUrl: "http://web.test/health" },
        { name: "ws", args: [], healthUrl: "http://ws.test/health" },
      ]),
      startService: vi.fn((definition) => {
        events.push(`start:${definition.name}`)
        return managedService(definition.name, definition.name === "web" ? 11 : 22)
      }),
      waitForHealth: vi.fn(async (_url, name) => {
        events.push(`ready:${name}`)
      }),
      warmUpRoutes: vi.fn(async () => {
        events.push("warm")
      }),
    }
  }

  it("warms only for a reuse decision", async () => {
    const events: string[] = []
    const dependencies = startDependencies(events)

    await expect(startServices(
      decision({ mode: "reuse", restoreState: false, restorePolicy: "none" }),
      () => events.push("ownership"),
      dependencies,
    )).resolves.toEqual([])
    expect(events).toEqual(["warm"])
  })

  it("publishes ownership after each fresh spawn and never re-decides health", async () => {
    const events: string[] = []
    const ownership: number[][] = []
    const dependencies = startDependencies(events)

    const services = await startServices(
      decision(),
      (owned) => ownership.push(owned.map((service) => service.proc.pid!)),
      dependencies,
    )

    expect(services.map((service) => service.proc.pid)).toEqual([11, 22])
    expect(ownership).toEqual([[11], [11, 22]])
    expect(events).toEqual([
      "clear-logs",
      "start:web",
      "start:ws",
      "ready:web",
      "ready:ws",
      "warm",
    ])
  })

  it("publishes every owned PID before a start readiness failure escapes", async () => {
    const events: string[] = []
    const ownership: number[][] = []
    const dependencies = startDependencies(events)
    vi.mocked(dependencies.waitForHealth).mockImplementation(async (_url, name) => {
      if (name === "web") throw new Error("start readiness failed")
    })

    await expect(startServices(
      decision(),
      (owned) => ownership.push(owned.map((service) => service.proc.pid!)),
      dependencies,
    )).rejects.toThrow("start readiness failed")
    expect(ownership).toEqual([[11], [11, 22]])
  })
})

describe("E2E durable state artifacts", () => {
  it("restores a byte-identical present state and closes the manifest policy", () => {
    const paths = temporaryStatePaths()
    mkdirSync(paths.stateDir, { recursive: true })
    writeFileSync(resolve(paths.stateDir, "sentinel"), "original-state")
    writeFileSync(paths.manifestPath!, JSON.stringify({
      servicePids: [11],
      restoreState: true,
      restorePolicy: "restore-backup",
    }))

    expect(backupState(paths)).toBe("restore-backup")
    writeFileSync(resolve(paths.stateDir, "sentinel"), "test-write")
    restoreState(paths)

    expect(readFileSync(resolve(paths.stateDir, "sentinel"), "utf8")).toBe("original-state")
    expect(recoveryArtifact(paths)).toBe("none")
    expect(JSON.parse(readFileSync(paths.manifestPath!, "utf8"))).toMatchObject({
      servicePids: [],
      restoreState: false,
      restorePolicy: "none",
    })
  })

  it("records original absence and removes run-created state", () => {
    const paths = temporaryStatePaths()
    writeFileSync(paths.manifestPath!, JSON.stringify({
      servicePids: [22],
      restoreState: true,
      restorePolicy: "remove-created-state",
    }))

    expect(backupState(paths)).toBe("remove-created-state")
    expect(recoveryArtifact(paths)).toBe("absent")
    mkdirSync(paths.stateDir, { recursive: true })
    writeFileSync(resolve(paths.stateDir, "test-row"), "created")
    restoreState(paths)

    expect(existsSync(paths.stateDir)).toBe(false)
    expect(recoveryArtifact(paths)).toBe("none")
    expect(JSON.parse(readFileSync(paths.manifestPath!, "utf8"))).toMatchObject({
      servicePids: [],
      restoreState: false,
      restorePolicy: "none",
    })
  })

  it("fails closed when both artifacts exist or an expected artifact is missing", () => {
    const paths = temporaryStatePaths()
    mkdirSync(paths.backupDir, { recursive: true })
    writeFileSync(paths.absentMarker, "absent")

    expect(() => recoveryArtifact(paths)).toThrow("both exist")
    expect(() => restoreState(paths)).toThrow("both exist")
    expect(() => backupState(paths)).toThrow("both exist")

    rmSync(paths.backupDir, { recursive: true, force: true })
    rmSync(paths.absentMarker, { force: true })
    expect(hasRecoveryArtifact(paths)).toBe(false)
    expect(() => restoreState(paths)).toThrow("no recovery artifact")
  })

  it("does not apply an artifact that contradicts the durable manifest policy", () => {
    const paths = temporaryStatePaths()
    mkdirSync(paths.backupDir, { recursive: true })
    writeFileSync(resolve(paths.backupDir, "sentinel"), "original")
    writeFileSync(paths.manifestPath!, JSON.stringify({
      restoreState: true,
      restorePolicy: "remove-created-state",
    }))

    expect(() => restoreState(paths)).toThrow("contradicts backup recovery artifact")
    expect(existsSync(paths.backupDir)).toBe(true)
  })

  it("supports a truly legacy policy-less manifest only with a backup", () => {
    const paths = temporaryStatePaths()
    mkdirSync(paths.backupDir, { recursive: true })
    writeFileSync(resolve(paths.backupDir, "sentinel"), "legacy-original")
    mkdirSync(paths.stateDir, { recursive: true })
    writeFileSync(resolve(paths.stateDir, "sentinel"), "test-write")
    writeFileSync(paths.manifestPath!, JSON.stringify({
      servicePids: [33],
      restoreState: true,
    }))

    expect(readPriorServiceManifest(paths.manifestPath!)).toMatchObject({
      restoreState: true,
      restorePolicy: "restore-backup",
    })
    restoreState(paths)
    expect(readFileSync(resolve(paths.stateDir, "sentinel"), "utf8")).toBe("legacy-original")
    expect(recoveryArtifact(paths)).toBe("none")
  })

  it("rejects a legacy policy-less manifest paired with an absence marker", () => {
    const paths = temporaryStatePaths()
    writeFileSync(paths.absentMarker, "absent")
    mkdirSync(paths.stateDir, { recursive: true })
    writeFileSync(resolve(paths.stateDir, "test-row"), "keep-on-failure")
    writeFileSync(paths.manifestPath!, JSON.stringify({
      servicePids: [44],
      restoreState: true,
    }))

    expect(() => restoreState(paths)).toThrow("contradicts absent recovery artifact")
    expect(readFileSync(resolve(paths.stateDir, "test-row"), "utf8")).toBe("keep-on-failure")
    expect(existsSync(paths.absentMarker)).toBe(true)
  })

  it("rejects explicit none and invalid policies without touching the artifact or state", () => {
    for (const restorePolicy of ["none", "surprise-policy"]) {
      const paths = temporaryStatePaths()
      mkdirSync(paths.backupDir, { recursive: true })
      writeFileSync(resolve(paths.backupDir, "sentinel"), "original")
      mkdirSync(paths.stateDir, { recursive: true })
      writeFileSync(resolve(paths.stateDir, "sentinel"), "test-write")
      writeFileSync(paths.manifestPath!, JSON.stringify({
        servicePids: [55],
        restoreState: true,
        restorePolicy,
      }))

      expect(() => readPriorServiceManifest(paths.manifestPath!)).toThrow(/restorePolicy|policy/)
      expect(() => restoreState(paths)).toThrow("Invalid E2E restore policy")
      expect(readFileSync(resolve(paths.stateDir, "sentinel"), "utf8")).toBe("test-write")
      expect(readFileSync(resolve(paths.backupDir, "sentinel"), "utf8")).toBe("original")
    }
  })
})

describe("E2E prior ownership manifest", () => {
  it("parses exact owned PIDs and restore policy", () => {
    const paths = temporaryStatePaths()
    writeFileSync(paths.manifestPath!, JSON.stringify({
      servicePids: [8, 9, 8],
      restoreState: true,
      restorePolicy: "remove-created-state",
    }))

    expect(readPriorServiceManifest(paths.manifestPath!)).toEqual({
      servicePids: [8, 9],
      restoreState: true,
      restorePolicy: "remove-created-state",
    })
  })

  it("rejects invalid ownership instead of signaling an arbitrary process", () => {
    const paths = temporaryStatePaths()
    writeFileSync(paths.manifestPath!, JSON.stringify({ servicePids: ["42"] }))
    expect(() => readPriorServiceManifest(paths.manifestPath!)).toThrow("Invalid servicePids")
  })

  it("rejects a restore policy when restoreState is false", () => {
    const paths = temporaryStatePaths()
    writeFileSync(paths.manifestPath!, JSON.stringify({
      servicePids: [],
      restoreState: false,
      restorePolicy: "restore-backup",
    }))
    expect(() => readPriorServiceManifest(paths.manifestPath!))
      .toThrow("restore policy while restoreState=false")
  })

  it("reads prior ownership before AUTH removal in global setup", () => {
    const source = readFileSync(
      resolve(__dirname, "e2e-ui/_setup/global-setup.ts"),
      "utf8",
    )
    expect(source.indexOf("readPriorServiceManifest()"))
      .toBeLessThan(source.indexOf("rmSync(AUTH_DIR"))
    expect(source).toContain("await prepareServiceLifecycle(priorManifest)")
    expect(source).toContain("await cleanupFailedSetup(decision, ownedServicePids)")
    expect(source).not.toContain("REUSE_EXISTING")
  })
})
