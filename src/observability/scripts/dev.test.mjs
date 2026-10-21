import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import { runStandalone } from "./dev.mjs"

it("stops its owned collector on a signal and removes only its own signal handlers", async () => {
  const runtime = new EventEmitter()
  const other = vi.fn()
  runtime.on("SIGINT", other)
  const stop = vi.fn()
  const start = vi.fn(async () => ({ stop }))
  const owner = await runStandalone({ runtime, start, root: "/fixture" })
  runtime.emit("SIGTERM")
  await owner.stop()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(runtime.exitCode).toBe(0)
  expect(runtime.listeners("SIGINT")).toEqual([other])
})

it("keeps unexpected startup failure as failure and stops a late-returning collector", async () => {
  const runtime = new EventEmitter()
  const stop = vi.fn()
  await runStandalone({ runtime, start: async ({ onExit }) => { onExit(); return { stop } } })
  expect(runtime.exitCode).toBe(1)
  expect(stop).toHaveBeenCalledTimes(1)
})

it("cleans up failed startup and keeps a user startup cancellation successful", async () => {
  const runtime = new EventEmitter()
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    await runStandalone({ runtime, start: async () => { throw new Error("fixture startup failure") } })
    expect(runtime.exitCode).toBe(1)
    await runStandalone({ runtime, start: async () => { runtime.emit("SIGINT"); throw new Error("fixture cancellation") } })
    expect(runtime.exitCode).toBe(0)
  } finally { log.mockRestore() }
})
