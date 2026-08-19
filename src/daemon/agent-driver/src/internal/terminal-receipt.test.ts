import { describe, expect, it } from "vitest";
import { TerminalReceiptFence } from "./terminal-receipt.js";

describe("TerminalReceiptFence", () => {
  it("bounds retained fingerprints while preserving current ownership", () => {
    const fence = new TerminalReceiptFence("test");
    const current = fence.beginTurn();
    for (let index = 0; index < 65; index += 1) fence.claimTerminal(`terminal-${index}`);
    expect(fence.isCurrent(current)).toBe(true);
    expect(fence.claimTerminal("terminal-64")).toBe(current);
  });
});
