import { createHash, webcrypto } from "node:crypto"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Page, Request, TestInfo } from "@playwright/test"
import type { CaseActors } from "@/test/e2e-ui/_fixtures/case-fixture"
import { captureMessageReading, installMessageReadingCollector } from "@/test/e2e-ui/_fixtures/message-reading-diagnostic"
import {
  observeMessageReading, READING_DIAGNOSTIC_ENUMS, READING_DIAGNOSTIC_IDENTITY_KEYS, READING_DIAGNOSTIC_REFERENCE_KEYS,
  READING_DIAGNOSTIC_STAGES, READING_DIAGNOSTIC_VALUE_KEYS, type ReadingDiagnosticFields,
} from "./message-reading-diagnostic"

const options = {
  captureSeed: "node-provided-collector-seed",
  limit: 100, stages: READING_DIAGNOSTIC_STAGES, enums: READING_DIAGNOSTIC_ENUMS, values: READING_DIAGNOSTIC_VALUE_KEYS,
  identities: READING_DIAGNOSTIC_IDENTITY_KEYS, refs: READING_DIAGNOSTIC_REFERENCE_KEYS,
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function serializedCollector() {
  const source = ts.createSourceFile("message-reading-diagnostic.ts",
    readFileSync(new URL("../../test/e2e-ui/_fixtures/message-reading-diagnostic.ts", import.meta.url), "utf8"), ts.ScriptTarget.ESNext, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "installMessageReadingCollector")
  if (!declaration) throw new Error("Missing collector function declaration")
  const { outputText } = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  const installer = runInNewContext(`${outputText}\ninstallMessageReadingCollector`, { exports: {} }) as typeof installMessageReadingCollector
  return installer.toString()
}

function environment(crypto: unknown = webcrypto) {
  const value = { crypto, top: null as unknown }
  value.top = value
  vi.stubGlobal("window", value)
  return value
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("reading diagnostic privacy and lifecycle", () => {
  it("does not evaluate diagnostic data without the explicit sink", () => {
    vi.stubGlobal("window", undefined)
    const fields = vi.fn(() => { throw new Error("must not run") })
    expect(() => observeMessageReading("reading.report", fields)).not.toThrow()
    expect(fields).not.toHaveBeenCalled()
    environment()
    observeMessageReading("reading.report", fields)
    expect(fields).not.toHaveBeenCalled()
  })

  it("retains only allowlisted values and hashes, never identity or rejected text", async () => {
    environment()
    installMessageReadingCollector(options)
    const rawCursor = "private-cursor-351:range=1-25"
    const forbidden = "private-body-cookie-password-351"
    observeMessageReading("reading.report", () => ({
      identities: { cursor: rawCursor, body: forbidden },
      values: { source: "manual", count: 2, reason: forbidden, body: forbidden, status: Number.NaN, pageCount: Infinity },
    } as unknown as ReadingDiagnosticFields))
    const snapshot = await window.__alookMessageReadingDiagnostic!.snapshot(true)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(rawCursor)
    expect(serialized).not.toContain(forbidden)
    expect(snapshot.records.at(-1)?.hashes.cursor).toBe(sha256(rawCursor))
    expect(snapshot.records.at(-1)?.values).toEqual({ source: "manual", count: 2 })
    expect(snapshot.rejected).toBeGreaterThanOrEqual(5)
    expect(snapshot.pending).toBe(0)
  })

  it("joins existing callback and object instances while separating different owners", async () => {
    environment()
    installMessageReadingCollector(options)
    const reader = () => undefined, owner = {}, other = {}
    observeMessageReading("surface.bind", () => ({ refs: { reader, owner }, identities: { message: "message351" } }))
    observeMessageReading("reading.report", () => ({ refs: { reader, owner }, identities: { message: "message351" } }))
    observeMessageReading("reading.parent-result", () => ({ refs: { reader, owner: other } }))
    const { records } = await window.__alookMessageReadingDiagnostic!.snapshot(true)
    const [binding, report, different] = records.slice(1)
    expect(binding.refs.reader).toMatch(/^[a-f0-9]{64}$/)
    expect(binding.refs.reader).toBe(report.refs.reader)
    expect(binding.refs.owner).toBe(report.refs.owner)
    expect(binding.refs.owner).not.toBe(different.refs.owner)
    expect(binding.hashes.message).toBe(report.hashes.message)
    expect(new Set(records.map(record => record.documentHash)).size).toBe(1)
  })

  it("preserves invocation order when SHA256 operations finish out of order", async () => {
    let releaseFirst: (() => void) | undefined
    let secondFinished: (() => void) | undefined
    const secondCompletion = new Promise<void>(resolve => { secondFinished = resolve })
    const crypto = { randomUUID: () => webcrypto.randomUUID(), subtle: { digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const input = new TextDecoder().decode(data)
      if (input === "fast-second") return webcrypto.subtle.digest(algorithm, data).then(result => { secondFinished!(); return result })
      if (input !== "slow-first") return webcrypto.subtle.digest(algorithm, data)
      return new Promise<ArrayBuffer>((resolve, reject) => {
        releaseFirst = () => { void webcrypto.subtle.digest(algorithm, data).then(resolve, reject) }
      })
    } } }
    environment(crypto)
    installMessageReadingCollector(options)
    observeMessageReading("reading.report", () => ({ identities: { message: "slow-first" } }))
    observeMessageReading("reading.parent", () => ({ identities: { message: "fast-second" } }))
    const result = window.__alookMessageReadingDiagnostic!.snapshot(true)
    expect(releaseFirst).toBeTypeOf("function")
    await secondCompletion
    releaseFirst!()
    const snapshot = await result
    expect(snapshot.records.slice(1).map(record => record.hashes.message)).toEqual([sha256("slow-first"), sha256("fast-second")])
    expect(snapshot.records.map(record => record.sequence)).toEqual([0, 1, 2])
    expect(snapshot.records[1].pageNow).toBeLessThanOrEqual(snapshot.records[2].pageNow)
    expect(snapshot.pending).toBe(0)
  })

  it("reports bounded overflow instead of treating missing records as a closed gate", async () => {
    environment()
    installMessageReadingCollector({ ...options, limit: 3 })
    for (let i = 0; i < 10; i++) observeMessageReading("pagination.gate", () => ({ values: { count: i } }))
    const snapshot = await window.__alookMessageReadingDiagnostic!.snapshot(true)
    expect(snapshot.records).toHaveLength(3)
    expect(snapshot.invoked).toBe(11)
    expect(snapshot.dropped).toBe(8)
    expect(snapshot.active).toBe(false)
    observeMessageReading("pagination.gate", () => ({ values: { count: 100 } }))
    const stopped = await window.__alookMessageReadingDiagnostic!.snapshot()
    expect(stopped.records).toHaveLength(3)
    expect(stopped.afterStop).toBe(1)
  })

  it("reports hash failure without retaining raw values or rejecting business work", async () => {
    environment({ randomUUID: () => webcrypto.randomUUID(), subtle: { digest: () => Promise.reject(new Error("private crypto failure")) } })
    installMessageReadingCollector(options)
    expect(() => observeMessageReading("reading.report", () => ({ identities: { message: "private message351" } }))).not.toThrow()
    const snapshot = await window.__alookMessageReadingDiagnostic!.snapshot(true)
    expect(snapshot.hashErrors).toBeGreaterThan(0)
    expect(snapshot.records.at(-1)?.hashFailure).toBe(true)
    expect(snapshot.records.at(-1)?.hashes.message).toBeNull()
    expect(JSON.stringify(snapshot)).not.toMatch(/private message351|private crypto failure/)
    expect(snapshot.pending).toBe(0)
  })

  it("contains diagnostic factory and sink failures", async () => {
    environment()
    installMessageReadingCollector(options)
    expect(() => observeMessageReading("reading.report", () => { throw new Error("private getter") })).not.toThrow()
    expect((await window.__alookMessageReadingDiagnostic!.snapshot()).sourceErrors).toBe(1)
    window.__alookMessageReadingDiagnostic!.record = () => { throw new Error("private sink") }
    window.__alookMessageReadingDiagnostic!.failure = () => { throw new Error("private failure") }
    expect(() => observeMessageReading("reading.report", () => ({}))).not.toThrow()
  })

  it("installs from its serialized init-script function without module closures", async () => {
    const host = environment({ subtle: webcrypto.subtle })
    expect(host.crypto).not.toHaveProperty("randomUUID")
    runInNewContext(`(${serializedCollector()})(options)`, { window: host, options, performance, Date, TextEncoder, Uint8Array })
    observeMessageReading("pagination.gate", () => ({ values: { enabled: true }, identities: { cursor: "cursor351" } }))
    const snapshot = await window.__alookMessageReadingDiagnostic!.snapshot(true)
    expect(snapshot.records.at(-1)?.hashes.cursor).toBe(sha256("cursor351"))
    expect(snapshot.hashErrors).toBe(0)
    expect(snapshot.sourceErrors).toBe(0)
  })
})

function fixture(label = "desktop") {
  environment()
  const cleanups: Array<() => Promise<unknown>> = []
  const attachments: Array<{ name: string; body: string }> = []
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const frame = {}
  let closed = false
  const page = {
    addInitScript: vi.fn(async () => undefined),
    evaluate: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => await fn(arg)),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => { listeners.set(event, callback) }),
    off: vi.fn((event: string) => { listeners.delete(event) }),
    mainFrame: () => frame,
    isClosed: () => closed,
  }
  const info = { title: `dm ${label} fast preserves reading across two real pages in both directions`,
    attach: vi.fn(async (name: string, data: { body: string }) => { attachments.push({ name, body: data.body }) }) }
  const actors = { onCleanup: (operation: () => Promise<unknown>) => { cleanups.push(operation) } }
  return { page, info, actors, cleanups, attachments, listeners, frame, close: () => { closed = true },
    capture: () => captureMessageReading(actors as CaseActors, page as unknown as Page, info as unknown as TestInfo) }
}

function boundaryCoverage() {
  for (const stage of ["surface.bind", "controller.bind", "pagination.gate", "reading.reconcile"] as const)
    observeMessageReading(stage, () => ({}))
}

describe("reading diagnostic native-fixture tooling", () => {
  it("completes a Node-seeded capture when browser crypto has no randomUUID", async () => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture()
    const host = environment({ subtle: webcrypto.subtle })
    expect(host.crypto).not.toHaveProperty("randomUUID")
    const capture = await value.capture()
    const seed = (value.page.evaluate.mock.calls[0][1] as { captureSeed: string }).captureSeed
    expect(seed).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    boundaryCoverage()
    capture!.record("phase.start", { values: { direction: "older" } })
    capture!.record("observer.cleanup", { values: { operationCount: 0 } })
    await value.cleanups[0]()
    const result = JSON.parse(value.attachments[0].body)
    expect(result.complete).toBe(true)
    expect(result.collectionComplete).toBe(true)
    expect(result.requiredBoundaryCoverage).toBe(true)
    expect(result.node.sourceErrors).toBe(0)
    expect(result.browser.hashErrors).toBe(0)
    expect(value.attachments[0].body).not.toContain(seed)
  })

  it("leaves the page untouched unless both the flag and original identity match", async () => {
    const value = fixture()
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", undefined)
    expect(await value.capture()).toBeUndefined()
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    value.info.title = "dm desktop slow preserves reading across two real pages in both directions"
    expect(await value.capture()).toBeUndefined()
    expect(value.page.addInitScript).not.toHaveBeenCalled()
    expect(value.page.evaluate).not.toHaveBeenCalled()
    expect(value.cleanups).toHaveLength(0)
  })

  it.each(["desktop", "narrow"])("attaches %s on cleanup with complete joins and separate Node clocks", async label => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture(label), capture = await value.capture()
    boundaryCoverage()
    capture!.record("phase.start", { values: { direction: "older" } })
    value.cleanups.push(async () => { capture!.record("observer.cleanup", { values: { operationCount: 0 } }) })
    for (const cleanup of [...value.cleanups].reverse()) await cleanup()
    expect(value.attachments).toHaveLength(1)
    const result = JSON.parse(value.attachments[0].body)
    expect(result.complete).toBe(true)
    expect(result.collectionComplete).toBe(true)
    expect(result.requiredBoundaryCoverage).toBe(true)
    expect(result.node.records[0]).toMatchObject({ stage: "phase.start", navigationCount: 0 })
    expect(result.node.records[0].nodeNow).toBeTypeOf("number")
    expect(result.browser.records[0].pageNow).toBeTypeOf("number")
    expect(result.browser.pending).toBe(0)
    expect(value.listeners.size).toBe(0)
    expect(window.__alookMessageReadingDiagnostic).toBeUndefined()
  })

  it("does not qualify an empty application trace or a replaced phase document", async () => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture(), capture = await value.capture()
    capture!.record("phase.start", { values: { direction: "older" } })
    capture!.record("observer.cleanup", { values: { operationCount: 0 } })
    value.listeners.get("request")!({ isNavigationRequest: () => true, frame: () => value.frame })
    await value.cleanups[0]()
    const result = JSON.parse(value.attachments[0].body)
    expect(result.complete).toBe(false)
    expect(result.requiredBoundaryCoverage).toBe(false)
    expect(result.node.phaseNavigationUnchanged).toBe(false)
    expect(result.node.navigationCount).toBe(1)
  })

  it("keeps Node records and reports incomplete evidence if the original page closes", async () => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture(), capture = await value.capture()
    capture!.record("phase.start", { values: { direction: "older" } })
    capture!.record("observer.request", { identities: { cursor: "private-node-cursor351" } })
    value.close()
    await value.cleanups[0]()
    const result = JSON.parse(value.attachments[0].body)
    expect(result.complete).toBe(false)
    expect(result.browser).toBeNull()
    expect(result.node.pageClosed).toBe(true)
    expect(result.node.records.at(-1).hashes.cursor).toBe(sha256("private-node-cursor351"))
    expect(value.attachments[0].body).not.toContain("private-node-cursor351")
    expect(value.listeners.size).toBe(0)
  })

  it("joins a failed observer operation to its actual request and last phase without error text", async () => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture(), capture = await value.capture()
    const request = {} as Request
    capture!.record("observer.request", { identities: { cursor: "cursor351-private-failure" } }, request)
    capture!.record("observer.json-start", { identities: { cursor: "cursor351-private-failure" } }, request)
    capture!.record("observer.failed", { values: { source: "callback", failure: true } }, request)
    await value.cleanups[0]()
    const result = JSON.parse(value.attachments[0].body), records = result.node.records
    expect(records.map((record: { previousStage: string | null }) => record.previousStage)).toEqual([null, "observer.request", "observer.json-start"])
    expect(new Set(records.map((record: { refs: { nodeRequest: string } }) => record.refs.nodeRequest)).size).toBe(1)
    expect(records[1].hashes.cursor).toBe(sha256("cursor351-private-failure"))
    expect(value.attachments[0].body).not.toContain("cursor351-private-failure")
    expect(result.complete).toBe(false)
  })

  it("reports setup failure without replacing the original business outcome", async () => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture()
    value.page.addInitScript.mockRejectedValueOnce(new Error("private setup failure"))
    expect(await value.capture()).toBeDefined()
    await value.cleanups[0]()
    const result = JSON.parse(value.attachments[0].body)
    expect(result.complete).toBe(false)
    expect(result.node.sourceErrors).toBeGreaterThan(0)
    expect(value.attachments[0].body).not.toContain("private setup failure")
    expect(value.listeners.size).toBe(0)
  })

  it("contains navigation-observer failure and makes the collection incomplete", async () => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture(), capture = await value.capture()
    boundaryCoverage()
    capture!.record("phase.start", { values: { direction: "older" } })
    capture!.record("observer.cleanup", { values: { operationCount: 0 } })
    expect(() => value.listeners.get("request")!({ isNavigationRequest: () => true, frame: () => { throw new Error("private frame failure") } })).not.toThrow()
    await value.cleanups[0]()
    const result = JSON.parse(value.attachments[0].body)
    expect(result.complete).toBe(false)
    expect(result.node.sourceErrors).toBe(1)
    expect(result.collectionComplete).toBe(false)
    expect(result.requiredBoundaryCoverage).toBe(true)
    expect(value.attachments[0].body).not.toContain("private frame failure")
  })

  it("bounds snapshot cleanup and clears its owned deadline timer", async () => {
    vi.stubEnv("ALOOK_READING_DIAGNOSTIC", "1")
    const value = fixture()
    await value.capture()
    value.page.evaluate.mockImplementationOnce(async () => await new Promise(() => undefined))
    vi.useFakeTimers()
    const cleanup = value.cleanups[0]()
    await vi.advanceTimersByTimeAsync(2000)
    await cleanup
    expect(JSON.parse(value.attachments[0].body).complete).toBe(false)
    expect(JSON.parse(value.attachments[0].body).node.sourceErrors).toBeGreaterThan(0)
    expect(value.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
