import { describe, it, expect, vi } from "vitest";
import * as ws from "../../src/db/queries/workspace";

function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  chain.innerJoin = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("workspace exports", () => {
  it("exports getWorkspace", () => { expect(typeof ws.getWorkspace).toBe("function"); });
  it("exports getWorkspaceBySlug", () => { expect(typeof ws.getWorkspaceBySlug).toBe("function"); });
  it("exports listWorkspaces", () => { expect(typeof ws.listWorkspaces).toBe("function"); });
  it("exports createWorkspace", () => { expect(typeof ws.createWorkspace).toBe("function"); });
  it("exports updateWorkspace", () => { expect(typeof ws.updateWorkspace).toBe("function"); });
  it("exports deleteWorkspace", () => { expect(typeof ws.deleteWorkspace).toBe("function"); });
});

describe("getWorkspace", () => {
  it("returns null when not found", async () => { expect(await ws.getWorkspace(createSelectMock([]), "x", "u")).toBeNull(); });
  it("returns workspace", async () => { const w = { id: "ws_1" }; expect(await ws.getWorkspace(createSelectMock([w]), "ws_1", "u")).toEqual(w); });
});

describe("getWorkspaceBySlug", () => {
  it("returns null when not found", async () => { expect(await ws.getWorkspaceBySlug(createSelectMock([]), "x")).toBeNull(); });
  it("returns workspace", async () => { const w = { id: "ws_1" }; expect(await ws.getWorkspaceBySlug(createSelectMock([w]), "slug")).toEqual(w); });
});

describe("createWorkspace", () => {
  it("creates workspace", async () => {
    const w = { id: "ws_1" };
    expect(await ws.createWorkspace(createSelectMock([w]), { name: "N", slug: "s" })).toEqual(w);
  });
});

describe("updateWorkspace", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await ws.updateWorkspace(chain, "x", { name: "N" })).toBeNull();
  });
  it("returns updated", async () => {
    const w = { id: "ws_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([w]));
    expect(await ws.updateWorkspace(chain, "ws_1", { name: "N" })).toEqual(w);
  });
});

describe("deleteWorkspace", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await ws.deleteWorkspace(chain, "x")).toBeNull();
  });
  it("returns deleted", async () => {
    const w = { id: "ws_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([w]));
    expect(await ws.deleteWorkspace(chain, "ws_1")).toEqual(w);
  });
});
