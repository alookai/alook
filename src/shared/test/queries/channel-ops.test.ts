import { describe, it, expect, vi } from "vitest";
import * as channelQueries from "../../src/db/queries/channel";

describe("getChannelByName", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    expect(await channelQueries.getChannelByName(chain, "ws_1", "missing")).toBeNull();
  });
  it("returns channel when found", async () => {
    const ch = { id: "ch_1", name: "general" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([ch]));
    expect(await channelQueries.getChannelByName(chain, "ws_1", "general")).toEqual(ch);
  });
});

describe("getChannelById", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    expect(await channelQueries.getChannelById(chain, "x", "ws_1")).toBeNull();
  });
  it("returns channel when found", async () => {
    const ch = { id: "ch_1", name: "general" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([ch]));
    expect(await channelQueries.getChannelById(chain, "ch_1", "ws_1")).toEqual(ch);
  });
});

describe("listChannels", () => {
  it("returns channels ordered by position", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => Promise.resolve([{ id: "ch_1" }]));
    await channelQueries.listChannels(chain, "ws_1");
    expect(chain.orderBy).toHaveBeenCalled();
  });
});

describe("createChannel", () => {
  it("creates channel at next position", async () => {
    const ch = { id: "ch_1", name: "new", position: 2 };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ maxPos: 1 }]));
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([ch]));
    const result = await channelQueries.createChannel(chain, { workspaceId: "ws_1", name: "new" });
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ name: "new", position: 2 }));
    expect(result).toEqual(ch);
  });
});

describe("deleteChannel", () => {
  it("returns null when channel not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    expect(await channelQueries.deleteChannel(chain, "x", "ws_1")).toBeNull();
  });
  it("deletes channel and conversations", async () => {
    const ch = { id: "ch_1", name: "old" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([ch]));
    chain.delete = vi.fn(() => chain);
    chain.run = vi.fn(() => Promise.resolve());
    chain.batch = vi.fn(() => Promise.resolve());
    const result = await channelQueries.deleteChannel(chain, "ch_1", "ws_1");
    expect(chain.run).toHaveBeenCalled();
    expect(chain.batch).toHaveBeenCalled();
    expect(result).toEqual(ch);
  });
});

describe("renameChannel", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    expect(await channelQueries.renameChannel(chain, "x", "ws_1", "new")).toBeNull();
  });
  it("renames and updates conversations", async () => {
    const ch = { id: "ch_1", name: "old" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([ch]));
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.batch = vi.fn(() => Promise.resolve());
    const result = await channelQueries.renameChannel(chain, "ch_1", "ws_1", "new");
    expect(result).toEqual({ ...ch, name: "new" });
  });
});

describe("reorderChannels", () => {
  it("calls batch with updates", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.batch = vi.fn(() => Promise.resolve());
    await channelQueries.reorderChannels(chain, "ws_1", ["ch_a", "ch_b"]);
    expect(chain.batch).toHaveBeenCalled();
  });
});
