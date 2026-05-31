import { describe, it, expect, vi } from "vitest";
import * as whitelistQueries from "../../src/db/queries/whitelist";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.onConflictDoNothing = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.delete = vi.fn(() => chain);
  return chain;
}

describe("whitelist query module exports", () => {
  it("exports getWhitelist", () => {
    expect(typeof whitelistQueries.getWhitelist).toBe("function");
  });

  it("exports addWhitelist", () => {
    expect(typeof whitelistQueries.addWhitelist).toBe("function");
  });

  it("exports removeWhitelist", () => {
    expect(typeof whitelistQueries.removeWhitelist).toBe("function");
  });

  it("exports removeWhitelistByEmail", () => {
    expect(typeof whitelistQueries.removeWhitelistByEmail).toBe("function");
  });

  it("exports isWhitelisted", () => {
    expect(typeof whitelistQueries.isWhitelisted).toBe("function");
  });

  it("exports buildWhitelistSet", () => {
    expect(typeof whitelistQueries.buildWhitelistSet).toBe("function");
  });
});

describe("addWhitelist", () => {
  it("returns null when insert conflicts (no row returned)", async () => {
    const mockDb = createMockDb([]);
    mockDb.returning = vi.fn(() => Promise.resolve([]));
    const result = await whitelistQueries.addWhitelist(mockDb, "ag_1", "ws_1", "user@example.com");
    expect(result).toBeNull();
  });
});

describe("removeWhitelist", () => {
  it("returns null when no row deleted", async () => {
    const mockDb = createMockDb([]);
    mockDb.returning = vi.fn(() => Promise.resolve([]));
    const result = await whitelistQueries.removeWhitelist(mockDb, "wl_1", "ag_1", "ws_1");
    expect(result).toBeNull();
  });
});
