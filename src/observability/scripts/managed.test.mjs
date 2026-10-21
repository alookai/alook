import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { EventEmitter } from "node:events"
import net from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { assertPortAvailable, startManagedCollector, stopOwnedChild } from "./managed.mjs"
import { forceNativeGroup } from "./process-group.mjs"

const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, "127.0.0.1", resolveReady))
  const value = server.address().port
  await new Promise(resolveClosed => server.close(resolveClosed))
  return value
}
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "alook-observability-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const packageManager = resolve(root, "native-pnpm")
  const log = resolve(root, "calls.jsonl")
  writeFileSync(packageManager, `#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http'),cp=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({args,cwd:process.cwd(),registry:process.env.WRANGLER_REGISTRY_PATH,endpoint:process.env.NEXT_PUBLIC_FARO_OTLP_ENDPOINT,pid:process.pid})+'\\n');
if(args.includes('migrations')) {
  if(process.env.TEST_HOLD_MIGRATION) setInterval(()=>{},1000);
  else process.exit(process.env.TEST_MIGRATION_FAILURE ? 2 : 0);
} else {
  const port=Number(args[args.indexOf('--port')+1]);
  const variable=args[args.indexOf('--var')+1]||'';
  if(process.env.TEST_GRANDCHILD_PORT && args.includes('wrangler')) cp.spawn(process.execPath,['-e','require("node:net").createServer().listen('+Number(process.env.TEST_GRANDCHILD_PORT)+',"127.0.0.1")'],{stdio:'ignore'});
  http.createServer((req,res)=>{
    if(req.url==='/__exit'){res.end('{}',()=>setImmediate(()=>process.exit(7)));return;}
    res.statusCode=process.env.TEST_NOT_READY?503:200;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(args.includes('next') ? {zone:args.includes('blog')?'blog':'main',endpoint:process.env.NEXT_PUBLIC_FARO_OTLP_ENDPOINT} : {service:'alook-observability',schema:1,runId:process.env.TEST_WRONG_ID?'wrong':variable.slice('LOCAL_RUN_ID:'.length)}));
  }).listen(port,'127.0.0.1');
}
`)
  chmodSync(packageManager, 0o755)
  cleanup.push(async () => {
    if (!existsSync(log)) return
    for (const line of readFileSync(log, "utf8").trim().split("\n")) {
      const call = JSON.parse(line)
      if (call.args.includes("dev")) await forceNativeGroup(call.pid)
    }
  })
  return { root, packageManager, env: { ...process.env, TEST_CALLS: log }, calls: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) }
}
async function start(value, extra = {}) {
  const port = await freePort()
  const collector = await startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: String(port) }, stdio: "ignore", ...extra })
  cleanup.push(() => collector.stop())
  return { collector, port }
}

it("runs native pnpm migrations before the receiver, binds its own health identity and releases child/grandchild ports", async () => {
  const value = fixture()
  const grandchild = await freePort()
  value.env.TEST_GRANDCHILD_PORT = String(grandchild)
  const { collector, port } = await start(value)
  const calls = value.calls()
  expect(calls).toHaveLength(2)
  expect(calls[0].args.slice(0, 8)).toEqual(["--filter", "@alook/observability", "exec", "wrangler", "d1", "migrations", "apply", "alook-observability-local"])
  expect(calls[1].args).toContain("--local")
  expect(calls.every(call => call.registry === resolve(value.root, ".wrangler/registry"))).toBe(true)
  expect(collector.env.NEXT_PUBLIC_FARO_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${port}`)
  await vi.waitFor(async () => { await expect(assertPortAvailable(grandchild)).rejects.toThrow("occupied") })
  await collector.stop()
  await assertPortAvailable(port)
  await assertPortAvailable(grandchild)
})

it("refuses occupied ports without terminating their listener", async () => {
  const value = fixture()
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, "127.0.0.1", resolveReady))
  cleanup.push(() => new Promise(resolveClosed => server.close(resolveClosed)))
  await expect(startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: String(server.address().port) }, stdio: "ignore" })).rejects.toThrow("occupied")
  expect(server.listening).toBe(true)
})

it("cleans up on cancellation during migrations, failed migrations and mismatched readiness", async () => {
  const value = fixture()
  const controller = new AbortController()
  const port = await freePort()
  const pending = startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: String(port), TEST_HOLD_MIGRATION: "1" }, signal: controller.signal, stdio: "ignore" })
  const result = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(value.calls()).toHaveLength(1))
  controller.abort()
  await result
  await assertPortAvailable(port)
  await expect(startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: String(port), TEST_MIGRATION_FAILURE: "1" }, stdio: "ignore" })).rejects.toThrow("migrations failed")
  await expect(startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: String(port), TEST_WRONG_ID: "1" }, stdio: "ignore" })).rejects.toThrow("another process")
  await assertPortAvailable(port)
})

it("reports unexpected receiver exit to its owner", async () => {
  const value = fixture()
  const onExit = vi.fn()
  const { collector } = await start(value, { onExit })
  await fetch(collector.origin + "/__exit").catch(() => {})
  await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith({ code: 7, signal: null }))
  await collector.stop()
})

it("passes isolated ports and one receiver origin through the real multi-zone owner, then stops every owned listener", async () => {
  const value = fixture()
  const ports = { ingress: await freePort(), main: await freePort(), blog: await freePort(), receiver: await freePort() }
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../web/scripts/dev-zones.mjs")], {
    cwd: resolve(import.meta.dirname, "../../web"), detached: process.platform !== "win32", stdio: "ignore",
    env: { ...value.env, npm_execpath: value.packageManager, ALOOK_DEV_PORT: String(ports.ingress), ALOOK_DEV_MAIN_PORT: String(ports.main), ALOOK_DEV_BLOG_PORT: String(ports.blog), ALOOK_OBSERVABILITY_PORT: String(ports.receiver) },
  })
  cleanup.push(() => stopOwnedChild(child))
  await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${ports.ingress}/`)).status).toBe(200), { timeout: 5000 })
  expect(await (await fetch(`http://127.0.0.1:${ports.ingress}/blog`)).json()).toEqual({ zone: "blog", endpoint: `http://127.0.0.1:${ports.receiver}` })
  expect(value.calls().filter(call => call.args.includes("wrangler") && call.args.includes("dev"))).toHaveLength(1)
  expect(value.calls().filter(call => call.args.includes("next"))).toHaveLength(2)
  await stopOwnedChild(child)
  for (const port of Object.values(ports)) await vi.waitFor(() => assertPortAvailable(port))
}, 10_000)

it.skipIf(process.platform === "win32")("releases all detached native children when the zone owner is killed before async shutdown", async () => {
  const value = fixture()
  const ports = { ingress: await freePort(), main: await freePort(), blog: await freePort(), receiver: await freePort() }
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../web/scripts/dev-zones.mjs")], {
    cwd: resolve(import.meta.dirname, "../../web"), detached: true, stdio: "ignore",
    env: { ...value.env, npm_execpath: value.packageManager, ALOOK_DEV_PORT: String(ports.ingress), ALOOK_DEV_MAIN_PORT: String(ports.main), ALOOK_DEV_BLOG_PORT: String(ports.blog), ALOOK_OBSERVABILITY_PORT: String(ports.receiver) },
  })
  cleanup.push(() => stopOwnedChild(child))
  await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${ports.ingress}/`)).status).toBe(200), { timeout: 5000 })
  child.kill("SIGKILL")
  await vi.waitFor(() => expect(child.signalCode).toBe("SIGKILL"))
  for (const port of Object.values(ports)) await vi.waitFor(() => assertPortAvailable(port), { timeout: 5000 })
}, 10_000)

it("starts collection only for next dev and stops the frontend when its receiver exits", async () => {
  const value = fixture()
  const receiver = await freePort()
  const frontend = await freePort()
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../../scripts/dev-with-wrangler-registry.mjs"), "../../.wrangler/registry", "next", "dev", "--port", String(frontend)], {
    cwd: resolve(import.meta.dirname, "../../web"), detached: process.platform !== "win32", stdio: "ignore",
    env: { ...value.env, npm_execpath: value.packageManager, ALOOK_OBSERVABILITY_PORT: String(receiver) },
  })
  cleanup.push(() => stopOwnedChild(child))
  await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${frontend}`)).status).toBe(200), { timeout: 5000 })
  await fetch(`http://127.0.0.1:${receiver}/__exit`).catch(() => {})
  await vi.waitFor(() => expect(child.exitCode).toBe(1), { timeout: 5000 })
  await assertPortAvailable(frontend)
  await assertPortAvailable(receiver)
}, 10_000)

it("times out an unhealthy receiver and cancels while waiting for health", async () => {
  const value = fixture()
  const port = await freePort()
  await expect(startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: String(port), TEST_NOT_READY: "1" }, readinessMs: 1000, stdio: "ignore" })).rejects.toThrow("did not become ready")
  await assertPortAvailable(port)
  const controller = new AbortController()
  const next = fixture()
  const pending = startManagedCollector({ ...next, env: { ...next.env, ALOOK_OBSERVABILITY_PORT: String(port), TEST_NOT_READY: "1" }, signal: controller.signal, stdio: "ignore" })
  const result = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(next.calls()).toHaveLength(2))
  controller.abort()
  await result
  await assertPortAvailable(port)
})

it("rejects invalid startup configuration before launching and respects an already cancelled owner", async () => {
  const value = fixture()
  for (const invalid of ["0", "-1", "text", "65536"]) await expect(startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: invalid } })).rejects.toThrow("port")
  await expect(startManagedCollector({ ...value, packageManager: "" })).rejects.toThrow("npm_execpath")
  const controller = new AbortController()
  controller.abort(new Error("already cancelled fixture"))
  const port = await freePort()
  await expect(startManagedCollector({ ...value, env: { ...value.env, ALOOK_OBSERVABILITY_PORT: String(port) }, signal: controller.signal })).rejects.toThrow("already cancelled")
})

it.skipIf(process.platform === "win32")("delegates Windows cleanup to an exact owned PID tree command, and skips closed or missing PIDs", async () => {
  const value = fixture()
  const log = resolve(value.root, "tree-args.txt")
  const command = resolve(value.root, "taskkill")
  writeFileSync(command, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TEST_TASKKILL_CALLS"\n')
  chmodSync(command, 0o755)
  vi.stubEnv("PATH", value.root + ":" + process.env.PATH)
  vi.stubEnv("TEST_TASKKILL_CALLS", log)
  try {
    const child = Object.assign(new EventEmitter(), { pid: 777777, exitCode: null, signalCode: null })
    await stopOwnedChild(child, "win32")
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["/pid", "777777", "/T", "/F"])
    rmSync(log)
    child.exitCode = 0
    await stopOwnedChild(child, "win32")
    await stopOwnedChild({ exitCode: 0, signalCode: null })
    expect(existsSync(log)).toBe(false)
  } finally { vi.unstubAllEnvs() }
})
