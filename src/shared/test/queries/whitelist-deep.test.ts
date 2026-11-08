import { describe, it, expect, vi } from "vitest";
import * as wl from "../../src/db/queries/whitelist";

describe("isWhitelisted", () => {
  it("returns true for whitelisted email", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.limit = vi.fn(() => Promise.resolve([{ id: "wl_1" }]));
    expect(await wl.isWhitelisted(chain, "ag_1", "w", "test@test.com")).toBe(true);
  });
  it("returns false for non-whitelisted email", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.limit = vi.fn(() => Promise.resolve([]));
    expect(await wl.isWhitelisted(chain, "ag_1", "w", "unknown@test.com")).toBe(false);
  });
});

describe("buildWhitelistSet", () => {
  it("builds a check function that matches whitelisted emails", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ email: "a@b.com" }]));
    const result = await wl.buildWhitelistSet(chain, "ag_1", "w");
    expect(result.check("a@b.com")).toBe(true);
    expect(result.check("unknown@b.com")).toBe(false);
  });
});
