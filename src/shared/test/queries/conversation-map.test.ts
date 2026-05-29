import { describe, it, expect, vi } from "vitest";
import * as conversationMapQueries from "../../src/db/queries/conversation-map";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.onConflictDoNothing = vi.fn(() => Promise.resolve());
  return chain;
}

describe("conversation-map query module exports", () => {
  it("exports findByKey", () => {
    expect(typeof conversationMapQueries.findByKey).toBe("function");
  });

  it("exports createMapping", () => {
    expect(typeof conversationMapQueries.createMapping).toBe("function");
  });
});

describe("findByKey", () => {
  it("returns conversationId when mapping exists", async () => {
    const mockDb = createMockDb([{ conversationId: "conv_123" }]);
    const result = await conversationMapQueries.findByKey(mockDb, "email:ag_1:thread", "ws_1");
    expect(result).toBe("conv_123");
    expect(mockDb.select).toHaveBeenCalledOnce();
    expect(mockDb.from).toHaveBeenCalledOnce();
    expect(mockDb.where).toHaveBeenCalledOnce();
    expect(mockDb.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no mapping exists", async () => {
    const mockDb = createMockDb([]);
    const result = await conversationMapQueries.findByKey(mockDb, "email:ag_1:unknown", "ws_1");
    expect(result).toBeNull();
  });
});
