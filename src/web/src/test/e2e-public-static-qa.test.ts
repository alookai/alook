import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { assertPublicStaticInputs, assertPublicStaticWriteSeparation, builtPrecacheEntries, containedPath, phaseWorkerDefinitions, readPublicStaticManifest, validatePhaseCommand, validatePublicStaticManifest } from "../../scripts/dev-zone-processes.mjs"
import { createPhaseGate, createUpgradeSocketOwner } from "../../scripts/dev-zone-ingress.mjs"
import { phaseProbeCrossed, phaseReadinessFailure, type PublicStaticPhaseReceipt } from "./e2e-ui/_setup/service-lifecycle"
import { publicStaticQaManifest, serviceDefinitions } from "./e2e-ui/_setup/services"
import { signIn } from "./e2e-ui/_setup/auth"
import { assertFaultBase, blogBuildIdFromScripts, exactSwRequest, releaseDelta, runQaScope, withinQaDeadline, type QaAsset } from "./e2e-ui/_fixtures/public-static-qa"

const directories: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "alook-222-phase-unit-"))
  const owner = join(directory, "auth")
  mkdirSync(owner)
  directories.push(directory)
  const releases = Object.fromEntries(["N", "Nplus1"].map(name => {
    const root = join(directory, name)
    const revision = `revision-${name}`
    const precacheUrl = "/_next/static/main/_buildManifest.js"
    const sw = Buffer.from(`new Serwist({precacheEntries:${JSON.stringify([{ url: precacheUrl, revision }])}})`)
    const paths = ["src/web/wrangler.toml", "src/web/blog/wrangler.toml", "src/web/custom-worker.ts", "src/web/blog/custom-worker.ts", "src/web/.open-next/worker.js", "src/web/blog/.open-next/worker.js", "src/web/public/sw.js", "src/web/.open-next/assets/sw.js"]
    const helpers = ["main", "blog"].flatMap(zone => ["_buildManifest.js", "_clientMiddlewareManifest.js", "_ssgManifest.js"].map(helper => ({
      zone, url: `${zone === "blog" ? "/blog-static" : ""}/_next/static/${zone}/${helper}`,
      path: `src/web/${zone === "blog" ? "blog/" : ""}.open-next/assets/${zone}-${helper}`,
    })))
    const inputs = [...paths, ...helpers.map(value => value.path)].map(path => {
      const bytes = path.endsWith("/sw.js") ? sw : Buffer.from(`${name}:${path}`)
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), bytes)
      return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
    })
    return [name, { root, head: "a".repeat(40), tree: "b".repeat(40), swSha256: createHash("sha256").update(sw).digest("hex"), mainBuildId: "main", blogBuildId: "blog", inputs, assets: helpers.map(value => ({ ...value, ...inputs.find(input => input.path === value.path)!, ...(value.url === precacheUrl ? { precache: true, revision } : {}) })) }]
  }))
  const value = { schema: 1, runId: "unit-run-222", controlDirectory: "control", defaultRelease: "Nplus1", releases }
  const file = join(directory, "release-inputs.json")
  writeFileSync(file, JSON.stringify(value))
  return { owner, value, file }
}

describe("public static QA immutable input and phase controls", () => {
  it("loads the real supplementary config with original budgets and a mandatory phase-capability dependency", async () => {
    vi.stubEnv("ALOOK_PUBLIC_STATIC_QA", "0")
    const { default: ordinary } = await import("../../playwright.config")
    const { default: supplementary } = await import("../../playwright.public-static-qa.config")
    expect(process.env.ALOOK_PUBLIC_STATIC_QA).toBe("1")
    expect(supplementary).toMatchObject({
      testDir: "./src/test/e2e-ui/_qa/public-static",
      testMatch: "**/*.qa.ts",
      timeout: 60_000,
      expect: { timeout: 10_000 },
      workers: 1,
      retries: 0,
      maxFailures: 1,
    })
    expect(supplementary.globalSetup).toBe(ordinary.globalSetup)
    expect(supplementary.globalTeardown).toBe(ordinary.globalTeardown)
    expect(supplementary.use).toEqual(ordinary.use)
    expect(supplementary.projects).toHaveLength(ordinary.projects!.length * 2)
    for (const project of ordinary.projects!) {
      const capabilityName = `${project.name}-phase-capability`
      const capability = supplementary.projects!.find(value => value.name === capabilityName)
      const journeys = supplementary.projects!.find(value => value.name === project.name)
      expect(capability).toMatchObject({ ...project, name: capabilityName, grep: /@phase-capability/ })
      expect(journeys).toMatchObject({ ...project, grepInvert: /@phase-capability/, dependencies: [capabilityName] })
    }
  })
  it("submits only once for a separately owned same-device login and retains its original failure", async () => {
    const visits: string[] = [], submits: number[] = []
    const failure = new Error("UI response lost")
    const page = {
      goto: async (url: string) => { visits.push(url) },
      getByRole: (role: string) => role === "textbox" ? { waitFor: async () => {}, fill: async () => {} } : { click: async () => { throw failure } },
      waitForURL: async () => {},
    } as unknown as Parameters<typeof signIn>[0]
    await expect(signIn(page, "qa@example.invalid", { singleAttempt: true, onSubmission: () => { submits.push(1) } })).rejects.toBe(failure)
    expect(visits).toHaveLength(1)
    expect(visits[0]).toContain("/sign-in?redirect=/c")
    expect(submits).toEqual([1])
  })
  it("binds the complete precache catalogue to actual frozen worker entries and rejects ambiguity", () => {
    expect(builtPrecacheEntries('new SW({precacheEntries:[{"url":"/a]b","revision":"actual"}]})')).toEqual([{ url: "/a]b", revision: "actual" }])
    expect(() => builtPrecacheEntries("precacheEntries:self.__SW_MANIFEST")).toThrow("unambiguous")
    expect(() => builtPrecacheEntries('x({precacheEntries:[{"url":"/a","revision":null}]});y({precacheEntries:[{"url":"/b","revision":null}]})')).toThrow("unambiguous")
    const { owner, file } = fixture()
    const manifest = readPublicStaticManifest(file, owner)
    manifest.releases.N.assets.find((asset: { precache?: boolean; revision?: string | null }) => asset.precache)!.revision = "not-emitted"
    expect(() => assertPublicStaticInputs(manifest)).toThrow("actual emitted")
  })

  it("resolves the two real emitted binding forms, aliases and lexical shadowing without executing worker text", () => {
    const entries = [{ revision: null, url: "/one.js" }, { revision: "actual-revision", url: "/two.webp" }]
    const literal = JSON.stringify(entries)
    expect(builtPrecacheEntries(`(()=>{var p=${literal};new W({precacheEntries:p})})()`)).toEqual(entries)
    expect(builtPrecacheEntries(`(()=>{var g;g=${literal};new W({precacheEntries:g})})()`)).toEqual(entries)
    expect(builtPrecacheEntries(`(()=>{var p=${literal};var q=p;new W({precacheEntries:q})})()`)).toEqual(entries)
    expect(builtPrecacheEntries(`var p=[{url:"/wrong",revision:null}];(()=>{var p=${literal};new W({precacheEntries:p})})()`)).toEqual(entries)
    const sentinel = Symbol.for("qa222-no-worker-execution")
    delete (globalThis as Record<symbol, unknown>)[sentinel]
    expect(builtPrecacheEntries(`globalThis[Symbol.for("qa222-no-worker-execution")]=true;(()=>{var p=${literal};new W({precacheEntries:p})})()`)).toEqual(entries)
    expect((globalThis as Record<symbol, unknown>)[sentinel]).toBeUndefined()
  })

  it("resolves the real memoized bundler initializer only after its unchanged factory is called directly", () => {
    const factory = '(e,t,s)=>()=>{if(s)throw s[0];try{return e&&(t=e(e=0)),t}catch(r){throw s=[r],r}}'
    const array = '[{url:"/real",revision:"revision"}]'
    const prefix = `var b=${factory};var g,h=b(()=>{g=${array}});`
    expect(builtPrecacheEntries(`(()=>{${prefix}h();var worker=new W({precacheEntries:g})})()`)).toEqual([{ url: "/real", revision: "revision" }])
    const invalid = [
      `${prefix}new W({precacheEntries:g})`,
      `${prefix}if(false)h();new W({precacheEntries:g})`,
      `${prefix}false&&h();new W({precacheEntries:g})`,
      `${prefix}return;h();new W({precacheEntries:g})`,
      `${prefix}h=()=>{};h();new W({precacheEntries:g})`,
      `var b=()=>()=>{};var g,h=b(()=>{g=${array}});h();new W({precacheEntries:g})`,
      `var b=${factory};var g,h=b(()=>{if(false)g=${array}});h();new W({precacheEntries:g})`,
      `var g,h=b(()=>{g=${array}});var b=${factory};h();new W({precacheEntries:g})`,
      `var b=${factory};var g,h=b(()=>{g=${array},sideEffect()});h();new W({precacheEntries:g})`,
    ]
    for (const source of invalid) expect(() => builtPrecacheEntries(`(()=>{${source}})()`), source).toThrow("unambiguous")
  })

  it("rejects reassignment, mutation, conditional or late writes, cycles and dynamic entry values", () => {
    const array = '[{url:"/actual",revision:"revision"}]'
    const invalid = [
      `var p=${array};p=${array};new W({precacheEntries:p})`,
      `var p=${array};p.push({url:"/extra",revision:null});new W({precacheEntries:p})`,
      `var p;if(false)p=${array};new W({precacheEntries:p})`,
      `var p;false&&(p=${array});new W({precacheEntries:p})`,
      `var p;new W({precacheEntries:p});p=${array}`,
      'var p=q;var q=p;new W({precacheEntries:p})',
      'var p=makeEntries();new W({precacheEntries:p})',
      'new W({precacheEntries:[{url:readURL(),revision:null}]})',
      'new W({precacheEntries:[{url:"/a",revision:null,...other}]})',
      'new W({precacheEntries:[{url:"/a",url:"/b",revision:null}]})',
      'var p;function unused(){p=[{url:"/a",revision:null}]}new W({precacheEntries:p})',
      'if(false)new W({precacheEntries:[{url:"/a",revision:null}]})',
      'false&&new W({precacheEntries:[{url:"/a",revision:null}]})',
      'try{new W({precacheEntries:[{url:"/a",revision:null}]})}catch{}',
      'new W({precacheEntries:[{url:"/a",revision:null}],...{precacheEntries:[]}})',
      'new W({precacheEntries:[{url:"/a",revision:null}],["precacheEntries"]:[]})',
      'var p=[{url:"/a",revision:null}];var box={p};box.p[0].url="changed";new W({precacheEntries:p})',
      'var p=[{url:"/a",revision:null}];eval("p=[]");new W({precacheEntries:p})',
      'new W({precacheEntries:[{url:"/a",revision:null,extra:sideEffect()}]})',
      'return;new W({precacheEntries:[{url:"/a",revision:null}]})',
      'throw new Error("stop");new W({precacheEntries:[{url:"/a",revision:null}]})',
      '(function*(){var p=[{url:"/a",revision:null}];new W({precacheEntries:p})})()',
      '(async()=>{var p=[{url:"/a",revision:null}];new W({precacheEntries:p})})()',
    ]
    for (const source of invalid) expect(() => builtPrecacheEntries(`(()=>{${source}})()`), source).toThrow("unambiguous")
  })
  it("retires HTTP samples crossing a valid completed transition while retaining stable and foreign failures", () => {
    const before: PublicStaticPhaseReceipt = { schema: 1, runId: "run", manifestDigest: "bound", sequence: 0, release: "N", status: "ready" }
    expect(phaseProbeCrossed(before, { ...before }, 1000)).toBe(false)
    expect(phaseProbeCrossed(before, { ...before, sequence: 1, release: "Nplus1" }, 1000)).toBe(true)
    expect(phaseProbeCrossed(before, { ...before, sequence: 1, status: "switching", deadline: 1500, caseId: "case", expectedStops: [{ label: "main backend", pid: 10 }, { label: "Blog backend", pid: 11 }] }, 1000)).toBe(true)
    for (const change of [{ status: "failed" as const, failure: "stable failed" }, { runId: "foreign" }, { sequence: -1 }, { release: "Nplus1" as const }, { status: "switching" as const, deadline: 999 }]) expect(() => phaseProbeCrossed(before, { ...before, ...change }, 1000)).toThrow()
  })
  it("binds helper URLs to the unique actual Flight build and rejects missing/ambiguous data", () => {
    expect(blogBuildIdFromScripts('self.__next_f.push([1,"0:{\\"b\\":\\"real_build-1\\"}"])')).toBe("real_build-1")
    expect(blogBuildIdFromScripts('{"b":"same"}\n{"b":"same"}')).toBe("same")
    expect(() => blogBuildIdFromScripts("no build here")).toThrow("exactly one")
    expect(() => blogBuildIdFromScripts('{"b":"main"}\n{"b":"blog"}')).toThrow("exactly one")
  })

  it("selects only the exact service-worker network leg and preserves the real public fault base", () => {
    const worker = {} as Parameters<typeof exactSwRequest>[2]
    const other = {} as Parameters<typeof exactSwRequest>[2]
    const url = "http://localhost/real.js"
    expect(exactSwRequest({ url: () => url, serviceWorker: () => worker }, url, worker)).toBe(true)
    for (const [requestUrl, owner] of [[url, null], [url, other], [`${url}?query`, worker]] as const) expect(exactSwRequest({ url: () => requestUrl, serviceWorker: () => owner }, url, worker)).toBe(false)
    const body = Buffer.from("real original helper")
    const asset = { url: "/_next/static/build/_buildManifest.js", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") } as QaAsset
    const headers = { "content-type": "application/javascript", "cache-control": "public, max-age=31536000" }
    expect(() => assertFaultBase(asset, 200, headers, body)).not.toThrow()
    for (const [status, actualHeaders, actualBody] of [[404, headers, body], [200, { ...headers, "cache-control": "private" }, body], [200, { ...headers, "content-type": "text/html" }, body], [200, { ...headers, vary: "Cookie" }, body], [200, { ...headers, "set-cookie": "qa=fake" }, body], [200, headers, Buffer.from("other")]] as const) expect(() => assertFaultBase(asset, status, actualHeaders, actualBody)).toThrow("real bound")
  })

  it("keeps primary and every independent cleanup failure and closes in reverse ownership order", async () => {
    const order: number[] = [], primary = new Error("primary"), first = new Error("cleanup first"), second = new Error("cleanup second")
    const result = runQaScope(async onClose => {
      onClose(async () => { order.push(1); throw first })
      onClose(async () => { order.push(2); throw second })
      throw primary
    })
    await expect(result).rejects.toMatchObject({ errors: [primary, second, first] })
    expect(order).toEqual([2, 1])
  })

  it("cancels pending owned operations and does not turn deadline failure into success", async () => {
    const controller = new AbortController()
    const pending = withinQaDeadline(new Promise<void>(() => {}), Date.now() + 1000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow("cancelled")
    await expect(withinQaDeadline(new Promise<void>(() => {}), Date.now() - 1)).rejects.toThrow("original deadline")
    expect(await withinQaDeadline(Promise.resolve(42), Date.now() + 1000)).toBe(42)
  })

  it("distinguishes real same-URL body changes from added, deleted and unchanged precaches", () => {
    const asset = (url: string, sha256: string) => ({ url, sha256, precache: true }) as QaAsset
    expect(releaseDelta([asset("/same", "old"), asset("/gone", "x"), asset("/stable", "s")], [asset("/same", "new"), asset("/new", "n"), asset("/stable", "s")])).toEqual({ added: ["/new"], deleted: ["/gone"], changed: ["/same"], unchanged: ["/stable"] })
  })

  it("checks actual bound bytes and rejects a changed input without touching another release", () => {
    const { owner, file } = fixture()
    const manifest = readPublicStaticManifest(file, owner)
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(manifest.releases.N.root, "src/web/public/sw.js"), "changed")
    expect(() => assertPublicStaticInputs(manifest)).toThrow("input changed")
  })

  it("rejects escaping ownership, repeated inputs and mismatched SW/helper catalogues before startup", () => {
    const { owner, value } = fixture()
    expect(() => containedPath(owner, "../outside")).toThrow("escapes")
    expect(() => validatePublicStaticManifest({ ...value, controlDirectory: "/outside" }, owner)).toThrow("escapes")
    const duplicate = structuredClone(value)
    duplicate.releases.N.inputs.push(duplicate.releases.N.inputs[0])
    expect(() => validatePublicStaticManifest(duplicate, owner)).toThrow("unique")
    const wrong = structuredClone(value)
    wrong.releases.N.swSha256 = "f".repeat(64)
    expect(() => validatePublicStaticManifest(wrong, owner)).toThrow("SW inputs")
    const missing = structuredClone(value)
    missing.releases.N.assets.pop()
    expect(() => validatePublicStaticManifest(missing, owner)).toThrow("helper")
  })

  it("rejects a symlinked input even when its bytes and length match", () => {
    const { owner, file } = fixture()
    const manifest = readPublicStaticManifest(file, owner)
    const target = join(manifest.releases.N.root, "src/web/public/sw.js")
    rmSync(target)
    symlinkSync(join(manifest.releases.N.root, "src/web/.open-next/assets/sw.js"), target)
    expect(() => assertPublicStaticInputs(manifest)).toThrow("input changed")
  })

  it("rejects release roots reset by setup and real control-parent escapes before any write", () => {
    const { owner, value, file } = fixture()
    const reset = structuredClone(value)
    reset.releases.N.root = join(owner, "will-be-deleted")
    expect(() => validatePublicStaticManifest(reset, owner)).toThrow("mutable/reset")
    symlinkSync(value.releases.N.root, join(owner, "link"), "dir")
    expect(() => validatePublicStaticManifest({ ...value, controlDirectory: "link/control" }, owner)).toThrow("escapes")
    const manifest = readPublicStaticManifest(file, owner)
    expect(() => assertPublicStaticWriteSeparation(manifest, [join(value.releases.N.root, "src/web/public")])).toThrow(/mutable|sealed/)
  })

  it("keeps one absolute persistence identity while selecting the real version config roots", () => {
    const { owner, file } = fixture()
    const manifest = readPublicStaticManifest(file, owner)
    const old = phaseWorkerDefinitions(manifest, "N", "/installed/wrangler.js", owner)
    const next = phaseWorkerDefinitions(manifest, "Nplus1", "/installed/wrangler.js", owner)
    for (let index = 0; index < 2; index++) {
      expect(old[index].args[3]).not.toBe(next[index].args[3])
      expect(old[index].args[old[index].args.indexOf("--persist-to") + 1]).toBe(next[index].args[next[index].args.indexOf("--persist-to") + 1])
      expect(old[index].args[0]).toBe("/installed/wrangler.js")
    }
  })

  it("refuses stale/foreign/deadline commands and retains a case lease until restored release", () => {
    const manifest = { runId: "run", digest: "digest", defaultRelease: "Nplus1" }
    const receipt = { sequence: 1, release: "N", status: "ready", caseId: "case-a" }
    const command = { action: "switch", sequence: 2, runId: "run", manifestDigest: "digest", caseId: "case-a", from: "N", to: "Nplus1", deadline: 1_100 }
    expect(validatePhaseCommand(command, manifest, receipt, 1_000)).toBe(command)
    for (const change of [{ caseId: "case-b" }, { sequence: 1 }, { deadline: 999 }, { deadline: 61_001 }, { from: "Nplus1" }, { action: "release" }, { manifestDigest: "foreign" }]) {
      expect(() => validatePhaseCommand({ ...command, ...change }, manifest, receipt, 1_000)).toThrow("foreign")
    }
    expect(() => validatePhaseCommand({ ...command, action: "release", from: "Nplus1", to: "Nplus1" }, manifest, { ...receipt, release: "Nplus1" }, 1_000)).not.toThrow()
  })

  it("requires explicit supplementary/prebuilt mode and leaves ordinary combined argv unchanged", () => {
    vi.stubEnv("ALOOK_E2E_RELEASE_MANIFEST", "")
    vi.stubEnv("ALOOK_PUBLIC_STATIC_QA", "")
    expect(publicStaticQaManifest()).toBeNull()
    expect(serviceDefinitions()[0].args).toContain("--with-ws-do")
    expect(serviceDefinitions()[0].args).not.toContain("--public-static-manifest")
    vi.stubEnv("ALOOK_PUBLIC_STATIC_QA", "1")
    expect(() => publicStaticQaManifest()).toThrow("requires ALOOK_E2E_RELEASE_MANIFEST")
    vi.stubEnv("ALOOK_E2E_RELEASE_MANIFEST", "/does-not-exist")
    vi.stubEnv("ALOOK_E2E_PREBUILT", "")
    expect(() => publicStaticQaManifest()).toThrow("prebuilt")
  })

  it("refuses an old default before a complete candidate QA run can use candidate-only assertions", () => {
    const { value, file } = fixture()
    value.defaultRelease = "N"
    writeFileSync(file, JSON.stringify(value))
    vi.stubEnv("ALOOK_PUBLIC_STATIC_QA", "1")
    vi.stubEnv("ALOOK_E2E_PREBUILT", "1")
    vi.stubEnv("ALOOK_E2E_RELEASE_MANIFEST", file)
    expect(() => publicStaticQaManifest(false)).toThrow("requires Nplus1")
  })

  it("holds HTTP until a phase commits and rejects all pending/future work on owner failure", async () => {
    const gate = createPhaseGate()
    await gate.ready()
    gate.hold()
    let passed = false
    const waiting = gate.ready().then(() => { passed = true })
    await Promise.resolve()
    expect(passed).toBe(false)
    gate.release()
    await waiting
    expect(passed).toBe(true)
    gate.hold()
    const held = gate.ready()
    gate.fail(new Error("owner failed"))
    await expect(held).rejects.toThrow("owner failed")
    await expect(gate.ready()).rejects.toThrow("owner failed")
    expect(() => gate.hold()).toThrow("failed")
  })

  it("retires both upgraded sockets on either error and drains owned pairs without opening a port", async () => {
    class Socket extends EventEmitter {
      closed = false
      destroyCount = 0
      destroy() { if (!this.closed) { this.closed = true; this.destroyCount++; this.emit("close") }; return this }
    }
    const owner = createUpgradeSocketOwner()
    const client = new Socket(), backend = new Socket()
    owner.own(client, backend)
    backend.emit("error", new Error("backend failed"))
    expect(client.closed).toBe(true)
    expect(backend.closed).toBe(true)
    const otherClient = new Socket(), otherBackend = new Socket()
    owner.own(otherClient, otherBackend)
    await owner.close()
    expect(otherClient.closed && otherBackend.closed).toBe(true)
    expect([client, backend, otherClient, otherBackend].map(value => value.destroyCount)).toEqual([1, 1, 1, 1])
  })

  it("permits only two specifically registered children inside a live bounded transition", () => {
    const receipt: PublicStaticPhaseReceipt = { schema: 1, runId: "run", manifestDigest: "digest", sequence: 1, release: "N", status: "switching", caseId: "case-a", deadline: 1_100, expectedStops: [{ label: "main backend", pid: 10 }, { label: "Blog backend", pid: 20 }] }
    expect(phaseReadinessFailure(receipt, 1_000)).toBeNull()
    expect(phaseReadinessFailure(receipt, 1_100)).toContain("expired")
    expect(phaseReadinessFailure({ ...receipt, expectedStops: [{ label: "stable WS/queue", pid: 10 }, { label: "Blog backend", pid: 20 }] }, 1_000)).toContain("invalid")
    expect(phaseReadinessFailure({ ...receipt, expectedStops: [{ label: "main backend", pid: 10 }, { label: "Blog backend", pid: 10 }] }, 1_000)).toContain("invalid")
    expect(phaseReadinessFailure({ ...receipt, status: "failed", failure: "stable socket lost" }, 1_000)).toBe("stable socket lost")
  })
})
