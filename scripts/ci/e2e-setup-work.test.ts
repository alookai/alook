import { afterEach, expect, it, vi } from "vitest"
import { measureSetupAsync, measureSetupSync, prepareSetupUsers } from "../../src/web/src/test/e2e-ui/_setup/setup-work"

afterEach(() => { vi.restoreAllMocks() })

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it("prepares every user once with at most two active preparations", async () => {
  const users = Array.from({ length: 7 }, (_, index) => index)
  const gates = users.map(() => deferred<void>())
  const starts = users.map(() => deferred<void>())
  const called: number[] = []
  let active = 0
  let peak = 0
  const running = prepareSetupUsers(users, (user) => {
    called.push(user)
    active++
    peak = Math.max(peak, active)
    starts[user].resolve()
    return gates[user].promise.finally(() => { active-- })
  })
  try {
    expect(called).toEqual([0, 1])
    for (let index = 0; index < 5; index++) {
      gates[index].resolve()
      await starts[index + 2].promise
      expect(active).toBeLessThanOrEqual(2)
    }
    gates[5].resolve()
    gates[6].resolve()
    await running
    expect(called).toEqual(users)
    expect(peak).toBe(2)
    expect(active).toBe(0)
  } finally {
    for (const gate of gates) gate.resolve()
    await running
  }
})

it("stops new users after failure and waits for the other user before browser cleanup", async () => {
  const first = deferred<void>()
  const second = deferred<void>()
  const failure = new Error("original preparation failure")
  const called: string[] = []
  const close = vi.fn()
  const observed = (async () => {
    try {
      await prepareSetupUsers(["first", "second", "unstarted"], (user) => {
        called.push(user)
        return user === "first" ? first.promise : second.promise
      })
      return undefined
    } finally { close() }
  })().catch(error => error as unknown)
  first.reject(failure)
  await first.promise.catch(() => undefined)
  expect(close).not.toHaveBeenCalled()
  expect(called).toEqual(["first", "second"])
  second.resolve()
  expect(await observed).toBe(failure)
  expect(close).toHaveBeenCalledOnce()
  expect(called).toEqual(["first", "second"])
})

it("retains both in-flight failures in input order without starting another user", async () => {
  const first = deferred<void>()
  const second = deferred<void>()
  const firstError = new Error("first user")
  const secondError = new Error("second user")
  const prepare = vi.fn((user: number) => user === 0 ? first.promise : second.promise)
  const observed = prepareSetupUsers([0, 1, 2], prepare).catch(error => error as unknown)
  second.reject(secondError)
  first.reject(firstError)
  const result = await observed
  expect(result).toBeInstanceOf(AggregateError)
  expect((result as AggregateError).errors[0]).toBe(firstError)
  expect((result as AggregateError).errors[1]).toBe(secondError)
  expect(prepare.mock.calls.map(call => call[0])).toEqual([0, 1])
})

it("records synchronous work without copying its value or error into the phase", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const value = { privateResult: "not-a-phase-field" }
  const action = vi.fn(() => value)
  expect(measureSetupSync("prepare-services", action)).toBe(value)
  expect(action).toHaveBeenCalledOnce()
  const records = log.mock.calls.map(call => JSON.parse(call[0] as string) as { event: string; outcome?: string; durationMs?: number })
  expect(records.map(record => record.event)).toEqual(["start", "end"])
  expect(records[1].outcome).toBe("passed")
  expect(records[1].durationMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(records)).not.toContain(value.privateResult)
  const failure = new Error("private preparation details")
  let observed: unknown
  try { measureSetupSync("prepare-services", () => { throw failure }) } catch (error) { observed = error }
  expect(observed).toBe(failure)
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string).outcome).toBe("failed")
  expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message)
})

it("keeps an existing asynchronous action pending and preserves its exact result", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const held = deferred<object>()
  const action = vi.fn(() => held.promise)
  const running = measureSetupAsync("prepare-user", action, 2)
  expect(action).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledOnce()
  const value = { privateResult: "not-a-phase-field" }
  held.resolve(value)
  expect(await running).toBe(value)
  const end = JSON.parse(log.mock.calls.at(-1)![0] as string) as { event: string; outcome: string; slot: number; durationMs: number }
  expect(end).toMatchObject({ event: "end", outcome: "passed", slot: 2 })
  expect(end.durationMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(log.mock.calls)).not.toContain(value.privateResult)
})

it("preserves asynchronous failure identity and does not export its message", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const failure = new Error("private asynchronous details")
  await expect(measureSetupAsync("global-teardown", () => Promise.reject(failure))).rejects.toBe(failure)
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string).outcome).toBe("failed")
  expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message)
})

it("keeps diagnostic output failures from replacing work results or failures", async () => {
  vi.spyOn(console, "log").mockImplementation(() => { throw new Error("diagnostic sink unavailable") })
  const value = {}
  const failure = new Error("original work failure")
  expect(measureSetupSync("prepare-services", () => value)).toBe(value)
  await expect(measureSetupAsync("start-services", () => Promise.resolve(value))).resolves.toBe(value)
  await expect(measureSetupAsync("setup-cleanup", () => Promise.reject(failure))).rejects.toBe(failure)
})
