import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { createSourceFile, isCallExpression, isFunctionDeclaration, isPropertyAccessExpression, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { afterEach, expect, it } from "vitest"
import { tid } from "../src/lib/community/testids"

type Target = { serverId: string; channelId?: string; messageScrollerId: string }
const target: Target = { serverId: "server", channelId: "target", messageScrollerId: tid.messageScroller }
const ast = createSourceFile("switch.perf.ts", readFileSync(new URL("../src/test/e2e-ui/perf/switch.perf.ts", import.meta.url), "utf8"), ScriptTarget.ESNext, true)
const setupSource = ast.statements.flatMap(s => isVariableStatement(s) ? [...s.declarationList.declarations] : []).find(d => d.name.getText(ast) === "INPAGE_SETUP")!.initializer!.getText(ast)
let predicate = ast.statements.find(s => isFunctionDeclaration(s) && s.name?.text === "samplePerfTarget")?.getText(ast)
if (!predicate) {
  const visit = (node: import("typescript").Node) => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && node.expression.name.text === "waitForFunction" && node.arguments[0]?.getText(ast).includes("__PERF_PAINTED_TS__")) predicate = node.arguments[0].getText(ast)
    node.forEachChild(visit)
  }
  ast.forEachChild(visit)
}
const compiled = transpileModule(`const samplePerfTarget = ${predicate}; const INPAGE_SETUP = ${setupSource}; exports.sample = samplePerfTarget; exports.setup = INPAGE_SETUP;`, { compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.CommonJS } }).outputText
const program = {} as { sample: (input: Target) => unknown; setup: string }
new Function("exports", "tid", compiled)(program, tid)
const documents: JSDOM[] = []
afterEach(() => { documents.splice(0).forEach(dom => dom.window.close()) })

function setup(path = "/c/channels/server/target") {
  const dom = new JSDOM(`<main data-slot="community-conversation-surface" data-channel-id="target"><div data-testid="${tid.messageScroller}" aria-busy="false"><div data-message-list-content><div data-msg-id="message">Target body</div></div></div></main>`, { url: `http://localhost${path}`, runScripts: "outside-only" })
  documents.push(dom)
  const window = dom.window
  let now = 100
  Object.defineProperty(window.performance, "now", { value: () => now })
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", { value(this: HTMLElement) { const top = Number(this.dataset.top ?? 0), height = this.hasAttribute("data-msg-id") ? 20 : 100; return { x: 0, y: top, top, bottom: top + height, left: 0, right: 100, width: 100, height } } })
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", { value(this: HTMLElement) { return this.style.display === "none" ? [] : [this.getBoundingClientRect()] } })
  const frames: FrameRequestCallback[] = []
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
  const resize: Array<{ disconnected: boolean; deliver: () => void }> = []
  window.ResizeObserver = class { disconnected = false; constructor(private callback: () => void) { resize.push(this) } observe() {} disconnect() { this.disconnected = true } deliver() { if (!this.disconnected) this.callback() } } as unknown as typeof ResizeObserver
  const observers: Array<{ disconnected: boolean }> = []
  window.PerformanceObserver = class { disconnected = false; constructor() { observers.push(this) } observe() {} disconnect() { this.disconnected = true } } as unknown as typeof PerformanceObserver
  const sample = window.eval(`(${program.sample.toString()})`) as (input: Target) => unknown
  return { window, api: window as unknown as Window, sample, install: () => window.eval(program.setup), frame: () => { now += 16; frames.splice(0).forEach(callback => callback(now)) }, resize, observers, tick: (value: number) => { now = value } }
}

it("runs the serialized target predicate without a Node closure", () => {
  const f = setup()
  expect(f.sample(target)).toBeTruthy()
  expect(f.api.__PERF_PAINTED_TS__).toBe(100)
})
it.each(["old-channel", "old-server", "inert", "hidden", "busy", "skeleton", "outside"])("rejects %s as target paint", variant => {
  const f = setup(variant === "old-channel" ? "/c/channels/server/old" : variant === "old-server" ? "/c/channels/other/target" : undefined)
  const surface = f.window.document.querySelector("main")!, content = surface.querySelector("[data-message-list-content]")!, row = content.querySelector<HTMLElement>("[data-msg-id]")!
  if (variant === "inert") content.setAttribute("inert", "")
  if (variant === "hidden") content.setAttribute("aria-hidden", "true")
  if (variant === "busy") surface.querySelector("[aria-busy]")!.setAttribute("aria-busy", "true")
  if (variant === "skeleton") { row.remove(); content.innerHTML = '<div data-slot="skeleton"></div>' }
  if (variant === "outside") row.dataset.top = "200"
  expect(f.sample(target)).toBeFalsy()
  expect(f.api.__PERF_PAINTED_TS__ ?? null).toBeNull()
})
it("binds the actual channel resolved inside the requested server", () => {
  const f = setup("/c/channels/server/resolved")
  f.window.document.querySelector("main")!.setAttribute("data-channel-id", "resolved")
  expect(f.sample({ ...target, channelId: undefined })).toMatchObject({ channelId: "resolved" })
  expect(f.sample(target)).toBeFalsy()
})
it("settles after qualified target paint and retains the resize buffer", async () => {
  const f = setup(); f.install()
  expect(f.api.__PERF_ATTACH_RESIZE__!(target)).toBe(true)
  f.resize.at(-1)!.deliver(); f.tick(150)
  const pending = f.api.__PERF_WAIT_FOR_STABLE_RESIZE__!(target)
  f.frame(); f.frame()
  expect(await pending).toMatchObject({ contentChannelId: "target", contentStableTs: 182 })
  expect(f.api.__PERF_PAINTED_TS__).toBe(100)
  expect(f.api.__PERF_RESIZES__).toEqual([100])
})
it("keeps the original120-frame failure bound for a missing target", async () => {
  const f = setup("/c/channels/server/old"); f.install()
  const outcome = f.api.__PERF_WAIT_FOR_STABLE_RESIZE__!(target).then(() => null, error => error)
  for (let i = 0; i < 120; i++) f.frame()
  expect(await outcome).toBeInstanceOf(f.window.Error)
  expect(f.api.__PERF_PAINTED_TS__ ?? null).toBeNull()
})
it("releases prior existing collectors without editing their saved buffer", () => {
  const f = setup(); f.install(); f.api.__PERF_ATTACH_RESIZE__!(target)
  const saved = f.api.__PERF_RESOURCES__!
  saved.push({ name: "keep-original", startTime: 1, responseEnd: 2 }); f.install()
  expect(f.observers).toHaveLength(4)
  expect(f.observers.slice(0, 2).every(o => o.disconnected)).toBe(true)
  expect(f.resize[0].disconnected).toBe(true)
  expect(saved).toEqual([{ name: "keep-original", startTime: 1, responseEnd: 2 }])
  expect(f.api.__PERF_RESOURCES__).toEqual([])
})

it("requires a current resize delivery when the qualified target root is replaced", async () => {
  const f = setup(); f.install(); f.api.__PERF_ATTACH_RESIZE__!(target); f.resize.at(-1)!.deliver()
  const pending = f.api.__PERF_WAIT_FOR_STABLE_RESIZE__!(target)
  let settled = false
  void pending.then(() => { settled = true })
  const root = f.window.document.querySelector(`[data-testid="${tid.messageScroller}"]`)!
  root.replaceWith(root.cloneNode(true))
  f.frame(); f.frame(); await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.resize[0].disconnected).toBe(true)
  f.resize.at(-1)!.deliver(); f.frame()
  expect(await pending).toMatchObject({ contentChannelId: "target", contentStableTs: 148 })
})

it.each([false, true])("retains the primary readiness error and never returns runner success: drainFails=%s", async drainFails => {
  let measureSource = ""
  const visit = (node: import("typescript").Node) => {
    if (isFunctionDeclaration(node) && node.name?.text === "measureSwitch") measureSource = node.getText(ast)
    node.forEachChild(visit)
  }
  ast.forEachChild(visit)
  const body = transpileModule(`exports.measure = ${measureSource};`, { compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.CommonJS } }).outputText
  const exports = {} as { measure: (kind: string, id: string, cache: string, navigate: () => Promise<void>) => Promise<void> }
  const failure = new Error("browser predicate failed")
  const captured: unknown[] = []
  let evaluations = 0
  const page = { evaluate: async () => [undefined, undefined, 1000][evaluations++], waitForFunction: async () => { throw failure } }
  const drained = { clickTs: 1000, skeletonTs: null, paintedTs: null, contentStableTs: null, resources: [], commits: [], unmounts: [], layoutShifts: [], degraded: false }
  let flushes = 0
  const drain = async () => { if (drainFails) throw new Error("capture failed after predicate"); return drained }
  new Function("exports", "page", "captured", "targetServer", "tid", "INPAGE_SETUP", "drainSwitch", "flushCapture", "samplePerfTarget", body)(exports, page, captured, { id: "server" }, tid, program.setup, drain, () => { flushes++ }, program.sample)
  await expect(exports.measure("channel", "target", "cold", async () => {})).rejects.toBe(failure)
  expect(captured).toHaveLength(drainFails ? 0 : 1)
  expect(flushes).toBe(drainFails ? 0 : 1)
  if (!drainFails) expect(captured[0]).toMatchObject({ targetId: "target", paintedTs: null, contentStableTs: null })
})

function emptyTarget(f: ReturnType<typeof setup>) {
  const content = f.window.document.querySelector<HTMLElement>("[data-message-list-content]")!
  content.dataset.initialPositionPhase = "revealed"
  content.innerHTML = '<div aria-hidden="true" data-message-empty-tail></div>'
  return content
}

it("accepts only a revealed real empty target and records its content kind", () => {
  const f = setup(); emptyTarget(f)
  expect(f.sample(target)).toMatchObject({ channelId: "target", contentKind: "empty" })
  expect(f.api.__PERF_PAINTED_TS__).toBe(100)
})

it.each(["missing-marker", "busy", "hidden", "inert", "skeleton", "positioning", "error", "old-scope", "hidden-tail", "outside-message"])("rejects empty-state lookalike %s", variant => {
  const f = setup(variant === "old-scope" ? "/c/channels/server/old" : undefined), content = emptyTarget(f)
  if (variant === "missing-marker") content.innerHTML = ""
  if (variant === "busy") content.parentElement!.setAttribute("aria-busy", "true")
  if (variant === "hidden") content.setAttribute("aria-hidden", "true")
  if (variant === "inert") content.setAttribute("inert", "")
  if (variant === "skeleton") content.insertAdjacentHTML("beforeend", '<div data-slot="skeleton"></div>')
  if (variant === "positioning") content.dataset.initialPositionPhase = "positioning"
  if (variant === "error") content.insertAdjacentHTML("beforeend", '<div role="alert">Failed</div>')
  if (variant === "hidden-tail") content.querySelector<HTMLElement>("[data-message-empty-tail]")!.style.display = "none"
  if (variant === "outside-message") content.insertAdjacentHTML("beforeend", '<div data-msg-id="old" data-top="200">Outside</div>')
  expect(f.sample(target)).toBeFalsy()
  expect(f.api.__PERF_PAINTED_TS__ ?? null).toBeNull()
})

it("settles and identifies the server's actual empty default channel", async () => {
  const f = setup("/c/channels/server/all")
  f.window.document.querySelector("main")!.setAttribute("data-channel-id", "all")
  emptyTarget(f); f.install()
  const serverTarget = { ...target, channelId: undefined }
  expect(f.api.__PERF_ATTACH_RESIZE__!(serverTarget)).toBe(true)
  f.resize.at(-1)!.deliver()
  const pending = f.api.__PERF_WAIT_FOR_STABLE_RESIZE__!(serverTarget)
  f.frame(); f.frame()
  expect(await pending).toMatchObject({ contentChannelId: "all", contentKind: "empty", contentStableTs: 132 })
})
