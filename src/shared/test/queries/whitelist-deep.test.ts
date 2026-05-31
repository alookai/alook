import { describe, it, expect, vi } from "vitest";
import * as wl from "../../src/db/queries/whitelist";

describe("addWhitelist", () => {
  it("returns null on conflict", async () => {
    const chain: any = {};
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await wl.addWhitelist(chain, "ag_1", "w", "test@test.com")).toBeNull();
  });
  it("returns entry when created", async () => {
    const entry = { id: "wl_1", email: "test@test.com" };
    const chain: any = {};
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([entry]));
    expect(await wl.addWhitelist(chain, "ag_1", "w", "test@test.com")).toEqual(entry);
  });
});

describe("removeWhitelist", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await wl.removeWhitelist(chain, "x", "ag_1", "w")).toBeNull();
  });
  it("returns removed entry", async () => {
    const entry = { id: "wl_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([entry]));
    expect(await wl.removeWhitelist(chain, "wl_1", "ag_1", "w")).toEqual(entry);
  });
});

describe("removeWhitelistByEmail", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await wl.removeWhitelistByEmail(chain, "ag_1", "w", "x@x.com")).toBeNull();
  });
  it("returns removed entry", async () => {
    const entry = { id: "wl_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([entry]));
    expect(await wl.removeWhitelistByEmail(chain, "ag_1", "w", "t@t.com")).toEqual(entry);
  });
});

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
