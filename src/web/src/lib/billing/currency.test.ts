import { describe, expect, it } from "vitest"
import { stripeAmountToMajorUnit } from "./currency"

describe("Stripe charge currency amounts", () => {
  it.each([
    ["usd", 500, 5],
    ["jpy", 500, 500],
    ["isk", 500, 5],
    ["huf", 500, 5],
    ["twd", 500, 5],
    ["ugx", 500, 5],
  ] as const)("converts %s from Stripe minor units", (currency, amount, expected) => {
    expect(stripeAmountToMajorUnit(amount, currency)).toBe(expected)
  })

  it.each([
    [-1, "usd"],
    [1.5, "usd"],
    [Number.MAX_SAFE_INTEGER + 1, "usd"],
    [500, "invalid"],
  ] as const)("rejects an invalid amount or currency", (amount, currency) => {
    expect(stripeAmountToMajorUnit(amount, currency)).toBeNull()
  })
})
