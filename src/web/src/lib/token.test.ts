import { describe, it, expect } from "vitest";
import { generateMachineToken } from "./token.js";

describe("generateMachineToken", () => {
  it("starts with 'al_' prefix", () => {
    const token = generateMachineToken();
    expect(token.startsWith("al_")).toBe(true);
  });

  it("has correct length (al_ + 48 hex chars = 51)", () => {
    const token = generateMachineToken();
    expect(token.length).toBe(51);
  });

  it("contains only valid hex characters after prefix", () => {
    const token = generateMachineToken();
    const hex = token.slice(3);
    expect(hex).toMatch(/^[0-9a-f]{48}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateMachineToken()));
    expect(tokens.size).toBe(10);
  });
});
