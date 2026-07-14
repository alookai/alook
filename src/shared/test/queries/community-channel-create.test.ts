import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createChannel } from "../../src/db/queries/community/channel";

function createMockDb() {
  const insertValues = vi.fn();
  const insert = vi.fn(() => ({
    values: vi.fn((v: any) => {
      insertValues(v);
      return {
        returning: vi.fn(() =>
          Promise.resolve([{ id: "c_new", ...v }])
        ),
      };
    }),
  }));
  return { insert, __insertValues: insertValues } as any;
}

describe("createChannel — categoryId coercion", () => {
  it("coerces an empty-string categoryId to null (top-level channel FK)", async () => {
    const db = createMockDb();
    await createChannel(db, { serverId: "s1", categoryId: "", name: "general" });
    expect(db.__insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: null })
    );
  });

  it("coerces undefined categoryId to null", async () => {
    const db = createMockDb();
    await createChannel(db, { serverId: "s1", name: "general" });
    expect(db.__insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: null })
    );
  });

  it("preserves a real categoryId", async () => {
    const db = createMockDb();
    await createChannel(db, { serverId: "s1", categoryId: "cat_1", name: "general" });
    expect(db.__insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: "cat_1" })
    );
  });
});
