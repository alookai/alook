import { describe, expect, it } from "vitest";
import { parseAttemptedCountReceipt } from "../src/transport-receipt";

describe("parseAttemptedCountReceipt", () => {
  it("accepts attempted-only, equal dual-write, and optionally legacy sent-only receipts", () => {
    expect(parseAttemptedCountReceipt({ attempted: 2 })).toBe(2);
    expect(parseAttemptedCountReceipt({ attempted: 2, sent: 2 })).toBe(2);
    expect(parseAttemptedCountReceipt({ sent: 2 })).toBe(2);
    expect(() => parseAttemptedCountReceipt({ sent: 2 }, { allowLegacySentOnly: false })).toThrow();
  });

  it.each([
    null,
    {},
    { attempted: -1 },
    { attempted: 0.5 },
    { attempted: Number.MAX_SAFE_INTEGER + 1 },
    { attempted: 1, sent: 0 },
    { attempted: 1, sent: "1" },
  ])("rejects malformed or inconsistent receipt %#", (receipt) => {
    expect(() => parseAttemptedCountReceipt(receipt)).toThrow();
  });
});
