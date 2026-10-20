import { EventEmitter } from "node:events"
import net from "node:net"
import { afterEach, expect, it, vi } from "vitest"
import { assertPortAvailable } from "./managed.mjs"
import { runOwnedProcess, spawnOwnedProcess, stopOwnedChild } from "./owned-process.mjs"

const cleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function freePort() {
  const server = net.createServer()
  await new Promise(resolveReady => server.listen(0, "127.0.0.1", resolveReady))
  const port = server.address().port
  await new Promise(resolveClosed => server.close(resolveClosed))
  return port
}
const nativeServer = port => `require('node:http').createServer((req,res)=>res.end('owned')).listen(${port},'127.0.0.1')`
function runtime() {
  const value = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message, callback) => callback?.()), exitCode: undefined })
  value.disconnect = vi.fn(() => { value.connected = false })
  return value
}

it("stops the native group when its IPC parent disconnects and retires its own signal handlers", async () => {
  const owner = runtime()
  const port = await freePort()
  const pending = runOwnedProcess({ command: process.execPath, args: ["-e", nativeServer(port)], runtime: owner, stdio: "ignore" })
  cleanup.push(async () => { owner.connected = false; owner.emit("disconnect"); await pending })
  await vi.waitFor(async () => expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("owned"))
  owner.connected = false
  owner.emit("disconnect")
  expect(await pending).toEqual({ code: 0 })
  expect(owner.listenerCount("SIGTERM")).toBe(0)
  expect(owner.send.mock.calls[0][0]).toMatchObject({ type: "spawned" })
  await assertPortAvailable(port)
})

it("handles IPC stop and signal retirement, and refuses to start without a connected owner", async () => {
  for (const event of ["message", "SIGTERM"]) {
    const owner = runtime()
    const port = await freePort()
    const pending = runOwnedProcess({ command: process.execPath, args: ["-e", nativeServer(port)], runtime: owner, stdio: "ignore" })
    cleanup.push(async () => { owner.emit("SIGTERM"); await pending })
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalled())
    owner.emit(event, { type: "stop" })
    expect(await pending).toEqual({ code: 0 })
    expect(owner.disconnect).toHaveBeenCalledTimes(1)
    await assertPortAvailable(port)
  }
  const retired = runtime(); retired.connected = false
  expect(await runOwnedProcess({ command: process.execPath, runtime: retired })).toEqual({ code: 0 })
  expect(retired.send).not.toHaveBeenCalled()
  await expect(runOwnedProcess({ runtime: runtime() })).rejects.toThrow("command")
})

it("preserves native command failure and cleans a race in IPC admission", async () => {
  expect(await runOwnedProcess({ command: process.execPath, args: ["-e", "process.exit(7)"], runtime: runtime(), stdio: "ignore" })).toEqual({ code: 7 })
  expect(await runOwnedProcess({ command: "/missing/alook-native-command", runtime: runtime(), stdio: "ignore" })).toEqual({ code: 1 })
  for (const failure of ["throw", "callback"]) {
    const owner = runtime()
    owner.send.mockImplementation((_message, callback) => { if (failure === "throw") throw new Error("IPC retired"); callback(new Error("IPC retired")) })
    expect(await runOwnedProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], runtime: owner, stdio: "ignore" })).toEqual({ code: 0 })
  }
})

it("uses the real IPC supervisor and keeps repeated stop idempotent", async () => {
  const port = await freePort()
  const child = spawnOwnedProcess(process.execPath, ["-e", nativeServer(port)], { stdio: "ignore" })
  cleanup.push(() => stopOwnedChild(child))
  await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200))
  await stopOwnedChild(child)
  await stopOwnedChild(child)
  expect(child.exitCode).toBe(0)
  await assertPortAvailable(port)
  const exited = spawnOwnedProcess(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" })
  cleanup.push(() => stopOwnedChild(exited))
  await vi.waitFor(() => expect(exited.exitCode).toBe(7))
  await stopOwnedChild(exited)
})

it.skipIf(process.platform === "win32")("retains native-group ownership until the supervisor confirms retirement", async () => {
  for (const phase of ["before", "during"]) {
    const port = await freePort()
    const child = spawnOwnedProcess(process.execPath, ["-e", nativeServer(port)], { stdio: "ignore" })
    cleanup.push(() => stopOwnedChild(child))
    await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200))
    if (phase === "before") {
      child.kill("SIGKILL")
      await vi.waitFor(() => expect(child.signalCode).toBe("SIGKILL"))
    } else child.send = () => child.kill("SIGKILL")
    await stopOwnedChild(child)
    expect(child.signalCode).toBe("SIGKILL")
    await vi.waitFor(() => assertPortAvailable(port))
  }
})

it.skipIf(process.platform === "win32")("bounds cleanup when the IPC supervisor itself is stopped and cannot read shutdown", async () => {
  const port = await freePort()
  const child = spawnOwnedProcess(process.execPath, ["-e", nativeServer(port)], { stdio: "ignore" })
  cleanup.push(() => stopOwnedChild(child))
  await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200))
  child.kill("SIGSTOP")
  await stopOwnedChild(child)
  expect(child.signalCode).toBe("SIGKILL")
  await assertPortAvailable(port)
}, 15_000)
