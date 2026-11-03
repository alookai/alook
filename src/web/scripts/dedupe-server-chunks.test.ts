import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { dedupeServerChunks } from "./dedupe-server-chunks"

const roots: string[] = []
const chunk = 'module.exports=[123,context=>{context.exports.value="same"}];\n'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alook-server-chunks-"))
  roots.push(root)
  const original = join(root, ".next/server/chunks")
  const standalone = join(root, ".next/standalone/src/web/.next/server/chunks")
  function put(name: string, source = chunk) {
    for (const base of [original, standalone]) {
      const filename = join(base, name)
      mkdirSync(dirname(filename), { recursive: true })
      writeFileSync(filename, source)
    }
  }
  function trace(name: string, files: string[]) {
    const filename = join(root, ".next", name)
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(filename, JSON.stringify({ version: 1, files }))
    return filename
  }
  return { root, original, standalone, put, trace }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("dedupeServerChunks", () => {
  it("preserves all paths and forwards identical chunks to a deterministic canonical file", () => {
    const f = fixture()
    f.put("z.js")
    f.put("a.js")
    const trace = f.trace("server/app/sign-in/page.js.nft.json", ["../../chunks/z.js"])
    const result = dedupeServerChunks(f.root)
    expect(result.aliases).toBe(1)
    expect(result.savedBytes).toBeGreaterThan(0)
    expect(result.updatedTraces).toBe(1)
    expect(readFileSync(join(f.standalone, "a.js"), "utf8")).toBe(chunk)
    const require = createRequire(join(f.root, "entry.cjs"))
    const canonical = require(join(f.standalone, "a.js"))
    const alias = require(join(f.standalone, "z.js"))
    expect(alias).toBe(canonical)
    const context = { exports: {} }
    alias[1](context)
    expect(context.exports).toEqual({ value: "same" })
    expect(readFileSync(join(f.original, "z.js"), "utf8")).toBe(chunk)
    expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual({ version: 1, files: ["../../chunks/z.js", "../../chunks/a.js"] })
    expect(dedupeServerChunks(f.root)).toEqual({ aliases: 0, savedBytes: 0, updatedTraces: 0 })
  })

  it("ignores only each file's own trailing source map pointer", () => {
    const f = fixture()
    f.put("a.js", `${chunk}\n//# sourceMappingURL=a.js.map`)
    f.put("b.js", `${chunk}\n//# sourceMappingURL=b.js.map`)
    f.put("c.js", `${chunk}\n//# sourceMappingURL=other.js.map`)
    expect(dedupeServerChunks(f.root).aliases).toBe(1)
    expect(readFileSync(join(f.standalone, "c.js"), "utf8")).toContain("other.js.map")
  })

  it("supports strict IIFE chunks and keeps factory dispatch behavior", () => {
    const f = fixture()
    const source = '(()=>{"use strict";module.exports=[321,context=>{context.exports.n=context.input+1}];})();\n'
    f.put("a.js", source)
    f.put("b.js", source)
    dedupeServerChunks(f.root)
    const require = createRequire(join(f.root, "entry.cjs"))
    const first = require(join(f.standalone, "a.js"))
    const second = require(join(f.standalone, "b.js"))
    expect(second).toBe(first)
    const context = { input: 8, exports: {} }
    second[1](context)
    expect(context.exports).toEqual({ n: 9 })
  })

  it("keeps directories, different bytes, unsupported code and non-JS files separate", () => {
    const f = fixture()
    f.put("a.js")
    f.put("ssr/a.js")
    f.put("different.js", chunk.replace("same", "different"))
    f.put("one.js", 'module.exports={value:"object"};')
    f.put("two.js", 'module.exports={value:"object"};')
    f.put("data.json", chunk)
    f.put("data2.json", chunk)
    f.put("[turbopack]_runtime.js", "globalThis.chunkRuntime = new Map();")
    expect(dedupeServerChunks(f.root).aliases).toBe(0)
  })

  it.each(["__filename", "__dirname", "module.filename", "module.id"])("keeps location-dependent chunks: %s", expression => {
    const f = fixture()
    f.put("a.js", `module.exports=[321,c=>{c.exports.path=${expression}}];`)
    f.put("b.js", `module.exports=[321,c=>{c.exports.path=${expression}}];`)
    expect(dedupeServerChunks(f.root).aliases).toBe(0)
  })

  it("updates top-level traces without dropping metadata or duplicating existing dependencies", () => {
    const f = fixture()
    f.put("a.js")
    f.put("b.js")
    const first = f.trace("next-server.js.nft.json", ["server/chunks/b.js"])
    const second = f.trace("server/app/c/page.js.nft.json", ["../../chunks/b.js", "../../chunks/a.js"])
    expect(dedupeServerChunks(f.root).updatedTraces).toBe(1)
    expect(JSON.parse(readFileSync(first, "utf8")).files).toEqual(["server/chunks/b.js", "server/chunks/a.js"])
    expect(JSON.parse(readFileSync(second, "utf8")).files).toHaveLength(2)
  })

  it("validates traces before changing chunks", () => {
    const f = fixture()
    f.put("a.js")
    f.put("b.js")
    const trace = f.trace("next-server.js.nft.json", [])
    writeFileSync(trace, '{"version":1,"files":[12]}')
    expect(() => dedupeServerChunks(f.root)).toThrow("Invalid Next file trace")
    expect(readFileSync(join(f.standalone, "b.js"), "utf8")).toBe(chunk)
  })

  it("does not follow symlinks or touch the Blog tree", () => {
    const f = fixture()
    f.put("a.js")
    const outside = join(f.root, "outside.js")
    writeFileSync(outside, chunk)
    symlinkSync(outside, join(f.standalone, "linked.js"))
    symlinkSync(dirname(outside), join(f.standalone, "linked-directory"))
    const blog = join(f.root, "blog/.next/standalone/src/web/blog/.next/server/chunks/b.js")
    mkdirSync(dirname(blog), { recursive: true })
    writeFileSync(blog, chunk)
    expect(dedupeServerChunks(f.root).aliases).toBe(0)
    expect(readFileSync(outside, "utf8")).toBe(chunk)
    expect(readFileSync(blog, "utf8")).toBe(chunk)
  })

  it("is a no-op without a standalone build", () => {
    const f = fixture()
    expect(dedupeServerChunks(f.root)).toEqual({ aliases: 0, savedBytes: 0, updatedTraces: 0 })
  })

  it("keeps tiny chunks when forwarding would increase their size", () => {
    const f = fixture()
    f.put("a.js", "module.exports=[1,a=>0];")
    f.put("b.js", "module.exports=[1,a=>0];")
    expect(dedupeServerChunks(f.root).aliases).toBe(0)
    expect(readFileSync(join(f.standalone, "b.js"), "utf8")).toBe("module.exports=[1,a=>0];")
  })

  it.each([
    'module.exports=[9,(()=>{let count=0;return ()=>++count})()];',
    '(()=>{"use strict";module.exports=[9,()=>++count];let count=0})();',
    'module.exports=[9,function counter(){return counter.n=(counter.n||0)+1}];',
  ])("preserves independent eager or named-function state: %s", source => {
    const f = fixture()
    f.put("a.js", source)
    f.put("b.js", source)
    expect(dedupeServerChunks(f.root).aliases).toBe(0)
    const require = createRequire(join(f.root, "entry.cjs"))
    expect(require(join(f.standalone, "a.js"))[1]()).toBe(1)
    expect(require(join(f.standalone, "b.js"))[1]()).toBe(1)
  })

  it.each(["module.exports", "exports", "require", "arguments", "this", 'eval("module.exports")'])("does not merge factories capturing their CommonJS wrapper: %s", expression => {
    const f = fixture()
    f.put("a.js", `module.exports=[321,context=>{context.value=${expression}}];`)
    f.put("b.js", `module.exports=[321,context=>{context.value=${expression}}];`)
    expect(dedupeServerChunks(f.root).aliases).toBe(0)
  })

  it("accepts strict factory groups and class-owned context without capturing wrapper state", () => {
    const f = fixture()
    const source = 'module.exports=[[123,context=>{class Example{value=this;method(){return arguments.length}};context.exports={module:Example}}],456,context=>{context.exports="plain"}];'
    f.put("a.js", source)
    f.put("b.js", source)
    expect(dedupeServerChunks(f.root).aliases).toBe(1)
  })

  it.each([
    'module.exports=[123,context=>{}',
    'module.exports=[123];',
    'module.exports=[context=>{}];',
    'module.exports=[[123]];',
    'module.exports=[...other];',
    '(function(){module.exports=[123,context=>{}]})()',
    'module.exports=[123,context=>{return class Example{[this.state](){}}}];',
    'module.exports=[123,context=>{return class Example{[arguments[0]]=true}}];',
    '(()=>{"use strict";module.exports=[123,context=>{}];sideEffect()})();',
  ])("keeps unsupported or malformed factory containers: %s", source => {
    const f = fixture()
    f.put("a.js", source)
    f.put("b.js", source)
    expect(dedupeServerChunks(f.root).aliases).toBe(0)
  })
})
