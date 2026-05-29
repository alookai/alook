import { describe, it, expect, vi } from "vitest";
import * as pin from "../../src/db/queries/agent-pin";

describe("agent-pin exports", () => {
  it("exports listPins", () => { expect(typeof pin.listPins).toBe("function"); });
  it("exports pinAgent", () => { expect(typeof pin.pinAgent).toBe("function"); });
  it("exports unpinAgent", () => { expect(typeof pin.unpinAgent).toBe("function"); });
  it("exports reorderPins", () => { expect(typeof pin.reorderPins).toBe("function"); });
});

describe("pinAgent", () => {
  it("returns null on conflict", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ maxPos: 2 }]));
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await pin.pinAgent(chain, { agentId: "a", workspaceId: "w", userId: "u" })).toBeNull();
  });
  it("creates at next position", async () => {
    const p = { id: "pin_1", position: 3 };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ maxPos: 2 }]));
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([p]));
    expect(await pin.pinAgent(chain, { agentId: "a", workspaceId: "w", userId: "u" })).toEqual(p);
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ position: 3 }));
  });
});

describe("unpinAgent", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await pin.unpinAgent(chain, "a", "w", "u")).toBeNull();
  });
  it("returns removed pin", async () => {
    const p = { id: "pin_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([p]));
    expect(await pin.unpinAgent(chain, "a", "w", "u")).toEqual(p);
  });
});

describe("reorderPins", () => {
  it("calls batch", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.batch = vi.fn(() => Promise.resolve());
    await pin.reorderPins(chain, "w", "u", ["a", "b"]);
    expect(chain.batch).toHaveBeenCalled();
  });
});
