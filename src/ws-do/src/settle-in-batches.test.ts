import { describe, expect, it, vi } from "vitest"
import { settleInBatches } from "./settle-in-batches"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("settleInBatches", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "throws synchronously for invalid batch size %s",
    (batchSize) => {
      const mapper = vi.fn(async (value: number) => value)

      expect(() => settleInBatches([1], mapper, batchSize)).toThrow(RangeError)
      expect(mapper).not.toHaveBeenCalled()
    },
  )

  it.each([0, 1, 40, 41, 81, 1000])(
    "settles %i inputs in input-index order",
    async (inputCount) => {
      const inputs = Array.from({ length: inputCount }, (_, index) => index)
      let active = 0
      let maxActive = 0
      const mapper = vi.fn(async (value: number, index: number) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return `${index}:${value}`
      })

      const results = await settleInBatches(inputs, mapper, 40)

      expect(results).toEqual(inputs.map((value, index) => ({
        status: "fulfilled",
        value: `${index}:${value}`,
      })))
      expect(mapper).toHaveBeenCalledTimes(inputCount)
      expect(maxActive).toBe(Math.min(inputCount, 40))
    },
  )

  it("waits for every item in one batch before starting the next", async () => {
    const gates = Array.from({ length: 41 }, () => deferred<number>())
    const started: number[] = []
    const execution = settleInBatches(gates, async (gate, index) => {
      started.push(index)
      return gate.promise
    }, 40)

    await vi.waitFor(() => expect(started).toEqual(Array.from({ length: 40 }, (_, index) => index)))
    for (let index = 0; index < 39; index++) gates[index].resolve(index)
    await Promise.resolve()
    expect(started).toHaveLength(40)

    gates[39].resolve(39)
    await vi.waitFor(() => expect(started).toHaveLength(41))
    gates[40].resolve(40)

    await expect(execution).resolves.toEqual(Array.from({ length: 41 }, (_, index) => ({
      status: "fulfilled",
      value: index,
    })))
  })

  it("preserves input indexes when items settle out of order", async () => {
    const gates = Array.from({ length: 3 }, () => deferred<string>())
    const execution = settleInBatches(gates, (gate) => gate.promise, 3)

    gates[2].resolve("third")
    gates[0].resolve("first")
    gates[1].reject(new Error("second failed"))

    const results = await execution

    expect(results[0]).toEqual({ status: "fulfilled", value: "first" })
    expect(results[1]).toEqual({ status: "rejected", reason: expect.any(Error) })
    expect(results[2]).toEqual({ status: "fulfilled", value: "third" })
  })

  it("settles synchronous throws and rejections without blocking later items", async () => {
    const mapper = vi.fn((value: number) => {
      if (value === 1) throw new Error("sync")
      if (value === 2) return Promise.reject(new Error("async"))
      return Promise.resolve(value)
    })

    const results = await settleInBatches([0, 1, 2, 3], mapper, 2)

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "rejected",
      "fulfilled",
    ])
    expect(mapper).toHaveBeenCalledTimes(4)
  })
})
