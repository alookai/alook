import { describe, it, expect, vi } from "vitest";
import * as sidebar from "../../src/db/queries/agent-sidebar-order";

describe("agent-sidebar-order exports", () => {
  it("exports listOrder", () => { expect(typeof sidebar.listOrder).toBe("function"); });
  it("exports reorder", () => { expect(typeof sidebar.reorder).toBe("function"); });
});

describe("listOrder", () => {
  it("queries ordered items", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => Promise.resolve([]));
    await sidebar.listOrder(chain, "w", "u");
    expect(chain.orderBy).toHaveBeenCalled();
  });
});

describe("reorder", () => {
  it("calls batch", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.batch = vi.fn(() => Promise.resolve());
    await sidebar.reorder(chain, "w", "u", ["a", "b"]);
    expect(chain.batch).toHaveBeenCalled();
  });
});
